import { ACTION_QUEUE_STATUS_TABLE } from "../../config/constants.js";
import { cleanText } from "../../utils/text.js";

const ACTION_QUEUE_STATUSES = ["new", "reviewed", "done", "dismissed"];
const CONTACT_STATUSES = ["not_contacted", "attempted", "contacted", "qualified"];
const ACTIONABLE_INTENTS = ["contact", "booking", "pricing", "support"];
const SUPPORTED_FOLLOW_UP_ACTION_TYPES = [
  "lead_follow_up",
  "pricing_interest",
  "booking_intent",
  "repeat_high_intent_visitor",
];
const ACTION_QUEUE_PERSISTENCE_COLUMNS = [
  "note",
  "outcome",
  "next_step",
  "follow_up_needed",
  "follow_up_completed",
  "contact_status",
];

function isMissingRelationError(error, relationName) {
  const message = cleanText(error?.message || "");
  return (
    error?.code === "PGRST205" ||
    error?.code === "42P01" ||
    message.toLowerCase().includes(`'public.${relationName}'`) ||
    message.toLowerCase().includes(`${relationName} was not found`)
  );
}

function normalizeStatus(value) {
  const normalized = cleanText(value).toLowerCase();
  return ACTION_QUEUE_STATUSES.includes(normalized) ? normalized : "new";
}

function isMissingPersistenceColumnError(error) {
  const message = cleanText(error?.message || "").toLowerCase();

  return (
    error?.code === "PGRST204" ||
    error?.code === "42703" ||
    ACTION_QUEUE_PERSISTENCE_COLUMNS.some((columnName) => message.includes(columnName))
  );
}

function isUnavailablePersistenceError(error) {
  return isMissingRelationError(error, ACTION_QUEUE_STATUS_TABLE) || isMissingPersistenceColumnError(error);
}

function normalizeBooleanFlag(value) {
  if (value === true || value === false) {
    return value;
  }

  const normalized = cleanText(value).toLowerCase();

  if (["true", "yes", "1"].includes(normalized)) {
    return true;
  }

  if (["false", "no", "0"].includes(normalized)) {
    return false;
  }

  return null;
}

function normalizeContactStatus(value) {
  const normalized = cleanText(value).toLowerCase();
  return CONTACT_STATUSES.includes(normalized) ? normalized : "";
}

function normalizePersistedItem(item = {}) {
  return {
    agentId: cleanText(item.agentId || item.agent_id),
    ownerUserId: cleanText(item.ownerUserId || item.owner_user_id),
    actionKey: cleanText(item.actionKey || item.action_key),
    status: normalizeStatus(item.status),
    note: cleanText(item.note),
    outcome: cleanText(item.outcome),
    nextStep: cleanText(item.nextStep || item.next_step),
    followUpNeeded: normalizeBooleanFlag(item.followUpNeeded ?? item.follow_up_needed),
    followUpCompleted: normalizeBooleanFlag(item.followUpCompleted ?? item.follow_up_completed),
    contactStatus: normalizeContactStatus(item.contactStatus || item.contact_status),
    updatedAt: item.updatedAt || item.updated_at || null,
  };
}

function normalizeActionType(value) {
  const normalized = cleanText(value).toLowerCase();
  return [
    "lead_follow_up",
    "pricing_interest",
    "booking_intent",
    "repeat_high_intent_visitor",
    "knowledge_gap",
    "unanswered_question",
  ].includes(normalized)
    ? normalized
    : "";
}

function isSupportedFollowUpActionType(value) {
  return SUPPORTED_FOLLOW_UP_ACTION_TYPES.includes(normalizeActionType(value));
}

function buildActionType(interaction = {}) {
  switch (interaction.type) {
    case "contact":
      return "lead_follow_up";
    case "pricing":
      return "pricing_interest";
    case "booking":
      return "booking_intent";
    case "weak_answer":
      return interaction.unresolved ? "unanswered_question" : "knowledge_gap";
    default:
      return "";
  }
}

function buildFollowUpWorkflowState(followUp = {}) {
  const status = cleanText(followUp.status).toLowerCase();

  switch (status) {
    case "ready":
      return {
        key: "follow_up_ready",
        label: "Follow-up ready",
        copy: cleanText(followUp.subject)
          ? `Prepared and ready to review: ${cleanText(followUp.subject)}`
          : "A prepared follow-up is ready for review.",
        attention: true,
        resolved: false,
        rank: 0,
      };
    case "draft":
      return {
        key: "follow_up_draft",
        label: "Draft prepared",
        copy: "A prepared follow-up draft is waiting for owner review.",
        attention: true,
        resolved: false,
        rank: 1,
      };
    case "failed":
      return {
        key: "follow_up_failed",
        label: "Follow-up failed",
        copy: cleanText(followUp.lastError)
          ? `Last failure: ${cleanText(followUp.lastError)}`
          : "The prepared follow-up failed and still needs owner attention.",
        attention: true,
        resolved: false,
        rank: 0,
      };
    case "missing_contact":
      return {
        key: "missing_contact",
        label: "Missing contact",
        copy: "Vonza prepared the context, but this conversation still needs a usable email address or phone number.",
        attention: true,
        resolved: false,
        rank: 0,
      };
    case "sent":
      return {
        key: "follow_up_sent",
        label: "Follow-up sent",
        copy: "The prepared follow-up was marked sent, so this queue item is resolved.",
        attention: false,
        resolved: true,
        rank: 4,
      };
    case "dismissed":
      return {
        key: "follow_up_dismissed",
        label: "Dismissed",
        copy: "This prepared follow-up was intentionally dismissed.",
        attention: false,
        resolved: false,
        rank: 5,
      };
    default:
      return null;
  }
}

