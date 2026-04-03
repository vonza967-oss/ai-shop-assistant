import { randomUUID } from "node:crypto";

import {
  ACTION_QUEUE_STATUS_TABLE,
  CONVERSION_OUTCOME_TABLE,
  LEAD_CAPTURE_TABLE,
} from "../../config/constants.js";
import { cleanText } from "../../utils/text.js";
import { normalizeWebsiteUrl } from "../../utils/url.js";
import { getWidgetInstallContextByInstallId, isMissingRelationError as isMissingInstallRelationError } from "../install/installPresenceService.js";
import { updateActionQueueStatus } from "../analytics/actionQueueService.js";

export const CONVERSION_OUTCOME_TYPES = [
  "booking_started",
  "booking_completed",
  "quote_started",
  "quote_requested",
  "checkout_started",
  "checkout_completed",
  "contact_clicked",
  "email_clicked",
  "phone_clicked",
  "follow_up_sent",
  "follow_up_replied",
  "conversion_marked_manual",
];

export const CONVERSION_SOURCE_TYPES = [
  "direct_cta",
  "follow_up",
  "manual_mark",
  "success_url_match",
  "external_success_ping",
  "workflow_sync",
];

export const CONVERSION_CONFIRMATION_LEVELS = [
  "clicked",
  "observed",
  "confirmed",
  "manual",
];

export const SUCCESS_URL_MATCH_MODES = ["exact", "path_prefix"];

const COMPLETED_OUTCOME_TYPES = new Set([
  "booking_completed",
  "quote_requested",
  "checkout_completed",
  "contact_clicked",
  "email_clicked",
  "phone_clicked",
  "follow_up_replied",
  "conversion_marked_manual",
]);

const BUSINESS_SUCCESS_OUTCOME_TYPES = new Set([
  "booking_completed",
  "quote_requested",
  "checkout_completed",
]);

const CLICK_OUTCOME_TYPES = new Set([
  "booking_started",
  "quote_started",
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
  "action_key",
  "follow_up_id",
  "page_url",
  "origin",
  "target_url",
  "success_url",
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
    message.includes(`${relationName} was not found`)
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
  return CONVERSION_OUTCOME_TYPES.includes(normalized) ? normalized : "";
}

function normalizeSourceType(value) {
  const normalized = cleanText(value).toLowerCase();
  return CONVERSION_SOURCE_TYPES.includes(normalized) ? normalized : "";
}

function normalizeConfirmationLevel(value, fallbackValue = "observed") {
  const normalized = cleanText(value).toLowerCase();
  return CONVERSION_CONFIRMATION_LEVELS.includes(normalized) ? normalized : fallbackValue;
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
      return "quote_started";
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
      return "booking_completed";
    case "quote_started":
      return "quote_requested";
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
    case "booking_completed":
      return "Booking completed";
    case "quote_started":
      return "Quote started";
    case "quote_requested":
      return "Quote requested";
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
    case "conversion_marked_manual":
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
    outcomes.push({ outcomeType: "booking_completed", successUrl: settings.bookingSuccessUrl });
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
    outcomes.push({ outcomeType: "quote_started", successUrl: settings.quoteStartUrl });
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
    contactEmail: cleanText(row.contact_email || row.contactEmail).toLowerCase(),
    contactPhone: cleanText(row.contact_phone || row.contactPhone),
  };
}

function normalizeOutcomeRecord(row = {}) {
  const metadata = normalizeMetadata(row.metadata);
  const outcomeType = normalizeOutcomeType(row.outcome_type || row.outcomeType);
  const sourceType = normalizeSourceType(row.source_type || row.sourceType);
  const inferredPath = cleanText(metadata.attributionPath)
    || (cleanUuid(row.follow_up_id || row.followUpId) ? "follow_up" : "")
    || (sourceType === "manual_mark" ? "manual" : "direct");

  return {
    id: cleanUuid(row.id),
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
    actionKey: cleanText(row.action_key || row.actionKey),
    followUpId: cleanUuid(row.follow_up_id || row.followUpId),
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
    .in("outcome_type", ["booking_started", "quote_started", "checkout_started"])
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
    return "follow_up";
  }

  if (normalizeSourceType(sourceOutcome?.sourceType) === "manual_mark") {
    return "manual";
  }

  return "direct";
}

async function syncOutcomeIntoOperationalState(supabase, outcome) {
  const normalized = normalizeOutcomeRecord(outcome);

  if (!normalized.agentId || !normalized.ownerUserId || !normalized.actionKey) {
    return null;
  }

  if (normalized.outcomeType === "booking_completed" || normalized.outcomeType === "checkout_completed") {
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
    source_type: normalizeSourceType(base.sourceType),
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
    action_key: cleanText(base.actionKey) || null,
    follow_up_id: cleanUuid(base.followUpId) || null,
    page_url: normalizePageUrl(base.pageUrl) || null,
    origin: normalizeOrigin(base.origin || base.pageUrl) || null,
    target_url: normalizeTargetUrl(base.targetUrl) || null,
    success_url: normalizePageUrl(base.successUrl) || null,
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
  const sourceType = resolvedFollowUpId ? "follow_up" : "direct_cta";
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
    const outcome = await upsertOutcomeRecord(supabase, buildOutcomePayload({
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
      actionKey,
      followUpId,
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
    sourceType: "manual_mark",
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
    actionKey,
    followUpId,
    pageUrl: input.pageUrl,
    origin: input.origin,
    successUrl: input.successUrl || input.pageUrl,
    metadata: {
      attributionPath: buildAttributionPath(null, followUpId),
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
    actionKey: input.actionKey,
    followUpId: input.followUpId,
    pageUrl: input.pageUrl,
    successUrl: input.successUrl,
    metadata: {
      attributionPath: "follow_up",
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

function buildEmptyOutcomeSummary() {
  return {
    total: 0,
    assistedConversions: 0,
    confirmedBusinessOutcomes: 0,
    directOutcomeCount: 0,
    followUpAssistedOutcomeCount: 0,
    bookingStarted: 0,
    bookingCompleted: 0,
    quoteStarted: 0,
    quoteRequested: 0,
    checkoutStarted: 0,
    checkoutCompleted: 0,
    contactClicked: 0,
    emailClicked: 0,
    phoneClicked: 0,
    followUpSent: 0,
    followUpReplied: 0,
    manualMarked: 0,
    directVsFollowUpSplit: {
      direct: 0,
      followUp: 0,
      manual: 0,
    },
    topPages: [],
    topIntents: [],
  };
}

function incrementCounter(summary, key) {
  summary[key] = Number(summary[key] || 0) + 1;
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
    followUpId: entry.followUpId,
    pageUrl: entry.pageUrl,
    successUrl: entry.successUrl,
    occurredAt: entry.occurredAt,
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
      case "booking_completed":
        incrementCounter(summary, "bookingCompleted");
        break;
      case "quote_started":
        incrementCounter(summary, "quoteStarted");
        break;
      case "quote_requested":
        incrementCounter(summary, "quoteRequested");
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
      case "conversion_marked_manual":
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
      if (record.attributionPath === "follow_up") {
        summary.followUpAssistedOutcomeCount += 1;
        summary.directVsFollowUpSplit.followUp += 1;
      } else if (record.attributionPath === "manual") {
        summary.directVsFollowUpSplit.manual += 1;
      } else {
        summary.directOutcomeCount += 1;
        summary.directVsFollowUpSplit.direct += 1;
      }

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
