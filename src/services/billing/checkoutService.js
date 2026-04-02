import Stripe from "stripe";

import {
  getPublicAppUrl,
  getStripePriceId,
  getStripeSecretKey,
  getStripeWebhookSecret,
} from "../../config/env.js";
import { cleanText } from "../../utils/text.js";

let stripeClient = null;

function getStripeClient() {
  if (stripeClient) {
    return stripeClient;
  }

  const secretKey = getStripeSecretKey();

  if (!secretKey) {
    const error = new Error("STRIPE_SECRET_KEY is not configured.");
    error.statusCode = 500;
    throw error;
  }

  stripeClient = new Stripe(secretKey);
  return stripeClient;
}

async function sessionIncludesConfiguredPrice(session, options = {}) {
  const normalizedSessionId = cleanText(session?.id);
  const expectedPriceId = cleanText(options.expectedPriceId || getStripePriceId());
  const stripe = options.stripe || getStripeClient();

  if (!expectedPriceId) {
    const error = new Error("STRIPE_PRICE_ID is not configured.");
    error.statusCode = 500;
    throw error;
  }

  if (!normalizedSessionId) {
    return false;
  }

  const lineItems = await stripe.checkout.sessions.listLineItems(normalizedSessionId, {
    limit: 20,
  });

  return Boolean((lineItems?.data || []).some((item) => {
    const priceId = cleanText(item?.price?.id || item?.price);
    return priceId === expectedPriceId;
  }));
}

export async function createHostedCheckoutSession({ user, email }) {
  const priceId = getStripePriceId();

  if (!priceId) {
    const error = new Error("STRIPE_PRICE_ID is not configured.");
    error.statusCode = 500;
    throw error;
  }

  const appUrl = getPublicAppUrl();
  const stripe = getStripeClient();
  const ownerUserId = cleanText(user?.id);
  const customerEmail = cleanText(email || user?.email);

  if (!ownerUserId) {
    const error = new Error("Authenticated user is required.");
    error.statusCode = 401;
    throw error;
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    success_url: `${appUrl}/dashboard?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/dashboard?payment=cancel`,
    customer_email: customerEmail || undefined,
    metadata: {
      owner_user_id: ownerUserId,
    },
  });

  return session;
}

export async function verifySuccessfulCheckout({ sessionId, ownerUserId }, options = {}) {
  const normalizedSessionId = cleanText(sessionId);
  const normalizedOwnerUserId = cleanText(ownerUserId);

  if (!normalizedSessionId) {
    const error = new Error("session_id is required.");
    error.statusCode = 400;
    throw error;
  }

  if (!normalizedOwnerUserId) {
    const error = new Error("Authenticated user is required.");
    error.statusCode = 401;
    throw error;
  }

  const stripe = options.stripe || getStripeClient();
  const session = await stripe.checkout.sessions.retrieve(normalizedSessionId);

  if (!session) {
    const error = new Error("Checkout session not found.");
    error.statusCode = 404;
    throw error;
  }

  if (cleanText(session.metadata?.owner_user_id) !== normalizedOwnerUserId) {
    const error = new Error("This checkout session does not belong to the signed-in user.");
    error.statusCode = 403;
    throw error;
  }

  if (session.payment_status !== "paid") {
    const error = new Error("Payment is not completed yet.");
    error.statusCode = 400;
    throw error;
  }

  const hasExpectedPrice = await sessionIncludesConfiguredPrice(session, {
    stripe,
    expectedPriceId: options.expectedPriceId,
  });

  if (!hasExpectedPrice) {
    const error = new Error("This checkout session does not match the configured Vonza access price.");
    error.statusCode = 403;
    throw error;
  }

  return session;
}

export function constructStripeWebhookEvent({ payload, signature }) {
  const webhookSecret = getStripeWebhookSecret();

  if (!webhookSecret) {
    const error = new Error("STRIPE_WEBHOOK_SECRET is not configured.");
    error.statusCode = 500;
    throw error;
  }

  if (!signature) {
    const error = new Error("Missing Stripe signature.");
    error.statusCode = 400;
    throw error;
  }

  const stripe = getStripeClient();
  return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
}

export async function getPaidOwnerIdFromCheckoutSession(session, options = {}) {
  if (!session || session.payment_status !== "paid") {
    return null;
  }

  const ownerUserId = cleanText(session.metadata?.owner_user_id);

  if (!ownerUserId) {
    return null;
  }

  const hasExpectedPrice = await sessionIncludesConfiguredPrice(session, {
    stripe: options.stripe,
    expectedPriceId: options.expectedPriceId,
  });

  return hasExpectedPrice ? ownerUserId : null;
}

export function isStripeConfigError(error) {
  return /STRIPE_(SECRET_KEY|PRICE_ID|WEBHOOK_SECRET) is not configured/i.test(
    cleanText(error?.message)
  );
}

export function isStripeCheckoutMinimumAmountError(error) {
  const message = cleanText(error?.message);

  return /checkout session'?s total amount due must add up to at least/i.test(message)
    || /amount must convert to at least/i.test(message);
}

export function getStripeCheckoutConfigurationErrorMessage(error) {
  if (!isStripeCheckoutMinimumAmountError(error)) {
    return "";
  }

  return "Stripe checkout is using a price that is below Stripe's minimum allowed amount for the configured currency. Update STRIPE_PRICE_ID to a valid Stripe price in the same account and mode, then retry checkout.";
}