function hasOwnerHandoffContent(item = {}) {
  return Boolean(
    cleanText(item.note)
    || cleanText(item.outcome)
    || cleanText(item.nextStep || item.next_step)
    || normalizeBooleanFlag(item.followUpNeeded ?? item.follow_up_needed) !== null
    || normalizeBooleanFlag(item.followUpCompleted ?? item.follow_up_completed) !== null
    || normalizeContactStatus(item.contactStatus || item.contact_status)
  );
}

function isFollowUpNeeded(item = {}) {
  if (item.followUpCompleted === true || normalizeStatus(item.status) === "done" || normalizeStatus(item.status) === "dismissed") {
    return false;
  }

  if (item.followUpNeeded === true || item.followUpNeeded === false) {
    return item.followUpNeeded;
  }

  return normalizeStatus(item.status) !== "dismissed";
}

function isResolved(item = {}) {
  return item.followUpCompleted === true || normalizeStatus(item.status) === "done";
}

function buildOwnerWorkflow(item = {}) {
  const followUpWorkflow = buildFollowUpWorkflowState(item.followUp || {});

  if (followUpWorkflow) {
    return followUpWorkflow;
  }

  const status = normalizeStatus(item.status);
  const followUpNeeded = isFollowUpNeeded(item);
  const resolved = isResolved(item);
  const handoffStarted = hasOwnerHandoffContent(item);

  if (status === "dismissed") {
    return {
      key: "dismissed",
      label: "Dismissed",
      copy: "This item was intentionally dismissed from the lightweight owner follow-up flow.",
      attention: false,
      resolved: false,
      rank: 5,
    };
  }

  if (resolved) {
    return {
      key: "resolved",
      label: "Resolved",
      copy: cleanText(item.outcome)
        ? "A resolution is recorded and this queue item no longer needs active follow-up."
        : "This queue item is marked complete and no longer needs active follow-up.",
      attention: false,
      resolved: true,
      rank: 4,
    };
  }

  if (followUpNeeded) {
    return {
      key: handoffStarted ? "follow_up_in_progress" : "follow_up_needed",
      label: handoffStarted ? "Follow-up in progress" : "Needs follow-up",
      copy: cleanText(item.nextStep)
        ? `Next step: ${cleanText(item.nextStep)}`
        : "The owner still needs to follow up on this conversation signal.",
      attention: true,
      resolved: false,
      rank: handoffStarted ? 1 : 0,
    };
  }

  if (status === "reviewed" || handoffStarted) {
    return {
      key: "reviewed_pending",
      label: "Reviewed",
      copy: cleanText(item.outcome)
        ? "Owner context is recorded, but the item is not marked resolved yet."
        : "The owner has started reviewing this item, but the final outcome is not recorded yet.",
      attention: true,
      resolved: false,
      rank: 2,
    };
  }

  return {
    key: "needs_review",
    label: "Needs owner review",
    copy: "This flagged conversation still needs an owner decision on what happened next.",
    attention: true,
    resolved: false,
    rank: 3,
  };
}

