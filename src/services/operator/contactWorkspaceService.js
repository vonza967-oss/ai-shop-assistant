import {
  CONNECTED_ACCOUNT_TABLE,
  CONVERSION_OUTCOME_TABLE,
  FOLLOW_UP_WORKFLOW_TABLE,
  LEAD_CAPTURE_TABLE,
  OPERATOR_CALENDAR_EVENT_TABLE,
  OPERATOR_CAMPAIGN_RECIPIENT_TABLE,
  OPERATOR_CONTACT_IDENTITY_TABLE,
  OPERATOR_CONTACT_TABLE,
  OPERATOR_INBOX_THREAD_TABLE,
  OPERATOR_TASK_TABLE,
} from "../../config/constants.js";
import { cleanText } from "../../utils/text.js";

export const CONTACT_LIFECYCLE_STATES = [
  "new",
  "active_lead",
  "qualified",
  "customer",
  "support_issue",
  "complaint_risk",
  "dormant",
];

const CONTACT_SELECT = [
  "id",
  "agent_id",
  "business_id",
  "owner_user_id",
  "display_name",
  "primary_email",
  "primary_phone",
  "primary_phone_normalized",
  "primary_person_key",
  "lifecycle_state",
  "lifecycle_state_source",
  "suggested_lifecycle_state",
  "activity_sources",
  "high_priority_flags",
  "last_activity_at",
  "next_action_type",
  "next_action_title",
  "next_action_payload",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const CONTACT_IDENTITY_SELECT = [
  "id",
  "contact_id",
  "agent_id",
  "business_id",
  "owner_user_id",
  "identity_type",
  "identity_value",
  "is_primary",
  "source_type",
  "first_seen_at",
  "last_seen_at",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const CONTACT_EMPTY_STATE = Object.freeze({
  totalContacts: 0,
  contactsNeedingAttention: 0,
  complaintRiskContacts: 0,
  leadsWithoutNextStep: 0,
  customersAwaitingFollowUp: 0,
});

function isMissingRelationError(error, relationName = "") {
  const message = cleanText(error?.message || "").toLowerCase();

  return (
    error?.code === "PGRST205"
    || error?.code === "PGRST204"
    || error?.code === "42P01"
    || error?.code === "42703"
    || message.includes(`'public.${relationName}'`)
    || message.includes(`${relationName} was not found`)
    || (message.includes("column") && message.includes("does not exist"))
  );
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(value) {
  const cleaned = cleanText(value);
  const match = cleaned.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : cleaned.toLowerCase();
}

function normalizePhone(value) {
  return cleanText(value);
}

function normalizePhoneDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 7 ? digits : "";
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueText(values = []) {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function parseTimestamp(value) {
  const timestamp = new Date(value || "").getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getMostRecentTimestamp(values = []) {
  return values.reduce((latest, value) => {
    const timestamp = parseTimestamp(value);
    return timestamp > latest ? timestamp : latest;
  }, 0);
}

function formatSourceLabel(source) {
  return cleanText(source).replaceAll("_", " ");
}

function mapStoredContactRow(row = {}) {
  return {
    id: cleanText(row.id),
    agentId: cleanText(row.agent_id),
    businessId: cleanText(row.business_id),
    ownerUserId: cleanText(row.owner_user_id),
    displayName: cleanText(row.display_name),
    primaryEmail: normalizeEmail(row.primary_email),
    primaryPhone: normalizePhone(row.primary_phone),
    primaryPhoneNormalized: normalizePhoneDigits(row.primary_phone_normalized || row.primary_phone),
    primaryPersonKey: cleanText(row.primary_person_key),
    lifecycleState: cleanText(row.lifecycle_state) || "new",
    lifecycleStateSource: cleanText(row.lifecycle_state_source) || "system",
    suggestedLifecycleState: cleanText(row.suggested_lifecycle_state) || "new",
    activitySources: normalizeArray(row.activity_sources),
    highPriorityFlags: normalizeArray(row.high_priority_flags),
    lastActivityAt: row.last_activity_at || null,
    nextActionType: cleanText(row.next_action_type) || "no_action_needed",
    nextActionTitle: cleanText(row.next_action_title),
    nextActionPayload: row.next_action_payload && typeof row.next_action_payload === "object"
      ? row.next_action_payload
      : {},
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapStoredIdentityRow(row = {}) {
  return {
    id: cleanText(row.id),
    contactId: cleanText(row.contact_id),
    agentId: cleanText(row.agent_id),
    businessId: cleanText(row.business_id),
    ownerUserId: cleanText(row.owner_user_id),
    identityType: cleanText(row.identity_type),
    identityValue: cleanText(row.identity_value),
    isPrimary: row.is_primary === true,
    sourceType: cleanText(row.source_type),
    firstSeenAt: row.first_seen_at || null,
    lastSeenAt: row.last_seen_at || null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
  };
}

function createIdentityMaps() {
  return {
    email: new Map(),
    phone: new Map(),
    person_key: new Map(),
    session_key: new Map(),
    lead_id: new Map(),
    follow_up_id: new Map(),
    thread_id: new Map(),
    event_id: new Map(),
    campaign_recipient_id: new Map(),
  };
}

function createGroup(seed = {}) {
  return {
    id: cleanText(seed.id),
    persistedContact: seed.persistedContact || null,
    businessId: cleanText(seed.businessId || seed.persistedContact?.businessId),
    displayNames: uniqueText([
      cleanText(seed.displayName),
      cleanText(seed.persistedContact?.displayName),
    ]),
    emails: uniqueText([
      normalizeEmail(seed.email),
      normalizeEmail(seed.persistedContact?.primaryEmail),
    ]),
    phones: uniqueText([
      normalizePhone(seed.phone),
      normalizePhone(seed.persistedContact?.primaryPhone),
    ]),
    phoneDigits: uniqueText([
      normalizePhoneDigits(seed.phoneDigits || seed.phone),
      normalizePhoneDigits(seed.persistedContact?.primaryPhoneNormalized || seed.persistedContact?.primaryPhone),
    ]),
    personKeys: uniqueText([
      cleanText(seed.personKey),
      cleanText(seed.persistedContact?.primaryPersonKey),
    ]),
    sessionKeys: uniqueText(seed.sessionKeys || []),
    sourceKinds: uniqueText(seed.sourceKinds || seed.persistedContact?.activitySources || []),
    flags: uniqueText(seed.flags || seed.persistedContact?.highPriorityFlags || []),
    leads: [],
    followUps: [],
    threads: [],
    events: [],
    tasks: [],
    recipients: [],
    campaigns: [],
    outcomes: [],
    latestMessageId: cleanText(seed.latestMessageId || seed.persistedContact?.metadata?.latestMessageId),
    lastActivityAt: seed.lastActivityAt || seed.persistedContact?.lastActivityAt || null,
  };
}

function addToGroupCollection(group, collectionKey, record = {}) {
  const recordId = cleanText(record.id);

  if (!recordId) {
    return;
  }

  if (!group[collectionKey].find((entry) => cleanText(entry.id) === recordId)) {
    group[collectionKey].push(record);
  }
}

function addIdentityValues(group, updates = {}) {
  group.displayNames = uniqueText(group.displayNames.concat(cleanText(updates.displayName)));
  group.emails = uniqueText(group.emails.concat(normalizeEmail(updates.email)));
  group.phones = uniqueText(group.phones.concat(normalizePhone(updates.phone)));
  group.phoneDigits = uniqueText(group.phoneDigits.concat(normalizePhoneDigits(updates.phoneDigits || updates.phone)));
  group.personKeys = uniqueText(group.personKeys.concat(cleanText(updates.personKey)));
  group.sessionKeys = uniqueText(group.sessionKeys.concat(normalizeArray(updates.sessionKeys)));
  group.sourceKinds = uniqueText(group.sourceKinds.concat(normalizeArray(updates.sourceKinds)));
  group.flags = uniqueText(group.flags.concat(normalizeArray(updates.flags)));
  group.latestMessageId = cleanText(updates.latestMessageId || group.latestMessageId);

  const mostRecentActivity = getMostRecentTimestamp([group.lastActivityAt, updates.lastActivityAt]);
  group.lastActivityAt = mostRecentActivity ? new Date(mostRecentActivity).toISOString() : group.lastActivityAt || null;
}

function registerIdentity(identityMaps, group, identityType, identityValue) {
  const value = identityType === "email"
    ? normalizeEmail(identityValue)
    : identityType === "phone"
      ? normalizePhoneDigits(identityValue)
      : cleanText(identityValue);

  if (!value || !identityMaps[identityType]) {
    return;
  }

  identityMaps[identityType].set(value, group);
}

function mergeGroups(primary, secondary, identityMaps, groups) {
  if (!primary || !secondary || primary === secondary) {
    return primary || secondary;
  }

  [
    "leads",
    "followUps",
    "threads",
    "events",
    "tasks",
    "recipients",
    "campaigns",
    "outcomes",
  ].forEach((collectionKey) => {
    secondary[collectionKey].forEach((record) => addToGroupCollection(primary, collectionKey, record));
  });

  addIdentityValues(primary, {
    displayName: secondary.displayNames[0],
    email: secondary.emails[0],
    phone: secondary.phones[0],
    phoneDigits: secondary.phoneDigits[0],
    personKey: secondary.personKeys[0],
    sessionKeys: secondary.sessionKeys,
    sourceKinds: secondary.sourceKinds,
    flags: secondary.flags,
    latestMessageId: secondary.latestMessageId,
    lastActivityAt: secondary.lastActivityAt,
  });

  if (!primary.id && secondary.id) {
    primary.id = secondary.id;
  }

  if (!primary.persistedContact && secondary.persistedContact) {
    primary.persistedContact = secondary.persistedContact;
  }

  Object.entries(identityMaps).forEach(([identityType, identityMap]) => {
    identityMap.forEach((group, key) => {
      if (group === secondary) {
        identityMap.set(key, primary);
      }
    });
  });

  const index = groups.indexOf(secondary);
  if (index >= 0) {
    groups.splice(index, 1);
  }

  return primary;
}

function collectCandidateGroups(identityMaps, explicitGroups = [], strongIdentities = [], weakIdentities = []) {
  const groups = [];

  explicitGroups.forEach((group) => {
    if (group && !groups.includes(group)) {
      groups.push(group);
    }
  });

  strongIdentities.forEach(({ type, value }) => {
    const normalizedValue = type === "email"
      ? normalizeEmail(value)
      : type === "phone"
        ? normalizePhoneDigits(value)
        : cleanText(value);
    const group = identityMaps[type]?.get(normalizedValue);
    if (group && !groups.includes(group)) {
      groups.push(group);
    }
  });

  weakIdentities.forEach(({ type, value }) => {
    const group = identityMaps[type]?.get(cleanText(value));
    if (group && !groups.includes(group)) {
      groups.push(group);
    }
  });

  return groups;
}

function getThreadContactEmails(thread = {}) {
  const messages = normalizeArray(thread.messages);
  const inboundSenders = messages
    .filter((message) => cleanText(message.direction) === "inbound")
    .map((message) => normalizeEmail(message.sender));
  const outboundRecipients = messages
    .filter((message) => cleanText(message.direction) === "outbound")
    .flatMap((message) => normalizeArray(message.recipients))
    .map(normalizeEmail);

  const directParticipants = normalizeArray(thread.participants)
    .map(normalizeEmail);

  return uniqueText(inboundSenders.concat(outboundRecipients, directParticipants)).filter(Boolean);
}

function getLeadFlags(lead = {}) {
  const flags = [];
  const captureState = cleanText(lead.captureState);
  const actionType = cleanText(lead.latestActionType || lead.latestIntentType);
  const reason = cleanText(lead.captureReason).toLowerCase();

  if (["captured", "partial_contact", "prompted", "prompt_ready"].includes(captureState)) {
    flags.push("lead");
  }

  if (["booking_intent", "booking_request"].includes(actionType) || reason.includes("booking")) {
    flags.push("booking_intent");
  }

  if (reason.includes("complaint") || reason.includes("support") || reason.includes("refund")) {
    flags.push("complaint");
  }

  return flags;
}

function getThreadFlags(thread = {}) {
  const flags = [];

  if (cleanText(thread.classification) === "complaint" || cleanText(thread.riskLevel) === "high") {
    flags.push("complaint");
  }

  if (thread.needsReply) {
    flags.push("follow_up_due");
  }

  return flags;
}

function getEventFlags(event = {}) {
  const flags = [];

  if (parseTimestamp(event.startAt) > Date.now() && cleanText(event.status) !== "cancelled") {
    flags.push("booked");
  }

  if (cleanText(event.approvalStatus) === "pending_owner") {
    flags.push("follow_up_due");
  }

  return flags;
}

function getTaskFlags(task = {}) {
  const taskType = cleanText(task.taskType);
  const flags = [];

  if (["complaint_queue", "support_follow_up"].includes(taskType) && cleanText(task.status) === "open") {
    flags.push("complaint");
  }

  if (["missed_booking_opportunity", "calendar_mutation_approval", "campaign_approval"].includes(taskType) && cleanText(task.status) === "open") {
    flags.push("follow_up_due");
  }

  return flags;
}

function getRecipientFlags(recipient = {}, campaign = {}) {
  const flags = [];

  if (["queued", "active"].includes(cleanText(recipient.status)) || cleanText(campaign.status) === "active") {
    flags.push("campaign_active");
  }

  return flags;
}

function getFollowUpFlags(followUp = {}) {
  const status = cleanText(followUp.status);
  return ["draft", "ready", "failed", "missing_contact"].includes(status) ? ["follow_up_due"] : [];
}

function getOutcomeFlags(outcome = {}) {
  const flags = [];
  const outcomeType = cleanText(outcome.outcomeType);

  if (["booking_completed", "quote_requested", "checkout_completed"].includes(outcomeType)) {
    flags.push("customer");
  }

  if (["booking_started", "booking_completed"].includes(outcomeType)) {
    flags.push("booked");
  }

  return flags;
}

function buildTimelineEntries(group = {}) {
  const entries = [];

  group.leads.forEach((lead) => {
    entries.push({
      id: `lead:${lead.id}`,
      at: lead.capturedAt || lead.lastSeenAt || lead.createdAt || null,
      source: "chat",
      label: lead.captureState === "captured" ? "Lead captured" : "Lead signal",
      summary: cleanText(lead.captureReason || lead.latestActionType || lead.latestIntentType || "Chat visitor activity"),
      messageId: cleanText(lead.latestMessageId),
      actionKey: cleanText(lead.latestActionKey),
    });
  });

  group.followUps.forEach((followUp) => {
    entries.push({
      id: `followup:${followUp.id}`,
      at: followUp.sentAt || followUp.updatedAt || followUp.createdAt || null,
      source: "follow_up",
      label: `Follow-up ${cleanText(followUp.status || "draft")}`,
      summary: cleanText(followUp.subject || followUp.topic || "Prepared follow-up"),
      followUpId: followUp.id,
    });
  });

  group.threads.forEach((thread) => {
    const latestInbound = normalizeArray(thread.messages)
      .slice()
      .reverse()
      .find((message) => cleanText(message.direction) === "inbound");

    entries.push({
      id: `thread:${thread.id}`,
      at: thread.lastMessageAt || thread.updatedAt || thread.createdAt || null,
      source: "inbox",
      label: cleanText(thread.subject || "Inbox thread"),
      summary: cleanText(latestInbound?.bodyPreview || latestInbound?.bodyText || thread.snippet || thread.classification),
      threadId: thread.id,
    });
  });

  group.events.forEach((event) => {
    entries.push({
      id: `event:${event.id}`,
      at: event.startAt || event.updatedAt || event.createdAt || null,
      source: "calendar",
      label: cleanText(event.title || "Calendar event"),
      summary: cleanText(event.description || event.location || event.status || "Calendar activity"),
      eventId: event.id,
    });
  });

  group.tasks.forEach((task) => {
    entries.push({
      id: `task:${task.id}`,
      at: task.updatedAt || task.createdAt || null,
      source: "task",
      label: cleanText(task.title || task.taskType || "Operator task"),
      summary: cleanText(task.description || task.status || "Task activity"),
      taskId: task.id,
    });
  });

  group.recipients.forEach((recipient) => {
    entries.push({
      id: `recipient:${recipient.id}`,
      at: recipient.lastContactedAt || recipient.nextSendAt || recipient.updatedAt || recipient.createdAt || null,
      source: "campaign",
      label: cleanText(recipient.campaignTitle || "Campaign recipient"),
      summary: cleanText([
        recipient.status,
        recipient.replyState,
      ].filter(Boolean).join(" · ") || "Campaign activity"),
      campaignId: recipient.campaignId,
    });
  });

  group.outcomes.forEach((outcome) => {
    entries.push({
      id: `outcome:${outcome.id}`,
      at: outcome.occurredAt || outcome.createdAt || null,
      source: "conversion",
      label: cleanText(outcome.label || outcome.outcomeType || "Outcome"),
      summary: cleanText(outcome.attributionPath || outcome.sourceType || "Conversion outcome"),
      outcomeId: outcome.id,
    });
  });

  return entries
    .filter((entry) => parseTimestamp(entry.at) || entry.summary || entry.label)
    .sort((left, right) => parseTimestamp(right.at) - parseTimestamp(left.at));
}

function pickDisplayName(group = {}) {
  return cleanText(group.displayNames[0])
    || normalizeEmail(group.emails[0])
    || normalizePhone(group.phones[0])
    || cleanText(group.persistedContact?.displayName)
    || "Unknown contact";
}

function pickBestIdentifier(group = {}) {
  return cleanText(group.displayNames[0])
    || normalizeEmail(group.emails[0])
    || normalizePhone(group.phones[0])
    || (group.sessionKeys.length ? "Session continuity only" : "Identity unknown");
}

function buildSuggestedLifecycleState(group = {}, now = Date.now()) {
  const flagSet = new Set(group.flags);
  const latestOutcomeTypes = new Set(group.outcomes.map((outcome) => cleanText(outcome.outcomeType)));
  const openComplaintTask = group.tasks.find((task) =>
    ["complaint_queue", "support_follow_up"].includes(cleanText(task.taskType))
    && cleanText(task.status) === "open"
  );
  const lastActivityAt = parseTimestamp(group.lastActivityAt);
  const hasBookedEvent = group.events.some((event) =>
    parseTimestamp(event.startAt) > 0
    && cleanText(event.status) !== "cancelled"
  );
  const hasLeadSignal = group.leads.some((lead) =>
    ["captured", "partial_contact", "prompted", "prompt_ready"].includes(cleanText(lead.captureState))
  );
  const hasQualifiedSignal = group.followUps.length > 0
    || group.recipients.length > 0
    || hasBookedEvent;

  if (flagSet.has("complaint") || cleanText(openComplaintTask?.taskType) === "complaint_queue") {
    return "complaint_risk";
  }

  if (cleanText(openComplaintTask?.taskType) === "support_follow_up") {
    return "support_issue";
  }

  if (
    hasBookedEvent
    || latestOutcomeTypes.has("booking_completed")
    || latestOutcomeTypes.has("quote_requested")
    || latestOutcomeTypes.has("checkout_completed")
    || flagSet.has("customer")
  ) {
    return "customer";
  }

  if (hasLeadSignal && hasQualifiedSignal) {
    return "qualified";
  }

  if (hasLeadSignal || flagSet.has("lead") || flagSet.has("booking_intent")) {
    return "active_lead";
  }

  if (lastActivityAt && (now - lastActivityAt) > 1000 * 60 * 60 * 24 * 21) {
    return "dormant";
  }

  return "new";
}

function buildNextAction(contact = {}, group = {}) {
  const openComplaintTask = group.tasks.find((task) =>
    cleanText(task.taskType) === "complaint_queue"
    && cleanText(task.status) === "open"
  );
  const openSupportTask = group.tasks.find((task) =>
    cleanText(task.taskType) === "support_follow_up"
    && cleanText(task.status) === "open"
  );
  const pendingFollowUp = group.followUps.find((followUp) =>
    ["draft", "ready", "failed", "missing_contact"].includes(cleanText(followUp.status))
  );
  const pendingCalendarAction = group.events.find((event) => cleanText(event.approvalStatus) === "pending_owner");
  const futureEvent = group.events.find((event) =>
    parseTimestamp(event.startAt) > Date.now()
    && cleanText(event.status) !== "cancelled"
  );
  const activeCampaignRecipient = group.recipients.find((recipient) =>
    ["queued", "active"].includes(cleanText(recipient.status))
  );
  const leadSignal = group.leads.find((lead) =>
    ["captured", "partial_contact", "prompted", "prompt_ready"].includes(cleanText(lead.captureState))
  );
  const primaryThread = group.threads[0] || null;

  if (openComplaintTask) {
    return {
      key: "reply_to_complaint",
      title: "Reply to complaint",
      description: cleanText(openComplaintTask.title || openComplaintTask.description || "A complaint-risk contact still needs attention."),
      actionType: primaryThread ? "open_inbox_thread" : "open_automations_task",
      targetSection: primaryThread ? "inbox" : "automations",
      targetId: primaryThread ? primaryThread.id : openComplaintTask.id,
      taskId: openComplaintTask.id,
      threadId: primaryThread?.id || "",
    };
  }

  if (openSupportTask) {
    return {
      key: "review_support",
      title: "Review support issue",
      description: cleanText(openSupportTask.title || openSupportTask.description || "A support issue still needs an operator decision."),
      actionType: "open_automations_task",
      targetSection: "automations",
      targetId: openSupportTask.id,
      taskId: openSupportTask.id,
    };
  }

  if (pendingCalendarAction) {
    return {
      key: "review_booking_request",
      title: "Review calendar action",
      description: cleanText(pendingCalendarAction.title || "A calendar action is waiting for approval."),
      actionType: "open_calendar_event",
      targetSection: "calendar",
      targetId: pendingCalendarAction.id,
      eventId: pendingCalendarAction.id,
    };
  }

  if (pendingFollowUp) {
    return {
      key: "send_quote_follow_up",
      title: "Review follow-up",
      description: cleanText(pendingFollowUp.subject || pendingFollowUp.topic || "A prepared follow-up is waiting for approval."),
      actionType: "open_follow_up",
      targetSection: "automations",
      targetId: pendingFollowUp.id,
      followUpId: pendingFollowUp.id,
    };
  }

  if (leadSignal && !futureEvent) {
    return {
      key: "schedule_call",
      title: "Schedule call",
      description: cleanText(leadSignal.captureReason || "This contact showed booking or lead intent but no scheduled next step is visible yet."),
      actionType: "draft_calendar",
      targetSection: "calendar",
      leadId: cleanText(leadSignal.id),
    };
  }

  if (contact.lifecycleState === "customer" && !activeCampaignRecipient) {
    return {
      key: "add_review_request_campaign",
      title: "Add to review-request campaign",
      description: "This customer does not have an active campaign or follow-up sequence linked yet.",
      actionType: "draft_campaign",
      targetSection: "automations",
      recommendedGoal: "review_request",
    };
  }

  if (contact.lifecycleState === "active_lead" && !activeCampaignRecipient) {
    return {
      key: "draft_quote_follow_up",
      title: "Draft quote follow-up",
      description: "This lead has recent intent but no active outbound next step yet.",
      actionType: "draft_follow_up",
      targetSection: "automations",
      recommendedGoal: "quote_follow_up",
    };
  }

  return {
    key: "no_action_needed",
    title: "No action needed",
    description: "This contact does not have a higher-priority manual next step right now.",
    actionType: "stay_put",
    targetSection: "contacts",
  };
}

function buildContactSummary(group = {}, options = {}) {
  const timeline = buildTimelineEntries(group);
  const lastActivityAt = timeline[0]?.at || group.lastActivityAt || group.persistedContact?.lastActivityAt || null;
  const sourceSet = new Set(group.sourceKinds.concat(
    group.threads.length ? ["inbox"] : [],
    group.events.length ? ["calendar"] : [],
    group.recipients.length ? ["campaign"] : [],
    group.followUps.length ? ["follow_up"] : [],
    group.leads.length ? ["chat"] : []
  ));
  const flags = uniqueText(group.flags.concat(
    group.leads.flatMap(getLeadFlags),
    group.threads.flatMap(getThreadFlags),
    group.events.flatMap(getEventFlags),
    group.tasks.flatMap(getTaskFlags),
    group.followUps.flatMap(getFollowUpFlags),
    group.recipients.flatMap((recipient) => getRecipientFlags(recipient, recipient.campaign || {})),
    group.outcomes.flatMap(getOutcomeFlags)
  ));
  const suggestedLifecycleState = buildSuggestedLifecycleState(group, options.now || Date.now());
  const persistedContact = group.persistedContact || {};
  const lifecycleStateSource = cleanText(persistedContact.lifecycleStateSource) || "system";
  const lifecycleState = lifecycleStateSource === "owner"
    ? (cleanText(persistedContact.lifecycleState) || suggestedLifecycleState)
    : suggestedLifecycleState;
  const contact = {
    id: cleanText(group.id),
    name: pickDisplayName(group),
    bestIdentifier: pickBestIdentifier(group),
    email: normalizeEmail(group.emails[0] || persistedContact.primaryEmail),
    phone: normalizePhone(group.phones[0] || persistedContact.primaryPhone),
    lifecycleState,
    lifecycleStateSource,
    suggestedLifecycleState,
    mostRecentActivityAt: lastActivityAt,
    sources: [...sourceSet].map(formatSourceLabel),
    flags: flags.map(formatSourceLabel),
    partialIdentity: !normalizeEmail(group.emails[0]) && !normalizePhone(group.phones[0]),
    latestMessageId: cleanText(group.latestMessageId),
    primaryThreadId: cleanText(group.threads[0]?.id),
    primaryEventId: cleanText(group.events[0]?.id),
    primaryFollowUpId: cleanText(group.followUps[0]?.id),
    leadId: cleanText(group.leads[0]?.id),
    personKey: cleanText(group.personKeys[0]),
    timeline: timeline.slice(0, 12),
    counts: {
      leads: group.leads.length,
      inboxThreads: group.threads.length,
      calendarEvents: group.events.length,
      campaigns: group.campaigns.length,
      followUps: group.followUps.length,
      tasks: group.tasks.length,
      outcomes: group.outcomes.length,
    },
    complaintTaskIds: group.tasks
      .filter((task) => ["complaint_queue", "support_follow_up"].includes(cleanText(task.taskType)) && cleanText(task.status) === "open")
      .map((task) => cleanText(task.id)),
  };
  contact.nextAction = buildNextAction(contact, group);
  contact.related = {
    leadIds: uniqueText(group.leads.map((lead) => lead.id)),
    followUpIds: uniqueText(group.followUps.map((followUp) => followUp.id)),
    threadIds: uniqueText(group.threads.map((thread) => thread.id)),
    eventIds: uniqueText(group.events.map((event) => event.id)),
    taskIds: uniqueText(group.tasks.map((task) => task.id)),
    campaignIds: uniqueText(group.campaigns.map((campaign) => campaign.id)),
  };

  return contact;
}

function buildFilterSummary(contacts = []) {
  const staleThreshold = Date.now() - (1000 * 60 * 60 * 24 * 21);
  const count = (predicate) => contacts.filter(predicate).length;

  return {
    quick: [
      { key: "all", label: "All", count: contacts.length },
      { key: "leads", label: "Leads", count: count((contact) => ["active_lead", "qualified", "new"].includes(contact.lifecycleState)) },
      { key: "customers", label: "Customers", count: count((contact) => contact.lifecycleState === "customer") },
      { key: "complaints", label: "Complaints", count: count((contact) => contact.flags.includes("complaint")) },
      { key: "follow_up_due", label: "Follow-up due", count: count((contact) => contact.flags.includes("follow up due")) },
      { key: "booked", label: "Booked", count: count((contact) => contact.flags.includes("booked")) },
      { key: "no_recent_activity", label: "No recent activity", count: count((contact) => parseTimestamp(contact.mostRecentActivityAt) < staleThreshold) },
      { key: "campaign_active", label: "Campaign active", count: count((contact) => contact.flags.includes("campaign active")) },
    ],
    sources: [
      { key: "source_chat", label: "Chat", count: count((contact) => contact.sources.includes("chat")) },
      { key: "source_inbox", label: "Inbox", count: count((contact) => contact.sources.includes("inbox")) },
      { key: "source_calendar", label: "Calendar", count: count((contact) => contact.sources.includes("calendar")) },
      { key: "source_campaign", label: "Campaign", count: count((contact) => contact.sources.includes("campaign")) },
      { key: "source_follow_up", label: "Follow-up", count: count((contact) => contact.sources.includes("follow up")) },
    ],
  };
}

function buildContactsSummary(contacts = []) {
  return {
    totalContacts: contacts.length,
    contactsNeedingAttention: contacts.filter((contact) => cleanText(contact.nextAction?.key) !== "no_action_needed").length,
    complaintRiskContacts: contacts.filter((contact) =>
      ["complaint_risk", "support_issue"].includes(cleanText(contact.lifecycleState))
      || contact.flags.includes("complaint")
    ).length,
    leadsWithoutNextStep: contacts.filter((contact) =>
      ["active_lead", "qualified", "new"].includes(cleanText(contact.lifecycleState))
      && ["schedule_call", "draft_quote_follow_up", "review_booking_request"].includes(cleanText(contact.nextAction?.key))
    ).length,
    customersAwaitingFollowUp: contacts.filter((contact) =>
      cleanText(contact.lifecycleState) === "customer"
      && ["add_review_request_campaign", "send_quote_follow_up"].includes(cleanText(contact.nextAction?.key))
    ).length,
  };
}

function buildContactsHealth(options = {}) {
  return {
    persistenceAvailable: options.persistenceAvailable !== false,
    migrationRequired: options.migrationRequired === true,
    loadError: cleanText(options.loadError),
    partialData: options.partialData === true,
  };
}

export function buildContactWorkspaceFromRecords(options = {}) {
  const groups = [];
  const identityMaps = createIdentityMaps();

  const registerStoredContact = (storedContact = {}, storedIdentities = []) => {
    const group = createGroup({
      id: storedContact.id,
      persistedContact: storedContact,
      businessId: storedContact.businessId,
      displayName: storedContact.displayName,
      email: storedContact.primaryEmail,
      phone: storedContact.primaryPhone,
      phoneDigits: storedContact.primaryPhoneNormalized,
      personKey: storedContact.primaryPersonKey,
      sourceKinds: storedContact.activitySources,
      flags: storedContact.highPriorityFlags,
      lastActivityAt: storedContact.lastActivityAt,
      latestMessageId: cleanText(storedContact.metadata?.latestMessageId),
    });

    groups.push(group);

    registerIdentity(identityMaps, group, "email", storedContact.primaryEmail);
    registerIdentity(identityMaps, group, "phone", storedContact.primaryPhoneNormalized || storedContact.primaryPhone);
    registerIdentity(identityMaps, group, "person_key", storedContact.primaryPersonKey);

    storedIdentities.forEach((identity) => {
      addIdentityValues(group, {
        email: identity.identityType === "email" ? identity.identityValue : "",
        phone: identity.identityType === "phone" ? identity.identityValue : "",
        personKey: identity.identityType === "person_key" ? identity.identityValue : "",
        sessionKeys: identity.identityType === "session_key" ? [identity.identityValue] : [],
      });
      registerIdentity(identityMaps, group, identity.identityType, identity.identityValue);
    });
  };

  const storedContacts = normalizeArray(options.storedContacts);
  const storedIdentities = normalizeArray(options.storedIdentities);

  storedContacts.forEach((storedContact) => {
    registerStoredContact(
      storedContact,
      storedIdentities.filter((identity) => identity.contactId === storedContact.id)
    );
  });

  const findOrCreateGroup = ({ explicitGroups = [], strongIdentities = [], weakIdentities = [] } = {}) => {
    const candidates = collectCandidateGroups(identityMaps, explicitGroups, strongIdentities, weakIdentities);

    if (!candidates.length) {
      const group = createGroup({
        businessId: options.businessId,
      });
      groups.push(group);
      return group;
    }

    const [primary, ...secondaryGroups] = candidates;
    secondaryGroups.forEach((group) => mergeGroups(primary, group, identityMaps, groups));
    return primary;
  };

  normalizeArray(options.leads).forEach((lead) => {
    const strongIdentities = [
      { type: "email", value: lead.contactEmail },
      { type: "phone", value: lead.contactPhoneNormalized || lead.contactPhone },
      { type: "person_key", value: lead.personKey },
      { type: "lead_id", value: lead.id },
    ].filter((entry) => cleanText(entry.value));
    const weakIdentities = [
      { type: "session_key", value: lead.visitorSessionKey },
    ].filter((entry) => cleanText(entry.value));
    const group = findOrCreateGroup({ strongIdentities, weakIdentities });

    addToGroupCollection(group, "leads", lead);
    addIdentityValues(group, {
      displayName: lead.contactName,
      email: lead.contactEmail,
      phone: lead.contactPhone,
      phoneDigits: lead.contactPhoneNormalized,
      personKey: lead.personKey,
      sessionKeys: [lead.visitorSessionKey],
      sourceKinds: ["chat"],
      flags: getLeadFlags(lead),
      latestMessageId: lead.latestMessageId,
      lastActivityAt: lead.lastSeenAt || lead.updatedAt || lead.createdAt,
    });
    registerIdentity(identityMaps, group, "email", lead.contactEmail);
    registerIdentity(identityMaps, group, "phone", lead.contactPhoneNormalized || lead.contactPhone);
    registerIdentity(identityMaps, group, "person_key", lead.personKey);
    registerIdentity(identityMaps, group, "session_key", lead.visitorSessionKey);
    registerIdentity(identityMaps, group, "lead_id", lead.id);
  });

  normalizeArray(options.followUps).forEach((followUp) => {
    const explicitGroups = [
      identityMaps.follow_up_id.get(cleanText(followUp.id)),
      identityMaps.person_key.get(cleanText(followUp.personKey)),
      normalizeArray(followUp.linkedLeadIds || []).map((leadId) => identityMaps.lead_id.get(cleanText(leadId))),
    ].flat().filter(Boolean);
    const strongIdentities = [
      { type: "email", value: followUp.contactEmail },
      { type: "phone", value: followUp.contactPhone },
      { type: "person_key", value: followUp.personKey },
      { type: "follow_up_id", value: followUp.id },
    ].filter((entry) => cleanText(entry.value));
    const group = findOrCreateGroup({ explicitGroups, strongIdentities });

    addToGroupCollection(group, "followUps", followUp);
    addIdentityValues(group, {
      displayName: followUp.contactName,
      email: followUp.contactEmail,
      phone: followUp.contactPhone,
      personKey: followUp.personKey,
      sourceKinds: ["follow_up"],
      flags: getFollowUpFlags(followUp),
      lastActivityAt: followUp.sentAt || followUp.updatedAt || followUp.createdAt,
    });
    registerIdentity(identityMaps, group, "email", followUp.contactEmail);
    registerIdentity(identityMaps, group, "phone", followUp.contactPhone);
    registerIdentity(identityMaps, group, "person_key", followUp.personKey);
    registerIdentity(identityMaps, group, "follow_up_id", followUp.id);
  });

  normalizeArray(options.threads).forEach((thread) => {
    const threadEmails = getThreadContactEmails(thread);
    const explicitGroups = [
      identityMaps.thread_id.get(cleanText(thread.id)),
      identityMaps.lead_id.get(cleanText(thread.relatedLeadId)),
      identityMaps.follow_up_id.get(cleanText(thread.relatedFollowUpId)),
    ].filter(Boolean);
    const strongIdentities = [
      ...threadEmails.map((email) => ({ type: "email", value: email })),
      { type: "thread_id", value: thread.id },
    ].filter((entry) => cleanText(entry.value));
    const group = findOrCreateGroup({ explicitGroups, strongIdentities });

    addToGroupCollection(group, "threads", thread);
    addIdentityValues(group, {
      email: threadEmails[0],
      sourceKinds: ["inbox"],
      flags: getThreadFlags(thread),
      lastActivityAt: thread.lastMessageAt || thread.updatedAt || thread.createdAt,
    });
    threadEmails.forEach((email) => registerIdentity(identityMaps, group, "email", email));
    registerIdentity(identityMaps, group, "thread_id", thread.id);
  });

  normalizeArray(options.events).forEach((event) => {
    const explicitGroups = [
      identityMaps.event_id.get(cleanText(event.id)),
      identityMaps.lead_id.get(cleanText(event.leadId)),
    ].filter(Boolean);
    const strongIdentities = [
      ...normalizeArray(event.attendeeEmails).map((email) => ({ type: "email", value: email })),
      { type: "event_id", value: event.id },
    ].filter((entry) => cleanText(entry.value));
    const group = findOrCreateGroup({ explicitGroups, strongIdentities });

    addToGroupCollection(group, "events", event);
    addIdentityValues(group, {
      email: normalizeArray(event.attendeeEmails)[0],
      sourceKinds: ["calendar"],
      flags: getEventFlags(event),
      lastActivityAt: event.startAt || event.updatedAt || event.createdAt,
    });
    normalizeArray(event.attendeeEmails).forEach((email) => registerIdentity(identityMaps, group, "email", email));
    registerIdentity(identityMaps, group, "event_id", event.id);
  });

  normalizeArray(options.campaigns).forEach((campaign) => {
    normalizeArray(campaign.recipients).forEach((recipient) => {
      const decoratedRecipient = {
        ...recipient,
        campaign,
        campaignId: campaign.id,
        campaignTitle: campaign.title,
      };
      const explicitGroups = [
        identityMaps.campaign_recipient_id.get(cleanText(recipient.id)),
        identityMaps.lead_id.get(cleanText(recipient.leadId)),
        identityMaps.person_key.get(cleanText(recipient.personKey)),
      ].filter(Boolean);
      const strongIdentities = [
        { type: "email", value: recipient.contactEmail },
        { type: "person_key", value: recipient.personKey },
        { type: "campaign_recipient_id", value: recipient.id },
      ].filter((entry) => cleanText(entry.value));
      const group = findOrCreateGroup({ explicitGroups, strongIdentities });

      addToGroupCollection(group, "recipients", decoratedRecipient);
      addToGroupCollection(group, "campaigns", campaign);
      addIdentityValues(group, {
        displayName: recipient.contactName,
        email: recipient.contactEmail,
        personKey: recipient.personKey,
        sourceKinds: ["campaign"],
        flags: getRecipientFlags(recipient, campaign),
        lastActivityAt: recipient.lastContactedAt || recipient.nextSendAt || recipient.updatedAt || recipient.createdAt || campaign.updatedAt,
      });
      registerIdentity(identityMaps, group, "email", recipient.contactEmail);
      registerIdentity(identityMaps, group, "person_key", recipient.personKey);
      registerIdentity(identityMaps, group, "campaign_recipient_id", recipient.id);
    });
  });

  normalizeArray(options.tasks).forEach((task) => {
    const explicitGroups = [
      identityMaps.thread_id.get(cleanText(task.relatedThreadId)),
      identityMaps.event_id.get(cleanText(task.relatedEventId)),
      identityMaps.lead_id.get(cleanText(task.relatedLeadId)),
    ].filter(Boolean);
    const strongIdentities = [
      { type: "email", value: task.taskState?.contactEmail },
    ].filter((entry) => cleanText(entry.value));
    const group = explicitGroups.length || strongIdentities.length
      ? findOrCreateGroup({ explicitGroups, strongIdentities })
      : null;

    if (!group) {
      return;
    }

    addToGroupCollection(group, "tasks", task);
    addIdentityValues(group, {
      email: task.taskState?.contactEmail,
      sourceKinds: ["task"],
      flags: getTaskFlags(task),
      lastActivityAt: task.updatedAt || task.createdAt,
    });
    registerIdentity(identityMaps, group, "email", task.taskState?.contactEmail);
  });

  normalizeArray(options.outcomes).forEach((outcome) => {
    const explicitGroups = [
      identityMaps.lead_id.get(cleanText(outcome.leadId)),
      identityMaps.follow_up_id.get(cleanText(outcome.followUpId)),
      identityMaps.person_key.get(cleanText(outcome.personKey)),
      identityMaps.session_key.get(cleanText(outcome.sessionId)),
    ].filter(Boolean);
    const strongIdentities = [
      { type: "person_key", value: outcome.personKey },
    ].filter((entry) => cleanText(entry.value));
    const weakIdentities = [
      { type: "session_key", value: outcome.sessionId },
    ].filter((entry) => cleanText(entry.value));
    const group = explicitGroups.length || strongIdentities.length || weakIdentities.length
      ? findOrCreateGroup({ explicitGroups, strongIdentities, weakIdentities })
      : null;

    if (!group) {
      return;
    }

    addToGroupCollection(group, "outcomes", outcome);
    addIdentityValues(group, {
      sourceKinds: ["conversion"],
      flags: getOutcomeFlags(outcome),
      lastActivityAt: outcome.occurredAt || outcome.createdAt,
    });
  });

  const orderedPairs = groups
    .map((group) => ({
      group,
      contact: buildContactSummary(group, options),
    }))
    .sort((left, right) => parseTimestamp(right.contact.mostRecentActivityAt) - parseTimestamp(left.contact.mostRecentActivityAt));
  const contacts = orderedPairs.map((pair) => pair.contact);
  const orderedGroups = orderedPairs.map((pair) => pair.group);

  return {
    groups: orderedGroups,
    contacts,
    list: contacts,
    filters: buildFilterSummary(contacts),
    summary: buildContactsSummary(contacts),
  };
}

async function probeContactPersistence(supabase) {
  const [contactProbe, identityProbe] = await Promise.all([
    supabase.from(OPERATOR_CONTACT_TABLE).select("id").limit(1),
    supabase.from(OPERATOR_CONTACT_IDENTITY_TABLE).select("id").limit(1),
  ]);

  const missingError = [contactProbe.error, identityProbe.error].find((error) =>
    isMissingRelationError(error, OPERATOR_CONTACT_TABLE)
    || isMissingRelationError(error, OPERATOR_CONTACT_IDENTITY_TABLE)
  );

  if (missingError) {
    return {
      persistenceAvailable: false,
      migrationRequired: true,
    };
  }

  if (contactProbe.error) {
    throw contactProbe.error;
  }

  if (identityProbe.error) {
    throw identityProbe.error;
  }

  return {
    persistenceAvailable: true,
    migrationRequired: false,
  };
}

async function listStoredContacts(supabase, { agentId, ownerUserId }) {
  const { data, error } = await supabase
    .from(OPERATOR_CONTACT_TABLE)
    .select(CONTACT_SELECT)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .order("last_activity_at", { ascending: false });

  if (error) {
    if (isMissingRelationError(error, OPERATOR_CONTACT_TABLE)) {
      return [];
    }

    throw error;
  }

  return (data || []).map(mapStoredContactRow);
}

async function listStoredContactIdentities(supabase, { agentId, ownerUserId }) {
  const { data, error } = await supabase
    .from(OPERATOR_CONTACT_IDENTITY_TABLE)
    .select(CONTACT_IDENTITY_SELECT)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId);

  if (error) {
    if (isMissingRelationError(error, OPERATOR_CONTACT_IDENTITY_TABLE)) {
      return [];
    }

    throw error;
  }

  return (data || []).map(mapStoredIdentityRow);
}

function buildContactPayload(contact = {}, group = {}, options = {}) {
  const persistedContact = group.persistedContact || {};
  const lifecycleStateSource = cleanText(persistedContact.lifecycleStateSource) === "owner" ? "owner" : "system";
  const lifecycleState = lifecycleStateSource === "owner"
    ? cleanText(persistedContact.lifecycleState || contact.suggestedLifecycleState)
    : cleanText(contact.suggestedLifecycleState);

  return {
    id: cleanText(group.id) || undefined,
    agent_id: options.agentId,
    business_id: options.businessId || null,
    owner_user_id: options.ownerUserId,
    display_name: contact.name || null,
    primary_email: contact.email || null,
    primary_phone: contact.phone || null,
    primary_phone_normalized: normalizePhoneDigits(contact.phone) || null,
    primary_person_key: contact.personKey || null,
    lifecycle_state: lifecycleState || "new",
    lifecycle_state_source: lifecycleStateSource,
    suggested_lifecycle_state: contact.suggestedLifecycleState || "new",
    activity_sources: contact.sources.map((source) => source.replaceAll(" ", "_")),
    high_priority_flags: contact.flags.map((flag) => flag.replaceAll(" ", "_")),
    last_activity_at: contact.mostRecentActivityAt || null,
    next_action_type: cleanText(contact.nextAction?.key) || "no_action_needed",
    next_action_title: cleanText(contact.nextAction?.title) || null,
    next_action_payload: {
      ...contact.nextAction,
      latestMessageId: contact.latestMessageId || "",
      leadId: contact.leadId || "",
      primaryThreadId: contact.primaryThreadId || "",
    },
    metadata: {
      bestIdentifier: contact.bestIdentifier,
      partialIdentity: contact.partialIdentity === true,
      latestMessageId: contact.latestMessageId || "",
      related: contact.related || {},
      counts: contact.counts || {},
    },
    updated_at: nowIso(),
  };
}

function buildIdentityRows(contact = {}, group = {}, options = {}) {
  const contactId = cleanText(contact.id || group.id);
  const rows = [];
  const pushIdentity = (identityType, identityValue, isPrimary = false) => {
    const normalizedValue = identityType === "email"
      ? normalizeEmail(identityValue)
      : identityType === "phone"
        ? normalizePhoneDigits(identityValue)
        : cleanText(identityValue);

    if (!normalizedValue) {
      return;
    }

    rows.push({
      contact_id: contactId,
      agent_id: options.agentId,
      business_id: options.businessId || null,
      owner_user_id: options.ownerUserId,
      identity_type: identityType,
      identity_value: normalizedValue,
      is_primary: isPrimary,
      source_type: "contact_sync",
      first_seen_at: group.lastActivityAt || nowIso(),
      last_seen_at: group.lastActivityAt || nowIso(),
      metadata: {},
      updated_at: nowIso(),
    });
  };

  pushIdentity("email", contact.email, true);
  pushIdentity("phone", contact.phone, true);
  pushIdentity("person_key", contact.personKey, true);
  group.sessionKeys.forEach((sessionKey) => pushIdentity("session_key", sessionKey));
  group.leads.forEach((lead) => pushIdentity("lead_id", lead.id));
  group.followUps.forEach((followUp) => pushIdentity("follow_up_id", followUp.id));
  group.threads.forEach((thread) => pushIdentity("thread_id", thread.id));
  group.events.forEach((event) => pushIdentity("event_id", event.id));
  group.recipients.forEach((recipient) => pushIdentity("campaign_recipient_id", recipient.id));

  return rows;
}

async function persistContacts(supabase, built, options = {}) {
  const persistedContacts = [];

  for (let index = 0; index < built.contacts.length; index += 1) {
    const contact = built.contacts[index];
    const group = built.groups[index];
    const payload = buildContactPayload(contact, group, options);
    const query = payload.id
      ? supabase
        .from(OPERATOR_CONTACT_TABLE)
        .update(payload)
        .eq("id", payload.id)
        .select(CONTACT_SELECT)
        .single()
      : supabase
        .from(OPERATOR_CONTACT_TABLE)
        .insert(payload)
        .select(CONTACT_SELECT)
        .single();
    const { data, error } = await query;

    if (error) {
      throw error;
    }

    const storedContact = mapStoredContactRow(data);
    group.id = storedContact.id;
    persistedContacts.push(storedContact);
  }

  const identityRows = persistedContacts.flatMap((contact, index) =>
    buildIdentityRows(
      { ...built.contacts[index], id: contact.id },
      built.groups[index],
      options
    )
  );

  if (identityRows.length) {
    const { error: identityError } = await supabase
      .from(OPERATOR_CONTACT_IDENTITY_TABLE)
      .upsert(identityRows, {
        onConflict: "agent_id,owner_user_id,identity_type,identity_value",
      });

    if (identityError) {
      throw identityError;
    }
  }

  return persistedContacts;
}

async function safeBackfillSourceContact(supabase, tableName, rowId, contactId) {
  const normalizedRowId = cleanText(rowId);
  const normalizedContactId = cleanText(contactId);

  if (!normalizedRowId || !normalizedContactId) {
    return;
  }

  const { error } = await supabase
    .from(tableName)
    .update({
      contact_id: normalizedContactId,
      updated_at: nowIso(),
    })
    .eq("id", normalizedRowId);

  if (error && !isMissingRelationError(error, tableName)) {
    throw error;
  }
}

async function backfillSourceContactLinks(supabase, built) {
  for (let index = 0; index < built.contacts.length; index += 1) {
    const contactId = cleanText(built.groups[index].id);
    if (!contactId) {
      continue;
    }

    const group = built.groups[index];
    for (const lead of group.leads) {
      await safeBackfillSourceContact(supabase, LEAD_CAPTURE_TABLE, lead.id, contactId);
    }
    for (const followUp of group.followUps) {
      await safeBackfillSourceContact(supabase, FOLLOW_UP_WORKFLOW_TABLE, followUp.id, contactId);
    }
    for (const thread of group.threads) {
      await safeBackfillSourceContact(supabase, OPERATOR_INBOX_THREAD_TABLE, thread.id, contactId);
    }
    for (const event of group.events) {
      await safeBackfillSourceContact(supabase, OPERATOR_CALENDAR_EVENT_TABLE, event.id, contactId);
    }
    for (const recipient of group.recipients) {
      await safeBackfillSourceContact(supabase, OPERATOR_CAMPAIGN_RECIPIENT_TABLE, recipient.id, contactId);
    }
    for (const task of group.tasks) {
      await safeBackfillSourceContact(supabase, OPERATOR_TASK_TABLE, task.id, contactId);
    }
    for (const outcome of group.outcomes) {
      await safeBackfillSourceContact(supabase, CONVERSION_OUTCOME_TABLE, outcome.id, contactId);
    }
  }
}

export async function getOperatorContactsWorkspace(
  supabase,
  {
    agent,
    ownerUserId,
    leads = [],
    threads = [],
    events = [],
    tasks = [],
    campaigns = [],
    followUps = [],
    outcomes = [],
    loadError = "",
  } = {}
) {
  const agentId = cleanText(agent?.id);
  const businessId = cleanText(agent?.businessId);

  if (!agentId || !cleanText(ownerUserId)) {
    return {
      list: [],
      filters: buildFilterSummary([]),
      summary: { ...CONTACT_EMPTY_STATE },
      health: buildContactsHealth({
        persistenceAvailable: true,
        migrationRequired: false,
        loadError,
      }),
    };
  }

  let persistenceState = {
    persistenceAvailable: true,
    migrationRequired: false,
  };
  let storedContacts = [];
  let storedIdentities = [];

  try {
    persistenceState = await probeContactPersistence(supabase);

    if (persistenceState.persistenceAvailable) {
      [storedContacts, storedIdentities] = await Promise.all([
        listStoredContacts(supabase, {
          agentId,
          ownerUserId,
        }),
        listStoredContactIdentities(supabase, {
          agentId,
          ownerUserId,
        }),
      ]);
    }
  } catch (error) {
    return {
      list: [],
      filters: buildFilterSummary([]),
      summary: { ...CONTACT_EMPTY_STATE },
      health: buildContactsHealth({
        persistenceAvailable: false,
        migrationRequired: false,
        loadError: cleanText(error.message || loadError || "Contacts workspace could not load."),
      }),
    };
  }

  const built = buildContactWorkspaceFromRecords({
    businessId,
    storedContacts,
    storedIdentities,
    leads,
    threads,
    events,
    tasks,
    campaigns,
    followUps,
    outcomes,
    now: Date.now(),
  });

  if (persistenceState.persistenceAvailable) {
    try {
      const persistedContacts = await persistContacts(supabase, built, {
        agentId,
        businessId,
        ownerUserId,
      });
      persistedContacts.forEach((storedContact, index) => {
        built.contacts[index].id = storedContact.id;
        built.groups[index].id = storedContact.id;
      });
      await backfillSourceContactLinks(supabase, built);
    } catch (error) {
      persistenceState = {
        persistenceAvailable: false,
        migrationRequired: false,
      };
      return {
        list: built.contacts,
        filters: built.filters,
        summary: built.summary,
        health: buildContactsHealth({
          persistenceAvailable: false,
          migrationRequired: false,
          loadError: cleanText(error.message || loadError || "Contacts sync failed."),
          partialData: true,
        }),
      };
    }
  }

  return {
    list: built.contacts,
    filters: built.filters,
    summary: built.summary,
    health: buildContactsHealth({
      persistenceAvailable: persistenceState.persistenceAvailable,
      migrationRequired: persistenceState.migrationRequired,
      loadError,
      partialData: Boolean(loadError),
    }),
  };
}

export async function updateOperatorContactLifecycleState(
  supabase,
  {
    agentId,
    ownerUserId,
    contactId,
    lifecycleState,
  } = {}
) {
  const normalizedLifecycleState = cleanText(lifecycleState);

  if (!CONTACT_LIFECYCLE_STATES.includes(normalizedLifecycleState)) {
    const error = new Error("Enter a valid contact lifecycle state.");
    error.statusCode = 400;
    throw error;
  }

  const { data, error } = await supabase
    .from(OPERATOR_CONTACT_TABLE)
    .update({
      lifecycle_state: normalizedLifecycleState,
      lifecycle_state_source: "owner",
      updated_at: nowIso(),
    })
    .eq("id", cleanText(contactId))
    .eq("agent_id", cleanText(agentId))
    .eq("owner_user_id", cleanText(ownerUserId))
    .select(CONTACT_SELECT)
    .single();

  if (error) {
    if (isMissingRelationError(error, OPERATOR_CONTACT_TABLE)) {
      const missing = new Error("Contacts persistence is not available until the latest migration is applied.");
      missing.statusCode = 409;
      throw missing;
    }

    throw error;
  }

  return mapStoredContactRow(data);
}
