import { buildActionQueue } from "../analytics/actionQueueService.js";
import { listAgentMessages } from "../chat/messageService.js";
import { syncFollowUpWorkflows } from "../followup/followUpService.js";
import { LEAD_CAPTURE_TABLE } from "../../config/constants.js";
import { cleanText } from "../../utils/text.js";

export const LEAD_CAPTURE_STATES = [
  "none",
  "prompt_ready",
  "prompted",
  "partial_contact",
  "captured",
  "declined",
  "blocked",
];

const ACTIVE_HIGH_INTENT_ACTION_TYPES = new Set([
  "lead_follow_up",
  "pricing_interest",
  "booking_intent",
]);
const PROMPT_COOLDOWN_MS = 1000 * 60 * 60 * 12;
const DECLINE_COOLDOWN_MS = 1000 * 60 * 60 * 24 * 7;
const LEAD_CAPTURE_SELECT = [
  "id",
  "agent_id",
  "business_id",
  "owner_user_id",
  "install_id",
  "lead_key",
  "person_key",
  "visitor_session_key",
  "capture_state",
  "preferred_channel",
  "contact_name",
  "contact_email",
  "contact_phone",
  "contact_phone_normalized",
  "source_page_url",
  "source_origin",
  "latest_intent_type",
  "latest_action_type",
  "latest_action_key",
  "latest_message_id",
  "related_action_keys",
  "prompt_count",
  "prompted_at",
  "captured_at",
  "declined_at",
  "blocked_at",
  "first_seen_at",
  "last_seen_at",
  "capture_trigger",
  "capture_reason",
  "capture_prompt",
  "capture_source",
  "capture_metadata",
  "related_follow_up_id",
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

function buildMissingLeadCaptureSchemaError(phase = "request") {
  const error = new Error(
    `[${phase}] Missing required live lead-capture schema for '${LEAD_CAPTURE_TABLE}'. Apply the latest database migration before running this build.`
  );
  error.statusCode = 500;
  error.code = "schema_not_ready";
  return error;
}

export async function assertLeadCaptureSchemaReady(supabase, options = {}) {
  const { error } = await supabase
    .from(LEAD_CAPTURE_TABLE)
    .select("id, agent_id, owner_user_id, install_id, visitor_session_key, capture_state, related_action_keys")
    .limit(1);

  if (error) {
    if (isMissingRelationError(error, LEAD_CAPTURE_TABLE)) {
      throw buildMissingLeadCaptureSchemaError(options.phase || "startup");
    }

    throw error;
  }
}

function normalizeState(value) {
  const normalized = cleanText(value).toLowerCase();
  return LEAD_CAPTURE_STATES.includes(normalized) ? normalized : "none";
}

function normalizePreferredChannel(value) {
  const normalized = cleanText(value).toLowerCase();
  return ["email", "phone"].includes(normalized) ? normalized : "";
}

function normalizeEmail(value) {
  return cleanText(value).toLowerCase();
}

function normalizePhone(value) {
  return cleanText(value);
}

function normalizePhoneDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 7 ? digits : "";
}

function hasUsableContact(record = {}) {
  return Boolean(normalizeEmail(record.contactEmail || record.email) || normalizePhoneDigits(record.contactPhone || record.phone));
}

function getPreferredChannel(contact = {}) {
  const preferred = normalizePreferredChannel(contact.preferredChannel || contact.preferred_channel);
  if (preferred) {
    return preferred;
  }

  if (normalizeEmail(contact.email || contact.contactEmail)) {
    return "email";
  }

  if (normalizePhoneDigits(contact.phone || contact.contactPhone)) {
    return "phone";
  }

  return "";
}

