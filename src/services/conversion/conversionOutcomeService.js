import { randomUUID } from "node:crypto";

import {
  ACTION_QUEUE_STATUS_TABLE,
  CONVERSION_OUTCOME_TABLE,
  FOLLOW_UP_WORKFLOW_TABLE,
  LEAD_CAPTURE_TABLE,
  OPERATOR_CALENDAR_EVENT_TABLE,
  OPERATOR_CAMPAIGN_RECIPIENT_TABLE,
  OPERATOR_CAMPAIGN_TABLE,
  OPERATOR_CONTACT_TABLE,
  OPERATOR_INBOX_THREAD_TABLE,
  OPERATOR_TASK_TABLE,
} from "../../config/constants.js";
import { cleanText } from "../../utils/text.js";
import { normalizeWebsiteUrl } from "../../utils/url.js";
import { getWidgetInstallContextByInstallId, isMissingRelationError as isMissingInstallRelationError } from "../install/installPresenceService.js";
import { updateActionQueueStatus } from "../analytics/actionQueueService.js";

export const CONVERSION_OUTCOME_TYPES = [
  "booking_started",
  "booking_confirmed",
  "quote_requested",
  "quote_sent",
  "quote_accepted",
  "checkout_started",
  "checkout_completed",
  "contact_clicked",
  "email_clicked",
  "phone_clicked",
  "follow_up_sent",
  "follow_up_replied",
  "complaint_opened",
  "complaint_resolved",
  "campaign_sent",
  "campaign_replied",
  "campaign_converted",
  "manual_outcome_marked",
];

export const CONVERSION_SOURCE_TYPES = [
  "direct_route",
  "follow_up_workflow",
  "manual_owner",
  "success_url_match",
  "external_success_ping",
  "workflow_sync",
  "inbox_thread",
  "calendar_event",
  "campaign",
  "operator_task",
];

export const CONVERSION_CONFIRMATION_LEVELS = [
  "clicked",
  "observed",
  "confirmed",
  "manual",
];

export const SUCCESS_URL_MATCH_MODES = ["exact", "path_prefix"];

export const OUTCOME_ATTRIBUTION_PATHS = [
  "direct_route",
  "follow_up_assisted",
  "inbox_thread",
  "calendar_booking",
  "campaign",
  "manual_owner",
];

const OUTCOME_TYPE_ALIASES = Object.freeze({
  booking_completed: "booking_confirmed",
  quote_started: "quote_requested",
  conversion_marked_manual: "manual_outcome_marked",
});

const SOURCE_TYPE_ALIASES = Object.freeze({
  direct_cta: "direct_route",
  follow_up: "follow_up_workflow",
  manual_mark: "manual_owner",
});

const ATTRIBUTION_PATH_ALIASES = Object.freeze({
  direct: "direct_route",
  follow_up: "follow_up_assisted",
  manual: "manual_owner",
});

const COMPLETED_OUTCOME_TYPES = new Set([
  "booking_started",
  "booking_confirmed",
  "quote_requested",
  "quote_sent",
  "quote_accepted",
  "checkout_started",
  "checkout_completed",
  "contact_clicked",
  "email_clicked",
  "phone_clicked",
  "follow_up_replied",
  "complaint_resolved",
  "campaign_replied",
  "campaign_converted",
  "manual_outcome_marked",
]);

const BUSINESS_SUCCESS_OUTCOME_TYPES = new Set([
  "booking_confirmed",
  "quote_requested",
  "quote_sent",
  "quote_accepted",
  "checkout_completed",
  "complaint_resolved",
  "campaign_converted",
]);

const CLICK_OUTCOME_TYPES = new Set([
  "booking_started",
  "quote_requested",
  "checkout_started",
  "contact_clicked",
  "email_clicked",
  "phone_clicked",
]);

const URL_BASED_CTA_TYPES = new Set(["booking", "quote", "checkout"]);

const LEAD_SELECT = [
  "id",
  "agent_id",
  "owner_user_id",
  "lead_key",
  "person_key",
  "visitor_session_key",
  "latest_action_type",
  "latest_action_key",
  "related_action_keys",
  "related_follow_up_id",
  "contact_id",
  "contact_email",
  "contact_phone",
].join(", ");

const OUTCOME_SELECT = [
  "id",
  "agent_id",
  "business_id",
  "owner_user_id",
  "install_id",
  "outcome_type",
  "source_type",
  "confirmation_level",
  "dedupe_key",
  "cta_event_id",
  "related_cta_type",
  "related_target_type",
  "related_action_type",
  "related_intent_type",
  "visitor_id",
  "session_id",
  "fingerprint",
  "conversation_id",
  "person_key",
  "lead_id",
  "contact_id",
  "action_key",
  "follow_up_id",
  "inbox_thread_id",
  "calendar_event_id",
  "campaign_id",
  "campaign_recipient_id",
  "operator_task_id",
  "page_url",
  "origin",
  "target_url",
  "success_url",
  "attribution_path",
  "metadata",
  "occurred_at",
  "created_at",
  "updated_at",
].join(", ");

function isMissingRelationError(error, relationName) {
  const message = cleanText(error?.message || "").toLowerCase();
  return (
    error?.code === "PGRST205" ||
    error?.code === "PGRST204" ||
    error?.code === "42703" ||
    error?.code === "42P01" ||
    message.includes(`'public.${relationName}'`) ||
    message.includes(`${relationName} was not found`) ||
    (message.includes("column") && message.includes("does not exist"))
  );
}

function buildMissingConversionOutcomeSchemaError(phase = "request") {
  const error = new Error(
    `[${phase}] Missing required conversion outcome schema for '${CONVERSION_OUTCOME_TABLE}'. Apply the latest database migration before running this build.`
  );
  error.statusCode = 500;
  error.code = "schema_not_ready";
  return error;
}

export async function assertConversionOutcomeSchemaReady(supabase, options = {}) {
  const { error } = await supabase
    .from(CONVERSION_OUTCOME_TABLE)
    .select("id, agent_id, owner_user_id, install_id, outcome_type, session_id, occurred_at")
    .limit(1);

  if (error) {
    if (isMissingRelationError(error, CONVERSION_OUTCOME_TABLE)) {
      throw buildMissingConversionOutcomeSchemaError(options.phase || "startup");
    }

    throw error;
  }
}

function normalizeOptionalUrl(value) {
  const normalized = cleanText(value);

  if (!normalized) {
    return "";
  }

  return normalizeWebsiteUrl(normalized, {
    requireHttps: true,
    requirePublicHostname: true,
  }) || "";
}

function normalizePageUrl(value) {
  const normalized = cleanText(value);

  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizeOrigin(value) {
  const pageUrl = normalizePageUrl(value);
  return pageUrl ? new URL(pageUrl).origin.toLowerCase() : "";
}

function normalizeTargetUrl(value) {
  const normalized = cleanText(value);

  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("mailto:") || normalized.startsWith("tel:")) {
    return normalized;
  }

  return normalizePageUrl(normalized);
}

function normalizeOutcomeType(value) {
  const normalized = cleanText(value).toLowerCase();
  const canonical = OUTCOME_TYPE_ALIASES[normalized] || normalized;
  return CONVERSION_OUTCOME_TYPES.includes(canonical) ? canonical : "";
}

function normalizeSourceType(value) {
  const normalized = cleanText(value).toLowerCase();
  const canonical = SOURCE_TYPE_ALIASES[normalized] || normalized;
  return CONVERSION_SOURCE_TYPES.includes(canonical) ? canonical : "";
}

function normalizeSourceTypeWithFallback(value, fallbackValue = "workflow_sync") {
  return normalizeSourceType(value) || fallbackValue;
}

