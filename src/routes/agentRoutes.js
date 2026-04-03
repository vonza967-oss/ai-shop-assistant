import express from "express";

import { getSupabaseClient } from "../clients/supabaseClient.js";
import { getAuthenticatedUser } from "../services/auth/authService.js";
import {
  claimAgentForOwner,
  createAgentForBusinessName,
  deleteAgent,
  getAgentWorkspaceSnapshot,
  getWidgetBootstrap,
  listAllAgents,
  listAgents,
  requireActiveAgentAccess,
  requireAgentAccess,
  resolveAgentContext,
  updateAgentAccessStatus,
  updateOwnedAccessStatus,
  updateAgentSettings,
} from "../services/agents/agentService.js";
import {
  assertMessagesSchemaReady,
  listAgentMessages,
} from "../services/chat/messageService.js";
import { buildAnalyticsSummary } from "../services/analytics/analyticsSummaryService.js";
import { getProductFunnelSummary, trackProductEvent } from "../services/analytics/productEventService.js";
import {
  assertWidgetTelemetrySchemaReady,
  listWidgetRoutingEventsByAgentId,
  trackWidgetEvent,
} from "../services/analytics/widgetTelemetryService.js";
import {
  buildActionQueue,
  listActionQueueStatuses,
  updateActionQueueStatus,
} from "../services/analytics/actionQueueService.js";
import {
  syncFollowUpWorkflows,
  updateFollowUpWorkflow,
} from "../services/followup/followUpService.js";
import {
  syncKnowledgeFixWorkflows,
  updateKnowledgeFixWorkflow,
} from "../services/knowledge/knowledgeFixService.js";
import {
  assertConversionOutcomeSchemaReady,
  detectConversionOutcomesForPage,
  listConversionOutcomesForAgent,
  markManualConversionOutcome,
  recordTrackedCtaClick,
  trackFollowUpOutcome,
} from "../services/conversion/conversionOutcomeService.js";
import {
  assertLeadCaptureSchemaReady,
  hydrateActionQueueWithLeadCaptures,
  listLeadCaptures,
} from "../services/leads/liveLeadCaptureService.js";
import {
  createHostedCheckoutSession,
  constructStripeWebhookEvent,
  getStripeCheckoutConfigurationErrorMessage,
  getPaidOwnerIdFromCheckoutSession,
  isStripeConfigError,
  isStripeCheckoutMinimumAmountError,
  verifySuccessfulCheckout,
} from "../services/billing/checkoutService.js";
import { isLocalDevBillingRequestAllowed } from "../config/env.js";
import {
  extractBusinessWebsiteContent,
  getStoredWebsiteContent,
} from "../services/scraping/websiteContentService.js";
import {
  recordInstallPing,
  verifyAgentInstallation,
} from "../services/install/installPresenceService.js";
import {
  approveCalendarAction,
  approveCampaignDraft,
  completeGoogleConnection,
  createCampaignDraft,
  createGoogleConnectionStart,
  draftCalendarAction,
  draftInboxReply,
  getOperatorWorkspaceSnapshot,
  sendDueCampaignSteps,
  sendInboxReply,
  updateOperatorTaskStatus,
} from "../services/operator/operatorWorkspaceService.js";
import { updateOperatorOnboardingState } from "../services/operator/operatorActivationService.js";

