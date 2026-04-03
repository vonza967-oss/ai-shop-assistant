import { cleanText } from "../../utils/text.js";

const HIGH_INTENT_ACTION_TYPES = new Set([
  "lead_follow_up",
  "pricing_interest",
  "booking_intent",
  "repeat_high_intent_visitor",
]);

function normalizeMessages(messages = []) {
  return Array.isArray(messages)
    ? messages.map((message) => ({
      role: cleanText(message.role).toLowerCase(),
      content: cleanText(message.content),
      createdAt: message.createdAt || message.created_at || null,
    }))
    : [];
}

function getTimestamp(value) {
  const timestamp = new Date(value || "").getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function buildDefaultRecentActivity() {
  return {
    level: "none",
    description: "No live activity yet",
    copy: "No live conversations have been stored yet.",
    lastActivityAt: null,
  };
}

function buildDefaultOperatorSignal() {
  return {
    title: "No operator signal yet",
    copy: "There is not a strong lead, booking, pricing, or support signal yet.",
    subtle: "No weak-answer signal has been detected yet.",
  };
}

export function createEmptyAnalyticsSummary() {
  return {
    ready: true,
    syncState: "ready",
    diagnosticsMessage: "",
    totalMessages: 0,
    visitorQuestions: 0,
    highIntentSignals: 0,
    directCtasShown: 0,
    ctaClicks: 0,
    ctaClickThroughRate: 0,
    contactsCaptured: 0,
    assistedOutcomes: 0,
    weakAnswerCount: 0,
    attentionNeeded: 0,
    lastMessageAt: null,
    recentActivity: buildDefaultRecentActivity(),
    operatorSignal: buildDefaultOperatorSignal(),
  };
}

function buildRecentActivity({
  totalMessages,
  visitorQuestions,
  lastMessageAt,
  widgetMetrics = {},
  installStatus = {},
  syncState,
}) {
  const base = buildDefaultRecentActivity();

  if (syncState === "pending") {
    return {
      ...base,
      level: "pending",
      description: "Syncing recent live activity",
      copy: "Widget activity was detected before the stored conversation read model caught up.",
      lastActivityAt: widgetMetrics.lastConversationAt || installStatus.lastSeenAt || null,
    };
  }

  if (!totalMessages && !visitorQuestions) {
    if (cleanText(installStatus.state) === "seen_recently" || cleanText(installStatus.state) === "seen_stale") {
      return {
        ...base,
        level: "waiting",
        description: "Live install detected, waiting for first stored conversation",
        copy: "Open the live site and send a real test question to confirm chat persistence and analytics end to end.",
        lastActivityAt: installStatus.lastSeenAt || null,
      };
    }

    return base;
  }

  const hoursSinceLastMessage = lastMessageAt
    ? Math.max(0, (Date.now() - getTimestamp(lastMessageAt)) / (1000 * 60 * 60))
    : null;

  if (hoursSinceLastMessage !== null && hoursSinceLastMessage <= 24 && visitorQuestions >= 3) {
    return {
      level: "active",
      description: "Active in the last day",
      copy: `${visitorQuestions} visitor question${visitorQuestions === 1 ? "" : "s"} and ${totalMessages} total stored message${totalMessages === 1 ? "" : "s"} are already in the read model.`,
      lastActivityAt: lastMessageAt,
    };
  }

  if (hoursSinceLastMessage !== null && hoursSinceLastMessage <= 72) {
    return {
      level: "recent",
      description: "Recent live usage",
      copy: `${visitorQuestions} visitor question${visitorQuestions === 1 ? "" : "s"} and ${totalMessages} total stored message${totalMessages === 1 ? "" : "s"} have been captured recently.`,
      lastActivityAt: lastMessageAt,
    };
  }

  return {
    level: "historical",
    description: "Earlier stored activity",
    copy: `${totalMessages} stored message${totalMessages === 1 ? "" : "s"} are available from earlier live usage.`,
    lastActivityAt: lastMessageAt,
  };
}

function buildOperatorSignal({
  highIntentSignals,
  weakAnswerCount,
  widgetMetrics = {},
  installStatus = {},
}) {
  const base = buildDefaultOperatorSignal();

  if (highIntentSignals > 0) {
    return {
      title: "High-intent operator signal",
      copy: `${highIntentSignals} high-intent customer signal${highIntentSignals === 1 ? "" : "s"} have already appeared.`,
      subtle: weakAnswerCount > 0
        ? `${weakAnswerCount} conversation${weakAnswerCount === 1 ? "" : "s"} still need a stronger answer path.`
        : `${Number(widgetMetrics.conversationsSinceInstall || 0)} conversation${Number(widgetMetrics.conversationsSinceInstall || 0) === 1 ? "" : "s"} started since install.`,
    };
  }

  if (Number(widgetMetrics.conversationsSinceInstall || 0) === 0 && ["seen_recently", "seen_stale", "installed_unseen"].includes(cleanText(installStatus.state))) {
    return {
      title: "No conversation signal yet",
      copy: "0 conversations since install. Run a live test flow to confirm visitors can reach the assistant.",
      subtle: weakAnswerCount > 0
        ? `${weakAnswerCount} conversation${weakAnswerCount === 1 ? "" : "s"} already showed a weak-answer signal.`
        : "Once real conversations arrive, Vonza will surface operator-facing signals here.",
    };
  }

  if (weakAnswerCount > 0) {
    return {
      title: "Answer quality signal",
      copy: `${weakAnswerCount} conversation${weakAnswerCount === 1 ? "" : "s"} may need a stronger answer path.`,
      subtle: "Review the weak-answer conversations before similar visitors hit the same gap again.",
    };
  }

  return base;
}

export function buildAnalyticsSummary({
  messages = [],
  actionQueue = {},
  widgetMetrics = {},
  installStatus = {},
  diagnosticsMessage = "",
} = {}) {
  const summary = createEmptyAnalyticsSummary();
  const normalizedMessages = normalizeMessages(messages);
  const queueItems = Array.isArray(actionQueue.items) ? actionQueue.items : [];
  const conversionSummary = {
    ...actionQueue.conversionSummary,
  };
  const outcomeSummary = {
    ...actionQueue.outcomeSummary,
  };
  const orderedMessages = normalizedMessages
    .slice()
    .sort((left, right) => getTimestamp(right.createdAt) - getTimestamp(left.createdAt));
  const lastMessageAt = orderedMessages[0]?.createdAt || null;
  const totalMessages = normalizedMessages.length;
  const visitorQuestions = normalizedMessages.filter((message) => message.role === "user").length;
  const highIntentSignals = Number(conversionSummary.highIntentConversations || 0)
    || queueItems.filter((item) => HIGH_INTENT_ACTION_TYPES.has(cleanText(item.actionType))).length;
  const weakAnswerCount = queueItems.filter((item) => item.weakAnswer === true || item.unresolved === true).length;
  const syncState =
    totalMessages === 0
    && visitorQuestions === 0
    && Number(widgetMetrics.conversationsSinceInstall || 0) > 0
      ? "pending"
      : "ready";

  return {
    ...summary,
    ready: !diagnosticsMessage,
    syncState,
    diagnosticsMessage: cleanText(diagnosticsMessage),
    totalMessages,
    visitorQuestions,
    highIntentSignals,
    directCtasShown: Number(conversionSummary.directCtasShown || 0),
    ctaClicks: Number(conversionSummary.ctaClicks || 0),
    ctaClickThroughRate: Number(conversionSummary.ctaClickThroughRate || 0),
    contactsCaptured: Number(conversionSummary.contactsCaptured || 0),
    assistedOutcomes: Number(outcomeSummary.assistedConversions || 0),
    weakAnswerCount,
    attentionNeeded: Number(actionQueue.summary?.attentionNeeded || 0),
    lastMessageAt,
    recentActivity: buildRecentActivity({
      totalMessages,
      visitorQuestions,
      lastMessageAt,
      widgetMetrics,
      installStatus,
      syncState,
    }),
    operatorSignal: buildOperatorSignal({
      highIntentSignals,
      weakAnswerCount,
      widgetMetrics,
      installStatus,
    }),
  };
}