function normalizeAttributionPath(value, fallbackValue = "direct_route") {
  const normalized = cleanText(value).toLowerCase();
  const canonical = ATTRIBUTION_PATH_ALIASES[normalized] || normalized;
  return OUTCOME_ATTRIBUTION_PATHS.includes(canonical) ? canonical : fallbackValue;
}

function normalizeConfirmationLevel(value, fallbackValue = "observed") {
  const normalized = cleanText(value).toLowerCase();
  return CONVERSION_CONFIRMATION_LEVELS.includes(normalized) ? normalized : fallbackValue;
}

function getConfirmationLevelRank(value) {
  switch (normalizeConfirmationLevel(value, "clicked")) {
    case "manual":
      return 4;
    case "confirmed":
      return 3;
    case "observed":
      return 2;
    case "clicked":
    default:
      return 1;
  }
}

function pickStrongerConfirmationLevel(currentValue, nextValue) {
  const currentLevel = normalizeConfirmationLevel(currentValue, "clicked");
  const nextLevel = normalizeConfirmationLevel(nextValue, "observed");
  return getConfirmationLevelRank(nextLevel) >= getConfirmationLevelRank(currentLevel)
    ? nextLevel
    : currentLevel;
}

export function normalizeSuccessUrlMatchMode(value, fallbackValue = "path_prefix") {
  const normalized = cleanText(value).toLowerCase();
  return SUCCESS_URL_MATCH_MODES.includes(normalized) ? normalized : fallbackValue;
}