export function createAgentRouter(deps = {}) {
  const router = express.Router();
  const getSupabase = deps.getSupabaseClient || getSupabaseClient;
  const authenticateUser = deps.getAuthenticatedUser || getAuthenticatedUser;
  const listAgentsImpl = deps.listAgents || listAgents;
  const createAgentForBusinessNameImpl = deps.createAgentForBusinessName || createAgentForBusinessName;
  const requireAgentAccessImpl = deps.requireAgentAccess || requireAgentAccess;
  const requireActiveAgentAccessImpl = deps.requireActiveAgentAccess || requireActiveAgentAccess;
  const assertMessagesSchemaReadyImpl = deps.assertMessagesSchemaReady || assertMessagesSchemaReady;
  const assertWidgetTelemetrySchemaReadyImpl =
    deps.assertWidgetTelemetrySchemaReady || assertWidgetTelemetrySchemaReady;
  const assertLeadCaptureSchemaReadyImpl =
    deps.assertLeadCaptureSchemaReady || assertLeadCaptureSchemaReady;
  const assertConversionOutcomeSchemaReadyImpl =
    deps.assertConversionOutcomeSchemaReady || assertConversionOutcomeSchemaReady;
  const listAgentMessagesImpl = deps.listAgentMessages || listAgentMessages;
  const buildActionQueueImpl = deps.buildActionQueue || buildActionQueue;
  const listActionQueueStatusesImpl = deps.listActionQueueStatuses || listActionQueueStatuses;
  const updateActionQueueStatusImpl = deps.updateActionQueueStatus || updateActionQueueStatus;
  const syncFollowUpWorkflowsImpl = deps.syncFollowUpWorkflows || syncFollowUpWorkflows;
  const updateFollowUpWorkflowImpl = deps.updateFollowUpWorkflow || updateFollowUpWorkflow;
  const syncKnowledgeFixWorkflowsImpl = deps.syncKnowledgeFixWorkflows || syncKnowledgeFixWorkflows;
  const updateKnowledgeFixWorkflowImpl = deps.updateKnowledgeFixWorkflow || updateKnowledgeFixWorkflow;
  const listConversionOutcomesForAgentImpl =
    deps.listConversionOutcomesForAgent || listConversionOutcomesForAgent;
  const recordTrackedCtaClickImpl = deps.recordTrackedCtaClick || recordTrackedCtaClick;
  const detectConversionOutcomesForPageImpl =
    deps.detectConversionOutcomesForPage || detectConversionOutcomesForPage;
  const markManualConversionOutcomeImpl =
    deps.markManualConversionOutcome || markManualConversionOutcome;
  const trackFollowUpOutcomeImpl = deps.trackFollowUpOutcome || trackFollowUpOutcome;
  const listLeadCapturesImpl = deps.listLeadCaptures || listLeadCaptures;
  const listWidgetRoutingEventsByAgentIdImpl =
    deps.listWidgetRoutingEventsByAgentId || listWidgetRoutingEventsByAgentId;
  const updateAgentSettingsImpl = deps.updateAgentSettings || updateAgentSettings;
  const deleteAgentImpl = deps.deleteAgent || deleteAgent;
  const resolveAgentContextImpl = deps.resolveAgentContext || resolveAgentContext;
  const getAgentWorkspaceSnapshotImpl = deps.getAgentWorkspaceSnapshot || getAgentWorkspaceSnapshot;
  const extractBusinessWebsiteContentImpl = deps.extractBusinessWebsiteContent || extractBusinessWebsiteContent;
  const getStoredWebsiteContentImpl = deps.getStoredWebsiteContent || getStoredWebsiteContent;
  const updateOwnedAccessStatusImpl = deps.updateOwnedAccessStatus || updateOwnedAccessStatus;
  const createHostedCheckoutSessionImpl =
    deps.createHostedCheckoutSession || createHostedCheckoutSession;
  const constructStripeWebhookEventImpl = deps.constructStripeWebhookEvent || constructStripeWebhookEvent;
  const getPaidOwnerIdFromCheckoutSessionImpl =
    deps.getPaidOwnerIdFromCheckoutSession || getPaidOwnerIdFromCheckoutSession;
  const getOperatorWorkspaceSnapshotImpl =
    deps.getOperatorWorkspaceSnapshot || getOperatorWorkspaceSnapshot;
  const createGoogleConnectionStartImpl =
    deps.createGoogleConnectionStart || createGoogleConnectionStart;
  const completeGoogleConnectionImpl =
    deps.completeGoogleConnection || completeGoogleConnection;
  const draftInboxReplyImpl =
    deps.draftInboxReply || draftInboxReply;
  const sendInboxReplyImpl =
    deps.sendInboxReply || sendInboxReply;
  const draftCalendarActionImpl =
    deps.draftCalendarAction || draftCalendarAction;
  const approveCalendarActionImpl =
    deps.approveCalendarAction || approveCalendarAction;
  const createCampaignDraftImpl =
    deps.createCampaignDraft || createCampaignDraft;
  const approveCampaignDraftImpl =
    deps.approveCampaignDraft || approveCampaignDraft;
  const sendDueCampaignStepsImpl =
    deps.sendDueCampaignSteps || sendDueCampaignSteps;
  const updateOperatorTaskStatusImpl =
    deps.updateOperatorTaskStatus || updateOperatorTaskStatus;
  const updateOperatorOnboardingStateImpl =
    deps.updateOperatorOnboardingState || updateOperatorOnboardingState;
  const getAdminToken = (req) => req.query.token || req.headers["x-admin-token"];

  function getCheckoutDraftBusinessName(user) {
    const ownerUserId = String(user?.id || "").trim();
    const suffix = ownerUserId ? ownerUserId.slice(0, 8) : "owner";
    return `Vonza setup ${suffix}`;
  }

  function ensureAdminAccess(req) {
    const configuredToken = process.env.ADMIN_TOKEN;

    if (!configuredToken) {
      const error = new Error("ADMIN_TOKEN is not configured on the server.");
      error.statusCode = 403;
      throw error;
    }

    if (getAdminToken(req) !== configuredToken) {
      const error = new Error("Forbidden");
      error.statusCode = 403;
      throw error;
    }
  }

  router.post("/stripe/webhook", async (req, res) => {
    try {
      const event = constructStripeWebhookEventImpl({
        payload: req.body,
        signature: req.headers["stripe-signature"],
      });

      if (event.type === "checkout.session.completed") {
        const ownerUserId = await getPaidOwnerIdFromCheckoutSessionImpl(event.data?.object);

        if (ownerUserId) {
          await updateOwnedAccessStatusImpl(getSupabase(), {
            ownerUserId,
            accessStatus: "active",
          });
        }
      }

      res.json({ received: true });
    } catch (err) {
      if (err?.type === "StripeSignatureVerificationError" || err?.message?.includes("signature")) {
        console.warn("[stripe webhook] Signature verification failed:", err.message);
      } else if (isStripeConfigError(err)) {
        console.warn("[stripe webhook] Stripe webhook configuration error:", err.message);
      } else {
        console.error(err);
      }
      res.status(err.statusCode || 400).json({
        error: err.message || "Webhook error",
      });
    }
  });

  router.get("/widget/bootstrap", async (req, res) => {
    try {
      const result = await getWidgetBootstrap(getSupabase(), {
        installId: req.query.install_id || req.query.installId,
        agentId: req.query.agent_id || req.query.agentId,
        agentKey: req.query.agent_key || req.query.agentKey,
        businessId: req.query.business_id || req.query.businessId,
        websiteUrl: req.query.website_url || req.query.websiteUrl,
        origin: req.query.origin,
        pageUrl: req.query.page_url || req.query.pageUrl,
      });

      res.setHeader("Cache-Control", "private, max-age=60, stale-while-revalidate=300");
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/install/ping", async (req, res) => {
    try {
      const result = await recordInstallPing(getSupabase(), {
        installId: req.body.install_id || req.body.installId,
        origin: req.body.origin,
        pageUrl: req.body.page_url || req.body.pageUrl,
        sessionId: req.body.session_id || req.body.sessionId,
        fingerprint: req.body.fingerprint,
        timestamp: req.body.timestamp,
      });

      res.json(result);
    } catch (err) {
      console.warn("[install ping] ingestion failure", {
        installId: req.body.install_id || req.body.installId || null,
        origin: req.body.origin || null,
        pageUrl: req.body.page_url || req.body.pageUrl || null,
        statusCode: err?.statusCode || 500,
        code: err?.code || null,
        message: err?.message || "Something went wrong",
      });
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/install/events", async (req, res) => {
    try {
      const result = await trackWidgetEvent(getSupabase(), {
        installId: req.body.install_id || req.body.installId,
        eventName: req.body.event_name || req.body.eventName,
        sessionId: req.body.session_id || req.body.sessionId,
        origin: req.body.origin,
        pageUrl: req.body.page_url || req.body.pageUrl,
        fingerprint: req.body.fingerprint,
        dedupeKey: req.body.dedupe_key || req.body.dedupeKey,
        metadata: req.body.metadata,
      });

      res.json(result);
    } catch (err) {
      console.warn("[install events] validation failure", {
        installId: req.body.install_id || req.body.installId || null,
        eventName: req.body.event_name || req.body.eventName || null,
        sessionId: req.body.session_id || req.body.sessionId || null,
        statusCode: err?.statusCode || 500,
        code: err?.code || null,
        message: err?.message || "Something went wrong",
      });
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.get("/install/cta", async (req, res) => {
    try {
      const result = await recordTrackedCtaClickImpl(getSupabase(), {
        installId: req.query.install_id || req.query.installId,
        sessionId: req.query.session_id || req.query.sessionId,
        visitorId: req.query.visitor_id || req.query.visitorId,
        fingerprint: req.query.fingerprint,
        pageUrl: req.query.page_url || req.query.pageUrl,
        origin: req.query.origin,
        ctaType: req.query.cta_type || req.query.ctaType,
        targetType: req.query.target_type || req.query.targetType,
        targetUrl: req.query.target_url || req.query.targetUrl,
        decisionKey: req.query.decision_key || req.query.decisionKey,
        relatedActionType: req.query.related_action_type || req.query.relatedActionType,
        relatedIntentType: req.query.related_intent_type || req.query.relatedIntentType,
        actionKey: req.query.action_key || req.query.actionKey,
        conversationId: req.query.conversation_id || req.query.conversationId,
        personKey: req.query.person_key || req.query.personKey,
        leadId: req.query.lead_id || req.query.leadId,
        followUpId: req.query.follow_up_id || req.query.followUpId,
        label: req.query.label,
      });

      res.redirect(302, result.redirectUrl);
    } catch (err) {
      console.warn("[conversion] CTA redirect failed:", {
        installId: req.query.install_id || req.query.installId || null,
        ctaType: req.query.cta_type || req.query.ctaType || null,
        targetType: req.query.target_type || req.query.targetType || null,
        statusCode: err?.statusCode || 500,
        message: err?.message || "Something went wrong",
      });

      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/install/outcomes/detect", async (req, res) => {
    try {
      const result = await detectConversionOutcomesForPageImpl(getSupabase(), {
        installId: req.body.install_id || req.body.installId,
        sessionId: req.body.session_id || req.body.sessionId,
        visitorId: req.body.visitor_id || req.body.visitorId,
        fingerprint: req.body.fingerprint,
        pageUrl: req.body.page_url || req.body.pageUrl,
        origin: req.body.origin,
        ctaEventId: req.body.cta_event_id || req.body.ctaEventId,
        outcomeType: req.body.outcome_type || req.body.outcomeType,
        ctaType: req.body.cta_type || req.body.ctaType,
        targetType: req.body.target_type || req.body.targetType,
        relatedActionType: req.body.related_action_type || req.body.relatedActionType,
        relatedIntentType: req.body.related_intent_type || req.body.relatedIntentType,
        actionKey: req.body.action_key || req.body.actionKey,
        conversationId: req.body.conversation_id || req.body.conversationId,
        personKey: req.body.person_key || req.body.personKey,
        leadId: req.body.lead_id || req.body.leadId,
        followUpId: req.body.follow_up_id || req.body.followUpId,
      });

      res.json(result);
    } catch (err) {
      console.warn("[conversion] Outcome detection failed:", {
        installId: req.body.install_id || req.body.installId || null,
        pageUrl: req.body.page_url || req.body.pageUrl || null,
        statusCode: err?.statusCode || 500,
        message: err?.message || "Something went wrong",
      });
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/install/outcomes/ping", async (req, res) => {
    try {
      const result = await detectConversionOutcomesForPageImpl(getSupabase(), {
        installId: req.body.install_id || req.body.installId,
        sessionId: req.body.session_id || req.body.sessionId,
        visitorId: req.body.visitor_id || req.body.visitorId,
        fingerprint: req.body.fingerprint,
        pageUrl: req.body.page_url || req.body.pageUrl,
        origin: req.body.origin,
        ctaEventId: req.body.cta_event_id || req.body.ctaEventId,
        outcomeType: req.body.outcome_type || req.body.outcomeType,
        ctaType: req.body.cta_type || req.body.ctaType,
        targetType: req.body.target_type || req.body.targetType,
        relatedActionType: req.body.related_action_type || req.body.relatedActionType,
        relatedIntentType: req.body.related_intent_type || req.body.relatedIntentType,
        actionKey: req.body.action_key || req.body.actionKey,
        conversationId: req.body.conversation_id || req.body.conversationId,
        personKey: req.body.person_key || req.body.personKey,
        leadId: req.body.lead_id || req.body.leadId,
        followUpId: req.body.follow_up_id || req.body.followUpId,
        source: "ping",
      });

      res.json(result);
    } catch (err) {
      console.warn("[conversion] Outcome ping failed:", {
        installId: req.body.install_id || req.body.installId || null,
        pageUrl: req.body.page_url || req.body.pageUrl || null,
        statusCode: err?.statusCode || 500,
        message: err?.message || "Something went wrong",
      });
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/create", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req).catch((error) => {
        if (error.statusCode === 401) {
          return null;
        }
        throw error;
      });
      const result = await createAgentForBusinessNameImpl(
        supabase,
        req.body.business_name,
        req.body.website_url || req.body.websiteUrl,
        req.body.client_id || req.body.clientId,
        user?.id || null
      );

      const hasInitialSettings = [
        req.body.assistant_name || req.body.assistantName,
        req.body.tone,
        req.body.system_prompt || req.body.systemPrompt,
        req.body.welcome_message || req.body.welcomeMessage,
        req.body.button_label || req.body.buttonLabel,
        req.body.primary_color || req.body.primaryColor,
        req.body.secondary_color || req.body.secondaryColor,
        req.body.website_url || req.body.websiteUrl,
      ].some((value) => Boolean(String(value || "").trim()));

      if (hasInitialSettings) {
        await updateAgentSettingsImpl(supabase, {
          agentId: result.agent.id,
          name: req.body.business_name,
          assistantName: req.body.assistant_name || req.body.assistantName,
          tone: req.body.tone,
          systemPrompt: req.body.system_prompt || req.body.systemPrompt,
          welcomeMessage: req.body.welcome_message || req.body.welcomeMessage,
          buttonLabel: req.body.button_label || req.body.buttonLabel,
          websiteUrl: req.body.website_url || req.body.websiteUrl,
          primaryColor: req.body.primary_color || req.body.primaryColor,
          secondaryColor: req.body.secondary_color || req.body.secondaryColor,
        });
      }

      res.json({
        agent_id: result.agent.id,
        agent_key: result.agent.publicAgentKey,
        business_id: result.business.id,
        access_status: result.agent.accessStatus,
      });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/google/connect/start", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req);
      const agentId = req.body.agent_id || req.body.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user.id,
        clientId: req.body.client_id || req.body.clientId,
      });

      const agent = await getAgentWorkspaceSnapshotImpl(supabase, agentId);
      const result = await createGoogleConnectionStartImpl(supabase, {
        agent,
        ownerUserId: user.id,
        redirectPath: req.body.redirect_path || req.body.redirectPath || "/dashboard",
        selectedMailbox: req.body.selected_mailbox || req.body.selectedMailbox,
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.get("/google/oauth/callback", async (req, res) => {
    try {
      const result = await completeGoogleConnectionImpl(getSupabase(), {
        stateToken: req.query.state,
        code: req.query.code,
        oauthError: req.query.error,
      });

      res.redirect(302, result.redirectUrl);
    } catch (err) {
      console.error(err);
      const message = encodeURIComponent(err.message || "google_connect_failed");
      res.redirect(302, `/dashboard?google=error&reason=${message}`);
    }
  });

  router.get("/agents/list", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req).catch((error) => {
        if (error.statusCode === 401) {
          return null;
        }
        throw error;
      });
      const result = await listAgentsImpl(supabase, {
        clientId: req.query.client_id || req.query.clientId,
        ownerUserId: user?.id || null,
        includeBridgeAgent: Boolean(user),
      });
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.get("/agents/admin-list", async (req, res) => {
    try {
      ensureAdminAccess(req);
      const agents = await listAllAgents(getSupabase());
      const funnel = await getProductFunnelSummary(getSupabase(), { days: 7 });
      res.json({ agents, funnel });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.get("/agents/messages", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req).catch((error) => {
        if (error.statusCode === 401) {
          return null;
        }
        throw error;
      });
      await requireActiveAgentAccessImpl(supabase, {
        agentId: req.query.agent_id || req.query.agentId,
        ownerUserId: user?.id || null,
        clientId: req.query.client_id || req.query.clientId,
      });
      await assertMessagesSchemaReadyImpl(supabase, { phase: "request" });
      const messages = await listAgentMessagesImpl(
        supabase,
        req.query.agent_id || req.query.agentId
      );
      res.json({ messages });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.get("/agents/operator-workspace", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req);
      const agentId = req.query.agent_id || req.query.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user.id,
        clientId: req.query.client_id || req.query.clientId,
      });

      const agent = await getAgentWorkspaceSnapshotImpl(supabase, agentId);
      const result = await getOperatorWorkspaceSnapshotImpl(supabase, {
        agent,
        ownerUserId: user.id,
        forceSync: req.query.force_sync === "true",
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/update", async (req, res) => {
    let user = null;

    try {
      const supabase = getSupabase();
      user = await authenticateUser(supabase, req).catch((error) => {
        if (error.statusCode === 401) {
          return null;
        }
        throw error;
      });
      await requireActiveAgentAccessImpl(supabase, {
        agentId: req.body.agent_id || req.body.agentId,
        ownerUserId: user?.id || null,
        clientId: req.body.client_id || req.body.clientId,
      });
      const result = await updateAgentSettingsImpl(supabase, {
        agentId: req.body.agent_id || req.body.agentId,
        name: req.body.name,
        assistantName: req.body.assistant_name || req.body.assistantName,
        tone: req.body.tone,
        systemPrompt: req.body.system_prompt || req.body.systemPrompt,
        welcomeMessage: req.body.welcome_message || req.body.welcomeMessage,
        buttonLabel: req.body.button_label || req.body.buttonLabel,
        websiteUrl: req.body.website_url || req.body.websiteUrl,
        primaryColor: req.body.primary_color || req.body.primaryColor,
        secondaryColor: req.body.secondary_color || req.body.secondaryColor,
        allowedDomains: req.body.allowed_domains || req.body.allowedDomains,
        bookingUrl: req.body.booking_url || req.body.bookingUrl,
        quoteUrl: req.body.quote_url || req.body.quoteUrl,
        checkoutUrl: req.body.checkout_url || req.body.checkoutUrl,
        bookingStartUrl: req.body.booking_start_url || req.body.bookingStartUrl,
        quoteStartUrl: req.body.quote_start_url || req.body.quoteStartUrl,
        bookingSuccessUrl: req.body.booking_success_url || req.body.bookingSuccessUrl,
        quoteSuccessUrl: req.body.quote_success_url || req.body.quoteSuccessUrl,
        checkoutSuccessUrl: req.body.checkout_success_url || req.body.checkoutSuccessUrl,
        successUrlMatchMode: req.body.success_url_match_mode || req.body.successUrlMatchMode,
        manualOutcomeMode: req.body.manual_outcome_mode ?? req.body.manualOutcomeMode,
        contactEmail: req.body.contact_email || req.body.contactEmail,
        contactPhone: req.body.contact_phone || req.body.contactPhone,
        primaryCtaMode: req.body.primary_cta_mode || req.body.primaryCtaMode,
        fallbackCtaMode: req.body.fallback_cta_mode || req.body.fallbackCtaMode,
        businessHoursNote: req.body.business_hours_note || req.body.businessHoursNote,
      });

      res.json({ ok: true, agent: result });
    } catch (err) {
      console.error("[agents/update] Failed to update agent settings:", {
        agentId: req.body.agent_id || req.body.agentId || null,
        ownerUserId: user?.id || null,
        clientId: req.body.client_id || req.body.clientId || null,
        websiteUrl: req.body.website_url || req.body.websiteUrl || null,
        code: err?.code || null,
        statusCode: err?.statusCode || 500,
        message: err?.message || "Something went wrong",
      });
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/delete", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req).catch((error) => {
        if (error.statusCode === 401) {
          return null;
        }
        throw error;
      });
      await requireActiveAgentAccessImpl(supabase, {
        agentId: req.body.agent_id || req.body.agentId,
        ownerUserId: user?.id || null,
        clientId: req.body.client_id || req.body.clientId,
      });
      const result = await deleteAgentImpl(supabase, req.body.agent_id || req.body.agentId);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.get("/agents/action-queue", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req).catch((error) => {
        if (error.statusCode === 401) {
          return null;
        }
        throw error;
      });
      const agentId = req.query.agent_id || req.query.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user?.id || null,
        clientId: req.query.client_id || req.query.clientId,
      });
      await Promise.all([
        assertMessagesSchemaReadyImpl(supabase, { phase: "request" }),
        assertWidgetTelemetrySchemaReadyImpl(supabase),
        assertLeadCaptureSchemaReadyImpl(supabase, { phase: "request" }),
        assertConversionOutcomeSchemaReadyImpl(supabase, { phase: "request" }),
      ]);

      const [messages, statuses, agentListResult] = await Promise.all([
        listAgentMessagesImpl(supabase, agentId),
        listActionQueueStatusesImpl(supabase, {
          agentId,
          ownerUserId: user?.id || null,
        }),
        listAgentsImpl(supabase, {
          ownerUserId: user?.id || null,
          includeBridgeAgent: false,
        }),
      ]);

      const persistedRecords = Array.isArray(statuses) ? statuses : statuses?.records || [];
      const persistenceAvailable = Array.isArray(statuses)
        ? true
        : statuses?.persistenceAvailable !== false;
      const agentProfile = (agentListResult?.agents || []).find((candidate) => candidate.id === agentId) || null;
      const preliminaryQueue = buildActionQueueImpl(messages, persistedRecords, {
        persistenceAvailable,
      });
      const websiteContent = agentProfile?.businessId
        ? await getStoredWebsiteContentImpl(supabase, agentProfile.businessId)
        : null;
      const [followUpSync, knowledgeFixSync] = await Promise.all([
        syncFollowUpWorkflowsImpl(supabase, {
          agentId,
          ownerUserId: user?.id || null,
          queueItems: preliminaryQueue.items || [],
          agentProfile: {
            agentId,
            ownerUserId: user?.id || null,
            businessName: agentProfile?.name || "",
            assistantName: agentProfile?.assistantName || agentProfile?.name || "",
          },
        }),
        syncKnowledgeFixWorkflowsImpl(supabase, {
          agentId,
          ownerUserId: user?.id || null,
          queueItems: preliminaryQueue.items || [],
          agentProfile: {
            agentId,
            ownerUserId: user?.id || null,
            systemPrompt: agentProfile?.systemPrompt || "",
            websiteUrl: agentProfile?.websiteUrl || "",
            knowledge: agentProfile?.knowledge || {},
          },
          websiteContent,
        }),
      ]);
      const latestStatuses = followUpSync?.persistenceAvailable === false && knowledgeFixSync?.persistenceAvailable === false
        ? statuses
        : await listActionQueueStatusesImpl(supabase, {
          agentId,
          ownerUserId: user?.id || null,
        });
      const finalPersistedRecords = Array.isArray(latestStatuses) ? latestStatuses : latestStatuses?.records || [];
      const finalPersistenceAvailable = Array.isArray(latestStatuses)
        ? true
        : latestStatuses?.persistenceAvailable !== false;

      const baseQueue = buildActionQueueImpl(messages, finalPersistedRecords, {
        persistenceAvailable: finalPersistenceAvailable,
        followUps: followUpSync?.records || [],
        knowledgeFixes: knowledgeFixSync?.records || [],
        followUpWorkflowAvailable: followUpSync?.persistenceAvailable !== false,
        knowledgeFixWorkflowAvailable: knowledgeFixSync?.persistenceAvailable !== false,
      });
      const [leadCaptures, conversionOutcomes] = await Promise.all([
        listLeadCapturesImpl(supabase, {
          agentId,
          ownerUserId: user?.id || null,
        }),
        listConversionOutcomesForAgentImpl(supabase, {
          agentId,
          ownerUserId: user?.id || null,
        }),
      ]);
      const routingEvents = await listWidgetRoutingEventsByAgentIdImpl(supabase, {
        agentId,
      });
      const hydratedQueue = hydrateActionQueueWithLeadCaptures(baseQueue, {
        records: leadCaptures.records || [],
        followUps: followUpSync?.records || [],
        widgetEvents: routingEvents,
        outcomes: conversionOutcomes,
        persistenceAvailable: leadCaptures.persistenceAvailable !== false,
      });

      res.json({
        ...hydratedQueue,
        analyticsSummary: buildAnalyticsSummary({
          messages,
          actionQueue: hydratedQueue,
          widgetMetrics: agentProfile?.widgetMetrics || {},
          installStatus: agentProfile?.installStatus || {},
        }),
      });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.get("/agents/install-status", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req).catch((error) => {
        if (error.statusCode === 401) {
          return null;
        }
        throw error;
      });
      const agentId = req.query.agent_id || req.query.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user?.id || null,
        clientId: req.query.client_id || req.query.clientId,
      });

      const agent = await getAgentWorkspaceSnapshotImpl(supabase, agentId);

      res.json({ agent });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/install/verify", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req).catch((error) => {
        if (error.statusCode === 401) {
          return null;
        }
        throw error;
      });
      const agentId = req.body.agent_id || req.body.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user?.id || null,
        clientId: req.body.client_id || req.body.clientId,
      });

      const verification = await verifyAgentInstallation(supabase, {
        agentId,
      });
      const agent = await getAgentWorkspaceSnapshotImpl(supabase, agentId);

      res.json({
        ok: verification.ok === true,
        verification,
        agent,
      });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/action-queue/status", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req).catch((error) => {
        if (error.statusCode === 401) {
          return null;
        }
        throw error;
      });
      const agentId = req.body.agent_id || req.body.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user?.id || null,
        clientId: req.body.client_id || req.body.clientId,
      });

      const result = await updateActionQueueStatusImpl(supabase, {
        agentId,
        ownerUserId: user?.id || null,
        actionKey: req.body.action_key || req.body.actionKey,
        status: req.body.status,
        note: req.body.note,
        outcome: req.body.outcome,
        nextStep: req.body.next_step || req.body.nextStep,
        followUpNeeded: req.body.follow_up_needed ?? req.body.followUpNeeded,
        followUpCompleted: req.body.follow_up_completed ?? req.body.followUpCompleted,
        contactStatus: req.body.contact_status || req.body.contactStatus,
      });

      const item = result?.item || result;
      const persistenceAvailable = result?.persistenceAvailable !== false;

      res.json({
        ok: true,
        item,
        persistenceAvailable,
        migrationRequired: !persistenceAvailable,
      });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/operator/inbox/draft-reply", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req);
      const agentId = req.body.agent_id || req.body.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user.id,
        clientId: req.body.client_id || req.body.clientId,
      });

      const agent = await getAgentWorkspaceSnapshotImpl(supabase, agentId);
      const result = await draftInboxReplyImpl(supabase, {
        agent,
        ownerUserId: user.id,
        threadId: req.body.thread_id || req.body.threadId,
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/operator/inbox/send-reply", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req);
      const agentId = req.body.agent_id || req.body.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user.id,
        clientId: req.body.client_id || req.body.clientId,
      });

      const agent = await getAgentWorkspaceSnapshotImpl(supabase, agentId);
      const result = await sendInboxReplyImpl(supabase, {
        agent,
        ownerUserId: user.id,
        threadId: req.body.thread_id || req.body.threadId,
        subject: req.body.subject,
        body: req.body.body,
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/operator/calendar/draft", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req);
      const agentId = req.body.agent_id || req.body.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user.id,
        clientId: req.body.client_id || req.body.clientId,
      });

      const agent = await getAgentWorkspaceSnapshotImpl(supabase, agentId);
      const result = await draftCalendarActionImpl(supabase, {
        agent,
        ownerUserId: user.id,
        eventId: req.body.event_id || req.body.eventId,
        actionType: req.body.action_type || req.body.actionType,
        title: req.body.title,
        description: req.body.description,
        startAt: req.body.start_at || req.body.startAt,
        endAt: req.body.end_at || req.body.endAt,
        timezone: req.body.timezone,
        location: req.body.location,
        attendeeEmails: req.body.attendee_emails || req.body.attendeeEmails,
        leadId: req.body.lead_id || req.body.leadId,
        relatedActionKey: req.body.related_action_key || req.body.relatedActionKey,
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/operator/calendar/approve", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req);
      const agentId = req.body.agent_id || req.body.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user.id,
        clientId: req.body.client_id || req.body.clientId,
      });

      const agent = await getAgentWorkspaceSnapshotImpl(supabase, agentId);
      const result = await approveCalendarActionImpl(supabase, {
        agent,
        ownerUserId: user.id,
        eventId: req.body.event_id || req.body.eventId,
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/operator/campaigns/draft", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req);
      const agentId = req.body.agent_id || req.body.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user.id,
        clientId: req.body.client_id || req.body.clientId,
      });

      const agent = await getAgentWorkspaceSnapshotImpl(supabase, agentId);
      const campaign = await createCampaignDraftImpl(supabase, {
        agent,
        ownerUserId: user.id,
        goal: req.body.goal,
        recipientSource: req.body.recipient_source || req.body.recipientSource,
        sendWindowHour: req.body.send_window_hour || req.body.sendWindowHour,
      });

      res.json({ campaign });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/operator/campaigns/approve", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req);
      const agentId = req.body.agent_id || req.body.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user.id,
        clientId: req.body.client_id || req.body.clientId,
      });

      const agent = await getAgentWorkspaceSnapshotImpl(supabase, agentId);
      const campaign = await approveCampaignDraftImpl(supabase, {
        agent,
        ownerUserId: user.id,
        campaignId: req.body.campaign_id || req.body.campaignId,
        sendWindowHour: req.body.send_window_hour || req.body.sendWindowHour,
      });

      res.json({ campaign });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/operator/campaigns/send-due", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req);
      const agentId = req.body.agent_id || req.body.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user.id,
        clientId: req.body.client_id || req.body.clientId,
      });

      const agent = await getAgentWorkspaceSnapshotImpl(supabase, agentId);
      const result = await sendDueCampaignStepsImpl(supabase, {
        agent,
        ownerUserId: user.id,
        campaignId: req.body.campaign_id || req.body.campaignId,
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/operator/tasks/update", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req);
      const agentId = req.body.agent_id || req.body.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user.id,
        clientId: req.body.client_id || req.body.clientId,
      });

      const task = await updateOperatorTaskStatusImpl(supabase, {
        agentId,
        ownerUserId: user.id,
        taskId: req.body.task_id || req.body.taskId,
        status: req.body.status,
        taskState: req.body.task_state || req.body.taskState,
      });

      res.json({ task });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/operator/activation", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req);
      const agentId = req.body.agent_id || req.body.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user.id,
        clientId: req.body.client_id || req.body.clientId,
      });

      const agent = await getAgentWorkspaceSnapshotImpl(supabase, agentId);
      const activation = await updateOperatorOnboardingStateImpl(supabase, {
        agent,
        ownerUserId: user.id,
        selectedMailbox: req.body.selected_mailbox || req.body.selectedMailbox,
        calendarContext: req.body.calendar_context || req.body.calendarContext,
        markInboxReviewed: req.body.mark_inbox_reviewed === true || req.body.markInboxReviewed === true,
        markCalendarReviewed: req.body.mark_calendar_reviewed === true || req.body.markCalendarReviewed === true,
      });

      res.json({ activation });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/follow-ups/update", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req).catch((error) => {
        if (error.statusCode === 401) {
          return null;
        }
        throw error;
      });
      const agentId = req.body.agent_id || req.body.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user?.id || null,
        clientId: req.body.client_id || req.body.clientId,
      });

      const result = await updateFollowUpWorkflowImpl(supabase, {
        agentId,
        ownerUserId: user?.id || null,
        followUpId: req.body.follow_up_id || req.body.followUpId,
        status: req.body.status,
        subject: req.body.subject,
        draftContent: req.body.draft_content ?? req.body.draftContent,
        errorMessage: req.body.error_message ?? req.body.errorMessage,
        reopen: req.body.reopen === true || req.body.reopen === "true",
      });

      if (result?.followUp?.status === "sent") {
        await trackFollowUpOutcomeImpl(supabase, {
          agentId,
          ownerUserId: user?.id || null,
          followUpId: result.followUp.id,
          actionKey: result.followUp.sourceActionKey,
          leadId: req.body.lead_id || req.body.leadId,
          outcomeType: "follow_up_sent",
        });
      }

      res.json({
        ok: true,
        followUp: result?.followUp || null,
        queueSync: result?.queueSync || null,
        persistenceAvailable: result?.persistenceAvailable !== false,
        message: result?.followUp?.status === "sent"
          ? "Follow-up marked sent."
          : result?.followUp?.status === "dismissed"
            ? "Follow-up dismissed."
            : result?.followUp?.status === "ready"
              ? "Follow-up marked ready."
              : result?.followUp?.status === "failed"
                ? "Follow-up marked failed."
                : "Follow-up saved.",
      });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/conversion-outcomes/manual", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req).catch((error) => {
        if (error.statusCode === 401) {
          return null;
        }
        throw error;
      });
      const agentId = req.body.agent_id || req.body.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user?.id || null,
        clientId: req.body.client_id || req.body.clientId,
      });

      const agentProfile = await getAgentWorkspaceSnapshotImpl(supabase, agentId);
      const result = await markManualConversionOutcomeImpl(supabase, {
        agentId,
        businessId: agentProfile?.businessId || req.body.business_id || req.body.businessId,
        ownerUserId: user?.id || null,
        installId: req.body.install_id || req.body.installId || agentProfile?.installId || "",
        outcomeType: req.body.outcome_type || req.body.outcomeType,
        ctaEventId: req.body.cta_event_id || req.body.ctaEventId,
        ctaType: req.body.cta_type || req.body.ctaType,
        targetType: req.body.target_type || req.body.targetType,
        relatedActionType: req.body.related_action_type || req.body.relatedActionType,
        relatedIntentType: req.body.related_intent_type || req.body.relatedIntentType,
        sessionId: req.body.session_id || req.body.sessionId,
        visitorId: req.body.visitor_id || req.body.visitorId,
        fingerprint: req.body.fingerprint,
        pageUrl: req.body.page_url || req.body.pageUrl,
        origin: req.body.origin,
        conversationId: req.body.conversation_id || req.body.conversationId,
        personKey: req.body.person_key || req.body.personKey,
        leadId: req.body.lead_id || req.body.leadId,
        actionKey: req.body.action_key || req.body.actionKey,
        followUpId: req.body.follow_up_id || req.body.followUpId,
        note: req.body.note,
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/knowledge-fixes/update", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req).catch((error) => {
        if (error.statusCode === 401) {
          return null;
        }
        throw error;
      });
      const agentId = req.body.agent_id || req.body.agentId;

      await requireActiveAgentAccessImpl(supabase, {
        agentId,
        ownerUserId: user?.id || null,
        clientId: req.body.client_id || req.body.clientId,
      });

      const agentListResult = await listAgentsImpl(supabase, {
        ownerUserId: user?.id || null,
        includeBridgeAgent: false,
      });
      const agentProfile = (agentListResult?.agents || []).find((candidate) => candidate.id === agentId) || null;
      const result = await updateKnowledgeFixWorkflowImpl(supabase, {
        agentId,
        ownerUserId: user?.id || null,
        knowledgeFixId: req.body.knowledge_fix_id || req.body.knowledgeFixId,
        status: req.body.status,
        issueSummary: req.body.issue_summary ?? req.body.issueSummary,
        mattersSummary: req.body.matters_summary ?? req.body.mattersSummary,
        proposedGuidance: req.body.proposed_guidance ?? req.body.proposedGuidance,
        errorMessage: req.body.error_message ?? req.body.errorMessage,
        agentProfile: {
          agentId,
          systemPrompt: agentProfile?.systemPrompt || "",
        },
      });

      res.json({
        ok: true,
        knowledgeFix: result?.knowledgeFix || null,
        queueSync: result?.queueSync || null,
        updatedAgent: result?.updatedAgent || null,
        persistenceAvailable: result?.persistenceAvailable !== false,
        message: result?.knowledgeFix?.status === "applied"
          ? "Knowledge fix applied to advanced guidance."
          : result?.knowledgeFix?.status === "dismissed"
            ? "Knowledge fix dismissed."
            : result?.knowledgeFix?.status === "ready"
              ? "Knowledge fix marked ready."
              : result?.knowledgeFix?.status === "failed"
                ? "Knowledge fix marked failed."
                : "Knowledge fix saved.",
      });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/knowledge/import", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req).catch((error) => {
        if (error.statusCode === 401) {
          return null;
        }
        throw error;
      });
      const context = await resolveAgentContextImpl(supabase, {
        agentKey: req.body.agent_key || req.body.agentKey,
        businessId: req.body.business_id || req.body.businessId,
      });
      if (user) {
        await requireActiveAgentAccessImpl(supabase, {
          agentId: context.agent.id,
          ownerUserId: user.id,
          clientId: req.body.client_id || req.body.clientId,
        });
      } else {
        await requireAgentAccessImpl(supabase, {
          agentId: context.agent.id,
          clientId: req.body.client_id || req.body.clientId,
        });
      }

      const result = await extractBusinessWebsiteContentImpl(supabase, {
        businessId: context.business.id,
        websiteUrl: context.business.website_url,
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/product-events", async (req, res) => {
    try {
      const result = await trackProductEvent(getSupabase(), {
        clientId: req.body.client_id || req.body.clientId,
        agentId: req.body.agent_id || req.body.agentId,
        eventName: req.body.event_name || req.body.eventName,
        source: req.body.source,
        metadata: req.body.metadata,
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/create-checkout-session", async (req, res) => {
    try {
      const supabase = getSupabase();
      const user = await authenticateUser(supabase, req);
      const action = req.body.action || "create";

      if (action === "simulate") {
        if (!isLocalDevBillingRequestAllowed(req)) {
          res.status(404).json({
            error: "Not found",
          });
          return;
        }

        await updateOwnedAccessStatusImpl(supabase, {
          ownerUserId: user.id,
          accessStatus: "active",
        });

        res.json({
          ok: true,
          simulated: true,
          access_status: "active",
        });
        return;
      }

      if (action === "confirm") {
        const session = await verifySuccessfulCheckout({
          sessionId: req.body.session_id || req.body.sessionId,
          ownerUserId: user.id,
        });

        res.json({
          ok: true,
          payment_status: session.payment_status,
          session_id: session.id,
        });
        return;
      }

      const existing = await listAgentsImpl(supabase, {
        ownerUserId: user.id,
        includeBridgeAgent: false,
      });

      if (!existing.agents?.length) {
        const draft = await createAgentForBusinessNameImpl(
          supabase,
          getCheckoutDraftBusinessName(user),
          "",
          "",
          user.id
        );

        await updateAgentSettingsImpl(supabase, {
          agentId: draft.agent.id,
          assistantName: "Your assistant",
        });
      }

      const session = await createHostedCheckoutSessionImpl({
        user,
        email: req.body.email,
      });

      res.json({
        ok: true,
        url: session.url,
        session_id: session.id,
      });
    } catch (err) {
      if (isStripeConfigError(err) || isStripeCheckoutMinimumAmountError(err)) {
        console.warn("[stripe checkout] Stripe configuration error:", err.message);
      } else {
        console.error(err);
      }

      const configurationErrorMessage = getStripeCheckoutConfigurationErrorMessage(err);

      res.status(err.statusCode || 500).json({
        error: isStripeConfigError(err)
          ? "Stripe checkout is not configured yet. Please check the Stripe environment settings."
          : configurationErrorMessage || err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/claim", async (req, res) => {
    try {
      const supabase = getSupabaseClient();
      const user = await getAuthenticatedUser(supabase, req);
      const agent = await claimAgentForOwner(supabase, {
        agentId: req.body.agent_id || req.body.agentId,
        clientId: req.body.client_id || req.body.clientId,
        ownerUserId: user.id,
      });

      res.json({
        ok: true,
        agent,
      });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  router.post("/agents/access-status", async (req, res) => {
    try {
      ensureAdminAccess(req);
      const agent = await updateAgentAccessStatus(getSupabaseClient(), {
        agentId: req.body.agent_id || req.body.agentId,
        accessStatus: req.body.access_status || req.body.accessStatus,
      });

      res.json({
        ok: true,
        agent,
      });
    } catch (err) {
      console.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || "Something went wrong",
      });
    }
  });

  return router;
}