function uniqueText(values = []) {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function extractContactInfo(text = "") {
  const normalized = String(text || "");
  const emailMatch = normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phoneMatch = normalized.match(/(?:\+?\d[\d().\-\s]{6,}\d)/);
  const namePatterns = [
    /\b(?:my name is|i am|i'm|this is)\s+([\p{L}][\p{L}'-]+(?:\s+[\p{L}][\p{L}'-]+){0,2})\b/iu,
    /\b(?:a nevem|az en nevem|nevem)\s+([\p{L}][\p{L}'-]+(?:\s+[\p{L}][\p{L}'-]+){0,2})\b/iu,
  ];
  let name = "";

  for (const pattern of namePatterns) {
    const match = normalized.match(pattern);
    if (cleanText(match?.[1])) {
      name = cleanText(match[1]);
      break;
    }
  }

  return {
    name,
    email: emailMatch ? normalizeEmail(emailMatch[0]) : "",
    phone: phoneMatch ? normalizePhone(phoneMatch[0]) : "",
    phoneNormalized: phoneMatch ? normalizePhoneDigits(phoneMatch[0]) : "",
  };
}

function isHungarian(language = "") {
  return cleanText(language).toLowerCase() === "hungarian";
}

function getTimestamp(value) {
  const timestamp = new Date(value || "").getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isRecent(value, windowMs) {
  const timestamp = getTimestamp(value);
  return Boolean(timestamp) && (Date.now() - timestamp) < windowMs;
}

function buildLeadKey({ email, phoneNormalized, personKey, sessionKey, actionKey }) {
  if (email) {
    return `email:${email}`;
  }

  if (phoneNormalized) {
    return `phone:${phoneNormalized}`;
  }

  if (personKey) {
    return `person:${personKey}`;
  }

  if (sessionKey) {
    return `session:${sessionKey}`;
  }

  return `action:${cleanText(actionKey) || "lead"}`;
}

function normalizeLeadRecord(record = {}) {
  if (!record || typeof record !== "object") {
    return {
      id: "",
      agentId: "",
      businessId: "",
      ownerUserId: "",
      installId: "",
      leadKey: "",
      personKey: "",
      visitorSessionKey: "",
      captureState: "none",
      preferredChannel: "",
      contactName: "",
      contactEmail: "",
      contactPhone: "",
      contactPhoneNormalized: "",
      sourcePageUrl: "",
      sourceOrigin: "",
      latestIntentType: "",
      latestActionType: "",
      latestActionKey: "",
      latestMessageId: "",
      relatedActionKeys: [],
      promptCount: 0,
      promptedAt: null,
      capturedAt: null,
      declinedAt: null,
      blockedAt: null,
      firstSeenAt: null,
      lastSeenAt: null,
      captureTrigger: "",
      captureReason: "",
      capturePrompt: "",
      captureSource: "widget_live_chat",
      captureMetadata: {},
      relatedFollowUpId: "",
      createdAt: null,
      updatedAt: null,
    };
  }

  return {
    id: cleanText(record.id),
    agentId: cleanText(record.agentId || record.agent_id),
    businessId: cleanText(record.businessId || record.business_id),
    ownerUserId: cleanText(record.ownerUserId || record.owner_user_id),
    installId: cleanText(record.installId || record.install_id),
    leadKey: cleanText(record.leadKey || record.lead_key),
    personKey: cleanText(record.personKey || record.person_key),
    visitorSessionKey: cleanText(record.visitorSessionKey || record.visitor_session_key),
    captureState: normalizeState(record.captureState || record.capture_state),
    preferredChannel: normalizePreferredChannel(record.preferredChannel || record.preferred_channel),
    contactName: cleanText(record.contactName || record.contact_name),
    contactEmail: normalizeEmail(record.contactEmail || record.contact_email),
    contactPhone: normalizePhone(record.contactPhone || record.contact_phone),
    contactPhoneNormalized: normalizePhoneDigits(record.contactPhoneNormalized || record.contact_phone_normalized || record.contactPhone || record.contact_phone),
    sourcePageUrl: cleanText(record.sourcePageUrl || record.source_page_url),
    sourceOrigin: cleanText(record.sourceOrigin || record.source_origin),
    latestIntentType: cleanText(record.latestIntentType || record.latest_intent_type),
    latestActionType: cleanText(record.latestActionType || record.latest_action_type),
    latestActionKey: cleanText(record.latestActionKey || record.latest_action_key),
    latestMessageId: cleanText(record.latestMessageId || record.latest_message_id),
    relatedActionKeys: uniqueText(record.relatedActionKeys || record.related_action_keys || []),
    promptCount: Number(record.promptCount || record.prompt_count || 0) || 0,
    promptedAt: record.promptedAt || record.prompted_at || null,
    capturedAt: record.capturedAt || record.captured_at || null,
    declinedAt: record.declinedAt || record.declined_at || null,
    blockedAt: record.blockedAt || record.blocked_at || null,
    firstSeenAt: record.firstSeenAt || record.first_seen_at || null,
    lastSeenAt: record.lastSeenAt || record.last_seen_at || null,
    captureTrigger: cleanText(record.captureTrigger || record.capture_trigger),
    captureReason: cleanText(record.captureReason || record.capture_reason),
    capturePrompt: cleanText(record.capturePrompt || record.capture_prompt),
    captureSource: cleanText(record.captureSource || record.capture_source) || "widget_live_chat",
    captureMetadata: record.captureMetadata || record.capture_metadata || {},
    relatedFollowUpId: cleanText(record.relatedFollowUpId || record.related_follow_up_id),
    createdAt: record.createdAt || record.created_at || null,
    updatedAt: record.updatedAt || record.updated_at || null,
  };
}

function buildPublicLeadCapture(record = {}, options = {}) {
  const normalized = normalizeLeadRecord(record);
  const followUp = options.followUp && typeof options.followUp === "object"
    ? {
        id: cleanText(options.followUp.id),
        status: cleanText(options.followUp.status),
      }
    : null;

  return {
    id: normalized.id || null,
    state: options.stateOverride || normalized.captureState,
    shouldPrompt: options.shouldPrompt === true,
    prompt: options.prompt || (normalized.capturePrompt ? { body: normalized.capturePrompt } : null),
    reason: normalized.captureReason || options.reason || "",
    trigger: normalized.captureTrigger || options.trigger || "",
    latestMessageId: normalized.latestMessageId || "",
    preferredChannel: normalized.preferredChannel || "",
    personKey: normalized.personKey || "",
    latestActionKey: normalized.latestActionKey || "",
    relatedFollowUpId: normalized.relatedFollowUpId || "",
    contact: {
      name: normalized.contactName || "",
      email: normalized.contactEmail || "",
      phone: normalized.contactPhone || "",
    },
    promptCount: normalized.promptCount,
    isReturningVisitor: options.isReturningVisitor === true,
    followUp,
    message: options.message || "",
  };
}

function pickLatestItem(items = []) {
  return [...items].sort((left, right) => getTimestamp(right.lastSeenAt) - getTimestamp(left.lastSeenAt))[0] || null;
}

function detectExplicitCaptureLanguage(message = "") {
  const normalized = cleanText(message).toLowerCase();

  if (!normalized) {
    return "";
  }

  if (
    normalized.includes("call me")
    || normalized.includes("call back")
    || normalized.includes("callback")
    || normalized.includes("reach out")
    || normalized.includes("contact me")
    || normalized.includes("get in touch")
  ) {
    return "direct_follow_up";
  }

  if (normalized.includes("quote") || normalized.includes("estimate")) {
    return "quote_request";
  }

  return "";
}

function detectCurrentHighIntentAction(message = "") {
  const normalized = cleanText(message).toLowerCase();

  if (!normalized) {
    return null;
  }

  if (
    normalized.includes("call me")
    || normalized.includes("call back")
    || normalized.includes("callback")
    || normalized.includes("contact me")
    || normalized.includes("reach me")
    || normalized.includes("email me")
    || normalized.includes("phone me")
    || normalized.includes("get in touch")
  ) {
    return {
      actionType: "lead_follow_up",
      intent: "contact",
      whyFlagged: "Flagged because this visitor asked for direct contact or a callback.",
    };
  }

  if (
    normalized.includes("book")
    || normalized.includes("booking")
    || normalized.includes("appointment")
    || normalized.includes("schedule")
    || normalized.includes("availability")
    || normalized.includes("reserve")
    || normalized.includes("consultation")
    || normalized.includes("demo")
  ) {
    return {
      actionType: "booking_intent",
      intent: "booking",
      whyFlagged: "Flagged because this visitor asked about booking, scheduling, or availability.",
    };
  }

  if (
    normalized.includes("quote")
    || normalized.includes("estimate")
    || normalized.includes("pricing")
    || normalized.includes("price")
    || normalized.includes("cost")
    || normalized.includes("how much")
    || normalized.includes("buy")
    || normalized.includes("purchase")
    || normalized.includes("order")
    || normalized.includes("checkout")
  ) {
    return {
      actionType: "pricing_interest",
      intent: "pricing",
      whyFlagged: "Flagged because this visitor asked about pricing, quotes, or purchase intent.",
    };
  }

  return null;
}

function buildPromptBody(actionType, language, reason, businessName) {
  const label = cleanText(businessName) || "the team";

  if (isHungarian(language)) {
    switch (actionType) {
      case "pricing_interest":
        return `Ha szeretnéd, elküldjük az árazási részleteket ${label} nevében. Mi a legjobb email-cím vagy telefonszám hozzá?`;
      case "booking_intent":
        return `Ha szeretnéd, megszervezzük a következő lépést ${label} csapatával. Mi a legjobb email-cím vagy telefonszám hozzá?`;
      default:
        return reason === "repeat_high_intent_visitor"
          ? `Látszik, hogy komoly érdeklődés van. Ha szeretnéd, ${label} csapata közvetlenül folytathatja veled. Mi a legjobb email-cím vagy telefonszám?`
          : `Ha szeretnéd, ${label} csapata közvetlenül folytathatja veled. Mi a legjobb email-cím vagy telefonszám?`;
    }
  }

  switch (actionType) {
    case "pricing_interest":
      return `If you'd like, ${label} can send pricing details directly. What's the best email or phone number to use?`;
    case "booking_intent":
      return `If you'd like, ${label} can follow up and help arrange the next step. What's the best email or phone number to use?`;
    default:
      return reason === "repeat_high_intent_visitor"
        ? `If you'd like, ${label} can follow up directly while this is still warm. What's the best email or phone number to use?`
        : `If you'd like, ${label} can follow up directly. What's the best email or phone number to use?`;
  }
}

function buildSuccessMessage(language, channel) {
  if (isHungarian(language)) {
    return channel === "phone"
      ? "Köszönöm. Elmentettem a telefonszámot, és a csapat ezen tud továbbmenni."
      : "Köszönöm. Elmentettem az elérhetőséget, és a csapat innen tud továbbmenni.";
  }

  return channel === "phone"
    ? "Thanks. I saved the phone number so the team can follow up from here."
    : "Thanks. I saved the contact details so the team can follow up from here.";
}

function buildDeclinedMessage(language) {
  return isHungarian(language)
    ? "Rendben, maradhatunk itt a chatben."
    : "No problem. We can keep going here in chat.";
}

function getSessionLeadContext(actionQueue = {}, sessionKey = "", message = "") {
  const items = Array.isArray(actionQueue.items) ? actionQueue.items : [];
  const sessionItems = items.filter((item) => cleanText(item.sessionKey) === cleanText(sessionKey));
  const latestSessionItem = pickLatestItem(sessionItems);
  const personKey = cleanText(latestSessionItem?.person?.key || latestSessionItem?.personKey);
  const repeatItem = personKey
    ? items.find((item) =>
      cleanText(item.actionType) === "repeat_high_intent_visitor"
      && cleanText(item.person?.key || item.personKey) === personKey)
    : null;
  const explicitTrigger = detectExplicitCaptureLanguage(message);
  const currentHighIntent = detectCurrentHighIntentAction(message);
  const syntheticTriggerItem = currentHighIntent
    ? {
      key: cleanText(latestSessionItem?.key) || `live:${cleanText(sessionKey) || "session"}:${cleanText(currentHighIntent.actionType)}`,
      actionType: currentHighIntent.actionType,
      intent: currentHighIntent.intent,
      whyFlagged: currentHighIntent.whyFlagged,
      messageId: cleanText(latestSessionItem?.messageId),
      sessionKey: cleanText(sessionKey),
      personKey,
    }
    : null;

  let triggerItem = null;
  let triggerCode = "";

  if (repeatItem) {
    triggerItem = repeatItem;
    triggerCode = "repeat_high_intent_visitor";
  }

  if (latestSessionItem && ACTIVE_HIGH_INTENT_ACTION_TYPES.has(cleanText(latestSessionItem.actionType))) {
    triggerItem = latestSessionItem;
    triggerCode = cleanText(latestSessionItem.actionType);
  }

  if (latestSessionItem && latestSessionItem.unresolved && ACTIVE_HIGH_INTENT_ACTION_TYPES.has(cleanText(latestSessionItem.actionType))) {
    triggerItem = latestSessionItem;
    triggerCode = "unresolved_high_value_question";
  }

  if (syntheticTriggerItem) {
    triggerItem = syntheticTriggerItem;
    triggerCode = cleanText(syntheticTriggerItem.actionType);
  }

  if (explicitTrigger && latestSessionItem && ACTIVE_HIGH_INTENT_ACTION_TYPES.has(cleanText(latestSessionItem.actionType))) {
    triggerItem = latestSessionItem;
    triggerCode = explicitTrigger;
  }

  if (explicitTrigger && syntheticTriggerItem) {
    triggerItem = syntheticTriggerItem;
    triggerCode = explicitTrigger;
  }

  return {
    latestSessionItem,
    personKey,
    repeatItem,
    triggerItem,
    triggerCode,
    isReturningVisitor: repeatItem?.person?.isReturning === true || latestSessionItem?.person?.isReturning === true,
  };
}

async function listLeadCaptureRecordsInternal(supabase, options = {}) {
  const agentId = cleanText(options.agentId);
  const ownerUserId = cleanText(options.ownerUserId);

  if (!agentId || !ownerUserId) {
    return {
      records: [],
      persistenceAvailable: true,
    };
  }

  const { data, error } = await supabase
    .from(LEAD_CAPTURE_TABLE)
    .select(LEAD_CAPTURE_SELECT)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) {
    if (isMissingRelationError(error, LEAD_CAPTURE_TABLE)) {
      return {
        records: [],
        persistenceAvailable: false,
      };
    }

    console.error(error);
    throw error;
  }

  return {
    records: (data || []).map((record) => normalizeLeadRecord(record)),
    persistenceAvailable: true,
  };
}

function pickExistingLead(records = [], options = {}) {
  const email = normalizeEmail(options.email);
  const phoneNormalized = normalizePhoneDigits(options.phoneNormalized || options.phone);
  const personKey = cleanText(options.personKey);
  const sessionKey = cleanText(options.sessionKey);

  return records.find((record) =>
    (email && record.contactEmail === email)
    || (phoneNormalized && record.contactPhoneNormalized === phoneNormalized)
    || (personKey && record.personKey === personKey)
    || (sessionKey && record.visitorSessionKey === sessionKey)
  ) || null;
}

function mergeLeadPayload(existing, payload) {
  const current = normalizeLeadRecord(existing || {});
  const next = {
    ...current,
    ...payload,
  };

  next.contactName = cleanText(payload.contactName || current.contactName);
  next.contactEmail = normalizeEmail(payload.contactEmail || current.contactEmail);
  next.contactPhone = normalizePhone(payload.contactPhone || current.contactPhone);
  next.contactPhoneNormalized = normalizePhoneDigits(payload.contactPhoneNormalized || payload.contactPhone || current.contactPhoneNormalized || current.contactPhone);
  next.preferredChannel = normalizePreferredChannel(payload.preferredChannel || current.preferredChannel || getPreferredChannel(next));
  next.relatedActionKeys = uniqueText([
    ...(current.relatedActionKeys || []),
    ...(payload.relatedActionKeys || []),
  ]);
  next.firstSeenAt = current.firstSeenAt || payload.firstSeenAt || new Date().toISOString();
  next.lastSeenAt = payload.lastSeenAt || current.lastSeenAt || new Date().toISOString();
  next.captureMetadata = {
    ...(current.captureMetadata || {}),
    ...(payload.captureMetadata || {}),
  };
  next.leadKey = buildLeadKey({
    email: next.contactEmail,
    phoneNormalized: next.contactPhoneNormalized,
    personKey: next.personKey,
    sessionKey: next.visitorSessionKey,
    actionKey: next.latestActionKey,
  });

  return next;
}

async function insertLeadCaptureRecord(supabase, payload) {
  const { data, error } = await supabase
    .from(LEAD_CAPTURE_TABLE)
    .insert({
      agent_id: payload.agentId,
      business_id: payload.businessId || null,
      owner_user_id: payload.ownerUserId || null,
      install_id: payload.installId || null,
      lead_key: payload.leadKey,
      person_key: payload.personKey || null,
      visitor_session_key: payload.visitorSessionKey || null,
      capture_state: payload.captureState,
      preferred_channel: payload.preferredChannel || null,
      contact_name: payload.contactName || null,
      contact_email: payload.contactEmail || null,
      contact_phone: payload.contactPhone || null,
      contact_phone_normalized: payload.contactPhoneNormalized || null,
      source_page_url: payload.sourcePageUrl || null,
      source_origin: payload.sourceOrigin || null,
      latest_intent_type: payload.latestIntentType || null,
      latest_action_type: payload.latestActionType || null,
      latest_action_key: payload.latestActionKey || null,
      latest_message_id: payload.latestMessageId || null,
      related_action_keys: payload.relatedActionKeys || [],
      prompt_count: payload.promptCount || 0,
      prompted_at: payload.promptedAt || null,
      captured_at: payload.capturedAt || null,
      declined_at: payload.declinedAt || null,
      blocked_at: payload.blockedAt || null,
      first_seen_at: payload.firstSeenAt || new Date().toISOString(),
      last_seen_at: payload.lastSeenAt || new Date().toISOString(),
      capture_trigger: payload.captureTrigger || null,
      capture_reason: payload.captureReason || null,
      capture_prompt: payload.capturePrompt || null,
      capture_source: payload.captureSource || "widget_live_chat",
      capture_metadata: payload.captureMetadata || {},
      related_follow_up_id: payload.relatedFollowUpId || null,
      updated_at: new Date().toISOString(),
    })
    .select(LEAD_CAPTURE_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return normalizeLeadRecord(data);
}

async function updateLeadCaptureRecord(supabase, payload) {
  const { data, error } = await supabase
    .from(LEAD_CAPTURE_TABLE)
    .update({
      business_id: payload.businessId || null,
      owner_user_id: payload.ownerUserId || null,
      install_id: payload.installId || null,
      lead_key: payload.leadKey,
      person_key: payload.personKey || null,
      visitor_session_key: payload.visitorSessionKey || null,
      capture_state: payload.captureState,
      preferred_channel: payload.preferredChannel || null,
      contact_name: payload.contactName || null,
      contact_email: payload.contactEmail || null,
      contact_phone: payload.contactPhone || null,
      contact_phone_normalized: payload.contactPhoneNormalized || null,
      source_page_url: payload.sourcePageUrl || null,
      source_origin: payload.sourceOrigin || null,
      latest_intent_type: payload.latestIntentType || null,
      latest_action_type: payload.latestActionType || null,
      latest_action_key: payload.latestActionKey || null,
      latest_message_id: payload.latestMessageId || null,
      related_action_keys: payload.relatedActionKeys || [],
      prompt_count: payload.promptCount || 0,
      prompted_at: payload.promptedAt || null,
      captured_at: payload.capturedAt || null,
      declined_at: payload.declinedAt || null,
      blocked_at: payload.blockedAt || null,
      first_seen_at: payload.firstSeenAt || null,
      last_seen_at: payload.lastSeenAt || null,
      capture_trigger: payload.captureTrigger || null,
      capture_reason: payload.captureReason || null,
      capture_prompt: payload.capturePrompt || null,
      capture_source: payload.captureSource || "widget_live_chat",
      capture_metadata: payload.captureMetadata || {},
      related_follow_up_id: payload.relatedFollowUpId || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", payload.id)
    .select(LEAD_CAPTURE_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return normalizeLeadRecord(data);
}

async function persistLeadCaptureRecord(supabase, existing, payload) {
  try {
    return existing?.id
      ? await updateLeadCaptureRecord(supabase, payload)
      : await insertLeadCaptureRecord(supabase, payload);
  } catch (error) {
    if (isMissingRelationError(error, LEAD_CAPTURE_TABLE)) {
      return null;
    }

    console.error("[lead capture] Failed to persist lead capture:", {
      leadId: existing?.id || null,
      agentId: payload.agentId || null,
      sessionKey: payload.visitorSessionKey || null,
      message: error.message,
    });
    throw error;
  }
}

function resolveFollowUpForLead(followUps = [], record = {}) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const normalizedRecord = normalizeLeadRecord(record);
  return (followUps || []).find((followUp) =>
    cleanText(followUp.id) === normalizedRecord.relatedFollowUpId
    || (normalizedRecord.personKey && cleanText(followUp.personKey) === normalizedRecord.personKey)
    || (normalizedRecord.relatedActionKeys || []).some((actionKey) =>
      cleanText(followUp.sourceActionKey) === actionKey
      || (Array.isArray(followUp.linkedActionKeys) && followUp.linkedActionKeys.map((entry) => cleanText(entry)).includes(actionKey))
    )
  ) || null;
}

function enrichQueueItemsWithLead(queueItems = [], leadRecord = null) {
  const normalizedLead = leadRecord ? normalizeLeadRecord(leadRecord) : null;

  if (!normalizedLead) {
    return queueItems;
  }

  return queueItems.map((item) => {
    const matchesLead = (
      normalizedLead.relatedActionKeys.includes(cleanText(item.key))
      || (normalizedLead.personKey && normalizedLead.personKey === cleanText(item.person?.key || item.personKey))
      || (normalizedLead.visitorSessionKey && normalizedLead.visitorSessionKey === cleanText(item.sessionKey))
    );

    if (!matchesLead) {
      return item;
    }

    return {
      ...item,
      personKey: cleanText(item.personKey || normalizedLead.personKey),
      contactCaptured: hasUsableContact(normalizedLead),
      contactInfo: {
        name: normalizedLead.contactName || item.contactInfo?.name || null,
        email: normalizedLead.contactEmail || item.contactInfo?.email || null,
        phone: normalizedLead.contactPhone || item.contactInfo?.phone || null,
      },
    };
  });
}

function buildDecisionFromContext(options = {}) {
  const existing = normalizeLeadRecord(options.existing || {});
  const sessionContext = options.sessionContext || {};
  const language = options.language;
  const businessName = options.businessName;
  const contact = options.contact || {};
  const hasContact = hasUsableContact(contact);
  const hasPartial = Boolean(cleanText(contact.name) || cleanText(contact.email) || cleanText(contact.phone));

  if (options.ownerScopeMissing) {
    return {
      nextState: "blocked",
      trigger: "owner_scope_missing",
      reason: "Lead capture is blocked because this assistant is not tied to an active owner scope yet.",
      shouldPrompt: false,
      prompt: null,
    };
  }

  if (existing.captureState === "captured" && hasUsableContact(existing)) {
    return {
      nextState: "captured",
      trigger: cleanText(existing.captureTrigger || sessionContext.triggerCode),
      reason: cleanText(existing.captureReason),
      shouldPrompt: false,
      prompt: null,
    };
  }

  if (hasContact && (sessionContext.triggerItem || existing.captureState === "prompted" || existing.captureState === "partial_contact" || existing.captureState === "prompt_ready" || existing.id)) {
    return {
      nextState: "captured",
      trigger: cleanText(sessionContext.triggerCode || existing.captureTrigger || existing.latestActionType),
      reason: cleanText(sessionContext.triggerItem?.whyFlagged || existing.captureReason),
      shouldPrompt: false,
      prompt: null,
      message: buildSuccessMessage(language, getPreferredChannel(contact)),
    };
  }

  if (!hasContact && hasPartial && (existing.captureState === "prompted" || existing.captureState === "partial_contact" || sessionContext.triggerItem)) {
    return {
      nextState: "partial_contact",
      trigger: cleanText(sessionContext.triggerCode || existing.captureTrigger || existing.latestActionType),
      reason: cleanText(sessionContext.triggerItem?.whyFlagged || existing.captureReason),
      shouldPrompt: true,
      prompt: {
        body: buildPromptBody(cleanText(sessionContext.triggerItem?.actionType || existing.latestActionType), language, cleanText(sessionContext.triggerCode), businessName),
      },
    };
  }

  if (existing.captureState === "declined" && isRecent(existing.declinedAt, DECLINE_COOLDOWN_MS)) {
    return {
      nextState: "declined",
      trigger: cleanText(existing.captureTrigger || sessionContext.triggerCode),
      reason: "Capture was recently declined, so Vonza is holding off instead of asking again immediately.",
      shouldPrompt: false,
      prompt: null,
    };
  }

  if (existing.captureState === "prompted" && isRecent(existing.promptedAt, PROMPT_COOLDOWN_MS)) {
    return {
      nextState: "prompted",
      trigger: cleanText(existing.captureTrigger || sessionContext.triggerCode),
      reason: cleanText(existing.captureReason || sessionContext.triggerItem?.whyFlagged),
      shouldPrompt: false,
      prompt: null,
    };
  }

  if (!sessionContext.triggerItem) {
    return {
      nextState: existing.captureState && existing.captureState !== "none" ? existing.captureState : "none",
      trigger: cleanText(existing.captureTrigger),
      reason: cleanText(existing.captureReason),
      shouldPrompt: false,
      prompt: null,
    };
  }

  const prompt = {
    body: buildPromptBody(cleanText(sessionContext.triggerItem.actionType), language, cleanText(sessionContext.triggerCode), businessName),
  };

  return {
    nextState: "prompt_ready",
    trigger: cleanText(sessionContext.triggerCode || sessionContext.triggerItem.actionType),
    reason: cleanText(sessionContext.triggerItem.whyFlagged),
    shouldPrompt: true,
    prompt,
  };
}

async function syncLeadFollowUp(supabase, options = {}) {
  if (!cleanText(options.agent?.ownerUserId)) {
    return {
      records: [],
      persistenceAvailable: true,
    };
  }

  const queueItems = enrichQueueItemsWithLead(options.queueItems || [], options.leadRecord);

  return await syncFollowUpWorkflows(supabase, {
    agentId: options.agent.id,
    ownerUserId: options.agent.ownerUserId,
    queueItems,
    agentProfile: {
      agentId: options.agent.id,
      ownerUserId: options.agent.ownerUserId,
      businessName: options.agent.name || options.business?.name || "",
      assistantName: options.widgetConfig?.assistantName || options.agent.name || "",
    },
  });
}

async function maybeAttachFollowUpId(supabase, leadRecord, followUpSync) {
  const followUp = resolveFollowUpForLead(followUpSync?.records || [], leadRecord);

  if (!leadRecord?.id || !followUp?.id || cleanText(leadRecord.relatedFollowUpId) === cleanText(followUp.id)) {
    return {
      leadRecord,
      followUp,
    };
  }

  const updated = await persistLeadCaptureRecord(supabase, leadRecord, mergeLeadPayload(leadRecord, {
    relatedFollowUpId: followUp.id,
  }));

  return {
    leadRecord: updated || leadRecord,
    followUp,
  };
}

async function buildLiveLeadContext(supabase, options = {}) {
  const messages = await listAgentMessages(supabase, options.agent.id);
  const actionQueue = buildActionQueue(messages, []);
  const sessionContext = getSessionLeadContext(actionQueue, options.sessionKey, options.userMessage);
  const listed = await listLeadCaptureRecordsInternal(supabase, {
    agentId: options.agent.id,
    ownerUserId: options.agent.ownerUserId,
  });
  const extractedContact = extractContactInfo(options.userMessage);
  const existing = pickExistingLead(listed.records, {
    email: extractedContact.email,
    phone: extractedContact.phone,
    phoneNormalized: extractedContact.phoneNormalized,
    personKey: sessionContext.personKey,
    sessionKey: options.sessionKey,
  });

  return {
    messages,
    actionQueue,
    sessionContext,
    extractedContact,
    existing,
    leadPersistenceAvailable: listed.persistenceAvailable,
    leadRecords: listed.records,
  };
}

export async function processLiveChatLeadCapture(supabase, options = {}) {
  const agent = options.agent || {};
  const business = options.business || {};
  const widgetConfig = options.widgetConfig || {};
  const language = options.language;
  const sessionKey = cleanText(options.sessionKey);
  const ownerScopeMissing = !cleanText(agent.ownerUserId);
  const context = await buildLiveLeadContext(supabase, {
    agent,
    sessionKey,
    userMessage: options.userMessage,
  });
  const decision = buildDecisionFromContext({
    existing: context.existing,
    sessionContext: context.sessionContext,
    language,
    businessName: widgetConfig.assistantName || agent.name || business.name,
    contact: context.extractedContact,
    ownerScopeMissing,
  });

  let leadRecord = context.existing ? normalizeLeadRecord(context.existing) : null;

  if (!ownerScopeMissing && decision.nextState !== "none" && context.leadPersistenceAvailable !== false) {
    const mergedPayload = mergeLeadPayload(leadRecord, {
      agentId: cleanText(agent.id),
      businessId: cleanText(business.id),
      ownerUserId: cleanText(agent.ownerUserId),
      installId: cleanText(options.installId || widgetConfig.installId),
      visitorSessionKey: sessionKey || null,
      personKey: cleanText(context.sessionContext.personKey || leadRecord?.personKey),
      captureState: decision.nextState,
      preferredChannel: getPreferredChannel(context.extractedContact),
      contactName: context.extractedContact.name || leadRecord?.contactName || "",
      contactEmail: context.extractedContact.email || leadRecord?.contactEmail || "",
      contactPhone: context.extractedContact.phone || leadRecord?.contactPhone || "",
      contactPhoneNormalized: context.extractedContact.phoneNormalized || leadRecord?.contactPhoneNormalized || "",
      sourcePageUrl: cleanText(options.pageUrl),
      sourceOrigin: cleanText(options.origin),
      latestIntentType: cleanText(context.sessionContext.latestSessionItem?.intent || leadRecord?.latestIntentType),
      latestActionType: cleanText(context.sessionContext.triggerItem?.actionType || context.sessionContext.latestSessionItem?.actionType || leadRecord?.latestActionType),
      latestActionKey: cleanText(context.sessionContext.triggerItem?.key || context.sessionContext.latestSessionItem?.key || leadRecord?.latestActionKey),
      latestMessageId: cleanText(context.sessionContext.latestSessionItem?.messageId || leadRecord?.latestMessageId),
      relatedActionKeys: uniqueText([
        cleanText(context.sessionContext.latestSessionItem?.key),
        cleanText(context.sessionContext.repeatItem?.key),
        ...(leadRecord?.relatedActionKeys || []),
      ]),
      lastSeenAt: new Date().toISOString(),
      captureTrigger: decision.trigger,
      captureReason: decision.reason,
      capturePrompt: decision.prompt?.body || leadRecord?.capturePrompt || "",
      captureMetadata: {
        isReturningVisitor: context.sessionContext.isReturningVisitor === true,
      },
      blockedAt: decision.nextState === "blocked" ? new Date().toISOString() : leadRecord?.blockedAt || null,
      capturedAt: decision.nextState === "captured"
        ? (leadRecord?.capturedAt || new Date().toISOString())
        : leadRecord?.capturedAt || null,
    });

    leadRecord = await persistLeadCaptureRecord(supabase, leadRecord, mergedPayload) || leadRecord;

    if (leadRecord) {
      console.info("[lead capture] Live lead state updated from chat.", {
        agentId: agent.id,
        sessionKey,
        leadId: leadRecord.id,
        state: leadRecord.captureState,
        trigger: leadRecord.captureTrigger,
      });
    }
  } else if (decision.trigger) {
    console.info("[lead capture] Prompt suppressed in live chat.", {
      agentId: agent.id,
      sessionKey,
      state: decision.nextState,
      trigger: decision.trigger,
      reason: decision.reason,
    });
  }

  let followUpSync = {
    records: [],
    persistenceAvailable: true,
  };

  if (!ownerScopeMissing) {
    followUpSync = await syncLeadFollowUp(supabase, {
      agent,
      business,
      widgetConfig,
      queueItems: context.actionQueue.items || [],
      leadRecord,
    });
  }

  const attached = await maybeAttachFollowUpId(supabase, leadRecord, followUpSync);

  return buildPublicLeadCapture(attached.leadRecord || leadRecord || {}, {
    stateOverride: decision.nextState === "prompt_ready"
      ? "prompt_ready"
      : normalizeState(attached.leadRecord?.captureState || leadRecord?.captureState || decision.nextState),
    shouldPrompt: decision.shouldPrompt,
    prompt: decision.prompt,
    trigger: decision.trigger,
    reason: decision.reason,
    message: decision.message,
    followUp: attached.followUp,
    isReturningVisitor: context.sessionContext.isReturningVisitor === true,
  });
}

export async function applyLeadCaptureAction(supabase, options = {}) {
  const agent = options.agent || {};
  const business = options.business || {};
  const widgetConfig = options.widgetConfig || {};
  const action = cleanText(options.action).toLowerCase();
  const language = options.language;
  const sessionKey = cleanText(options.sessionKey);
  const ownerScopeMissing = !cleanText(agent.ownerUserId);
  const context = await buildLiveLeadContext(supabase, {
    agent,
    sessionKey,
    userMessage: options.userMessage || "",
  });
  const formContact = {
    name: cleanText(options.name),
    email: normalizeEmail(options.email),
    phone: normalizePhone(options.phone),
    phoneNormalized: normalizePhoneDigits(options.phone),
    preferredChannel: normalizePreferredChannel(options.preferredChannel),
  };
  const mergedContact = {
    name: formContact.name || context.extractedContact.name || "",
    email: formContact.email || context.extractedContact.email || "",
    phone: formContact.phone || context.extractedContact.phone || "",
    phoneNormalized: formContact.phoneNormalized || context.extractedContact.phoneNormalized || "",
    preferredChannel: formContact.preferredChannel || getPreferredChannel(formContact),
  };
  const existing = context.existing ? normalizeLeadRecord(context.existing) : null;
  let nextState = existing?.captureState || "none";
  let message = "";

  if (ownerScopeMissing) {
    return buildPublicLeadCapture(existing || {}, {
      stateOverride: "blocked",
      reason: "Lead capture is blocked because this assistant is not tied to an active owner scope yet.",
      trigger: "owner_scope_missing",
    });
  }

  if (action === "prompt_shown") {
    nextState = "prompted";
  } else if (action === "decline") {
    nextState = "declined";
    message = buildDeclinedMessage(language);
  } else if (action === "submit") {
    nextState = hasUsableContact({
      email: mergedContact.email,
      phone: mergedContact.phone,
    })
      ? "captured"
      : "partial_contact";
    message = nextState === "captured"
      ? buildSuccessMessage(language, getPreferredChannel(mergedContact))
      : buildPromptBody(cleanText(context.sessionContext.triggerItem?.actionType || existing?.latestActionType), language, cleanText(context.sessionContext.triggerCode || existing?.captureTrigger), widgetConfig.assistantName || agent.name || business.name);
  }

  const decision = buildDecisionFromContext({
    existing,
    sessionContext: context.sessionContext,
    language,
    businessName: widgetConfig.assistantName || agent.name || business.name,
    contact: mergedContact,
  });
  const payload = mergeLeadPayload(existing, {
    agentId: cleanText(agent.id),
    businessId: cleanText(business.id),
    ownerUserId: cleanText(agent.ownerUserId),
    installId: cleanText(options.installId || widgetConfig.installId),
    visitorSessionKey: sessionKey || null,
    personKey: cleanText(context.sessionContext.personKey || existing?.personKey),
    captureState: nextState,
    preferredChannel: mergedContact.preferredChannel || getPreferredChannel(mergedContact),
    contactName: mergedContact.name || existing?.contactName || "",
    contactEmail: mergedContact.email || existing?.contactEmail || "",
    contactPhone: mergedContact.phone || existing?.contactPhone || "",
    contactPhoneNormalized: mergedContact.phoneNormalized || existing?.contactPhoneNormalized || "",
    sourcePageUrl: cleanText(options.pageUrl),
    sourceOrigin: cleanText(options.origin),
    latestIntentType: cleanText(context.sessionContext.latestSessionItem?.intent || existing?.latestIntentType),
    latestActionType: cleanText(context.sessionContext.triggerItem?.actionType || context.sessionContext.latestSessionItem?.actionType || existing?.latestActionType),
    latestActionKey: cleanText(context.sessionContext.triggerItem?.key || context.sessionContext.latestSessionItem?.key || existing?.latestActionKey),
    latestMessageId: cleanText(context.sessionContext.latestSessionItem?.messageId || existing?.latestMessageId),
    relatedActionKeys: uniqueText([
      cleanText(context.sessionContext.latestSessionItem?.key),
      cleanText(context.sessionContext.repeatItem?.key),
      ...(existing?.relatedActionKeys || []),
    ]),
    promptCount: action === "prompt_shown" ? (existing?.promptCount || 0) + 1 : existing?.promptCount || 0,
    promptedAt: action === "prompt_shown" ? new Date().toISOString() : existing?.promptedAt || null,
    declinedAt: action === "decline" ? new Date().toISOString() : existing?.declinedAt || null,
    capturedAt: nextState === "captured"
      ? (existing?.capturedAt || new Date().toISOString())
      : existing?.capturedAt || null,
    captureTrigger: cleanText(context.sessionContext.triggerCode || decision.trigger || existing?.captureTrigger),
    captureReason: cleanText(context.sessionContext.triggerItem?.whyFlagged || decision.reason || existing?.captureReason),
    capturePrompt: cleanText(decision.prompt?.body || existing?.capturePrompt),
    captureMetadata: {
      isReturningVisitor: context.sessionContext.isReturningVisitor === true,
    },
    lastSeenAt: new Date().toISOString(),
  });

  let leadRecord = await persistLeadCaptureRecord(supabase, existing, payload) || existing;

  let followUpSync = {
    records: [],
    persistenceAvailable: true,
  };

  if (action === "submit" || action === "decline") {
    followUpSync = await syncLeadFollowUp(supabase, {
      agent,
      business,
      widgetConfig,
      queueItems: context.actionQueue.items || [],
      leadRecord,
    });
  }

  const attached = await maybeAttachFollowUpId(supabase, leadRecord, followUpSync);
  leadRecord = attached.leadRecord || leadRecord;

  console.info("[lead capture] Lead action applied.", {
    agentId: agent.id,
    sessionKey,
    action,
    leadId: leadRecord?.id || null,
    state: leadRecord?.captureState || nextState,
  });

  return buildPublicLeadCapture(leadRecord || {}, {
    stateOverride: leadRecord?.captureState || nextState,
    reason: leadRecord?.captureReason || decision.reason,
    trigger: leadRecord?.captureTrigger || decision.trigger,
    message,
    followUp: attached.followUp,
    shouldPrompt: leadRecord?.captureState === "partial_contact",
    prompt: leadRecord?.captureState === "partial_contact"
      ? { body: leadRecord.capturePrompt || decision.prompt?.body || "" }
      : null,
    isReturningVisitor: context.sessionContext.isReturningVisitor === true,
  });
}

function buildEmptyLeadCaptureSummary() {
  return {
    highIntentConversations: 0,
    capturePromptsShown: 0,
    contactsCaptured: 0,
    captureRate: 0,
    followUpsPrepared: 0,
    followUpsSent: 0,
    pricingCaptures: 0,
    bookingCaptures: 0,
    directCtasShown: 0,
    ctaClicks: 0,
    ctaClickThroughRate: 0,
    bookingDirectHandoffs: 0,
    quoteDirectHandoffs: 0,
    contactDirectHandoffs: 0,
    checkoutDirectHandoffs: 0,
    followUpFallbackCount: 0,
    directRouteCount: 0,
    captureFallbackCount: 0,
  };
}

export async function listLeadCaptures(supabase, options = {}) {
  const listed = await listLeadCaptureRecordsInternal(supabase, options);
  return {
    ...listed,
    summary: buildEmptyLeadCaptureSummary(),
  };
}

export function hydrateActionQueueWithLeadCaptures(actionQueue = {}, options = {}) {
  const queue = actionQueue && typeof actionQueue === "object" ? actionQueue : {};
  const leadRecords = (options.records || []).map((record) => normalizeLeadRecord(record));
  const outcomeRecords = (options.outcomes?.records || []).map((record) => ({
    id: cleanText(record.id),
    outcomeType: cleanText(record.outcomeType || record.outcome_type),
    label: cleanText(record.label),
    attributionPath: cleanText(record.attributionPath),
    actionKey: cleanText(record.actionKey || record.action_key),
    leadId: cleanText(record.leadId || record.lead_id),
    followUpId: cleanText(record.followUpId || record.follow_up_id),
    personKey: cleanText(record.personKey || record.person_key),
    sessionId: cleanText(record.sessionId || record.session_id),
    pageUrl: cleanText(record.pageUrl || record.page_url),
    relatedIntentType: cleanText(record.relatedIntentType || record.related_intent_type),
    occurredAt: record.occurredAt || record.occurred_at || record.createdAt || record.created_at || null,
  }));
  const followUps = Array.isArray(options.followUps) ? options.followUps : [];
  const widgetEvents = (options.widgetEvents || []).map((event) => {
    const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : {};

    return {
      eventName: cleanText(event.event_name || event.eventName),
      sessionKey: cleanText(event.session_id || event.sessionId),
      pageUrl: cleanText(event.page_url || event.pageUrl),
      createdAt: event.created_at || event.createdAt || null,
      ctaType: cleanText(metadata.ctaType),
      targetType: cleanText(metadata.targetType),
      relatedIntentType: cleanText(metadata.relatedIntentType),
      relatedActionKey: cleanText(metadata.relatedActionKey),
      relatedConversationId: cleanText(metadata.relatedConversationId),
      relatedPersonKey: cleanText(metadata.relatedPersonKey),
      routingMode: cleanText(metadata.routingMode),
    };
  });
  const items = Array.isArray(queue.items) ? queue.items : [];
  const actionMap = new Map();
  const personMap = new Map();
  const sessionMap = new Map();
  const widgetEventsByActionKey = new Map();
  const widgetEventsByPersonKey = new Map();
  const widgetEventsBySessionKey = new Map();
  const outcomesByActionKey = new Map();
  const outcomesByLeadId = new Map();
  const outcomesByFollowUpId = new Map();
  const outcomesByPersonKey = new Map();
  const outcomesBySessionKey = new Map();

  leadRecords.forEach((record) => {
    record.relatedActionKeys.forEach((actionKey) => {
      if (!actionMap.has(actionKey)) {
        actionMap.set(actionKey, record);
      }
    });

    if (record.personKey && !personMap.has(record.personKey)) {
      personMap.set(record.personKey, record);
    }

    if (record.visitorSessionKey && !sessionMap.has(record.visitorSessionKey)) {
      sessionMap.set(record.visitorSessionKey, record);
    }
  });

  widgetEvents.forEach((event) => {
    if (event.relatedActionKey) {
      widgetEventsByActionKey.set(
        event.relatedActionKey,
        [...(widgetEventsByActionKey.get(event.relatedActionKey) || []), event]
      );
    }

    if (event.relatedPersonKey) {
      widgetEventsByPersonKey.set(
        event.relatedPersonKey,
        [...(widgetEventsByPersonKey.get(event.relatedPersonKey) || []), event]
      );
    }

    if (event.sessionKey) {
      widgetEventsBySessionKey.set(
        event.sessionKey,
        [...(widgetEventsBySessionKey.get(event.sessionKey) || []), event]
      );
    }
  });

  outcomeRecords.forEach((outcome) => {
    if (outcome.actionKey) {
      outcomesByActionKey.set(
        outcome.actionKey,
        [...(outcomesByActionKey.get(outcome.actionKey) || []), outcome]
      );
    }

    if (outcome.leadId) {
      outcomesByLeadId.set(
        outcome.leadId,
        [...(outcomesByLeadId.get(outcome.leadId) || []), outcome]
      );
    }

    if (outcome.followUpId) {
      outcomesByFollowUpId.set(
        outcome.followUpId,
        [...(outcomesByFollowUpId.get(outcome.followUpId) || []), outcome]
      );
    }

    if (outcome.personKey) {
      outcomesByPersonKey.set(
        outcome.personKey,
        [...(outcomesByPersonKey.get(outcome.personKey) || []), outcome]
      );
    }

    if (outcome.sessionId) {
      outcomesBySessionKey.set(
        outcome.sessionId,
        [...(outcomesBySessionKey.get(outcome.sessionId) || []), outcome]
      );
    }
  });

  const hydratedItems = items.map((item) => {
    const leadRecord = actionMap.get(cleanText(item.key))
      || personMap.get(cleanText(item.person?.key || item.personKey))
      || sessionMap.get(cleanText(item.sessionKey))
      || null;
    const followUp = resolveFollowUpForLead(followUps, leadRecord);
    const relatedEvents = [
      ...(widgetEventsByActionKey.get(cleanText(item.key)) || []),
      ...(widgetEventsByPersonKey.get(cleanText(item.person?.key || item.personKey)) || []),
      ...(widgetEventsBySessionKey.get(cleanText(item.sessionKey)) || []),
    ];
    const relatedOutcomes = [
      ...(outcomesByActionKey.get(cleanText(item.key)) || []),
      ...(leadRecord?.id ? outcomesByLeadId.get(cleanText(leadRecord.id)) || [] : []),
      ...(followUp?.id ? outcomesByFollowUpId.get(cleanText(followUp.id)) || [] : []),
      ...(outcomesByPersonKey.get(cleanText(item.person?.key || item.personKey)) || []),
      ...(outcomesBySessionKey.get(cleanText(item.sessionKey)) || []),
    ];
    const uniqueEventKeys = new Set();
    const dedupedEvents = relatedEvents.filter((event) => {
      const key = [
        event.eventName,
        event.createdAt,
        event.relatedActionKey,
        event.relatedPersonKey,
        event.sessionKey,
        event.ctaType,
        event.targetType,
      ].join("::");

      if (uniqueEventKeys.has(key)) {
        return false;
      }

      uniqueEventKeys.add(key);
      return true;
    });
    const shownEvents = dedupedEvents.filter((event) => event.eventName === "cta_shown");
    const clickedEvents = dedupedEvents.filter((event) => event.eventName === "cta_clicked");
    const latestShownEvent = [...shownEvents]
      .sort((left, right) => getTimestamp(right.createdAt) - getTimestamp(left.createdAt))[0] || null;
    const latestClickedEvent = [...clickedEvents]
      .sort((left, right) => getTimestamp(right.createdAt) - getTimestamp(left.createdAt))[0] || null;
    const latestRoutingEvent = [...clickedEvents, ...shownEvents]
      .sort((left, right) => getTimestamp(right.createdAt) - getTimestamp(left.createdAt))[0] || null;
    const routing = latestRoutingEvent
      ? {
        offered: shownEvents.length > 0,
        clicked: clickedEvents.length > 0,
        shownCount: shownEvents.length,
        clickCount: clickedEvents.length,
        ctaType: cleanText(latestRoutingEvent.ctaType),
        targetType: cleanText(latestRoutingEvent.targetType),
        relatedIntentType: cleanText(latestRoutingEvent.relatedIntentType),
        routingMode: cleanText(latestRoutingEvent.routingMode),
        lastShownAt: latestShownEvent?.createdAt || null,
        lastClickedAt: latestClickedEvent?.createdAt || null,
        sourcePageUrl: cleanText(latestRoutingEvent.pageUrl),
      }
      : null;
    const uniqueOutcomeKeys = new Set();
    const dedupedOutcomes = relatedOutcomes.filter((outcome) => {
      const key = [
        outcome.id,
        outcome.outcomeType,
        outcome.actionKey,
        outcome.leadId,
        outcome.followUpId,
        outcome.personKey,
        outcome.sessionId,
      ].join("::");

      if (uniqueOutcomeKeys.has(key)) {
        return false;
      }

      uniqueOutcomeKeys.add(key);
      return true;
    });
    const sortedOutcomes = dedupedOutcomes
      .slice()
      .sort((left, right) => getTimestamp(right.occurredAt) - getTimestamp(left.occurredAt));

    return {
      ...item,
      followUp: item.followUp || followUp || null,
      routing,
      outcomes: {
        count: sortedOutcomes.length,
        latest: sortedOutcomes[0] || null,
        recent: sortedOutcomes.slice(0, 3),
      },
      leadCapture: leadRecord
        ? buildPublicLeadCapture(leadRecord, {
          followUp,
          isReturningVisitor: item.person?.isReturning === true,
        })
        : null,
    };
  });

  const highIntentConversations = hydratedItems.filter((item) =>
    ACTIVE_HIGH_INTENT_ACTION_TYPES.has(cleanText(item.actionType))
  ).length;
  const capturePromptsShown = leadRecords.reduce((total, record) => total + (Number(record.promptCount) || 0), 0);
  const contactsCaptured = leadRecords.filter((record) =>
    normalizeState(record.captureState) === "captured" && hasUsableContact(record)
  ).length;
  const captureRate = highIntentConversations > 0
    ? Number((contactsCaptured / highIntentConversations).toFixed(3))
    : 0;
  const preparedFollowUpIds = new Set();
  const sentFollowUpIds = new Set();
  const shownEvents = widgetEvents.filter((event) => event.eventName === "cta_shown");
  const clickedEvents = widgetEvents.filter((event) => event.eventName === "cta_clicked");
  const fallbackEvents = widgetEvents.filter((event) => event.eventName === "capture_fallback_offered");

  hydratedItems.forEach((item) => {
    if (item.followUp?.id && cleanText(item.followUp.status) !== "dismissed") {
      preparedFollowUpIds.add(cleanText(item.followUp.id));
    }

    if (item.followUp?.id && cleanText(item.followUp.status) === "sent") {
      sentFollowUpIds.add(cleanText(item.followUp.id));
    }
  });

  return {
    ...queue,
    items: hydratedItems,
    outcomeSummary: options.outcomes?.summary || null,
    recentOutcomes: options.outcomes?.recentOutcomes || [],
    recentLeadCaptures: leadRecords
      .slice()
      .sort((left, right) => getTimestamp(right.lastSeenAt || right.updatedAt) - getTimestamp(left.lastSeenAt || left.updatedAt))
      .slice(0, 6)
      .map((record) => buildPublicLeadCapture(record, {
        followUp: resolveFollowUpForLead(followUps, record),
      })),
    conversionSummary: {
      highIntentConversations,
      capturePromptsShown,
      contactsCaptured,
      captureRate,
      followUpsPrepared: preparedFollowUpIds.size,
      followUpsSent: sentFollowUpIds.size,
      pricingCaptures: leadRecords.filter((record) =>
        normalizeState(record.captureState) === "captured" && cleanText(record.latestActionType) === "pricing_interest"
      ).length,
      bookingCaptures: leadRecords.filter((record) =>
        normalizeState(record.captureState) === "captured" && cleanText(record.latestActionType) === "booking_intent"
      ).length,
      directCtasShown: shownEvents.length,
      ctaClicks: clickedEvents.length,
      ctaClickThroughRate: shownEvents.length > 0
        ? Number((clickedEvents.length / shownEvents.length).toFixed(3))
        : 0,
      bookingDirectHandoffs: clickedEvents.filter((event) => event.ctaType === "booking").length,
      quoteDirectHandoffs: clickedEvents.filter((event) => event.ctaType === "quote").length,
      contactDirectHandoffs: clickedEvents.filter((event) => event.ctaType === "contact").length,
      checkoutDirectHandoffs: clickedEvents.filter((event) => event.ctaType === "checkout").length,
      followUpFallbackCount: fallbackEvents.length,
      directRouteCount: shownEvents.length,
      captureFallbackCount: fallbackEvents.length,
      assistedConversions: Number(options.outcomes?.summary?.assistedConversions || 0),
      confirmedBusinessOutcomes: Number(options.outcomes?.summary?.confirmedBusinessOutcomes || 0),
      directOutcomeCount: Number(options.outcomes?.summary?.directOutcomeCount || 0),
      followUpAssistedOutcomeCount: Number(options.outcomes?.summary?.followUpAssistedOutcomeCount || 0),
    },
    liveConversionAvailable: options.outcomes?.persistenceAvailable !== false,
    liveConversionMigrationRequired: options.outcomes?.persistenceAvailable === false,
  };
}
