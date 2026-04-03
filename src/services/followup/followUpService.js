import { createHash } from "node:crypto";

import {
  ACTION_QUEUE_STATUS_TABLE,
  FOLLOW_UP_WORKFLOW_TABLE,
} from "../../config/constants.js";
import { cleanText } from "../../utils/text.js";

export const FOLLOW_UP_WORKFLOW_STATUSES = [
  "draft",
  "ready",
  "sent",
  "failed",
  "dismissed",
  "missing_contact",
];

export const SUPPORTED_FOLLOW_UP_ACTION_TYPES = [
  "lead_follow_up",
  "pricing_interest",
  "booking_intent",
  "repeat_high_intent_visitor",
];

const SUPPORTED_ACTION_TYPE_SET = new Set(SUPPORTED_FOLLOW_UP_ACTION_TYPES);
const EDITABLE_FOLLOW_UP_STATUSES = new Set(["draft", "ready", "failed", "missing_contact"]);
const ACTIVE_FOLLOW_UP_STATUSES = new Set(["draft", "ready", "failed", "missing_contact"]);
const FOLLOW_UP_CHANNELS = new Set(["email", "phone", "manual"]);
const FOLLOW_UP_SELECT =
  "id, agent_id, owner_user_id, dedupe_key, source_action_key, linked_action_keys, action_type, person_key, contact_id, status, channel, contact_name, contact_email, contact_phone, subject, draft_content, last_generated_subject, last_generated_content, draft_edited_manually, evidence, why_prepared, topic, page_hint, source_hash, last_error, sent_at, dismissed_at, created_at, updated_at";

function isMissingRelationError(error, relationName) {
  const message = cleanText(error?.message || "");

  return (
    error?.code === "PGRST205" ||
    error?.code === "42P01" ||
    message.toLowerCase().includes(`'public.${relationName}'`) ||
    message.toLowerCase().includes(`${relationName} was not found`)
  );
}

function buildMissingFollowUpWorkflowSchemaError(phase = "request") {
  const error = new Error(
    `[${phase}] Missing required follow-up workflow schema for '${FOLLOW_UP_WORKFLOW_TABLE}'. Apply the latest database migration before running this build.`
  );
  error.statusCode = 500;
  error.code = "schema_not_ready";
  return error;
}

export async function assertFollowUpWorkflowSchemaReady(supabase, options = {}) {
  const { error } = await supabase
    .from(FOLLOW_UP_WORKFLOW_TABLE)
    .select(FOLLOW_UP_SELECT)
    .limit(1);

  if (error) {
    if (isMissingRelationError(error, FOLLOW_UP_WORKFLOW_TABLE) || error?.code === "42703" || error?.code === "PGRST204") {
      throw buildMissingFollowUpWorkflowSchemaError(options.phase || "startup");
    }

    throw error;
  }
}

function normalizeFollowUpStatus(value, options = {}) {
  const normalized = cleanText(value).toLowerCase();

  if (!normalized) {
    return options.allowEmpty ? "" : "draft";
  }

  return FOLLOW_UP_WORKFLOW_STATUSES.includes(normalized)
    ? normalized
    : (options.allowEmpty ? "" : "draft");
}

function assertValidFollowUpStatus(value) {
  const normalized = cleanText(value).toLowerCase();

  if (!FOLLOW_UP_WORKFLOW_STATUSES.includes(normalized)) {
    const error = new Error(`Invalid follow-up status '${value}'`);
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function normalizeActionType(value) {
  const normalized = cleanText(value).toLowerCase();
  return SUPPORTED_ACTION_TYPE_SET.has(normalized) ? normalized : "";
}

function normalizeChannel(value) {
  const normalized = cleanText(value).toLowerCase();
  return FOLLOW_UP_CHANNELS.has(normalized) ? normalized : "";
}

function normalizeEmail(value) {
  return cleanText(value).toLowerCase();
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 7 ? digits : "";
}

function normalizeLinkedActionKeys(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => cleanText(entry)).filter(Boolean))];
  }

  const normalized = cleanText(value);
  return normalized ? [normalized] : [];
}