function normalizeBooleanFlag(value, fallbackValue = false) {
  if (value === true || value === false) {
    return value;
  }

  const normalized = cleanText(value).toLowerCase();

  if (["1", "true", "yes"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }

  return fallbackValue;
}

export function normalizeOutcomeSettings(widgetConfig = {}) {
  return {
    bookingStartUrl: normalizeOptionalUrl(widgetConfig.bookingStartUrl || widgetConfig.booking_start_url),
    quoteStartUrl: normalizeOptionalUrl(widgetConfig.quoteStartUrl || widgetConfig.quote_start_url),
    bookingSuccessUrl: normalizeOptionalUrl(widgetConfig.bookingSuccessUrl || widgetConfig.booking_success_url),
    quoteSuccessUrl: normalizeOptionalUrl(widgetConfig.quoteSuccessUrl || widgetConfig.quote_success_url),
    checkoutSuccessUrl: normalizeOptionalUrl(widgetConfig.checkoutSuccessUrl || widgetConfig.checkout_success_url),
    successUrlMatchMode: normalizeSuccessUrlMatchMode(
      widgetConfig.successUrlMatchMode || widgetConfig.success_url_match_mode,
      "path_prefix"
    ),
    manualOutcomeMode: normalizeBooleanFlag(
      widgetConfig.manualOutcomeMode ?? widgetConfig.manual_outcome_mode,
      false
    ),
  };
}

function getTimestamp(value) {
  const timestamp = new Date(value || "").getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function cleanUuid(value) {
  const normalized = cleanText(value);
  return /^[0-9a-f-]{8,}$/i.test(normalized) ? normalized : "";
}

function uniqueText(values = []) {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function normalizeMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function getDefaultAttributionPath(options = {}) {
  if (cleanUuid(options.campaignRecipientId) || cleanUuid(options.campaignId)) {
    return "campaign";
  }

  if (cleanUuid(options.calendarEventId)) {
    return "calendar_booking";
  }

  if (cleanUuid(options.inboxThreadId)) {
    return "inbox_thread";
  }

  if (cleanUuid(options.followUpId)) {
    return "follow_up_assisted";
  }

  if (normalizeSourceType(options.sourceType) === "manual_owner") {
    return "manual_owner";
  }

  return "direct_route";
}

function getOutcomeSourceLabel(attributionPath = "") {
  switch (normalizeAttributionPath(attributionPath)) {
    case "follow_up_assisted":
      return "Follow-up";
    case "inbox_thread":
      return "Inbox";
    case "calendar_booking":
      return "Calendar";
    case "campaign":
      return "Campaign";
    case "manual_owner":
      return "Manual owner mark";
    default:
      return "Direct route";
  }
}

function mapContactClickOutcome(targetType = "") {
  switch (cleanText(targetType).toLowerCase()) {
    case "email":
      return "email_clicked";
    case "phone":
      return "phone_clicked";
    default:
      return "contact_clicked";
  }
}

function mapCtaClickToOutcomeType(ctaType = "", targetType = "") {
  switch (cleanText(ctaType).toLowerCase()) {
    case "booking":
      return "booking_started";
    case "quote":
      return "quote_requested";
    case "checkout":
      return "checkout_started";
    case "contact":
      return mapContactClickOutcome(targetType);
    default:
      return "";
  }
}

function mapStartedOutcomeToCompletedType(outcomeType = "") {
  switch (normalizeOutcomeType(outcomeType)) {
    case "booking_started":
      return "booking_confirmed";
    case "checkout_started":
      return "checkout_completed";
    default:
      return "";
  }
}

function mapOutcomeTypeToLabel(outcomeType = "") {
  switch (normalizeOutcomeType(outcomeType)) {
    case "booking_started":
      return "Booking started";
    case "booking_confirmed":
      return "Booking confirmed";
    case "quote_requested":
      return "Quote requested";
    case "quote_sent":
      return "Quote sent";
    case "quote_accepted":
      return "Quote accepted";
    case "checkout_started":
      return "Checkout started";
    case "checkout_completed":
      return "Checkout completed";
    case "contact_clicked":
      return "Contact clicked";
    case "email_clicked":
      return "Email clicked";
    case "phone_clicked":
      return "Phone clicked";
    case "follow_up_sent":
      return "Follow-up sent";
    case "follow_up_replied":
      return "Follow-up replied";
    case "complaint_opened":
      return "Complaint opened";
    case "complaint_resolved":
      return "Complaint resolved";
    case "campaign_sent":
      return "Campaign sent";
    case "campaign_replied":
      return "Campaign replied";
    case "campaign_converted":
      return "Campaign converted";
    case "manual_outcome_marked":
      return "Manual outcome";
    default:
      return "Outcome";
  }
}

function matchConfiguredUrl(candidateUrl, configuredUrl, mode) {
  const normalizedCandidate = normalizePageUrl(candidateUrl);
  const normalizedConfigured = normalizePageUrl(configuredUrl);

  if (!normalizedCandidate || !normalizedConfigured) {
    return false;
  }

  if (normalizeSuccessUrlMatchMode(mode) === "exact") {
    return normalizedCandidate === normalizedConfigured;
  }

  const candidate = new URL(normalizedCandidate);
  const configured = new URL(normalizedConfigured);

  if (candidate.origin !== configured.origin) {
    return false;
  }

  const candidatePath = candidate.pathname.replace(/\/+$/, "") || "/";
  const configuredPath = configured.pathname.replace(/\/+$/, "") || "/";

  if (!candidatePath.startsWith(configuredPath)) {
    return false;
  }

  if (configured.search) {
    return candidate.search === configured.search;
  }

  return true;
}

function getMatchedConfiguredOutcomes(settings, pageUrl, options = {}) {
  const outcomes = [];
  const mode = settings.successUrlMatchMode;
  const includeStartMatches = options.includeStartMatches === true;

  if (matchConfiguredUrl(pageUrl, settings.bookingSuccessUrl, mode)) {
    outcomes.push({ outcomeType: "booking_confirmed", successUrl: settings.bookingSuccessUrl });
  }

  if (matchConfiguredUrl(pageUrl, settings.quoteSuccessUrl, mode)) {
    outcomes.push({ outcomeType: "quote_requested", successUrl: settings.quoteSuccessUrl });
  }

  if (matchConfiguredUrl(pageUrl, settings.checkoutSuccessUrl, mode)) {
    outcomes.push({ outcomeType: "checkout_completed", successUrl: settings.checkoutSuccessUrl });
  }

  if (includeStartMatches && matchConfiguredUrl(pageUrl, settings.bookingStartUrl, mode)) {
    outcomes.push({ outcomeType: "booking_started", successUrl: settings.bookingStartUrl });
  }

  if (includeStartMatches && matchConfiguredUrl(pageUrl, settings.quoteStartUrl, mode)) {
    outcomes.push({ outcomeType: "quote_requested", successUrl: settings.quoteStartUrl });
  }

  return outcomes;
}

function parseCtaEventIdFromPageUrl(pageUrl) {
  const normalized = normalizePageUrl(pageUrl);

  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    return cleanUuid(parsed.searchParams.get("vz_cta_event_id"));
  } catch {
    return "";
  }
}

function appendTrackingParams(targetUrl, ctaEventId) {
  const normalizedTarget = normalizeTargetUrl(targetUrl);
  const normalizedCtaEventId = cleanUuid(ctaEventId);

  if (!normalizedTarget || !normalizedCtaEventId) {
    return normalizedTarget;
  }

  if (normalizedTarget.startsWith("mailto:") || normalizedTarget.startsWith("tel:")) {
    return normalizedTarget;
  }

  const parsed = new URL(normalizedTarget);
  parsed.searchParams.set("vz_cta_event_id", normalizedCtaEventId);
  parsed.searchParams.set("vz_source", "vonza");
  return parsed.toString();
}

function normalizeLeadRecord(row = {}) {
  return {
    id: cleanUuid(row.id),
    agentId: cleanText(row.agent_id || row.agentId),
    ownerUserId: cleanText(row.owner_user_id || row.ownerUserId),
    leadKey: cleanText(row.lead_key || row.leadKey),
    personKey: cleanText(row.person_key || row.personKey),
    visitorSessionKey: cleanText(row.visitor_session_key || row.visitorSessionKey),
    latestActionType: cleanText(row.latest_action_type || row.latestActionType),
    latestActionKey: cleanText(row.latest_action_key || row.latestActionKey),
    relatedActionKeys: uniqueText(row.related_action_keys || row.relatedActionKeys || []),
    relatedFollowUpId: cleanUuid(row.related_follow_up_id || row.relatedFollowUpId),
    contactId: cleanUuid(row.contact_id || row.contactId),
    contactEmail: cleanText(row.contact_email || row.contactEmail).toLowerCase(),
    contactPhone: cleanText(row.contact_phone || row.contactPhone),
  };
}

function normalizeOutcomeRecord(row = {}) {
  const metadata = normalizeMetadata(row.metadata);
  const outcomeType = normalizeOutcomeType(row.outcome_type || row.outcomeType);
  const sourceType = normalizeSourceType(row.source_type || row.sourceType);
  const inferredPath = normalizeAttributionPath(
    row.attribution_path
      || row.attributionPath
      || metadata.attributionPath,
    getDefaultAttributionPath({
      sourceType,
      followUpId: row.follow_up_id || row.followUpId,
      inboxThreadId: row.inbox_thread_id || row.inboxThreadId,
      calendarEventId: row.calendar_event_id || row.calendarEventId,
      campaignId: row.campaign_id || row.campaignId,
      campaignRecipientId: row.campaign_recipient_id || row.campaignRecipientId,
    })
  );

  return {
    id: cleanText(row.id),
    agentId: cleanText(row.agent_id || row.agentId),
    businessId: cleanText(row.business_id || row.businessId),
    ownerUserId: cleanText(row.owner_user_id || row.ownerUserId),
    installId: cleanText(row.install_id || row.installId),
    outcomeType,
    sourceType,
    confirmationLevel: normalizeConfirmationLevel(row.confirmation_level || row.confirmationLevel),
    dedupeKey: cleanText(row.dedupe_key || row.dedupeKey),
    ctaEventId: cleanUuid(row.cta_event_id || row.ctaEventId),
    relatedCtaType: cleanText(row.related_cta_type || row.relatedCtaType),
    relatedTargetType: cleanText(row.related_target_type || row.relatedTargetType),
    relatedActionType: cleanText(row.related_action_type || row.relatedActionType),
    relatedIntentType: cleanText(row.related_intent_type || row.relatedIntentType),
    visitorId: cleanText(row.visitor_id || row.visitorId),
    sessionId: cleanText(row.session_id || row.sessionId),
    fingerprint: cleanText(row.fingerprint),
    conversationId: cleanText(row.conversation_id || row.conversationId),
    personKey: cleanText(row.person_key || row.personKey),
    leadId: cleanUuid(row.lead_id || row.leadId),
    contactId: cleanUuid(row.contact_id || row.contactId),
    actionKey: cleanText(row.action_key || row.actionKey),
    followUpId: cleanUuid(row.follow_up_id || row.followUpId),
    inboxThreadId: cleanUuid(row.inbox_thread_id || row.inboxThreadId),
    calendarEventId: cleanUuid(row.calendar_event_id || row.calendarEventId),
    campaignId: cleanUuid(row.campaign_id || row.campaignId),
    campaignRecipientId: cleanUuid(row.campaign_recipient_id || row.campaignRecipientId),
    operatorTaskId: cleanUuid(row.operator_task_id || row.operatorTaskId),
    pageUrl: cleanText(row.page_url || row.pageUrl),
    origin: cleanText(row.origin),
    targetUrl: cleanText(row.target_url || row.targetUrl),
    successUrl: cleanText(row.success_url || row.successUrl),
    metadata,
    attributionPath: inferredPath,
    occurredAt: row.occurred_at || row.occurredAt || row.created_at || row.createdAt || null,
    createdAt: row.created_at || row.createdAt || null,
    updatedAt: row.updated_at || row.updatedAt || null,
    label: mapOutcomeTypeToLabel(outcomeType),
    sourceLabel: getOutcomeSourceLabel(inferredPath),
  };
}

async function getLeadRecordById(supabase, options = {}) {
  const leadId = cleanUuid(options.leadId);
  const agentId = cleanText(options.agentId);

  if (!leadId || !agentId) {
    return null;
  }

  const { data, error } = await supabase
    .from(LEAD_CAPTURE_TABLE)
    .select(LEAD_SELECT)
    .eq("id", leadId)
    .eq("agent_id", agentId)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error, LEAD_CAPTURE_TABLE)) {
      return null;
    }

    throw error;
  }

  return data ? normalizeLeadRecord(data) : null;
}

async function findLikelyLeadRecord(supabase, options = {}) {
  const directLead = await getLeadRecordById(supabase, options);

  if (directLead) {
    return directLead;
  }

  const agentId = cleanText(options.agentId);
  const ownerUserId = cleanText(options.ownerUserId);
  const personKey = cleanText(options.personKey);
  const sessionId = cleanText(options.sessionId);

  if (!agentId || !ownerUserId || (!personKey && !sessionId)) {
    return null;
  }

  let query = supabase
    .from(LEAD_CAPTURE_TABLE)
    .select(LEAD_SELECT)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .order("updated_at", { ascending: false })
    .limit(12);

  if (personKey) {
    query = query.eq("person_key", personKey);
  } else {
    query = query.eq("visitor_session_key", sessionId);
  }

  const { data, error } = await query;

  if (error) {
    if (isMissingRelationError(error, LEAD_CAPTURE_TABLE)) {
      return null;
    }

    throw error;
  }

  return data?.[0] ? normalizeLeadRecord(data[0]) : null;
}

