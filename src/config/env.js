export function getPort() {
  return Number(process.env.PORT || 3000);
}

export function getPublicAppUrl(port = getPort()) {
  return (process.env.PUBLIC_APP_URL || `http://0.0.0.0:${port}`).replace(/\/$/, "");
}

export function getSupabasePublicUrl() {
  return String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
}

export function getSupabaseAnonKey() {
  return String(process.env.SUPABASE_ANON_KEY || "");
}

export function getStripeSecretKey() {
  return String(process.env.STRIPE_SECRET_KEY || "");
}

export function getStripePriceId() {
  return String(process.env.STRIPE_PRICE_ID || "");
}

export function getStripeWebhookSecret() {
  return String(process.env.STRIPE_WEBHOOK_SECRET || "");
}

function normalizeBooleanEnv(value, fallback = false) {
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

export function getGoogleClientId() {
  return String(process.env.GOOGLE_CLIENT_ID || "");
}

export function getGoogleClientSecret() {
  return String(process.env.GOOGLE_CLIENT_SECRET || "");
}

export function getGoogleOAuthRedirectUri() {
  return String(
    process.env.GOOGLE_OAUTH_REDIRECT_URI || `${getPublicAppUrl()}/google/oauth/callback`
  ).replace(/\/$/, "");
}

export function getGoogleTokenEncryptionSecret() {
  return String(process.env.GOOGLE_TOKEN_ENCRYPTION_SECRET || "");
}

export function listMissingGoogleOperatorEnvVars() {
  const requiredKeys = [
    ["GOOGLE_CLIENT_ID", getGoogleClientId()],
    ["GOOGLE_CLIENT_SECRET", getGoogleClientSecret()],
    ["GOOGLE_OAUTH_REDIRECT_URI", process.env.GOOGLE_OAUTH_REDIRECT_URI],
    ["GOOGLE_TOKEN_ENCRYPTION_SECRET", getGoogleTokenEncryptionSecret()],
  ];

  return requiredKeys
    .filter(([, value]) => !String(value || "").trim())
    .map(([key]) => key);
}

export function isOperatorWorkspaceV1Enabled() {
  return normalizeBooleanEnv(process.env.VONZA_OPERATOR_WORKSPACE_V1, true);
}

export function isTodayCopilotEnabled() {
  return normalizeBooleanEnv(process.env.VONZA_TODAY_COPILOT_V1, false);
}

export function getBuildSha() {
  return String(
    process.env.RENDER_GIT_COMMIT
    || process.env.SOURCE_VERSION
    || process.env.COMMIT_SHA
    || ""
  ).trim();
}

export function getAppVersion() {
  return String(process.env.npm_package_version || "1.0.0").trim();
}

export function isDevFakeBillingEnabled() {
  return String(process.env.DEV_FAKE_BILLING || "").trim().toLowerCase() === "true";
}

function isLocalHostname(hostname) {
  const normalized = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "0.0.0.0"
    || normalized === "::1"
    || normalized.endsWith(".local");
}

function getHostnameFromUrl(value) {
  try {
    return new URL(String(value || "")).hostname;
  } catch {
    return "";
  }
}

export function isLocalDevBillingRequestAllowed(req) {
  if (!isDevFakeBillingEnabled()) {
    return false;
  }

  if (String(process.env.NODE_ENV || "").trim().toLowerCase() === "production") {
    return false;
  }

  const configuredHost = getHostnameFromUrl(process.env.PUBLIC_APP_URL);

  if (configuredHost && isLocalHostname(configuredHost)) {
    return true;
  }

  const requestHost = req?.hostname || String(req?.headers?.host || "").split(":")[0];
  return isLocalHostname(requestHost);
}