function uniqueText(values = []) {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function normalizeContactInfo(contactInfo = {}) {
  return {
    name: cleanText(contactInfo.name),
    email: normalizeEmail(contactInfo.email),
    phone: cleanText(contactInfo.phone),
    phoneNormalized: normalizePhone(contactInfo.phone),
  };
}

function hasUsableContact(contactInfo = {}) {
  return Boolean(normalizeEmail(contactInfo.email) || normalizePhone(contactInfo.phone));
}

function getPreferredChannel(contactInfo = {}) {
  if (normalizeEmail(contactInfo.email)) {
    return "email";
  }

  if (normalizePhone(contactInfo.phone)) {
    return "phone";
  }

  return "";
}

function getFirstName(name = "") {
  return cleanText(name).split(" ").filter(Boolean)[0] || "";
}

function hashParts(parts = []) {
  return createHash("sha256")
    .update(parts.map((part) => cleanText(part)).join("|"))
    .digest("hex")
    .slice(0, 32);
}

function formatActionTypeLabel(actionType) {
  switch (actionType) {
    case "lead_follow_up":
      return "Lead follow-up";
    case "pricing_interest":
      return "Pricing interest";
    case "booking_intent":
      return "Booking intent";
    case "repeat_high_intent_visitor":
      return "Repeat high-intent visitor";
    default:
      return "Follow-up";
  }
}

function detectExplicitSignal(item = {}) {
  const normalized = cleanText([
    item.question,
    item.snippet,
    item.whyFlagged,
    item.suggestedAction,
  ].join(" ")).toLowerCase();

  if (normalized.includes("callback") || normalized.includes("call me") || normalized.includes("call back")) {
    return "callback";
  }

  if (normalized.includes("quote") || normalized.includes("estimate")) {
    return "quote";
  }

  if (
    normalized.includes("book")
    || normalized.includes("appointment")
    || normalized.includes("schedule")
    || normalized.includes("availability")
  ) {
    return "booking";
  }

  if (
    normalized.includes("price")
    || normalized.includes("pricing")
    || normalized.includes("cost")
    || normalized.includes("package")
  ) {
    return "pricing";
  }

  if (
    normalized.includes("contact")
    || normalized.includes("email")
    || normalized.includes("phone")
    || normalized.includes("reach")
  ) {
    return "contact";
  }

  return "";
}

function buildTopic(item = {}, actionType) {
  const explicitTopic = cleanText(item.topic || item.pageHint || item.label);
  if (explicitTopic) {
    return explicitTopic;
  }

  return formatActionTypeLabel(actionType);
}

function buildEvidence(item = {}) {
  const lines = uniqueText([
    cleanText(item.snippet),
    cleanText(item.question) ? `Customer asked: ${cleanText(item.question)}` : "",
    cleanText(item.reply) ? `Vonza replied: ${cleanText(item.reply)}` : "",
  ]);

  return lines.join("\n");
}

function buildWhyPrepared(item = {}, actionType) {
  const explicitSignal = detectExplicitSignal(item);
  const reasons = [
    cleanText(item.whyFlagged) || `Prepared because this queue item maps to ${formatActionTypeLabel(actionType).toLowerCase()}.`,
  ];

  if (item.person?.isReturning && actionType !== "repeat_high_intent_visitor") {
    reasons.push("This visitor also has returning high-intent behavior in the action queue.");
  }

  if (explicitSignal) {
    reasons.push(`Detected explicit ${explicitSignal} intent in the conversation.`);
  }

  if (!hasUsableContact(item.contactInfo || {})) {
    reasons.push("Vonza still needs usable contact details before outreach can be sent.");
  }

  return uniqueText(reasons).join(" ");
}

function buildSubject(candidate) {
  const businessName = cleanText(candidate.businessName) || "the business";

  switch (candidate.actionType) {
    case "lead_follow_up":
      return `Following up on your request to contact ${businessName}`;
    case "pricing_interest":
      return `Following up on your pricing question for ${businessName}`;
    case "booking_intent":
      return `Following up on your booking request with ${businessName}`;
    case "repeat_high_intent_visitor":
      return `Following up on your recent questions for ${businessName}`;
    default:
      return `Following up from ${businessName}`;
  }
}

function buildDraftContent(candidate) {
  const businessName = cleanText(candidate.businessName) || "the business";
  const assistantName = cleanText(candidate.assistantName) || businessName;
  const firstName = getFirstName(candidate.contact.name);
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const topic = cleanText(candidate.topic).toLowerCase();
  const signal = detectExplicitSignal(candidate.item);
  const questionReference = cleanText(candidate.item.question)
    ? `I saw your recent question: "${cleanText(candidate.item.question)}".`
    : "";

  if (!candidate.hasUsableContact) {
    return [
      "No usable contact details were captured for this follow-up yet.",
      questionReference || cleanText(candidate.item.snippet),
      "Keep the queue item active, review the conversation, and wait for an email address or phone number before sending outreach.",
    ].filter(Boolean).join("\n\n");
  }

  if (candidate.channel === "phone") {
    const intro = `This is ${assistantName} from ${businessName}.`;

    switch (candidate.actionType) {
      case "lead_follow_up":
        return [
          greeting,
          intro,
          questionReference || `I’m following up on your request to get in touch with ${businessName}.`,
          signal === "callback"
            ? "You asked for a callback, so I wanted to reconnect while the request is still fresh."
            : "I wanted to make it easy to continue the conversation and point you to the right next step.",
          "If now still works, what is the best way for us to help from here?",
        ].join("\n\n");
      case "pricing_interest":
        return [
          greeting,
          intro,
          questionReference || `I’m following up on your pricing question for ${businessName}.`,
          "If you share a little more detail about what you need, we can guide you to the right option or quote.",
          "What are you trying to price out right now?",
        ].join("\n\n");
      case "booking_intent":
        return [
          greeting,
          intro,
          questionReference || `I’m following up on your booking request with ${businessName}.`,
          "If you tell us the day or time that works best, we can help move the booking forward.",
          "What time window are you hoping for?",
        ].join("\n\n");
      default:
        return [
          greeting,
          intro,
          questionReference || `I’m following up on your recent questions for ${businessName}.`,
          `You have shown clear interest around ${topic || "the next step"}, so I wanted to reconnect while that context is still warm.`,
          "What would be most helpful for us to send or confirm next?",
        ].join("\n\n");
    }
  }

  switch (candidate.actionType) {
    case "lead_follow_up":
      return [
        greeting,
        `This is ${assistantName} from ${businessName}.`,
        questionReference || `I’m following up on your request to get in touch with ${businessName}.`,
        signal === "callback"
          ? "You asked for a callback, so I wanted to make sure we reconnect quickly."
          : "I wanted to make it easy to continue the conversation and help with the next step.",
        "If you reply with the best way to help, we can take it from there.",
        `${assistantName}`,
      ].join("\n\n");
    case "pricing_interest":
      return [
        greeting,
        `This is ${assistantName} from ${businessName}.`,
        questionReference || `I’m following up on your pricing question for ${businessName}.`,
        "If you share a little more detail about what you need, we can point you to the most relevant option or help with the right quote request.",
        "Reply with the service, scope, or timeline you have in mind and we’ll help from there.",
        `${assistantName}`,
      ].join("\n\n");
    case "booking_intent":
      return [
        greeting,
        `This is ${assistantName} from ${businessName}.`,
        questionReference || `I’m following up on your booking request with ${businessName}.`,
        "If you send the day or time that works best, we can help move the booking forward and clarify the next step.",
        "Reply with your preferred timing and we’ll take it from there.",
        `${assistantName}`,
      ].join("\n\n");
    default:
      return [
        greeting,
        `This is ${assistantName} from ${businessName}.`,
        questionReference || `I’m following up on your recent questions for ${businessName}.`,
        `You have shown clear interest around ${topic || "the next step"}, so I wanted to reconnect while that context is still warm.`,
        "If you reply with what would be most helpful next, we can keep things moving.",
        `${assistantName}`,
      ].join("\n\n");
  }
}

function normalizeFollowUpWorkflow(record = {}) {
  return {
    id: cleanText(record.id),
    agentId: cleanText(record.agentId || record.agent_id),
    ownerUserId: cleanText(record.ownerUserId || record.owner_user_id),
    dedupeKey: cleanText(record.dedupeKey || record.dedupe_key),
    sourceActionKey: cleanText(record.sourceActionKey || record.source_action_key),
    linkedActionKeys: normalizeLinkedActionKeys(record.linkedActionKeys || record.linked_action_keys),
    actionType: normalizeActionType(record.actionType || record.action_type),
    personKey: cleanText(record.personKey || record.person_key),
    contactId: cleanText(record.contactId || record.contact_id),
    status: normalizeFollowUpStatus(record.status),
    channel: normalizeChannel(record.channel),
    contactName: cleanText(record.contactName || record.contact_name),
    contactEmail: normalizeEmail(record.contactEmail || record.contact_email),
    contactPhone: cleanText(record.contactPhone || record.contact_phone),
    subject: cleanText(record.subject),
    draftContent: cleanText(record.draftContent || record.draft_content),
    lastGeneratedSubject: cleanText(record.lastGeneratedSubject || record.last_generated_subject),
    lastGeneratedContent: cleanText(record.lastGeneratedContent || record.last_generated_content),
    draftEditedManually: record.draftEditedManually === true || record.draft_edited_manually === true,
    evidence: cleanText(record.evidence),
    whyPrepared: cleanText(record.whyPrepared || record.why_prepared),
    topic: cleanText(record.topic),
    pageHint: cleanText(record.pageHint || record.page_hint),
    sourceHash: cleanText(record.sourceHash || record.source_hash),
    lastError: cleanText(record.lastError || record.last_error),
    sentAt: record.sentAt || record.sent_at || null,
    dismissedAt: record.dismissedAt || record.dismissed_at || null,
    createdAt: record.createdAt || record.created_at || null,
    updatedAt: record.updatedAt || record.updated_at || null,
  };
}

function buildSyncCandidate(item = {}, agentProfile = {}) {
  const actionType = normalizeActionType(item.actionType);

  if (!actionType) {
    return null;
  }

  const contact = normalizeContactInfo(item.contactInfo || {});
  const personKey = cleanText(item.person?.key || item.personKey);
  const topic = buildTopic(item, actionType);
  const linkedActionKeys = uniqueText([
    item.key,
    ...(Array.isArray(item.relatedActionKeys) ? item.relatedActionKeys : []),
  ]);
  const hasContact = hasUsableContact(contact);
  const channel = getPreferredChannel(contact);
  const dedupeKey = personKey
    ? `person:${personKey}:${actionType}`
    : `action:${cleanText(item.key)}`;
  const evidence = buildEvidence(item);
  const whyPrepared = buildWhyPrepared(item, actionType);
  const subject = buildSubject({
    actionType,
    topic,
    businessName: agentProfile.businessName,
  });
  const candidate = {
    actionType,
    agentId: cleanText(agentProfile.agentId || item.agentId),
    ownerUserId: cleanText(agentProfile.ownerUserId || item.ownerUserId),
    businessName: cleanText(agentProfile.businessName),
    assistantName: cleanText(agentProfile.assistantName) || cleanText(agentProfile.businessName),
    dedupeKey,
    sourceActionKey: cleanText(item.key),
    linkedActionKeys,
    personKey,
    channel,
    contact,
    hasUsableContact: hasContact,
    topic,
    pageHint: cleanText(item.pageHint),
    evidence,
    whyPrepared,
    subject,
    item,
  };

  candidate.draftContent = buildDraftContent(candidate);
  candidate.sourceHash = hashParts([
    candidate.actionType,
    candidate.businessName,
    candidate.assistantName,
    candidate.contact.name,
    candidate.contact.email,
    candidate.contact.phoneNormalized,
    candidate.topic,
    candidate.pageHint,
    candidate.evidence,
    candidate.whyPrepared,
    candidate.subject,
    candidate.draftContent,
  ]);

  return candidate;
}

function buildComparableRecord(record = {}) {
  const normalized = normalizeFollowUpWorkflow(record);

  return JSON.stringify({
    dedupeKey: normalized.dedupeKey,
    sourceActionKey: normalized.sourceActionKey,
    linkedActionKeys: normalized.linkedActionKeys,
    actionType: normalized.actionType,
    personKey: normalized.personKey,
    status: normalized.status,
    channel: normalized.channel,
    contactName: normalized.contactName,
    contactEmail: normalized.contactEmail,
    contactPhone: normalized.contactPhone,
    subject: normalized.subject,
    draftContent: normalized.draftContent,
    lastGeneratedSubject: normalized.lastGeneratedSubject,
    lastGeneratedContent: normalized.lastGeneratedContent,
    draftEditedManually: normalized.draftEditedManually,
    evidence: normalized.evidence,
    whyPrepared: normalized.whyPrepared,
    topic: normalized.topic,
    pageHint: normalized.pageHint,
    sourceHash: normalized.sourceHash,
    lastError: normalized.lastError,
    sentAt: normalized.sentAt,
    dismissedAt: normalized.dismissedAt,
  });
}

function shouldRefreshDraft(existing, candidate) {
  const normalizedExisting = normalizeFollowUpWorkflow(existing);

  return (
    normalizedExisting.sourceHash !== candidate.sourceHash &&
    !normalizedExisting.draftEditedManually &&
    EDITABLE_FOLLOW_UP_STATUSES.has(normalizedExisting.status)
  );
}

function findExistingWorkflow(records = [], candidate) {
  const normalizedRecords = records.map((record) => normalizeFollowUpWorkflow(record));
  const actionKeySet = new Set(candidate.linkedActionKeys);

  const byLinkedAction = normalizedRecords.find((record) =>
    record.linkedActionKeys.some((actionKey) => actionKeySet.has(actionKey))
  );

  if (byLinkedAction) {
    return byLinkedAction;
  }

  const byDedupeKey = normalizedRecords.find((record) => record.dedupeKey === candidate.dedupeKey);

  if (byDedupeKey) {
    return byDedupeKey;
  }

  if (candidate.actionType === "repeat_high_intent_visitor" && candidate.personKey) {
    return normalizedRecords.find((record) =>
      record.personKey === candidate.personKey &&
      ACTIVE_FOLLOW_UP_STATUSES.has(record.status) &&
      SUPPORTED_ACTION_TYPE_SET.has(record.actionType) &&
      record.actionType !== "repeat_high_intent_visitor"
    ) || null;
  }

  return null;
}

function buildSyncedWorkflowPayload(existing, candidate) {
  const normalizedExisting = existing ? normalizeFollowUpWorkflow(existing) : null;
  const linkedActionKeys = uniqueText([
    ...(normalizedExisting?.linkedActionKeys || []),
    ...candidate.linkedActionKeys,
  ]);
  const nextStatus = normalizedExisting
    ? (
      normalizedExisting.status === "sent" || normalizedExisting.status === "dismissed"
        ? normalizedExisting.status
        : (!candidate.hasUsableContact ? "missing_contact" : normalizedExisting.status === "missing_contact" ? "draft" : normalizedExisting.status)
    )
    : (candidate.hasUsableContact ? "draft" : "missing_contact");
  const refreshDraft = !normalizedExisting || shouldRefreshDraft(normalizedExisting, candidate);
  const payload = {
    agent_id: candidate.agentId,
    owner_user_id: candidate.ownerUserId,
    dedupe_key: normalizedExisting?.dedupeKey || candidate.dedupeKey,
    source_action_key: normalizedExisting?.sourceActionKey || candidate.sourceActionKey,
    linked_action_keys: linkedActionKeys,
    action_type: normalizedExisting?.actionType || candidate.actionType,
    person_key: normalizedExisting?.personKey || candidate.personKey || null,
    status: nextStatus,
    channel: candidate.channel || normalizedExisting?.channel || null,
    contact_name: candidate.contact.name || normalizedExisting?.contactName || null,
    contact_email: candidate.contact.email || normalizedExisting?.contactEmail || null,
    contact_phone: candidate.contact.phone || normalizedExisting?.contactPhone || null,
    evidence: candidate.evidence || normalizedExisting?.evidence || null,
    why_prepared: candidate.whyPrepared || normalizedExisting?.whyPrepared || null,
    topic: candidate.topic || normalizedExisting?.topic || null,
    page_hint: candidate.pageHint || normalizedExisting?.pageHint || null,
    source_hash: candidate.sourceHash || normalizedExisting?.sourceHash || null,
    updated_at: new Date().toISOString(),
  };

  if (refreshDraft || !cleanText(normalizedExisting?.subject) || !cleanText(normalizedExisting?.draftContent)) {
    payload.subject = candidate.subject;
    payload.draft_content = candidate.draftContent;
    payload.last_generated_subject = candidate.subject;
    payload.last_generated_content = candidate.draftContent;
  } else {
    payload.subject = normalizedExisting.subject || candidate.subject;
    payload.draft_content = normalizedExisting.draftContent || candidate.draftContent;
    payload.last_generated_subject = normalizedExisting.lastGeneratedSubject || candidate.subject;
    payload.last_generated_content = normalizedExisting.lastGeneratedContent || candidate.draftContent;
  }

  payload.draft_edited_manually = normalizedExisting?.draftEditedManually === true;

  if (nextStatus !== "failed") {
    payload.last_error = null;
  } else if (cleanText(normalizedExisting?.lastError)) {
    payload.last_error = normalizedExisting.lastError;
  }

  if (nextStatus !== "sent") {
    payload.sent_at = normalizedExisting?.sentAt || null;
  }

  if (nextStatus !== "dismissed") {
    payload.dismissed_at = normalizedExisting?.dismissedAt || null;
  }

  return normalizeFollowUpWorkflow(payload);
}

function shouldPersistWorkflow(existing, nextWorkflow) {
  return buildComparableRecord(existing || {}) !== buildComparableRecord(nextWorkflow || {});
}

function mapFollowUpStatusToQueueState(followUp) {
  const normalized = normalizeFollowUpWorkflow(followUp);

  if (normalized.status === "sent") {
    return {
      status: "done",
      followUpNeeded: false,
      followUpCompleted: true,
    };
  }

  if (normalized.status === "dismissed") {
    return {
      status: "dismissed",
      followUpNeeded: false,
      followUpCompleted: false,
    };
  }

  return {
    status: "reviewed",
    followUpNeeded: true,
    followUpCompleted: false,
  };
}

async function persistQueueSyncForFollowUp(supabase, options = {}) {
  const followUp = normalizeFollowUpWorkflow(options.followUp);
  const queueState = mapFollowUpStatusToQueueState(followUp);
  const actionKeys = uniqueText([
    followUp.sourceActionKey,
    ...followUp.linkedActionKeys,
  ]);

  await Promise.all(actionKeys.map(async (actionKey) => {
    const { error } = await supabase
      .from(ACTION_QUEUE_STATUS_TABLE)
      .upsert(
        {
          agent_id: followUp.agentId,
          owner_user_id: followUp.ownerUserId,
          action_key: actionKey,
          status: queueState.status,
          follow_up_needed: queueState.followUpNeeded,
          follow_up_completed: queueState.followUpCompleted,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "agent_id,action_key" }
      );

    if (error) {
      console.error("[follow-up] Failed syncing queue state:", {
        followUpId: followUp.id || null,
        actionKey,
        status: queueState.status,
        message: error.message,
      });
      throw error;
    }
  }));

  console.info("[follow-up] Synced queue state from follow-up:", {
    followUpId: followUp.id || null,
    actionKeys,
    followUpStatus: followUp.status,
    queueStatus: queueState.status,
  });

  return queueState;
}

async function insertFollowUpWorkflow(supabase, workflow) {
  const payload = {
    agent_id: workflow.agentId,
    owner_user_id: workflow.ownerUserId,
    dedupe_key: workflow.dedupeKey,
    source_action_key: workflow.sourceActionKey,
    linked_action_keys: workflow.linkedActionKeys,
    action_type: workflow.actionType,
    person_key: workflow.personKey || null,
    contact_id: workflow.contactId || null,
    status: workflow.status,
    channel: workflow.channel || null,
    contact_name: workflow.contactName || null,
    contact_email: workflow.contactEmail || null,
    contact_phone: workflow.contactPhone || null,
    subject: workflow.subject || null,
    draft_content: workflow.draftContent || null,
    last_generated_subject: workflow.lastGeneratedSubject || null,
    last_generated_content: workflow.lastGeneratedContent || null,
    draft_edited_manually: workflow.draftEditedManually === true,
    evidence: workflow.evidence || null,
    why_prepared: workflow.whyPrepared || null,
    topic: workflow.topic || null,
    page_hint: workflow.pageHint || null,
    source_hash: workflow.sourceHash || null,
    last_error: workflow.lastError || null,
    sent_at: workflow.sentAt || null,
    dismissed_at: workflow.dismissedAt || null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from(FOLLOW_UP_WORKFLOW_TABLE)
    .insert(payload)
    .select(FOLLOW_UP_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return normalizeFollowUpWorkflow(data);
}

async function updateFollowUpWorkflowRecord(supabase, workflow) {
  const payload = {
    dedupe_key: workflow.dedupeKey,
    source_action_key: workflow.sourceActionKey,
    linked_action_keys: workflow.linkedActionKeys,
    action_type: workflow.actionType,
    person_key: workflow.personKey || null,
    contact_id: workflow.contactId || null,
    status: workflow.status,
    channel: workflow.channel || null,
    contact_name: workflow.contactName || null,
    contact_email: workflow.contactEmail || null,
    contact_phone: workflow.contactPhone || null,
    subject: workflow.subject || null,
    draft_content: workflow.draftContent || null,
    last_generated_subject: workflow.lastGeneratedSubject || null,
    last_generated_content: workflow.lastGeneratedContent || null,
    draft_edited_manually: workflow.draftEditedManually === true,
    evidence: workflow.evidence || null,
    why_prepared: workflow.whyPrepared || null,
    topic: workflow.topic || null,
    page_hint: workflow.pageHint || null,
    source_hash: workflow.sourceHash || null,
    last_error: workflow.lastError || null,
    sent_at: workflow.sentAt || null,
    dismissed_at: workflow.dismissedAt || null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from(FOLLOW_UP_WORKFLOW_TABLE)
    .update(payload)
    .eq("id", workflow.id)
    .select(FOLLOW_UP_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return normalizeFollowUpWorkflow(data);
}

export async function listFollowUpWorkflows(supabase, options = {}) {
  const agentId = cleanText(options.agentId);
  const ownerUserId = cleanText(options.ownerUserId);

  if (!agentId || !ownerUserId) {
    return {
      records: [],
      persistenceAvailable: true,
    };
  }

  const { data, error } = await supabase
    .from(FOLLOW_UP_WORKFLOW_TABLE)
    .select(FOLLOW_UP_SELECT)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .order("updated_at", { ascending: false });

  if (error) {
    if (isMissingRelationError(error, FOLLOW_UP_WORKFLOW_TABLE)) {
      return {
        records: [],
        persistenceAvailable: false,
      };
    }

    console.error(error);
    throw error;
  }

  return {
    records: (data || []).map((row) => normalizeFollowUpWorkflow(row)),
    persistenceAvailable: true,
  };
}

export async function syncFollowUpWorkflows(supabase, options = {}) {
  const agentId = cleanText(options.agentId);
  const ownerUserId = cleanText(options.ownerUserId);
  const agentProfile = {
    agentId,
    ownerUserId,
    businessName: cleanText(options.agentProfile?.businessName || options.agentProfile?.name),
    assistantName: cleanText(options.agentProfile?.assistantName || options.agentProfile?.name),
  };
  const queueItems = Array.isArray(options.queueItems) ? options.queueItems : [];

  if (!agentId || !ownerUserId) {
    return {
      records: [],
      persistenceAvailable: true,
    };
  }

  const listed = await listFollowUpWorkflows(supabase, {
    agentId,
    ownerUserId,
  });

  if (listed.persistenceAvailable === false) {
    return listed;
  }

  const records = [...listed.records];

  for (const item of queueItems) {
    const candidate = buildSyncCandidate(item, agentProfile);

    if (!candidate) {
      continue;
    }

    const existing = findExistingWorkflow(records, candidate);
    const nextWorkflow = buildSyncedWorkflowPayload(existing, candidate);

    if (!shouldPersistWorkflow(existing, nextWorkflow)) {
      continue;
    }

    let persisted = null;

    try {
      persisted = existing?.id
        ? await updateFollowUpWorkflowRecord(supabase, {
          ...nextWorkflow,
          id: existing.id,
        })
        : await insertFollowUpWorkflow(supabase, nextWorkflow);
    } catch (error) {
      if (isMissingRelationError(error, FOLLOW_UP_WORKFLOW_TABLE)) {
        return {
          records,
          persistenceAvailable: false,
        };
      }

      console.error("[follow-up] Failed to sync follow-up workflow:", {
        agentId,
        ownerUserId,
        actionKey: item.key || null,
        actionType: candidate.actionType,
        message: error.message,
      });
      throw error;
    }

    const index = records.findIndex((record) => record.id === persisted.id);
    if (index >= 0) {
      records[index] = persisted;
    } else {
      records.push(persisted);
    }

    console.info(existing?.id ? "[follow-up] Refreshed follow-up workflow." : "[follow-up] Created follow-up workflow.", {
      followUpId: persisted.id,
      sourceActionKey: persisted.sourceActionKey,
      actionType: persisted.actionType,
      status: persisted.status,
      draftEditedManually: persisted.draftEditedManually,
    });

    await persistQueueSyncForFollowUp(supabase, {
      followUp: persisted,
    });
  }

  return {
    records,
    persistenceAvailable: true,
  };
}

export async function createManualFollowUpWorkflow(supabase, options = {}) {
  const agentId = cleanText(options.agentId);
  const ownerUserId = cleanText(options.ownerUserId);
  const businessName = cleanText(options.businessName || options.name) || "Vonza";
  const assistantName = cleanText(options.assistantName || businessName) || businessName;
  const actionType = normalizeActionType(options.actionType || "lead_follow_up") || "lead_follow_up";
  const contact = normalizeContactInfo({
    name: options.contactName || options.name,
    email: options.contactEmail || options.email,
    phone: options.contactPhone || options.phone,
  });
  const personKey = cleanText(options.personKey);
  const contactId = cleanText(options.contactId || options.contact_id);
  const linkedActionKeys = normalizeLinkedActionKeys(options.linkedActionKeys || options.linked_action_keys || []);
  const sourceActionKey = cleanText(options.sourceActionKey || options.source_action_key)
    || `manual_contact:${personKey || contact.email || contact.phoneNormalized || businessName.toLowerCase().replace(/\s+/g, "_")}:${actionType}`;

  if (!agentId || !ownerUserId) {
    const error = new Error("agent_id and owner_user_id are required");
    error.statusCode = 400;
    throw error;
  }

  if (!hasUsableContact(contact)) {
    const error = new Error("A usable email address or phone number is required for a contact follow-up.");
    error.statusCode = 400;
    throw error;
  }

  const dedupeKey = personKey
    ? `manual_person:${personKey}:${actionType}`
    : `manual_contact:${contact.email || contact.phoneNormalized}:${actionType}`;
  const topic = cleanText(options.topic)
    || (actionType === "booking_intent"
      ? "Booking request"
      : actionType === "pricing_interest"
        ? "Pricing follow-up"
        : "Lead follow-up");
  const subject = cleanText(options.subject) || buildSubject({
    actionType,
    topic,
    businessName,
  });
  const candidate = {
    actionType,
    businessName,
    assistantName,
    channel: getPreferredChannel(contact),
    contact,
    hasUsableContact: true,
    topic,
    item: {
      question: cleanText(options.contextQuestion),
      snippet: cleanText(options.contextSnippet),
      label: topic,
    },
  };
  const draftContent = cleanText(options.draftContent) || buildDraftContent(candidate);
  const listed = await listFollowUpWorkflows(supabase, {
    agentId,
    ownerUserId,
  });

  if (listed.persistenceAvailable === false) {
    return {
      followUp: null,
      persistenceAvailable: false,
    };
  }

  const existing = listed.records.find((record) => record.dedupeKey === dedupeKey) || null;
  const workflow = normalizeFollowUpWorkflow({
    ...existing,
    agentId,
    ownerUserId,
    dedupeKey,
    sourceActionKey,
    linkedActionKeys: uniqueText([sourceActionKey, ...linkedActionKeys, ...(existing?.linkedActionKeys || [])]),
    actionType,
    personKey: personKey || existing?.personKey,
    contactId: contactId || existing?.contactId,
    status: "draft",
    channel: getPreferredChannel(contact),
    contactName: contact.name || existing?.contactName,
    contactEmail: contact.email || existing?.contactEmail,
    contactPhone: contact.phone || existing?.contactPhone,
    subject,
    draftContent,
    lastGeneratedSubject: subject,
    lastGeneratedContent: draftContent,
    draftEditedManually: Boolean(cleanText(options.subject) || cleanText(options.draftContent)),
    evidence: cleanText(options.evidence || options.contextSnippet),
    whyPrepared: cleanText(options.whyPrepared || `Prepared manually from the Contacts workspace for ${topic.toLowerCase()}.`),
    topic,
    pageHint: cleanText(options.pageHint),
    sourceHash: hashParts([dedupeKey, subject, draftContent]),
    lastError: "",
    sentAt: null,
    dismissedAt: null,
  });

  const persisted = existing?.id
    ? await updateFollowUpWorkflowRecord(supabase, workflow)
    : await insertFollowUpWorkflow(supabase, workflow);
  const queueSync = await persistQueueSyncForFollowUp(supabase, {
    followUp: persisted,
  });

  return {
    followUp: persisted,
    queueSync,
    persistenceAvailable: true,
  };
}

async function getFollowUpWorkflowById(supabase, options = {}) {
  const followUpId = cleanText(options.followUpId);
  const agentId = cleanText(options.agentId);
  const ownerUserId = cleanText(options.ownerUserId);

  if (!followUpId || !agentId || !ownerUserId) {
    const error = new Error("follow_up_id, agent_id, and owner_user_id are required");
    error.statusCode = 400;
    throw error;
  }

  const { data, error } = await supabase
    .from(FOLLOW_UP_WORKFLOW_TABLE)
    .select(FOLLOW_UP_SELECT)
    .eq("id", followUpId)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error, FOLLOW_UP_WORKFLOW_TABLE)) {
      return {
        record: null,
        persistenceAvailable: false,
      };
    }

    console.error(error);
    throw error;
  }

  return {
    record: data ? normalizeFollowUpWorkflow(data) : null,
    persistenceAvailable: true,
  };
}

export async function updateFollowUpWorkflow(supabase, options = {}) {
  const agentId = cleanText(options.agentId);
  const ownerUserId = cleanText(options.ownerUserId);
  const followUpId = cleanText(options.followUpId);
  const requestedStatus = options.status === undefined ? "" : assertValidFollowUpStatus(options.status);
  const requestedSubject = options.subject === undefined ? undefined : cleanText(options.subject);
  const requestedDraftContent = options.draftContent === undefined ? undefined : cleanText(options.draftContent);
  const requestedErrorMessage = options.errorMessage === undefined ? undefined : cleanText(options.errorMessage);
  const reopen = options.reopen === true;

  const lookup = await getFollowUpWorkflowById(supabase, {
    followUpId,
    agentId,
    ownerUserId,
  });

  if (lookup.persistenceAvailable === false) {
    return {
      followUp: null,
      persistenceAvailable: false,
    };
  }

  const existing = normalizeFollowUpWorkflow(lookup.record);

  if (!existing?.id) {
    const error = new Error("Follow-up workflow not found");
    error.statusCode = 404;
    throw error;
  }

  const nextStatus = requestedStatus || existing.status;
  const nextSubject = requestedSubject === undefined ? existing.subject : requestedSubject;
  const nextDraftContent = requestedDraftContent === undefined ? existing.draftContent : requestedDraftContent;
  const usableContact = hasUsableContact({
    email: existing.contactEmail,
    phone: existing.contactPhone,
  });
  const statusChanged = nextStatus !== existing.status;

  if ((existing.status === "sent" || existing.status === "dismissed") && statusChanged && !reopen) {
    const error = new Error("This follow-up is closed. Reopen it explicitly before changing the status.");
    error.statusCode = 400;
    throw error;
  }

  if (["draft", "ready", "sent"].includes(nextStatus) && !usableContact) {
    const error = new Error("This follow-up still needs a usable email address or phone number.");
    error.statusCode = 400;
    throw error;
  }

  const nextWorkflow = normalizeFollowUpWorkflow({
    ...existing,
    status: nextStatus,
    subject: nextSubject,
    draftContent: nextDraftContent,
    draftEditedManually:
      requestedSubject !== undefined || requestedDraftContent !== undefined
        ? (
          nextSubject !== existing.lastGeneratedSubject ||
          nextDraftContent !== existing.lastGeneratedContent ||
          existing.draftEditedManually
        )
        : existing.draftEditedManually,
    lastError: nextStatus === "failed"
      ? (requestedErrorMessage || existing.lastError || "Follow-up failed.")
      : "",
    sentAt: nextStatus === "sent"
      ? (existing.sentAt || new Date().toISOString())
      : (nextStatus === "draft" || nextStatus === "ready" || nextStatus === "failed" || nextStatus === "missing_contact") ? null : existing.sentAt,
    dismissedAt: nextStatus === "dismissed"
      ? (existing.dismissedAt || new Date().toISOString())
      : (nextStatus === "draft" || nextStatus === "ready" || nextStatus === "failed" || nextStatus === "missing_contact") ? null : existing.dismissedAt,
  });

  const persisted = await updateFollowUpWorkflowRecord(supabase, nextWorkflow);
  const queueSync = await persistQueueSyncForFollowUp(supabase, {
    followUp: persisted,
  });

  if (persisted.status === "sent") {
    console.info("[follow-up] Marked follow-up as sent.", {
      followUpId: persisted.id,
      sourceActionKey: persisted.sourceActionKey,
    });
  } else if (persisted.status === "dismissed") {
    console.info("[follow-up] Dismissed follow-up.", {
      followUpId: persisted.id,
      sourceActionKey: persisted.sourceActionKey,
    });
  } else if (persisted.status === "failed") {
    console.warn("[follow-up] Recorded follow-up failure.", {
      followUpId: persisted.id,
      sourceActionKey: persisted.sourceActionKey,
      lastError: persisted.lastError,
    });
  } else {
    console.info("[follow-up] Updated follow-up draft.", {
      followUpId: persisted.id,
      sourceActionKey: persisted.sourceActionKey,
      status: persisted.status,
    });
  }

  return {
    followUp: persisted,
    queueSync,
    persistenceAvailable: true,
  };
}