async function insertOutcomeRecord(supabase, payload) {
  const { data, error } = await supabase
    .from(CONVERSION_OUTCOME_TABLE)
    .insert(payload)
    .select(OUTCOME_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return normalizeOutcomeRecord(data || payload);
}

async function updateOutcomeRecord(supabase, recordId, payload) {
  const { data, error } = await supabase
    .from(CONVERSION_OUTCOME_TABLE)
    .update({
      ...payload,
      updated_at: new Date().toISOString(),
    })
    .eq("id", recordId)
    .select(OUTCOME_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return normalizeOutcomeRecord(data || payload);
}

async function upsertOutcomeRecord(supabase, payload) {
  try {
    return await insertOutcomeRecord(supabase, payload);
  } catch (error) {
    if (error?.code === "23505") {
      const { data, error: fetchError } = await supabase
        .from(CONVERSION_OUTCOME_TABLE)
        .select(OUTCOME_SELECT)
        .eq("dedupe_key", payload.dedupe_key)
        .maybeSingle();

      if (fetchError) {
        throw fetchError;
      }

      return data ? normalizeOutcomeRecord(data) : normalizeOutcomeRecord(payload);
    }

    if (isMissingRelationError(error, CONVERSION_OUTCOME_TABLE)) {
      return null;
    }

    throw error;
  }
}

async function getOutcomesByCtaEventId(supabase, options = {}) {
  const ctaEventId = cleanUuid(options.ctaEventId);

  if (!ctaEventId) {
    return [];
  }

  const { data, error } = await supabase
    .from(CONVERSION_OUTCOME_TABLE)
    .select(OUTCOME_SELECT)
    .eq("cta_event_id", ctaEventId)
    .order("occurred_at", { ascending: false });

  if (error) {
    if (isMissingRelationError(error, CONVERSION_OUTCOME_TABLE)) {
      return [];
    }

    throw error;
  }

  return (data || []).map((row) => normalizeOutcomeRecord(row));
}

async function getLatestSourceOutcomeForSession(supabase, options = {}) {
  const installId = cleanText(options.installId);
  const sessionId = cleanText(options.sessionId);

  if (!installId || !sessionId) {
    return null;
  }

  const { data, error } = await supabase
    .from(CONVERSION_OUTCOME_TABLE)
    .select(OUTCOME_SELECT)
    .eq("install_id", installId)
    .eq("session_id", sessionId)
    .in("outcome_type", ["booking_started", "quote_requested", "checkout_started"])
    .order("occurred_at", { ascending: false })
    .limit(8);

  if (error) {
    if (isMissingRelationError(error, CONVERSION_OUTCOME_TABLE)) {
      return null;
    }

    throw error;
  }

  return data?.[0] ? normalizeOutcomeRecord(data[0]) : null;
}

function buildAttributionPath(sourceOutcome = null, followUpId = "") {
  if (cleanUuid(followUpId) || cleanUuid(sourceOutcome?.followUpId)) {
    return "follow_up_assisted";
  }

  if (normalizeSourceType(sourceOutcome?.sourceType) === "manual_owner") {
    return "manual_owner";
  }

  return "direct_route";
}

async function syncOutcomeIntoOperationalState(supabase, outcome) {
  const normalized = normalizeOutcomeRecord(outcome);

  if (!normalized.agentId || !normalized.ownerUserId || !normalized.actionKey) {
    return null;
  }

  if (normalized.outcomeType === "booking_confirmed" || normalized.outcomeType === "checkout_completed") {
    return await updateActionQueueStatus(supabase, {
      agentId: normalized.agentId,
      ownerUserId: normalized.ownerUserId,
      actionKey: normalized.actionKey,
      status: "done",
      outcome: `${normalized.label} recorded by Vonza.`,
      nextStep: "",
      followUpNeeded: false,
      followUpCompleted: true,
    });
  }

  if (normalized.outcomeType === "quote_requested" || normalized.outcomeType === "follow_up_replied") {
    return await updateActionQueueStatus(supabase, {
      agentId: normalized.agentId,
      ownerUserId: normalized.ownerUserId,
      actionKey: normalized.actionKey,
      status: "reviewed",
      outcome: `${normalized.label} recorded by Vonza.`,
      nextStep: normalized.outcomeType === "quote_requested"
        ? "Reply with the requested quote details."
        : "Review the reply and continue the warm follow-up.",
      followUpNeeded: true,
      followUpCompleted: normalized.outcomeType === "follow_up_replied",
    });
  }

  return null;
}

function buildOutcomePayload(base = {}) {
  const metadata = normalizeMetadata(base.metadata);
  const occurredAt = base.occurredAt || new Date().toISOString();

  return {
    agent_id: cleanText(base.agentId),
    business_id: cleanText(base.businessId) || null,
    owner_user_id: cleanText(base.ownerUserId) || null,
    install_id: cleanText(base.installId) || null,
    outcome_type: normalizeOutcomeType(base.outcomeType),
    source_type: normalizeSourceTypeWithFallback(base.sourceType),
    confirmation_level: normalizeConfirmationLevel(base.confirmationLevel),
    dedupe_key: cleanText(base.dedupeKey),
    cta_event_id: cleanUuid(base.ctaEventId) || null,
    related_cta_type: cleanText(base.relatedCtaType) || null,
    related_target_type: cleanText(base.relatedTargetType) || null,
    related_action_type: cleanText(base.relatedActionType) || null,
    related_intent_type: cleanText(base.relatedIntentType) || null,
    visitor_id: cleanText(base.visitorId) || null,
    session_id: cleanText(base.sessionId) || null,
    fingerprint: cleanText(base.fingerprint) || null,
    conversation_id: cleanText(base.conversationId) || null,
    person_key: cleanText(base.personKey) || null,
    lead_id: cleanUuid(base.leadId) || null,
    contact_id: cleanUuid(base.contactId) || null,
    action_key: cleanText(base.actionKey) || null,
    follow_up_id: cleanUuid(base.followUpId) || null,
    inbox_thread_id: cleanUuid(base.inboxThreadId) || null,
    calendar_event_id: cleanUuid(base.calendarEventId) || null,
    campaign_id: cleanUuid(base.campaignId) || null,
    campaign_recipient_id: cleanUuid(base.campaignRecipientId) || null,
    operator_task_id: cleanUuid(base.operatorTaskId) || null,
    page_url: normalizePageUrl(base.pageUrl) || null,
    origin: normalizeOrigin(base.origin || base.pageUrl) || null,
    target_url: normalizeTargetUrl(base.targetUrl) || null,
    success_url: normalizePageUrl(base.successUrl) || null,
    attribution_path: normalizeAttributionPath(
      base.attributionPath,
      getDefaultAttributionPath({
        sourceType: base.sourceType,
        followUpId: base.followUpId,
        inboxThreadId: base.inboxThreadId,
        calendarEventId: base.calendarEventId,
        campaignId: base.campaignId,
        campaignRecipientId: base.campaignRecipientId,
      })
    ),
    metadata,
    occurred_at: occurredAt,
    created_at: occurredAt,
    updated_at: occurredAt,
  };
}

function assertCanonicalOutcomeType(outcomeType) {
  const normalized = normalizeOutcomeType(outcomeType);

  if (!normalized) {
    const error = new Error("Unsupported conversion outcome type.");
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

export async function recordTrackedCtaClick(supabase, input = {}) {
  const installId = cleanText(input.installId);
  const ctaType = cleanText(input.ctaType).toLowerCase();
  const targetType = cleanText(input.targetType).toLowerCase();
  const targetUrl = normalizeTargetUrl(input.targetUrl || input.href);
  const sessionId = cleanText(input.sessionId);
  const ctaEventId = cleanUuid(input.ctaEventId) || randomUUID();

  if (!installId) {
    const error = new Error("install_id is required");
    error.statusCode = 400;
    throw error;
  }

  if (!targetUrl) {
    const error = new Error("target_url is required");
    error.statusCode = 400;
    throw error;
  }

  const clickOutcomeType = mapCtaClickToOutcomeType(ctaType, targetType);

  if (!clickOutcomeType) {
    const error = new Error("Unsupported CTA type");
    error.statusCode = 400;
    throw error;
  }

  const context = await getWidgetInstallContextByInstallId(supabase, installId);

  if (!context?.agent?.id) {
    const error = new Error("Install not found");
    error.statusCode = 404;
    throw error;
  }

  const leadRecord = await findLikelyLeadRecord(supabase, {
    leadId: input.leadId,
    agentId: context.agent.id,
    ownerUserId: cleanText(context.agent.owner_user_id),
    personKey: input.personKey,
    sessionId,
  });
  const resolvedFollowUpId =
    cleanUuid(input.followUpId) ||
    cleanUuid(leadRecord?.relatedFollowUpId) ||
    "";
  const resolvedActionKey = cleanText(input.actionKey)
    || cleanText(leadRecord?.latestActionKey)
    || cleanText(leadRecord?.relatedActionKeys?.[0])
    || "";
  const resolvedPersonKey = cleanText(input.personKey) || cleanText(leadRecord?.personKey);
  const sourceType = resolvedFollowUpId ? "follow_up_workflow" : "direct_route";
  const attributionPath = buildAttributionPath(null, resolvedFollowUpId);
  const dedupeKey = [
    installId,
    ctaEventId,
    clickOutcomeType,
    cleanText(targetUrl),
  ].join("::");

  const persisted = await upsertOutcomeRecord(supabase, buildOutcomePayload({
    agentId: context.agent.id,
    businessId: context.business?.id || "",
    ownerUserId: context.agent.owner_user_id || "",
    installId,
    outcomeType: clickOutcomeType,
    sourceType,
    confirmationLevel: "clicked",
    dedupeKey,
    ctaEventId,
    relatedCtaType: ctaType,
    relatedTargetType: targetType || (targetUrl.startsWith("mailto:") ? "email" : targetUrl.startsWith("tel:") ? "phone" : "url"),
    relatedActionType: cleanText(input.relatedActionType) || cleanText(leadRecord?.latestActionType),
    relatedIntentType: cleanText(input.relatedIntentType),
    visitorId: cleanText(input.visitorId) || cleanText(input.fingerprint) || sessionId,
    sessionId,
    fingerprint: cleanText(input.fingerprint),
    conversationId: cleanText(input.conversationId),
    personKey: resolvedPersonKey,
    leadId: cleanUuid(input.leadId) || cleanUuid(leadRecord?.id),
    contactId: cleanUuid(input.contactId) || cleanUuid(leadRecord?.contactId),
    actionKey: resolvedActionKey,
    followUpId: resolvedFollowUpId,
    pageUrl: input.pageUrl,
    origin: input.origin,
    targetUrl,
    metadata: {
      decisionKey: cleanText(input.decisionKey),
      attributionPath,
      visitorId: cleanText(input.visitorId) || cleanText(input.fingerprint) || sessionId,
      leadKey: cleanText(leadRecord?.leadKey),
      label: cleanText(input.label),
    },
  }));

  console.info("[conversion] tracked_cta_click", {
    installId,
    ctaEventId,
    agentId: context.agent.id,
    outcomeType: clickOutcomeType,
    sourceType,
    actionKey: resolvedActionKey || null,
    leadId: leadRecord?.id || null,
    followUpId: resolvedFollowUpId || null,
  });

  return {
    ok: true,
    persistenceAvailable: Boolean(persisted),
    ctaEventId,
    redirectUrl: appendTrackingParams(targetUrl, ctaEventId),
    outcome: persisted,
  };
}

export async function detectConversionOutcomesForPage(supabase, input = {}) {
  const installId = cleanText(input.installId);
  const pageUrl = normalizePageUrl(input.pageUrl);
  const sessionId = cleanText(input.sessionId);
  const requestedOutcomeType = normalizeOutcomeType(input.outcomeType);

  if (!installId) {
    const error = new Error("install_id is required");
    error.statusCode = 400;
    throw error;
  }

  if (!pageUrl && !requestedOutcomeType) {
    const error = new Error("page_url or outcome_type is required");
    error.statusCode = 400;
    throw error;
  }

  const context = await getWidgetInstallContextByInstallId(supabase, installId);

  if (!context?.agent?.id) {
    const error = new Error("Install not found");
    error.statusCode = 404;
    throw error;
  }

  const settings = normalizeOutcomeSettings(context.widgetConfigRow || {});
  const ctaEventId = cleanUuid(input.ctaEventId) || parseCtaEventIdFromPageUrl(pageUrl);
  const existingCtaOutcomes = ctaEventId
    ? await getOutcomesByCtaEventId(supabase, { ctaEventId })
    : [];
  const sourceOutcome = existingCtaOutcomes.find((entry) => CLICK_OUTCOME_TYPES.has(entry.outcomeType))
    || await getLatestSourceOutcomeForSession(supabase, { installId, sessionId });
  const matchedOutcomes = requestedOutcomeType
    ? [{ outcomeType: requestedOutcomeType, successUrl: pageUrl }]
    : getMatchedConfiguredOutcomes(settings, pageUrl, {
      includeStartMatches: Boolean(ctaEventId),
    });

  if (!matchedOutcomes.length) {
    return {
      ok: true,
      matched: false,
      detectedOutcomes: [],
      persistenceAvailable: true,
    };
  }

  const leadRecord = await findLikelyLeadRecord(supabase, {
    leadId: input.leadId || sourceOutcome?.leadId,
    agentId: context.agent.id,
    ownerUserId: cleanText(context.agent.owner_user_id),
    personKey: input.personKey || sourceOutcome?.personKey,
    sessionId: sessionId || sourceOutcome?.sessionId,
  });
  const detected = [];

  for (const match of matchedOutcomes) {
    const normalizedOutcomeType = normalizeOutcomeType(match.outcomeType);
    const fallbackCompletedType = mapStartedOutcomeToCompletedType(sourceOutcome?.outcomeType);
    const finalOutcomeType =
      BUSINESS_SUCCESS_OUTCOME_TYPES.has(normalizedOutcomeType)
        ? normalizedOutcomeType
        : normalizeOutcomeType(fallbackCompletedType) || normalizedOutcomeType;

    if (!finalOutcomeType) {
      continue;
    }

    const followUpId =
      cleanUuid(input.followUpId) ||
      cleanUuid(sourceOutcome?.followUpId) ||
      cleanUuid(leadRecord?.relatedFollowUpId) ||
      "";
    const actionKey = cleanText(input.actionKey)
      || cleanText(sourceOutcome?.actionKey)
      || cleanText(leadRecord?.latestActionKey)
      || cleanText(leadRecord?.relatedActionKeys?.[0])
      || "";
    const attributionPath = buildAttributionPath(sourceOutcome, followUpId);
    const dedupeKey = [
      installId,
      ctaEventId || sessionId || actionKey || pageUrl,
      finalOutcomeType,
      cleanText(match.successUrl || pageUrl),
    ].join("::");
    const sourceType = input.source === "ping" ? "external_success_ping" : "success_url_match";
    const matchingExistingOutcome = existingCtaOutcomes.find((entry) => entry.outcomeType === finalOutcomeType)
      || (sourceOutcome?.outcomeType === finalOutcomeType ? sourceOutcome : null);
    let outcome = null;

    if (matchingExistingOutcome?.id) {
      outcome = await updateOutcomeRecord(supabase, matchingExistingOutcome.id, {
        business_id: matchingExistingOutcome.businessId || context.business?.id || null,
        install_id: matchingExistingOutcome.installId || installId || null,
        source_type: matchingExistingOutcome.sourceType || sourceType,
        confirmation_level: pickStrongerConfirmationLevel(
          matchingExistingOutcome.confirmationLevel,
          requestedOutcomeType ? "confirmed" : "observed"
        ),
        related_cta_type: cleanText(matchingExistingOutcome.relatedCtaType) || cleanText(input.ctaType) || cleanText(sourceOutcome?.relatedCtaType) || null,
        related_target_type: cleanText(matchingExistingOutcome.relatedTargetType) || cleanText(input.targetType) || cleanText(sourceOutcome?.relatedTargetType) || null,
        related_action_type: cleanText(matchingExistingOutcome.relatedActionType) || cleanText(input.relatedActionType) || cleanText(sourceOutcome?.relatedActionType) || cleanText(leadRecord?.latestActionType) || null,
        related_intent_type: cleanText(matchingExistingOutcome.relatedIntentType) || cleanText(input.relatedIntentType) || cleanText(sourceOutcome?.relatedIntentType) || null,
        visitor_id: cleanText(matchingExistingOutcome.visitorId) || cleanText(input.visitorId) || cleanText(sourceOutcome?.visitorId) || cleanText(input.fingerprint) || sessionId || null,
        session_id: cleanText(matchingExistingOutcome.sessionId) || sessionId || cleanText(sourceOutcome?.sessionId) || null,
        fingerprint: cleanText(matchingExistingOutcome.fingerprint) || cleanText(input.fingerprint) || cleanText(sourceOutcome?.fingerprint) || null,
        conversation_id: cleanText(matchingExistingOutcome.conversationId) || cleanText(input.conversationId) || cleanText(sourceOutcome?.conversationId) || null,
        person_key: cleanText(matchingExistingOutcome.personKey) || cleanText(input.personKey) || cleanText(sourceOutcome?.personKey) || cleanText(leadRecord?.personKey) || null,
        lead_id: cleanUuid(matchingExistingOutcome.leadId) || cleanUuid(input.leadId) || cleanUuid(sourceOutcome?.leadId) || cleanUuid(leadRecord?.id) || null,
        contact_id: cleanUuid(matchingExistingOutcome.contactId) || cleanUuid(input.contactId) || cleanUuid(sourceOutcome?.contactId) || cleanUuid(leadRecord?.contactId) || null,
        action_key: cleanText(matchingExistingOutcome.actionKey) || actionKey || null,
        follow_up_id: cleanUuid(matchingExistingOutcome.followUpId) || followUpId || null,
        inbox_thread_id: cleanUuid(matchingExistingOutcome.inboxThreadId) || cleanUuid(input.inboxThreadId) || null,
        calendar_event_id: cleanUuid(matchingExistingOutcome.calendarEventId) || cleanUuid(input.calendarEventId) || null,
        campaign_id: cleanUuid(matchingExistingOutcome.campaignId) || cleanUuid(input.campaignId) || null,
        campaign_recipient_id: cleanUuid(matchingExistingOutcome.campaignRecipientId) || cleanUuid(input.campaignRecipientId) || null,
        operator_task_id: cleanUuid(matchingExistingOutcome.operatorTaskId) || cleanUuid(input.operatorTaskId) || null,
        page_url: normalizePageUrl(pageUrl) || normalizePageUrl(matchingExistingOutcome.pageUrl) || null,
        origin: normalizeOrigin(input.origin || pageUrl || matchingExistingOutcome.origin) || null,
        success_url: normalizePageUrl(match.successUrl || pageUrl || matchingExistingOutcome.successUrl) || null,
        attribution_path: normalizeAttributionPath(matchingExistingOutcome.attributionPath, attributionPath),
        metadata: {
          ...normalizeMetadata(matchingExistingOutcome.metadata),
          attributionPath,
          matchedBy: requestedOutcomeType ? "explicit" : "configured_success_url",
          matchedPageUrl: pageUrl,
          sourceOutcomeType: cleanText(sourceOutcome?.outcomeType),
          confirmationSourceType: sourceType,
        },
      });
    } else {
      outcome = await upsertOutcomeRecord(supabase, buildOutcomePayload({
      agentId: context.agent.id,
      businessId: context.business?.id || "",
      ownerUserId: context.agent.owner_user_id || "",
      installId,
      outcomeType: finalOutcomeType,
      sourceType,
      confirmationLevel: requestedOutcomeType ? "confirmed" : "observed",
      dedupeKey,
      ctaEventId: ctaEventId || sourceOutcome?.ctaEventId,
      relatedCtaType: cleanText(input.ctaType) || cleanText(sourceOutcome?.relatedCtaType),
      relatedTargetType: cleanText(input.targetType) || cleanText(sourceOutcome?.relatedTargetType),
      relatedActionType: cleanText(input.relatedActionType) || cleanText(sourceOutcome?.relatedActionType) || cleanText(leadRecord?.latestActionType),
      relatedIntentType: cleanText(input.relatedIntentType) || cleanText(sourceOutcome?.relatedIntentType),
      visitorId: cleanText(input.visitorId) || cleanText(sourceOutcome?.visitorId) || cleanText(input.fingerprint) || sessionId,
      sessionId: sessionId || cleanText(sourceOutcome?.sessionId),
      fingerprint: cleanText(input.fingerprint) || cleanText(sourceOutcome?.fingerprint),
      conversationId: cleanText(input.conversationId) || cleanText(sourceOutcome?.conversationId),
      personKey: cleanText(input.personKey) || cleanText(sourceOutcome?.personKey) || cleanText(leadRecord?.personKey),
      leadId: cleanUuid(input.leadId) || cleanUuid(sourceOutcome?.leadId) || cleanUuid(leadRecord?.id),
      contactId: cleanUuid(input.contactId) || cleanUuid(sourceOutcome?.contactId) || cleanUuid(leadRecord?.contactId),
      actionKey,
      followUpId,
      inboxThreadId: input.inboxThreadId,
      calendarEventId: input.calendarEventId,
      campaignId: input.campaignId,
      campaignRecipientId: input.campaignRecipientId,
      operatorTaskId: input.operatorTaskId,
      pageUrl,
      origin: input.origin,
      targetUrl: cleanText(sourceOutcome?.targetUrl),
      successUrl: match.successUrl || pageUrl,
      metadata: {
        attributionPath,
        matchedBy: requestedOutcomeType ? "explicit" : "configured_success_url",
        matchedPageUrl: pageUrl,
        sourceOutcomeType: cleanText(sourceOutcome?.outcomeType),
      },
      }));
    }

    if (outcome) {
      detected.push(outcome);
      await syncOutcomeIntoOperationalState(supabase, outcome);
    }
  }

  console.info("[conversion] detect_page_outcome", {
    installId,
    agentId: context.agent.id,
    pageUrl,
    ctaEventId: ctaEventId || null,
    matchedOutcomeTypes: detected.map((entry) => entry.outcomeType),
  });

  return {
    ok: true,
    matched: detected.length > 0,
    persistenceAvailable: true,
    detectedOutcomes: detected,
  };
}

export async function markManualConversionOutcome(supabase, input = {}) {
  const installId = cleanText(input.installId);
  const agentId = cleanText(input.agentId);
  const ownerUserId = cleanText(input.ownerUserId);
  const normalizedOutcomeType = assertCanonicalOutcomeType(input.outcomeType);
  const leadRecord = await findLikelyLeadRecord(supabase, {
    leadId: input.leadId,
    agentId,
    ownerUserId,
    personKey: input.personKey,
    sessionId: input.sessionId,
  });
  const followUpId =
    cleanUuid(input.followUpId) ||
    cleanUuid(leadRecord?.relatedFollowUpId) ||
    "";
  const actionKey = cleanText(input.actionKey)
    || cleanText(leadRecord?.latestActionKey)
    || cleanText(leadRecord?.relatedActionKeys?.[0])
    || "";
  const dedupeKey = [
    agentId,
    ownerUserId,
    normalizedOutcomeType,
    cleanUuid(input.leadId) || leadRecord?.id || actionKey || cleanText(input.note),
  ].join("::");

  const outcome = await upsertOutcomeRecord(supabase, buildOutcomePayload({
    agentId,
    businessId: cleanText(input.businessId),
    ownerUserId,
    installId,
    outcomeType: normalizedOutcomeType,
    sourceType: "manual_owner",
    confirmationLevel: "manual",
    dedupeKey,
    ctaEventId: input.ctaEventId,
    relatedCtaType: input.ctaType,
    relatedTargetType: input.targetType,
    relatedActionType: input.relatedActionType || leadRecord?.latestActionType,
    relatedIntentType: input.relatedIntentType,
    visitorId: input.visitorId || input.sessionId,
    sessionId: input.sessionId,
    fingerprint: input.fingerprint,
    conversationId: input.conversationId,
    personKey: input.personKey || leadRecord?.personKey,
    leadId: input.leadId || leadRecord?.id,
    contactId: input.contactId || leadRecord?.contactId,
    actionKey,
    followUpId,
    inboxThreadId: input.inboxThreadId,
    calendarEventId: input.calendarEventId,
    campaignId: input.campaignId,
    campaignRecipientId: input.campaignRecipientId,
    operatorTaskId: input.operatorTaskId,
    pageUrl: input.pageUrl,
    origin: input.origin,
    successUrl: input.successUrl || input.pageUrl,
    metadata: {
      attributionPath: normalizeAttributionPath(
        input.attributionPath,
        getDefaultAttributionPath({
          sourceType: "manual_owner",
          followUpId,
          inboxThreadId: input.inboxThreadId,
          calendarEventId: input.calendarEventId,
          campaignId: input.campaignId,
          campaignRecipientId: input.campaignRecipientId,
        })
      ),
      manualOutcomeLabel: cleanText(input.manualOutcomeLabel),
      manualResolution: cleanText(input.manualResolution),
      note: cleanText(input.note),
    },
  }));

  if (outcome) {
    await syncOutcomeIntoOperationalState(supabase, outcome);
  }

  console.info("[conversion] manual_mark", {
    agentId,
    ownerUserId,
    outcomeType: normalizedOutcomeType,
    actionKey: actionKey || null,
    leadId: leadRecord?.id || cleanUuid(input.leadId) || null,
  });

  return {
    ok: true,
    persistenceAvailable: Boolean(outcome),
    outcome,
  };
}

export async function trackFollowUpOutcome(supabase, input = {}) {
  const normalizedOutcomeType = normalizeOutcomeType(input.outcomeType);

  if (!normalizedOutcomeType || !["follow_up_sent", "follow_up_replied"].includes(normalizedOutcomeType)) {
    return {
      ok: false,
      skipped: true,
    };
  }

  const dedupeKey = [
    cleanText(input.agentId),
    cleanText(input.followUpId),
    normalizedOutcomeType,
  ].join("::");
  const outcome = await upsertOutcomeRecord(supabase, buildOutcomePayload({
    agentId: input.agentId,
    businessId: input.businessId,
    ownerUserId: input.ownerUserId,
    installId: input.installId,
    outcomeType: normalizedOutcomeType,
    sourceType: "workflow_sync",
    confirmationLevel: normalizedOutcomeType === "follow_up_sent" ? "observed" : "confirmed",
    dedupeKey,
    ctaEventId: input.ctaEventId,
    relatedActionType: input.relatedActionType,
    relatedIntentType: input.relatedIntentType,
    visitorId: input.visitorId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    personKey: input.personKey,
    leadId: input.leadId,
    contactId: input.contactId,
    actionKey: input.actionKey,
    followUpId: input.followUpId,
    pageUrl: input.pageUrl,
    successUrl: input.successUrl,
    metadata: {
      attributionPath: "follow_up_assisted",
    },
  }));

  if (outcome && normalizedOutcomeType === "follow_up_replied") {
    await syncOutcomeIntoOperationalState(supabase, outcome);
  }

  return {
    ok: true,
    persistenceAvailable: Boolean(outcome),
    outcome,
  };
}

export async function recordOutcomeEvent(supabase, input = {}) {
  const agentId = cleanText(input.agentId);
  const ownerUserId = cleanText(input.ownerUserId);
  const normalizedOutcomeType = assertCanonicalOutcomeType(input.outcomeType);
  const leadRecord = await findLikelyLeadRecord(supabase, {
    leadId: input.leadId,
    agentId,
    ownerUserId,
    personKey: input.personKey,
    sessionId: input.sessionId,
  });
  const resolvedLeadId = cleanUuid(input.leadId) || cleanUuid(leadRecord?.id);
  const resolvedContactId = cleanUuid(input.contactId) || cleanUuid(leadRecord?.contactId);
  const resolvedFollowUpId =
    cleanUuid(input.followUpId) ||
    cleanUuid(leadRecord?.relatedFollowUpId) ||
    "";
  const resolvedActionKey = cleanText(input.actionKey)
    || cleanText(leadRecord?.latestActionKey)
    || cleanText(leadRecord?.relatedActionKeys?.[0])
    || "";
  const attributionPath = normalizeAttributionPath(
    input.attributionPath,
    getDefaultAttributionPath({
      sourceType: input.sourceType,
      followUpId: resolvedFollowUpId,
      inboxThreadId: input.inboxThreadId,
      calendarEventId: input.calendarEventId,
      campaignId: input.campaignId,
      campaignRecipientId: input.campaignRecipientId,
    })
  );
  const dedupeKey = cleanText(input.dedupeKey) || [
    agentId,
    ownerUserId,
    normalizedOutcomeType,
    cleanText(
      resolvedContactId
      || resolvedLeadId
      || input.inboxThreadId
      || input.calendarEventId
      || input.campaignRecipientId
      || input.operatorTaskId
      || input.ctaEventId
      || resolvedActionKey
      || input.pageUrl
      || input.successUrl
      || input.note
      || input.occurredAt
      || "outcome"
    ),
  ].join("::");
  const outcome = await upsertOutcomeRecord(supabase, buildOutcomePayload({
    agentId,
    businessId: input.businessId,
    ownerUserId,
    installId: input.installId,
    outcomeType: normalizedOutcomeType,
    sourceType: normalizeSourceTypeWithFallback(input.sourceType),
    confirmationLevel: input.confirmationLevel,
    dedupeKey,
    ctaEventId: input.ctaEventId,
    relatedCtaType: input.ctaType,
    relatedTargetType: input.targetType,
    relatedActionType: input.relatedActionType || leadRecord?.latestActionType,
    relatedIntentType: input.relatedIntentType,
    visitorId: input.visitorId || input.sessionId,
    sessionId: input.sessionId,
    fingerprint: input.fingerprint,
    conversationId: input.conversationId,
    personKey: input.personKey || leadRecord?.personKey,
    leadId: resolvedLeadId,
    contactId: resolvedContactId,
    actionKey: resolvedActionKey,
    followUpId: resolvedFollowUpId,
    inboxThreadId: input.inboxThreadId,
    calendarEventId: input.calendarEventId,
    campaignId: input.campaignId,
    campaignRecipientId: input.campaignRecipientId,
    operatorTaskId: input.operatorTaskId,
    pageUrl: input.pageUrl,
    origin: input.origin,
    targetUrl: input.targetUrl,
    successUrl: input.successUrl || input.pageUrl,
    attributionPath,
    occurredAt: input.occurredAt,
    metadata: {
      ...normalizeMetadata(input.metadata),
      attributionPath,
      sourceRecordType: cleanText(input.sourceRecordType),
      sourceRecordId: cleanText(input.sourceRecordId),
      manualOutcomeLabel: cleanText(input.manualOutcomeLabel),
      manualResolution: cleanText(input.manualResolution),
      note: cleanText(input.note),
    },
  }));

  if (outcome && input.syncOperationalState !== false) {
    await syncOutcomeIntoOperationalState(supabase, outcome);
  }

  return {
    ok: true,
    persistenceAvailable: Boolean(outcome),
    outcome,
  };
}

function buildEmptyOutcomeSummary() {
  return {
    total: 0,
    assistedConversions: 0,
    confirmedBusinessOutcomes: 0,
    directOutcomeCount: 0,
    followUpAssistedOutcomeCount: 0,
    bookingStarted: 0,
    bookingConfirmed: 0,
    bookingCompleted: 0,
    quoteRequested: 0,
    quoteSent: 0,
    quoteAccepted: 0,
    checkoutStarted: 0,
    checkoutCompleted: 0,
    contactClicked: 0,
    emailClicked: 0,
    phoneClicked: 0,
    followUpSent: 0,
    followUpReplied: 0,
    complaintOpened: 0,
    complaintResolved: 0,
    campaignSent: 0,
    campaignReplied: 0,
    campaignConverted: 0,
    manualMarked: 0,
    directVsFollowUpSplit: {
      direct: 0,
      followUp: 0,
      operator: 0,
      manual: 0,
    },
    pathCounts: {
      directRoute: 0,
      followUpAssisted: 0,
      inboxThread: 0,
      calendarBooking: 0,
      campaign: 0,
      manualOwner: 0,
    },
    topPages: [],
    topIntents: [],
  };
}

function incrementCounter(summary, key) {
  summary[key] = Number(summary[key] || 0) + 1;
}

function incrementAttributedPath(summary, attributionPath = "") {
  const normalized = normalizeAttributionPath(attributionPath);

  if (normalized === "follow_up_assisted") {
    summary.followUpAssistedOutcomeCount += 1;
    summary.directVsFollowUpSplit.followUp += 1;
    summary.pathCounts.followUpAssisted += 1;
    return;
  }

  if (normalized === "manual_owner") {
    summary.directVsFollowUpSplit.manual += 1;
    summary.pathCounts.manualOwner += 1;
    return;
  }

  if (normalized === "inbox_thread") {
    summary.directVsFollowUpSplit.operator += 1;
    summary.pathCounts.inboxThread += 1;
    return;
  }

  if (normalized === "calendar_booking") {
    summary.directVsFollowUpSplit.operator += 1;
    summary.pathCounts.calendarBooking += 1;
    return;
  }

  if (normalized === "campaign") {
    summary.directVsFollowUpSplit.operator += 1;
    summary.pathCounts.campaign += 1;
    return;
  }

  summary.directOutcomeCount += 1;
  summary.directVsFollowUpSplit.direct += 1;
  summary.pathCounts.directRoute += 1;
}

function buildRecentOutcome(entry = {}) {
  return {
    id: entry.id,
    outcomeType: entry.outcomeType,
    label: entry.label,
    sourceType: entry.sourceType,
    attributionPath: entry.attributionPath,
    relatedCtaType: entry.relatedCtaType,
    relatedIntentType: entry.relatedIntentType,
    actionKey: entry.actionKey,
    leadId: entry.leadId,
    contactId: entry.contactId,
    followUpId: entry.followUpId,
    inboxThreadId: entry.inboxThreadId,
    calendarEventId: entry.calendarEventId,
    campaignId: entry.campaignId,
    campaignRecipientId: entry.campaignRecipientId,
    operatorTaskId: entry.operatorTaskId,
    pageUrl: entry.pageUrl,
    successUrl: entry.successUrl,
    occurredAt: entry.occurredAt,
    sourceLabel: entry.sourceLabel,
  };
}

export async function listConversionOutcomesForAgent(supabase, options = {}) {
  const agentId = cleanText(options.agentId);
  const ownerUserId = cleanText(options.ownerUserId);
  const limit = Number(options.limit || 300);

  if (!agentId || !ownerUserId) {
    return {
      records: [],
      summary: buildEmptyOutcomeSummary(),
      recentOutcomes: [],
      persistenceAvailable: true,
    };
  }

  const { data, error } = await supabase
    .from(CONVERSION_OUTCOME_TABLE)
    .select(OUTCOME_SELECT)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingRelationError(error, CONVERSION_OUTCOME_TABLE)) {
      return {
        records: [],
        summary: buildEmptyOutcomeSummary(),
        recentOutcomes: [],
        persistenceAvailable: false,
      };
    }

    throw error;
  }

  const records = (data || []).map((row) => normalizeOutcomeRecord(row));
  const summary = buildEmptyOutcomeSummary();
  const pageCounts = new Map();
  const intentCounts = new Map();
  const recentOutcomes = [];

  for (const record of records) {
    summary.total += 1;

    switch (record.outcomeType) {
      case "booking_started":
        incrementCounter(summary, "bookingStarted");
        break;
      case "booking_confirmed":
        incrementCounter(summary, "bookingConfirmed");
        incrementCounter(summary, "bookingCompleted");
        break;
      case "quote_requested":
        incrementCounter(summary, "quoteRequested");
        break;
      case "quote_sent":
        incrementCounter(summary, "quoteSent");
        break;
      case "quote_accepted":
        incrementCounter(summary, "quoteAccepted");
        break;
      case "checkout_started":
        incrementCounter(summary, "checkoutStarted");
        break;
      case "checkout_completed":
        incrementCounter(summary, "checkoutCompleted");
        break;
      case "contact_clicked":
        incrementCounter(summary, "contactClicked");
        break;
      case "email_clicked":
        incrementCounter(summary, "emailClicked");
        break;
      case "phone_clicked":
        incrementCounter(summary, "phoneClicked");
        break;
      case "follow_up_sent":
        incrementCounter(summary, "followUpSent");
        break;
      case "follow_up_replied":
        incrementCounter(summary, "followUpReplied");
        break;
      case "complaint_opened":
        incrementCounter(summary, "complaintOpened");
        break;
      case "complaint_resolved":
        incrementCounter(summary, "complaintResolved");
        break;
      case "campaign_sent":
        incrementCounter(summary, "campaignSent");
        break;
      case "campaign_replied":
        incrementCounter(summary, "campaignReplied");
        break;
      case "campaign_converted":
        incrementCounter(summary, "campaignConverted");
        break;
      case "manual_outcome_marked":
        incrementCounter(summary, "manualMarked");
        break;
      default:
        break;
    }

    if (BUSINESS_SUCCESS_OUTCOME_TYPES.has(record.outcomeType)) {
      summary.confirmedBusinessOutcomes += 1;
    }

    if (COMPLETED_OUTCOME_TYPES.has(record.outcomeType)) {
      summary.assistedConversions += 1;
      incrementAttributedPath(summary, record.attributionPath);

      if (record.pageUrl) {
        pageCounts.set(record.pageUrl, Number(pageCounts.get(record.pageUrl) || 0) + 1);
      }

      if (record.relatedIntentType) {
        intentCounts.set(record.relatedIntentType, Number(intentCounts.get(record.relatedIntentType) || 0) + 1);
      }

      if (recentOutcomes.length < 8) {
        recentOutcomes.push(buildRecentOutcome(record));
      }
    }
  }

  summary.topPages = [...pageCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([label, count]) => ({ label, count }));
  summary.topIntents = [...intentCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([label, count]) => ({ label, count }));

  return {
    records,
    summary,
    recentOutcomes,
    persistenceAvailable: true,
  };
}