function normalizeQuestion(message) {
  return cleanText(String(message || ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value, maxLength = 180) {
  const normalized = cleanText(value);

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function getMessageTimestamp(message) {
  const value = new Date(message?.createdAt || message?.created_at || "").getTime();
  return Number.isFinite(value) ? value : 0;
}

function getChronologicalMessages(messages = []) {
  return [...messages].sort((left, right) => getMessageTimestamp(left) - getMessageTimestamp(right));
}

function buildConversationActionKey(message = {}, fallbackIndex = 0) {
  const messageId = cleanText(message.id || message.messageId);

  if (messageId) {
    return `conversation:${messageId}`;
  }

  const timestamp = cleanText(message.createdAt || message.created_at).replace(/[^0-9TZ]/gi, "");
  const questionSlug = normalizeQuestion(message.content || "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 48);

  return `conversation:${timestamp || `index-${fallbackIndex}`}:${questionSlug || "message"}`;
}

function categorizeIntent(message) {
  const normalized = cleanText(String(message || "")).toLowerCase();

  if (!normalized) {
    return "general";
  }

  if (
    normalized.includes("book")
    || normalized.includes("booking")
    || normalized.includes("appointment")
    || normalized.includes("schedule")
    || normalized.includes("availability")
    || normalized.includes("calendar")
    || normalized.includes("reserve")
    || normalized.includes("consultation")
    || normalized.includes("consult")
    || normalized.includes("meeting")
    || normalized.includes("demo")
  ) {
    return "booking";
  }

  if (
    normalized.includes("price")
    || normalized.includes("pricing")
    || normalized.includes("cost")
    || normalized.includes("quote")
    || normalized.includes("fee")
    || normalized.includes("buy")
    || normalized.includes("purchase")
    || normalized.includes("plan")
    || normalized.includes("package")
    || normalized.includes("how much")
  ) {
    return "pricing";
  }

  if (
    normalized.includes("problem")
    || normalized.includes("issue")
    || normalized.includes("broken")
    || normalized.includes("not working")
    || normalized.includes("complaint")
    || normalized.includes("refund")
    || normalized.includes("cancel")
    || normalized.includes("unhappy")
    || normalized.includes("support")
    || normalized.includes("frustrated")
    || normalized.includes("late")
  ) {
    return "support";
  }

  if (
    normalized.includes("contact")
    || normalized.includes("reach")
    || normalized.includes("call")
    || normalized.includes("email")
    || normalized.includes("phone")
    || normalized.includes("talk to")
    || normalized.includes("speak to")
    || normalized.includes("get in touch")
    || normalized.includes("someone")
  ) {
    return "contact";
  }

  if (
    normalized.includes("service")
    || normalized.includes("offer")
    || normalized.includes("product")
    || normalized.includes("help with")
    || normalized.includes("do you do")
    || normalized.includes("what do you do")
  ) {
    return "services";
  }

  return "general";
}

function getIntentLabel(intent) {
  switch (intent) {
    case "contact":
      return "Lead / contact";
    case "booking":
      return "Booking";
    case "pricing":
      return "Pricing / purchase";
    case "support":
      return "Support / complaint";
    default:
      return "General";
  }
}

function getSuggestedAction(intent) {
  switch (intent) {
    case "contact":
      return "Review whether the site and assistant make the contact path obvious enough, then follow up manually if contact details were captured.";
    case "booking":
      return "Clarify the booking path, availability, or consultation steps so the visitor can move forward faster.";
    case "pricing":
      return "Tighten pricing, package, or quote guidance so the assistant can answer with more confidence.";
    case "support":
      return "Review the issue, improve the weak answer path, and decide whether the business process or site copy needs a fix.";
    case "weak_answer":
      return "Improve website knowledge or assistant guidance so future visitors get a stronger answer.";
    default:
      return "Review the conversation pattern and decide whether the assistant or website needs a clearer next step.";
  }
}

function getFlaggedReason(intent, count) {
  const suffix = `${count} conversation${count === 1 ? "" : "s"}`;

  switch (intent) {
    case "contact":
      return `Flagged because ${suffix} showed direct lead or contact intent.`;
    case "booking":
      return `Flagged because ${suffix} asked about booking, scheduling, or availability.`;
    case "pricing":
      return `Flagged because ${suffix} asked about pricing, packages, or purchase intent.`;
    case "support":
      return `Flagged because ${suffix} looked like support, complaint, or problem-solving requests.`;
    case "weak_answer":
      return `Flagged because ${suffix} ended in weak or uncertain assistant answers.`;
    default:
      return `Flagged because ${suffix} showed a recurring pattern worth reviewing.`;
  }
}

function getConversationFlagReason(intent, options = {}) {
  const weakAnswer = options.weakAnswer === true;
  const unresolved = options.unresolved === true;
  const reasons = [];

  switch (intent) {
    case "contact":
      reasons.push("this visitor showed direct lead or contact intent");
      break;
    case "booking":
      reasons.push("this visitor asked about booking, scheduling, or availability");
      break;
    case "pricing":
      reasons.push("this visitor asked about pricing, packages, or purchase intent");
      break;
    case "support":
      reasons.push("this visitor sounded like support, complaint, or problem-resolution work");
      break;
    default:
      break;
  }

  if (unresolved) {
    reasons.push("the conversation did not receive a clear assistant answer yet");
  } else if (weakAnswer) {
    reasons.push("the assistant answer looked weak or uncertain");
  }

  if (!reasons.length) {
    return "Flagged because this conversation needs owner review.";
  }

  if (reasons.length === 1) {
    return `Flagged because ${reasons[0]}.`;
  }

  return `Flagged because ${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}.`;
}

function hasWeakAssistantReply(reply) {
  const normalized = cleanText(String(reply || "")).toLowerCase();

  if (!normalized) {
    return true;
  }

  return [
    "i don't know",
    "i do not know",
    "i'm not sure",
    "i am not sure",
    "i don't have",
    "i do not have",
    "i couldn't find",
    "i could not find",
    "i can't find",
    "i cannot find",
    "not available on the website",
    "not mentioned on the website",
    "not provided on the website",
    "please contact the business directly",
    "please reach out directly",
    "reach out to the business directly",
  ].some((snippet) => normalized.includes(snippet));
}

function buildConversationSummary(question, reply) {
  const normalizedQuestion = cleanText(question);
  const normalizedReply = cleanText(reply);

  if (normalizedQuestion && normalizedReply) {
    return truncateText(`Visitor asked: ${normalizedQuestion} Vonza replied: ${normalizedReply}`);
  }

  if (normalizedQuestion) {
    return truncateText(`Visitor asked: ${normalizedQuestion}`);
  }

  if (normalizedReply) {
    return truncateText(`Vonza replied: ${normalizedReply}`);
  }

  return "";
}

function getConversationSuggestedAction(type, options = {}) {
  const weakAnswer = options.weakAnswer === true;
  const contactCaptured = options.contactCaptured === true;
  const unresolved = options.unresolved === true;
  const base = getSuggestedAction(type);

  if (type === "contact" && contactCaptured && (weakAnswer || unresolved)) {
    return `${base} Contact details were captured here, so decide whether the owner should respond directly now.`;
  }

  if (type !== "weak_answer" && (weakAnswer || unresolved)) {
    return `${base} The assistant also struggled in this conversation, so improve the answer path before the next similar visitor arrives.`;
  }

  return base;
}

function extractContactInfo(text = "") {
  const normalized = String(text || "");
  const emailMatch = normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phoneMatch = normalized.match(/(?:\+?\d[\d().\-\s]{6,}\d)/);
  const namePatterns = [
    /\b(?:my name is|i am|i'm|this is)\s+([\p{L}][\p{L}'-]+(?:\s+[\p{L}][\p{L}'-]+){1,2})\b/iu,
    /\b(?:a nevem|az en nevem|nevem)\s+([\p{L}][\p{L}'-]+(?:\s+[\p{L}][\p{L}'-]+){1,2})\b/iu,
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
    email: emailMatch ? cleanText(emailMatch[0]) : "",
    phone: phoneMatch ? cleanText(phoneMatch[0]) : "",
    name,
  };
}

function mergeContactInfo(existing = {}, next = {}) {
  return {
    email: existing.email || next.email || "",
    phone: existing.phone || next.phone || "",
    name: existing.name || next.name || "",
  };
}

function normalizeEmail(value) {
  return cleanText(value).toLowerCase();
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 7 ? digits : "";
}

function normalizePersonName(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^\p{L}\s'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyPersonName(value) {
  const normalized = normalizePersonName(value);
  const parts = normalized.split(" ").filter(Boolean);
  const blockedParts = new Set([
    "hello",
    "support",
    "pricing",
    "team",
    "thanks",
    "thank",
    "customer",
    "visitor",
    "there",
    "someone",
  ]);

  return (
    parts.length >= 2 &&
    parts.length <= 3 &&
    parts.every((part) => part.length >= 2 && !blockedParts.has(part))
  );
}

function toTitleCase(value) {
  return cleanText(value)
    .split(" ")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function getInteractionCreatedAt(interaction = {}) {
  return interaction.createdAt || interaction.lastSeenAt || null;
}

function buildInteractionIdentity(interaction = {}) {
  const email = normalizeEmail(interaction.contactInfo?.email);
  const phone = normalizePhone(interaction.contactInfo?.phone);
  const sessionKey = cleanText(interaction.sessionKey);
  const normalizedName = isLikelyPersonName(interaction.contactInfo?.name)
    ? normalizePersonName(interaction.contactInfo?.name)
    : "";

  return {
    email,
    phone,
    sessionKey,
    name: normalizedName,
  };
}

function createPersonRecord(interaction = {}) {
  const identity = buildInteractionIdentity(interaction);
  const personKey = identity.email
    ? `person:email:${identity.email}`
    : identity.phone
      ? `person:phone:${identity.phone}`
      : identity.sessionKey
        ? `person:session:${identity.sessionKey}`
        : identity.name
          ? `person:name:${identity.name}`
          : `person:unknown:${interaction.key}`;

  return {
    key: personKey,
    email: identity.email || "",
    phone: identity.phone || "",
    phoneRaw: cleanText(interaction.contactInfo?.phone),
    name: identity.name || "",
    nameRaw: cleanText(interaction.contactInfo?.name),
    sessionKeys: new Set(identity.sessionKey ? [identity.sessionKey] : []),
    interactions: [],
    actionKeys: new Set(),
    intentCounts: new Map(),
    firstSeenAt: getInteractionCreatedAt(interaction),
    lastSeenAt: interaction.lastSeenAt || getInteractionCreatedAt(interaction),
  };
}

function addInteractionToPerson(person, interaction = {}) {
  const identity = buildInteractionIdentity(interaction);

  if (!person.email && identity.email) {
    person.email = identity.email;
  }

  if (!person.phone && identity.phone) {
    person.phone = identity.phone;
  }

  if (!person.phoneRaw && cleanText(interaction.contactInfo?.phone)) {
    person.phoneRaw = cleanText(interaction.contactInfo.phone);
  }

  if (!person.name && identity.name) {
    person.name = identity.name;
  }

  if (!person.nameRaw && cleanText(interaction.contactInfo?.name)) {
    person.nameRaw = cleanText(interaction.contactInfo.name);
  }

  if (identity.sessionKey) {
    person.sessionKeys.add(identity.sessionKey);
  }

  person.interactions.push(interaction);

  if (interaction.actionable) {
    person.actionKeys.add(interaction.key);
  }

  person.intentCounts.set(
    interaction.intent,
    (person.intentCounts.get(interaction.intent) || 0) + 1
  );

  const createdAt = getInteractionCreatedAt(interaction);

  if (!person.firstSeenAt || getMessageTimestamp({ createdAt }) < getMessageTimestamp({ createdAt: person.firstSeenAt })) {
    person.firstSeenAt = createdAt;
  }

  if (!person.lastSeenAt || getMessageTimestamp({ createdAt }) > getMessageTimestamp({ createdAt: person.lastSeenAt })) {
    person.lastSeenAt = createdAt;
  }
}

function mergePersonRecords(primary, secondary) {
  if (!primary || !secondary || primary.key === secondary.key) {
    return primary;
  }

  if (!primary.email && secondary.email) {
    primary.email = secondary.email;
  }

  if (!primary.phone && secondary.phone) {
    primary.phone = secondary.phone;
  }

  if (!primary.phoneRaw && secondary.phoneRaw) {
    primary.phoneRaw = secondary.phoneRaw;
  }

  if (!primary.name && secondary.name) {
    primary.name = secondary.name;
  }

  if (!primary.nameRaw && secondary.nameRaw) {
    primary.nameRaw = secondary.nameRaw;
  }

  secondary.sessionKeys.forEach((sessionKey) => {
    primary.sessionKeys.add(sessionKey);
  });
  secondary.interactions.forEach((interaction) => {
    primary.interactions.push(interaction);
  });
  secondary.actionKeys.forEach((actionKey) => {
    primary.actionKeys.add(actionKey);
  });
  secondary.intentCounts.forEach((count, intent) => {
    primary.intentCounts.set(intent, (primary.intentCounts.get(intent) || 0) + count);
  });

  if (!primary.firstSeenAt || getMessageTimestamp({ createdAt: secondary.firstSeenAt }) < getMessageTimestamp({ createdAt: primary.firstSeenAt })) {
    primary.firstSeenAt = secondary.firstSeenAt;
  }

  if (!primary.lastSeenAt || getMessageTimestamp({ createdAt: secondary.lastSeenAt }) > getMessageTimestamp({ createdAt: primary.lastSeenAt })) {
    primary.lastSeenAt = secondary.lastSeenAt;
  }

  return primary;
}

function registerPersonSignals(person, signalMaps) {
  if (person.email) {
    signalMaps.email.set(person.email, person.key);
  }

  if (person.phone) {
    signalMaps.phone.set(person.phone, person.key);
  }

  person.sessionKeys.forEach((sessionKey) => {
    signalMaps.session.set(sessionKey, person.key);
  });

  if (person.name) {
    signalMaps.name.set(person.name, person.key);
  }
}

function buildConversationInteractions(messages = []) {
  const chronological = getChronologicalMessages(messages);
  const interactions = [];

  chronological.forEach((message, index) => {
    if (message.role !== "user") {
      return;
    }

    const question = cleanText(message.content || "");

    if (!question) {
      return;
    }

    const intent = categorizeIntent(question);
    let reply = "";
    let assistantMessage = null;

    for (let cursor = index + 1; cursor < chronological.length; cursor += 1) {
      const nextMessage = chronological[cursor];

      if (nextMessage.role === "user") {
        break;
      }

      if (nextMessage.role === "assistant") {
        reply = cleanText(nextMessage.content || "");
        assistantMessage = nextMessage;
        break;
      }
    }

    const actionableIntent = ACTIONABLE_INTENTS.includes(intent);
    const weakAnswer = hasWeakAssistantReply(reply);
    const unresolved = !cleanText(reply);
    const type = actionableIntent ? intent : "weak_answer";
    const contactInfo = mergeContactInfo(extractContactInfo(question), extractContactInfo(reply));
    const actionKey = buildConversationActionKey(message, index);
    const lastSeenAt = assistantMessage?.createdAt || assistantMessage?.created_at || message.createdAt || message.created_at || null;
    const sessionKey = cleanText(
      message.sessionKey
      || message.session_key
      || assistantMessage?.sessionKey
      || assistantMessage?.session_key
    );

    interactions.push({
      key: actionKey,
      messageId: cleanText(message.id || message.messageId),
      type,
      label: type === "weak_answer"
        ? unresolved ? "Unresolved conversation" : "Weak answer"
        : getIntentLabel(type),
      question,
      reply,
      snippet: buildConversationSummary(question, reply),
      whyFlagged: getConversationFlagReason(intent, { weakAnswer, unresolved }),
      suggestedAction: getConversationSuggestedAction(type, {
        weakAnswer,
        unresolved,
        contactCaptured: Boolean(contactInfo.email || contactInfo.phone),
      }),
      createdAt: message.createdAt || message.created_at || null,
      lastSeenAt,
      unresolved,
      weakAnswer,
      intent,
      actionable: actionableIntent || weakAnswer,
      contactCaptured: Boolean(contactInfo.email || contactInfo.phone),
      contactInfo: contactInfo.email || contactInfo.phone || contactInfo.name
        ? {
            email: contactInfo.email || null,
            phone: contactInfo.phone || null,
            name: contactInfo.name || null,
          }
        : null,
      sessionKey: sessionKey || null,
    });
  });

  return interactions;
}

function buildRepeatHighIntentItems(people = [], persistedMap = new Map()) {
  return people
    .map((person) => {
      const highIntentTimeline = (person.timeline || [])
        .filter((entry) => ["contact", "pricing", "booking"].includes(entry.intent));

      if (!person.isReturning || highIntentTimeline.length < 2) {
        return null;
      }

      const actionKey = `person:${person.key}:repeat_high_intent`;
      const persistedItem = persistedMap.get(actionKey) || {};
      const snippets = (person.snippets || [])
        .filter((entry) => ["contact", "pricing", "booking"].includes(entry.intent))
        .slice(0, 2)
        .map((entry) => cleanText(entry.text))
        .filter(Boolean);
      const intentLabels = [...new Set(
        highIntentTimeline
          .map((entry) => getIntentLabel(entry.intent))
          .filter(Boolean)
      )];
      const ownerWorkflow = buildOwnerWorkflow({
        ...persistedItem,
      });

      return {
        key: actionKey,
        type: "repeat_high_intent",
        actionType: "repeat_high_intent_visitor",
        followUpSupported: true,
        label: "Repeat high-intent visitor",
        status: persistedItem.status || "new",
        count: highIntentTimeline.length,
        snippet: truncateText(snippets.join(" ")),
        question: snippets[0] || "",
        reply: "",
        whyFlagged: `Flagged because this same visitor returned across ${highIntentTimeline.length} high-intent interactions${intentLabels.length ? ` around ${intentLabels.join(", ")}` : ""}.`,
        suggestedAction: "Use the prepared follow-up to reconnect while the visitor is still showing active intent.",
        lastSeenAt: person.lastSeenAt || null,
        note: persistedItem.note || "",
        outcome: persistedItem.outcome || "",
        nextStep: persistedItem.nextStep || "",
        followUpNeeded: persistedItem.followUpNeeded,
        followUpCompleted: persistedItem.followUpCompleted,
        contactStatus: persistedItem.contactStatus || "",
        updatedAt: persistedItem.updatedAt || null,
        ownerWorkflow,
        contactCaptured: Boolean(person.email || person.phone),
        contactInfo: person.email || person.phone || person.name
          ? {
            email: person.email || null,
            phone: person.phone || null,
            name: person.name || null,
          }
          : null,
        unresolved: false,
        weakAnswer: false,
        intent: highIntentTimeline[0]?.intent || "contact",
        sessionKey: null,
        personKey: person.key,
        relatedActionKeys: highIntentTimeline.map((entry) => entry.actionKey).filter(Boolean),
        messageId: highIntentTimeline[0]?.messageId || "",
      };
    })
    .filter(Boolean);
}

function buildPersonKeyIntents(intentCounts = new Map()) {
  return [...intentCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([intent, count]) => ({
      intent,
      count,
      label: getIntentLabel(intent),
    }));
}

function buildPersonFollowUp(queueItems = []) {
  if (!queueItems.length) {
    return {
      key: "no_queue_items",
      label: "No queue items yet",
      copy: "This visitor has not created a follow-up item yet.",
      attentionCount: 0,
      resolvedCount: 0,
    };
  }

  const workflows = queueItems.map((item) => item.ownerWorkflow || buildOwnerWorkflow(item));
  const attentionCount = workflows.filter((workflow) => workflow.attention).length;
  const resolvedCount = workflows.filter((workflow) => workflow.resolved).length;

  if (attentionCount > 0) {
    return {
      key: "needs_attention",
      label: attentionCount === 1 ? "1 item needs attention" : `${attentionCount} items need attention`,
      copy: attentionCount === queueItems.length
        ? "Every linked queue item still needs owner attention."
        : "Some linked queue items still need owner attention.",
      attentionCount,
      resolvedCount,
    };
  }

  if (resolvedCount === queueItems.length) {
    return {
      key: "resolved",
      label: "Resolved",
      copy: "All linked queue items are resolved.",
      attentionCount,
      resolvedCount,
    };
  }

  return {
    key: "monitored",
    label: "Monitored",
    copy: "This visitor has queue history, but nothing urgent is open right now.",
    attentionCount,
    resolvedCount,
  };
}

function buildPersonStory(person) {
  const interactionCount = Number(person.interactionCount || person.interactions?.length || 0);
  const topIntent = person.keyIntents.find((entry) => entry.intent !== "general" && entry.intent !== "services") || person.keyIntents[0];

  if (topIntent?.intent === "pricing" && topIntent.count > 1) {
    return `This same person asked about pricing ${topIntent.count} times.`;
  }

  if (topIntent?.intent === "support" && topIntent.count > 1) {
    return `This support issue appears to be evolving across ${topIntent.count} interactions.`;
  }

  if (topIntent?.intent === "contact" && interactionCount > 1) {
    return `This lead came back across ${interactionCount} interactions.`;
  }

  if (interactionCount > 1) {
    return `This same visitor returned across ${interactionCount} interactions.`;
  }

  return "Single interaction so far.";
}

function buildPersonDisplayLabel(person) {
  if (cleanText(person.nameRaw)) {
    return cleanText(person.nameRaw);
  }

  if (person.email) {
    return person.email;
  }

  if (person.phoneRaw) {
    return person.phoneRaw;
  }

  if (person.sessionKeys.size > 0) {
    return person.interactions.length > 1 ? "Returning visitor" : "Known visitor";
  }

  return "Unknown visitor";
}

function stitchPeople(interactions = [], actionItems = []) {
  const peopleByKey = new Map();
  const signalMaps = {
    email: new Map(),
    phone: new Map(),
    session: new Map(),
    name: new Map(),
  };
  const actionItemMap = new Map(actionItems.map((item) => [item.key, item]));

  interactions.forEach((interaction) => {
    const identity = buildInteractionIdentity(interaction);
    const matchingKeys = new Set();

    if (identity.email && signalMaps.email.has(identity.email)) {
      matchingKeys.add(signalMaps.email.get(identity.email));
    }

    if (identity.phone && signalMaps.phone.has(identity.phone)) {
      matchingKeys.add(signalMaps.phone.get(identity.phone));
    }

    if (identity.sessionKey && signalMaps.session.has(identity.sessionKey)) {
      matchingKeys.add(signalMaps.session.get(identity.sessionKey));
    }

    if (
      identity.name &&
      signalMaps.name.has(identity.name) &&
      !identity.email &&
      !identity.phone &&
      !identity.sessionKey
    ) {
      matchingKeys.add(signalMaps.name.get(identity.name));
    }

    let person = null;

    if (!matchingKeys.size) {
      person = createPersonRecord(interaction);
      peopleByKey.set(person.key, person);
    } else {
      const [primaryKey, ...otherKeys] = [...matchingKeys];
      person = peopleByKey.get(primaryKey);

      otherKeys.forEach((otherKey) => {
        const otherPerson = peopleByKey.get(otherKey);

        if (!otherPerson) {
          return;
        }

        person = mergePersonRecords(person, otherPerson);
        peopleByKey.delete(otherKey);
      });
    }

    addInteractionToPerson(person, interaction);
    registerPersonSignals(person, signalMaps);
  });

  const people = [...peopleByKey.values()]
    .map((person) => {
      const queueItems = [...new Set([
        ...person.actionKeys,
        ...actionItems
          .filter((item) => cleanText(item.personKey) === person.key)
          .map((item) => item.key),
      ])]
        .map((actionKey) => actionItemMap.get(actionKey))
        .filter(Boolean)
        .sort((left, right) => getMessageTimestamp({ createdAt: right.lastSeenAt }) - getMessageTimestamp({ createdAt: left.lastSeenAt }));
      const interactionsDesc = [...person.interactions]
        .sort((left, right) => getMessageTimestamp({ createdAt: right.lastSeenAt || right.createdAt }) - getMessageTimestamp({ createdAt: left.lastSeenAt || left.createdAt }));
      const normalizedPerson = {
        key: person.key,
        label: buildPersonDisplayLabel(person),
        identityType: person.email
          ? "email"
          : person.phone
            ? "phone"
            : person.sessionKeys.size > 0
              ? "session"
              : person.name
                ? "name"
                : "unknown",
        email: person.email || null,
        phone: person.phoneRaw || null,
        name: cleanText(person.nameRaw) || (person.name ? toTitleCase(person.name) : null),
        firstSeenAt: person.firstSeenAt || null,
        lastSeenAt: person.lastSeenAt || null,
        interactionCount: interactionsDesc.length,
        queueItemCount: queueItems.length,
        isReturning: interactionsDesc.length > 1,
        keyIntents: buildPersonKeyIntents(person.intentCounts),
        snippets: interactionsDesc.slice(0, 3).map((interaction) => ({
          actionKey: interaction.key,
          messageId: interaction.messageId || "",
          text: interaction.snippet || buildConversationSummary(interaction.question, interaction.reply),
          at: interaction.lastSeenAt || interaction.createdAt || null,
          intent: interaction.intent,
          actionable: interaction.actionable,
        })),
        timeline: interactionsDesc.slice(0, 5).map((interaction) => ({
          actionKey: interaction.key,
          messageId: interaction.messageId || "",
          at: interaction.lastSeenAt || interaction.createdAt || null,
          label: interaction.label,
          intent: interaction.intent,
          summary: interaction.snippet || buildConversationSummary(interaction.question, interaction.reply),
          actionable: interaction.actionable,
        })),
        queueItemKeys: queueItems.map((item) => item.key),
        queueItems: queueItems.map((item) => ({
          key: item.key,
          label: item.label,
          status: item.status,
          ownerWorkflow: item.ownerWorkflow,
          lastSeenAt: item.lastSeenAt,
        })),
      };

      normalizedPerson.followUp = buildPersonFollowUp(queueItems);
      normalizedPerson.story = buildPersonStory(normalizedPerson);

      return normalizedPerson;
    })
    .sort((left, right) => getMessageTimestamp({ createdAt: right.lastSeenAt }) - getMessageTimestamp({ createdAt: left.lastSeenAt }));
  const peopleByActionKey = new Map();

  people.forEach((person) => {
    person.timeline.forEach((entry) => {
      peopleByActionKey.set(entry.actionKey, person.key);
    });
  });

  const peopleIndex = new Map(people.map((person) => [person.key, person]));

  return {
    people,
    items: actionItems.map((item) => {
      const personKey = cleanText(item.personKey) || peopleByActionKey.get(item.key);
      const person = peopleIndex.get(personKey);

      if (!person) {
        return item;
      }

      return {
        ...item,
        person: {
          key: person.key,
          label: person.label,
          identityType: person.identityType,
          relatedInteractionCount: person.interactionCount,
          relatedQueueItemCount: person.queueItemCount,
          isReturning: person.isReturning,
          story: person.story,
          followUp: person.followUp,
        },
      };
    }),
  };
}

function buildPeopleSummary(people = []) {
  return {
    total: people.length,
    returning: people.filter((person) => person.isReturning).length,
    linkedQueueItems: people.filter((person) => person.queueItemCount > 0).length,
  };
}

function buildStatusSummary(items = []) {
  const summary = {
    total: items.length,
    new: 0,
    reviewed: 0,
    done: 0,
    dismissed: 0,
    followUpNeeded: 0,
    followUpCompleted: 0,
    resolved: 0,
    attentionNeeded: 0,
  };

  items.forEach((item) => {
    const status = normalizeStatus(item.status);
    const workflow = item.ownerWorkflow || buildOwnerWorkflow(item);
    summary[status] += 1;

    if (isFollowUpNeeded(item)) {
      summary.followUpNeeded += 1;
    }

    if (item.followUpCompleted === true) {
      summary.followUpCompleted += 1;
    }

    if (isResolved(item)) {
      summary.resolved += 1;
    }

    if (workflow.attention) {
      summary.attentionNeeded += 1;
    }
  });

  return summary;
}

export function buildActionQueue(messages = [], persistedStatuses = [], options = {}) {
  const persistedMap = new Map(
    (persistedStatuses || []).map((item) => {
      const normalized = normalizePersistedItem(item);
      return [normalized.actionKey, normalized];
    })
  );
  const interactions = buildConversationInteractions(messages);
  const baseItems = interactions
    .filter((interaction) => interaction.actionable)
    .map((interaction) => {
      const persistedItem = persistedMap.get(interaction.key) || {};
      const ownerWorkflow = buildOwnerWorkflow(persistedItem);

      return {
        key: interaction.key,
        type: interaction.type,
        actionType: buildActionType(interaction),
        followUpSupported: isSupportedFollowUpActionType(buildActionType(interaction)),
        label: interaction.label,
        status: persistedItem.status || "new",
        count: 1,
        snippet: interaction.snippet,
        question: interaction.question,
        reply: interaction.reply,
        whyFlagged: interaction.whyFlagged,
        suggestedAction: interaction.suggestedAction,
        lastSeenAt: interaction.lastSeenAt,
        messageId: interaction.messageId || "",
        note: persistedItem.note || "",
        outcome: persistedItem.outcome || "",
        nextStep: persistedItem.nextStep || "",
        followUpNeeded: persistedItem.followUpNeeded,
        followUpCompleted: persistedItem.followUpCompleted,
        contactStatus: persistedItem.contactStatus || "",
        updatedAt: persistedItem.updatedAt || null,
        ownerWorkflow,
        contactCaptured: interaction.contactCaptured,
        contactInfo: interaction.contactInfo,
        unresolved: interaction.unresolved,
        weakAnswer: interaction.weakAnswer,
        intent: interaction.intent,
        sessionKey: interaction.sessionKey,
      };
    });
  const preliminarySortedItems = [...baseItems]
    .sort((left, right) => {
      const rankDelta = (left.ownerWorkflow?.rank ?? 99) - (right.ownerWorkflow?.rank ?? 99);

      if (rankDelta !== 0) {
        return rankDelta;
      }

      return getMessageTimestamp({ createdAt: right.lastSeenAt }) - getMessageTimestamp({ createdAt: left.lastSeenAt });
    });
  const preliminaryStitched = stitchPeople(interactions, preliminarySortedItems);
  const repeatHighIntentItems = buildRepeatHighIntentItems(preliminaryStitched.people, persistedMap);
  const items = [...baseItems, ...repeatHighIntentItems];
  const followUpsByActionKey = new Map();

  (Array.isArray(options.followUps) ? options.followUps : []).forEach((followUp) => {
    const linkedActionKeys = [
      cleanText(followUp.sourceActionKey || followUp.source_action_key),
      ...(Array.isArray(followUp.linkedActionKeys || followUp.linked_action_keys)
        ? followUp.linkedActionKeys || followUp.linked_action_keys
        : []),
    ]
      .map((actionKey) => cleanText(actionKey))
      .filter(Boolean);

    linkedActionKeys.forEach((actionKey) => {
      followUpsByActionKey.set(actionKey, followUp);
    });
  });

  const sortedItems = items
    .sort((left, right) => {
      const rankDelta = (left.ownerWorkflow?.rank ?? 99) - (right.ownerWorkflow?.rank ?? 99);

      if (rankDelta !== 0) {
        return rankDelta;
      }

      return getMessageTimestamp({ createdAt: right.lastSeenAt }) - getMessageTimestamp({ createdAt: left.lastSeenAt });
    });
  const stitched = stitchPeople(interactions, sortedItems);
  const hydratedItems = stitched.items.map((item) => {
    const followUp = followUpsByActionKey.get(item.key) || null;
    const ownerWorkflow = buildOwnerWorkflow({
      ...item,
      followUp,
    });

    return {
      ...item,
      actionType: normalizeActionType(item.actionType) || "",
      followUpSupported: item.followUpSupported === true || isSupportedFollowUpActionType(item.actionType),
      followUp,
      ownerWorkflow,
    };
  });

  return {
    items: hydratedItems,
    people: stitched.people,
    peopleSummary: buildPeopleSummary(stitched.people),
    summary: buildStatusSummary(hydratedItems),
    persistenceAvailable: options.persistenceAvailable !== false,
    migrationRequired: options.persistenceAvailable === false,
    followUpWorkflowAvailable: options.followUpWorkflowAvailable !== false,
    followUpWorkflowMigrationRequired: options.followUpWorkflowAvailable === false,
  };
}

export async function listActionQueueStatuses(supabase, options = {}) {
  const agentId = cleanText(options.agentId);
  const ownerUserId = cleanText(options.ownerUserId);

  if (!agentId || !ownerUserId) {
    return [];
  }

  const { data, error } = await supabase
    .from(ACTION_QUEUE_STATUS_TABLE)
    .select("agent_id, owner_user_id, action_key, status, note, outcome, next_step, follow_up_needed, follow_up_completed, contact_status, updated_at")
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId);

  if (error) {
    if (isUnavailablePersistenceError(error)) {
      return {
        records: [],
        persistenceAvailable: false,
      };
    }

    console.error(error);
    throw error;
  }

  return {
    records: (data || []).map((row) => normalizePersistedItem(row)),
    persistenceAvailable: true,
  };
}

export async function updateActionQueueStatus(supabase, options = {}) {
  const agentId = cleanText(options.agentId);
  const ownerUserId = cleanText(options.ownerUserId);
  const actionKey = cleanText(options.actionKey);
  const note = options.note === undefined ? undefined : cleanText(options.note);
  const outcome = options.outcome === undefined ? undefined : cleanText(options.outcome);
  const nextStep = options.nextStep === undefined ? undefined : cleanText(options.nextStep);
  const followUpNeeded = options.followUpNeeded === undefined ? undefined : normalizeBooleanFlag(options.followUpNeeded);
  const followUpCompleted = options.followUpCompleted === undefined ? undefined : normalizeBooleanFlag(options.followUpCompleted);
  const contactStatus = options.contactStatus === undefined ? undefined : normalizeContactStatus(options.contactStatus);
  const explicitStatus = options.status === undefined ? null : normalizeStatus(options.status);
  const hasHandoffUpdate = [
    note,
    outcome,
    nextStep,
    contactStatus,
  ].some((value) => value !== undefined && value !== "") || followUpNeeded !== undefined || followUpCompleted !== undefined;
  let status = explicitStatus;

  if (!status) {
    status = "new";
  }

  if (status !== "dismissed") {
    if (followUpCompleted === true || (followUpNeeded === false && outcome)) {
      status = "done";
    } else if (hasHandoffUpdate && status === "new") {
      status = "reviewed";
    }
  }

  if (!agentId || !ownerUserId || !actionKey) {
    const error = new Error("agent_id, owner_user_id, and action_key are required");
    error.statusCode = 400;
    throw error;
  }

  const payload = {
    agent_id: agentId,
    owner_user_id: ownerUserId,
    action_key: actionKey,
    updated_at: new Date().toISOString(),
  };

  payload.status = status;

  if (note !== undefined) {
    payload.note = note;
  }

  if (outcome !== undefined) {
    payload.outcome = outcome;
  }

  if (nextStep !== undefined) {
    payload.next_step = nextStep;
  }

  if (followUpNeeded !== undefined) {
    payload.follow_up_needed = followUpNeeded;
  }

  if (followUpCompleted !== undefined) {
    payload.follow_up_completed = followUpCompleted;
  }

  if (contactStatus !== undefined) {
    payload.contact_status = contactStatus || null;
  }

  const { data, error } = await supabase
    .from(ACTION_QUEUE_STATUS_TABLE)
    .upsert(payload, { onConflict: "agent_id,action_key" })
    .select("agent_id, owner_user_id, action_key, status, note, outcome, next_step, follow_up_needed, follow_up_completed, contact_status, updated_at")
    .single();

  if (error) {
    if (isUnavailablePersistenceError(error)) {
      return {
        item: normalizePersistedItem({
          agentId,
          ownerUserId,
          actionKey,
          status,
          note,
          outcome,
          nextStep,
          followUpNeeded,
          followUpCompleted,
          contactStatus,
          updatedAt: new Date().toISOString(),
        }),
        persistenceAvailable: false,
      };
    }

    console.error(error);
    throw error;
  }

  return {
    item: normalizePersistedItem(data),
    persistenceAvailable: true,
  };
}
