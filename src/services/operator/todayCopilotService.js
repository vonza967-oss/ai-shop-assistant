import { cleanText } from "../../utils/text.js";

const COPILOT_QUESTIONS = Object.freeze([
  "What needs attention today?",
  "Which leads need follow-up?",
  "Which contacts asked about pricing but have no outcome?",
  "What outcomes happened recently?",
  "What is the next best action?",
  "Summarize today's front-desk activity.",
  "Draft a follow-up for this contact.",
]);

function isSameDay(left, right) {
  return String(left || "").slice(0, 10) === String(right || "").slice(0, 10);
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function createRecommendation({
  id,
  type,
  title,
  summary,
  priority = "medium",
  confidence = "medium",
  rationale = "",
  source = {},
} = {}) {
  return {
    id: cleanText(id),
    type: cleanText(type),
    title: cleanText(title),
    summary: cleanText(summary),
    priority: cleanText(priority) || "medium",
    confidence: cleanText(confidence) || "medium",
    rationale: cleanText(rationale),
    source: source && typeof source === "object" && !Array.isArray(source) ? source : {},
    approvalRequired: true,
    writeBehavior: "recommendation_only",
  };
}

function createDraft({
  id,
  type,
  title,
  channel,
  subject,
  body,
  confidence = "medium",
  rationale = "",
  source = {},
} = {}) {
  return {
    id: cleanText(id),
    type: cleanText(type),
    title: cleanText(title),
    channel: cleanText(channel) || "email",
    subject: cleanText(subject),
    body: cleanText(body),
    confidence: cleanText(confidence) || "medium",
    rationale: cleanText(rationale),
    source: source && typeof source === "object" && !Array.isArray(source) ? source : {},
    approvalRequired: true,
    writeBehavior: "draft_only",
  };
}

function createAnswer({
  key,
  question,
  answer,
  confidence = "medium",
  rationale = "",
  recommendationIds = [],
  draftIds = [],
} = {}) {
  return {
    key: cleanText(key),
    question: cleanText(question),
    answer: cleanText(answer),
    confidence: cleanText(confidence) || "medium",
    rationale: cleanText(rationale),
    recommendationIds: recommendationIds.map((value) => cleanText(value)).filter(Boolean),
    draftIds: draftIds.map((value) => cleanText(value)).filter(Boolean),
  };
}

function buildFallbackGuidance({
  agent = {},
  businessProfile = {},
  websiteReady = false,
  installLive = false,
} = {}) {
  const guidance = [];

  if (!websiteReady) {
    guidance.push("Re-import website knowledge so Copilot can ground pricing, policy, and service answers in the current site content.");
  }

  if (!installLive) {
    guidance.push("Confirm the widget is live so Today starts seeing real front-desk activity instead of setup-only state.");
  }

  if ((businessProfile.readiness?.missingSections || []).length) {
    guidance.push(`Fill the business context foundation next: ${businessProfile.readiness.missingSections.join(", ")}.`);
  }

  if (!guidance.length) {
    guidance.push("As soon as live conversations, queue items, or outcomes appear, Copilot will summarize them here.");
  }

  return guidance;
}

function buildGeneratedDraft(contact = {}, options = {}) {
  const businessName = cleanText(options.businessName) || "the business";
  const assistantName = cleanText(options.assistantName) || businessName;
  const topic = cleanText(contact.topic || contact.intentLabel || "your request");
  const contactName = cleanText(contact.contactName);
  const greeting = contactName ? `Hi ${contactName},` : "Hi there,";

  return createDraft({
    id: cleanText(options.id) || "generated-follow-up",
    type: "follow_up_draft",
    title: cleanText(options.title) || `Draft follow-up for ${contactName || "this contact"}`,
    channel: cleanText(contact.channel) || "email",
    subject: cleanText(options.subject) || `${businessName}: following up on ${topic}`,
    body: [
      greeting,
      "",
      `This is ${assistantName} from ${businessName}.`,
      `I’m following up on ${topic} and wanted to make sure you have the right next step from us.`,
      "If you reply with the detail or timing you need, we can keep things moving without losing context.",
      "",
      `${assistantName}`,
    ].join("\n"),
    confidence: "medium",
    rationale: cleanText(options.rationale) || "No stored follow-up draft existed, so Copilot prepared a deterministic approval-first draft from the latest stable-core context.",
    source: {
      contactId: cleanText(contact.contactId),
      actionKey: cleanText(contact.actionKey),
    },
  });
}

function isPricingAction(item = {}) {
  const actionType = cleanText(item.actionType || item.type);
  return actionType === "pricing_interest" || actionType === "pricing";
}

export function createEmptyTodayCopilotState({ featureEnabled = false } = {}) {
  return {
    enabled: featureEnabled === true,
    featureEnabled: featureEnabled === true,
    readOnly: true,
    draftOnly: true,
    autonomousActionsEnabled: false,
    sparseData: true,
    generatedAt: new Date().toISOString(),
    headline: "Copilot is waiting for stable-core activity.",
    summary: "Today stays fully usable without Copilot. When stable-core data shows up, Copilot will summarize it here without taking external actions on its own.",
    questions: [...COPILOT_QUESTIONS],
    context: {
      agentId: "",
      businessId: "",
      sourceCounts: {
        messages: 0,
        actionQueueItems: 0,
        contacts: 0,
        followUps: 0,
        knowledgeFixes: 0,
        recentOutcomes: 0,
        widgetEvents: 0,
      },
      installLive: false,
      websiteKnowledgeReady: false,
      businessProfile: {
        readiness: {
          totalSections: 0,
          completedSections: 0,
          missingCount: 0,
          missingSections: [],
          summary: "",
        },
      },
      warnings: [],
    },
    answers: [],
    recommendations: [],
    drafts: [],
    fallback: {
      title: "Copilot needs a little more context",
      description: "There is not enough stable-core data yet to make strong recommendations.",
      guidance: [],
    },
  };
}

export function buildTodayCopilotSnapshot(options = {}) {
  if (options.featureEnabled !== true) {
    return createEmptyTodayCopilotState();
  }

  const agent = options.agent || {};
  const actionQueue = options.actionQueue || {};
  const businessProfile = options.businessProfile || { readiness: { missingSections: [] } };
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const contacts = Array.isArray(options.contacts) ? options.contacts : [];
  const followUps = Array.isArray(options.followUps) ? options.followUps : [];
  const knowledgeFixes = Array.isArray(options.knowledgeFixes) ? options.knowledgeFixes : [];
  const routingEvents = Array.isArray(options.routingEvents) ? options.routingEvents : [];
  const recentOutcomes = Array.isArray(options.recentOutcomes) ? options.recentOutcomes : [];
  const queueItems = Array.isArray(actionQueue.items) ? actionQueue.items : [];
  const attentionQueueItems = queueItems.filter((item) => item.ownerWorkflow?.attention === true);
  const followUpCandidates = followUps.filter((workflow) =>
    ["ready", "draft", "missing_contact"].includes(cleanText(workflow.status))
  );
  const knowledgeFixCandidates = knowledgeFixes.filter((workflow) =>
    ["ready", "draft", "failed"].includes(cleanText(workflow.status))
  );
  const pricingWithoutOutcomeItems = queueItems.filter((item) =>
    isPricingAction(item)
    && Number(item.outcomes?.count || 0) === 0
    && !["done", "dismissed"].includes(cleanText(item.status))
  );
  const contactsNeedingAttention = contacts.filter((contact) =>
    cleanText(contact.nextAction?.key) && cleanText(contact.nextAction?.key) !== "no_action_needed"
  );
  const nowIso = options.now || new Date().toISOString();
  const todaysMessages = messages.filter((message) =>
    isSameDay(message.createdAt || message.created_at, nowIso)
  );
  const websiteReady = cleanText(agent.knowledge?.state) === "ready";
  const installLive = ["seen_recently", "seen_stale", "installed_unseen"].includes(cleanText(agent.installStatus?.state));
  const sparseData = [
    messages.length,
    queueItems.length,
    contacts.length,
    followUps.length,
    recentOutcomes.length,
    routingEvents.length,
  ].every((count) => count === 0);
  const loadWarnings = Array.isArray(options.loadWarnings)
    ? options.loadWarnings.map((value) => cleanText(value)).filter(Boolean)
    : [];

  const recommendations = [];

  if (attentionQueueItems[0]) {
    const item = attentionQueueItems[0];
    recommendations.push(createRecommendation({
      id: `queue:${cleanText(item.key)}`,
      type: cleanText(item.actionType || item.type) || "attention_item",
      title: cleanText(item.suggestedAction) || cleanText(item.ownerWorkflow?.label) || "Review the top queue item",
      summary: cleanText(item.operatorSummary || item.whyFlagged || item.snippet) || "A stable-core issue needs owner review.",
      priority: "high",
      confidence: "high",
      rationale: "The action queue already marks this item as needing attention, so Copilot is surfacing it before lower-signal work.",
      source: {
        actionKey: cleanText(item.key),
      },
    }));
  }

  if (pricingWithoutOutcomeItems[0]) {
    const item = pricingWithoutOutcomeItems[0];
    recommendations.push(createRecommendation({
      id: `pricing-gap:${cleanText(item.key)}`,
      type: "pricing_gap",
      title: "Close the pricing-follow-up gap",
      summary: cleanText(item.operatorSummary || item.suggestedAction || item.snippet) || "Pricing intent was captured, but no outcome is recorded yet.",
      priority: "high",
      confidence: "medium",
      rationale: "Pricing questions are high-buying-intent signals, and this item still has no recorded result.",
      source: {
        actionKey: cleanText(item.key),
      },
    }));
  }

  if (knowledgeFixCandidates[0]) {
    const workflow = knowledgeFixCandidates[0];
    recommendations.push(createRecommendation({
      id: `knowledge-fix:${cleanText(workflow.id)}`,
      type: "knowledge_fix",
      title: "Review the open knowledge fix",
      summary: cleanText(workflow.issueSummary || workflow.topic || workflow.evidence) || "A recent front-desk answer still needs tighter guidance.",
      priority: "medium",
      confidence: "medium",
      rationale: "The same stable-core signals that triggered the queue item already produced a draft knowledge fix, so reviewing it can reduce repeat weak answers.",
      source: {
        knowledgeFixId: cleanText(workflow.id),
        actionKey: cleanText(workflow.sourceActionKey),
      },
    }));
  }

  if ((businessProfile.readiness?.missingSections || []).length) {
    recommendations.push(createRecommendation({
      id: "business-context:foundation",
      type: "business_context",
      title: "Fill the missing business context foundation",
      summary: businessProfile.readiness.summary,
      priority: sparseData ? "medium" : "low",
      confidence: "high",
      rationale: "Copilot can stay useful with sparse data, but services, pricing, policies, and hours make follow-up drafts and recommendations more grounded.",
      source: {
        missingSections: businessProfile.readiness.missingSections || [],
      },
    }));
  }

  const drafts = [];
  const storedDraft = followUpCandidates.find((workflow) =>
    cleanText(workflow.subject) && cleanText(workflow.draftContent)
  );

  if (storedDraft) {
    drafts.push(createDraft({
      id: cleanText(storedDraft.id),
      type: "follow_up_workflow",
      title: `Draft follow-up for ${cleanText(storedDraft.contactName) || "this contact"}`,
      channel: cleanText(storedDraft.channel) || "email",
      subject: cleanText(storedDraft.subject),
      body: cleanText(storedDraft.draftContent),
      confidence: "high",
      rationale: cleanText(storedDraft.whyPrepared) || "Vonza already prepared this deterministic follow-up from stable-core lead and queue data.",
      source: {
        followUpId: cleanText(storedDraft.id),
        contactId: cleanText(storedDraft.contactId),
        actionKey: cleanText(storedDraft.sourceActionKey),
      },
    }));
  } else if (attentionQueueItems[0] && attentionQueueItems[0].contactInfo) {
    drafts.push(buildGeneratedDraft({
      contactId: cleanText(attentionQueueItems[0].contactId),
      actionKey: cleanText(attentionQueueItems[0].key),
      contactName: cleanText(attentionQueueItems[0].contactInfo?.name),
      channel: attentionQueueItems[0].contactInfo?.email ? "email" : "phone",
      topic: cleanText(attentionQueueItems[0].topic || attentionQueueItems[0].label || attentionQueueItems[0].type),
    }, {
      businessName: cleanText(agent.name),
      assistantName: cleanText(agent.assistantName || agent.name),
      id: `generated:${cleanText(attentionQueueItems[0].key)}`,
      title: cleanText(attentionQueueItems[0].contactInfo?.name)
        ? `Draft follow-up for ${cleanText(attentionQueueItems[0].contactInfo?.name)}`
        : "Draft follow-up from the top queue item",
      rationale: "Copilot used the top stable-core queue item to draft a follow-up, but it still requires owner approval before any send.",
    }));
  }

  const topRecommendation = recommendations[0] || null;
  const topDraft = drafts[0] || null;
  const answers = [
    createAnswer({
      key: "attention_today",
      question: COPILOT_QUESTIONS[0],
      answer: sparseData
        ? "Stable-core activity is still sparse, so there is nothing urgent to rank yet."
        : attentionQueueItems.length
          ? `${pluralize(attentionQueueItems.length, "item")} need attention today. ${topRecommendation?.title || "Start with the top queue item."}`
          : "Nothing in stable-core data is currently marked urgent. Today looks steady.",
      confidence: sparseData ? "low" : "high",
      rationale: sparseData
        ? "Copilot only has setup-level context so far."
        : "This answer is grounded in the action queue, contact attention state, and open follow-up work.",
      recommendationIds: topRecommendation ? [topRecommendation.id] : [],
    }),
    createAnswer({
      key: "leads_needing_follow_up",
      question: COPILOT_QUESTIONS[1],
      answer: followUpCandidates.length
        ? `${pluralize(followUpCandidates.length, "lead")} already have approval-first follow-up work prepared or still open.`
        : contactsNeedingAttention.length
          ? `${pluralize(contactsNeedingAttention.length, "contact")} need a next step, but no prepared follow-up draft is stored yet.`
          : "No stable-core lead currently looks like it needs a follow-up.",
      confidence: followUpCandidates.length ? "high" : "medium",
      rationale: "Copilot is checking stored follow-up workflows first, then falling back to contact next-action signals.",
      recommendationIds: recommendations
        .filter((entry) => ["attention_item", "pricing_gap"].includes(entry.type))
        .map((entry) => entry.id),
    }),
    createAnswer({
      key: "pricing_without_outcome",
      question: COPILOT_QUESTIONS[2],
      answer: pricingWithoutOutcomeItems.length
        ? `${pluralize(pricingWithoutOutcomeItems.length, "pricing conversation")} still has interest but no recorded outcome.`
        : "Copilot does not currently see an open pricing-without-outcome gap in stable-core data.",
      confidence: pricingWithoutOutcomeItems.length ? "medium" : "medium",
      rationale: "This answer is based on pricing-interest queue items that still have no linked outcome.",
      recommendationIds: recommendations
        .filter((entry) => entry.type === "pricing_gap")
        .map((entry) => entry.id),
    }),
    createAnswer({
      key: "recent_outcomes",
      question: COPILOT_QUESTIONS[3],
      answer: recentOutcomes.length
        ? `${pluralize(recentOutcomes.length, "recent outcome")} were recorded. Latest: ${cleanText(recentOutcomes[0].label || recentOutcomes[0].outcomeType)}.`
        : "No recent outcome is recorded yet across the stable core.",
      confidence: recentOutcomes.length ? "high" : "medium",
      rationale: "This answer is pulled from recorded conversion outcomes rather than inferred from chat alone.",
    }),
    createAnswer({
      key: "next_best_action",
      question: COPILOT_QUESTIONS[4],
      answer: topRecommendation?.title || "Copilot does not see a stronger next action than staying on top of Today right now.",
      confidence: topRecommendation ? topRecommendation.confidence : "low",
      rationale: topRecommendation?.rationale || "There is not enough stable-core urgency to rank a stronger recommendation.",
      recommendationIds: topRecommendation ? [topRecommendation.id] : [],
    }),
    createAnswer({
      key: "front_desk_activity",
      question: COPILOT_QUESTIONS[5],
      answer: sparseData
        ? "The front desk is still mostly in setup mode, so Copilot only sees sparse stable-core activity."
        : `${pluralize(todaysMessages.length, "message")} arrived today. Website knowledge is ${websiteReady ? "ready" : "still limited"}, the widget is ${installLive ? "live or recently detected" : "not yet confirmed live"}, and ${pluralize(routingEvents.length, "routing event")} have been recorded.`,
      confidence: sparseData ? "low" : "high",
      rationale: "This summary combines messages, website knowledge state, install detection, and routing telemetry without depending on Google-connected beta data.",
    }),
    createAnswer({
      key: "draft_follow_up",
      question: COPILOT_QUESTIONS[6],
      answer: topDraft
        ? `${topDraft.title} is ready in draft-only mode and still requires owner approval before any send.`
        : "There is not enough stable-core contact context yet to prepare a safe follow-up draft.",
      confidence: topDraft ? topDraft.confidence : "low",
      rationale: topDraft?.rationale || "Copilot only drafts when there is a stored follow-up or enough contact context to keep the draft grounded.",
      draftIds: topDraft ? [topDraft.id] : [],
    }),
  ];

  return {
    enabled: true,
    featureEnabled: true,
    readOnly: true,
    draftOnly: true,
    autonomousActionsEnabled: false,
    sparseData,
    generatedAt: nowIso,
    headline: sparseData
      ? "Copilot sees the foundation, but not enough live operating data yet."
      : attentionQueueItems.length
        ? `${pluralize(attentionQueueItems.length, "thing")} need attention today.`
        : "Today looks stable across the current core.",
    summary: sparseData
      ? "Copilot is intentionally read-first and draft-first. It will stay conservative until stable-core activity gives it something real to summarize."
      : "Copilot is summarizing stable-core data only: front desk activity, website knowledge, install telemetry, contacts, outcomes, follow-up workflows, action queue, and knowledge-fix context.",
    questions: [...COPILOT_QUESTIONS],
    context: {
      agentId: cleanText(agent.id),
      businessId: cleanText(agent.businessId),
      businessName: cleanText(agent.name),
      sourceCounts: {
        messages: messages.length,
        actionQueueItems: queueItems.length,
        contacts: contacts.length,
        followUps: followUps.length,
        knowledgeFixes: knowledgeFixes.length,
        recentOutcomes: recentOutcomes.length,
        widgetEvents: routingEvents.length,
      },
      installLive,
      websiteKnowledgeReady: websiteReady,
      businessProfile,
      warnings: loadWarnings,
    },
    answers,
    recommendations,
    drafts,
    fallback: {
      title: sparseData ? "Copilot needs a little more real operating context" : "Copilot fallback",
      description: sparseData
        ? "There is not enough stable-core activity yet for strong recommendations."
        : "If one data source is sparse or missing, Copilot falls back to the remaining stable-core context instead of hallucinating certainty.",
      guidance: buildFallbackGuidance({
        agent,
        businessProfile,
        websiteReady,
        installLive,
      }),
    },
  };
}
