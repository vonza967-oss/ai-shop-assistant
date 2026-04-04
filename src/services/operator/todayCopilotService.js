import { cleanText } from "../../utils/text.js";

const COPILOT_QUESTIONS = Object.freeze([
  "What needs attention today?",
  "Which leads need follow-up?",
  "Which contacts asked about pricing but have no outcome?",
  "Are any complaints or support risks still open?",
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

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanSource(source = {}) {
  return source && typeof source === "object" && !Array.isArray(source) ? source : {};
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
  targetSection = "",
  targetId = "",
  actionType = "",
  surfaceLabel = "",
} = {}) {
  return {
    id: cleanText(id),
    type: cleanText(type),
    title: cleanText(title),
    summary: cleanText(summary),
    priority: cleanText(priority) || "medium",
    confidence: cleanText(confidence) || "medium",
    rationale: cleanText(rationale),
    source: cleanSource(source),
    targetSection: cleanText(targetSection),
    targetId: cleanText(targetId),
    actionType: cleanText(actionType),
    surfaceLabel: cleanText(surfaceLabel),
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
  targetSection = "",
  targetId = "",
  actionType = "",
  surfaceLabel = "",
  structuredPayload = {},
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
    source: cleanSource(source),
    targetSection: cleanText(targetSection),
    targetId: cleanText(targetId),
    actionType: cleanText(actionType),
    surfaceLabel: cleanText(surfaceLabel),
    structuredPayload:
      structuredPayload && typeof structuredPayload === "object" && !Array.isArray(structuredPayload)
        ? structuredPayload
        : {},
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

function createSummaryCard({
  id,
  label,
  text,
  confidence = "medium",
  rationale = "",
  recommendationIds = [],
  draftIds = [],
} = {}) {
  return {
    id: cleanText(id),
    label: cleanText(label),
    text: cleanText(text),
    confidence: cleanText(confidence) || "medium",
    rationale: cleanText(rationale),
    recommendationIds: recommendationIds.map((value) => cleanText(value)).filter(Boolean),
    draftIds: draftIds.map((value) => cleanText(value)).filter(Boolean),
  };
}

function buildFallbackGuidance({
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
  const topic = cleanText(contact.topic || "your request");
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
    targetSection: cleanText(options.targetSection) || "automations",
    targetId: cleanText(options.targetId),
    actionType: cleanText(options.actionType) || "draft_follow_up",
    surfaceLabel: cleanText(options.surfaceLabel) || "Open Automations",
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

function findComplaintRiskContact(contacts = []) {
  return contacts.find((contact) =>
    ["complaint_risk", "support_issue"].includes(cleanText(contact.lifecycleState))
    || normalizeArray(contact.flags).includes("complaint")
  ) || null;
}

function findLeadContact(contacts = []) {
  return contacts.find((contact) =>
    ["active_lead", "qualified", "new"].includes(cleanText(contact.lifecycleState))
    && cleanText(contact.nextAction?.key) !== "no_action_needed"
  ) || null;
}

function findOutcomeReviewContact(contacts = []) {
  return contacts.find((contact) =>
    ["active_lead", "qualified", "customer"].includes(cleanText(contact.lifecycleState))
    && contact.hasMeaningfulOutcome !== true
  ) || null;
}

function buildSupportRiskRecommendation(contact = {}) {
  if (!contact?.id) {
    return null;
  }

  return createRecommendation({
    id: `contact-risk:${cleanText(contact.id)}`,
    type: "support_risk_review",
    title: cleanText(contact.nextAction?.title) || "Review complaint or support risk",
    summary:
      cleanText(contact.nextAction?.description)
      || cleanText(contact.latestOutcome?.label)
      || "A complaint-risk or support issue contact still needs owner review.",
    priority: "high",
    confidence: "high",
    rationale: "Complaint and support risk should be surfaced before lower-signal follow-up work.",
    source: {
      contactId: cleanText(contact.id),
      lifecycleState: cleanText(contact.lifecycleState),
      taskIds: normalizeArray(contact.related?.taskIds),
    },
    targetSection: cleanText(contact.nextAction?.targetSection) || "contacts",
    targetId: cleanText(contact.nextAction?.targetId || contact.id),
    actionType: cleanText(contact.nextAction?.actionType) || "open_contact",
    surfaceLabel: "Open Contacts",
  });
}

function buildContactNextStepRecommendation(contact = {}) {
  if (!contact?.id) {
    return null;
  }

  return createRecommendation({
    id: `contact-next-step:${cleanText(contact.id)}`,
    type: "contact_next_step",
    title: cleanText(contact.nextAction?.title) || "Review contact next step",
    summary:
      cleanText(contact.nextAction?.description)
      || "A lead still needs a concrete next step routed through the current workflow surfaces.",
    priority: "high",
    confidence: "high",
    rationale: "Contacts already carry deterministic next actions, so Copilot should point the owner back to that workflow instead of inventing a new one.",
    source: {
      contactId: cleanText(contact.id),
      lifecycleState: cleanText(contact.lifecycleState),
    },
    targetSection: cleanText(contact.nextAction?.targetSection) || "contacts",
    targetId: cleanText(contact.nextAction?.targetId || contact.id),
    actionType: cleanText(contact.nextAction?.actionType) || "open_contact",
    surfaceLabel: "Open Contacts",
  });
}

function buildOutcomeReviewRecommendation(contact = {}) {
  if (!contact?.id) {
    return null;
  }

  return createRecommendation({
    id: `outcome-review:${cleanText(contact.id)}`,
    type: "outcome_review",
    title: "Review whether this contact reached a real outcome",
    summary:
      cleanText(contact.displayName || contact.primaryEmail || contact.primaryPhone)
      ? `${cleanText(contact.displayName || contact.primaryEmail || contact.primaryPhone)} still shows intent without a recorded result.`
      : "A contact still shows intent without a recorded result.",
    priority: "medium",
    confidence: "medium",
    rationale: "Outcome review keeps Contacts and Outcomes grounded when activity exists but no final result has been recorded yet.",
    source: {
      contactId: cleanText(contact.id),
    },
    targetSection: "contacts",
    targetId: cleanText(contact.id),
    actionType: "open_contact",
    surfaceLabel: "Open Contacts",
  });
}

function buildTaskProposal(topRecommendation = null) {
  if (!topRecommendation) {
    return null;
  }

  return createDraft({
    id: `task-proposal:${cleanText(topRecommendation.id)}`,
    type: "task_proposal",
    title: "Task proposal for the owner queue",
    channel: "internal",
    subject: cleanText(topRecommendation.title) || "Review the next owner task",
    body: [
      `Suggested task: ${cleanText(topRecommendation.title || "Review the next owner task")}`,
      cleanText(topRecommendation.summary) ? `Why now: ${cleanText(topRecommendation.summary)}` : "",
      cleanText(topRecommendation.surfaceLabel) ? `Best surface: ${cleanText(topRecommendation.surfaceLabel)}` : "",
      "This is a proposal only. Use the existing deterministic workflow to create or resolve the real task.",
    ].filter(Boolean).join("\n"),
    confidence: cleanText(topRecommendation.confidence) || "medium",
    rationale: "Copilot is preparing a task recommendation only; it is not creating tasks directly.",
    targetSection: cleanText(topRecommendation.targetSection),
    targetId: cleanText(topRecommendation.targetId),
    actionType: cleanText(topRecommendation.actionType),
    surfaceLabel: cleanText(topRecommendation.surfaceLabel),
    source: {
      recommendationId: cleanText(topRecommendation.id),
    },
    structuredPayload: {
      title: cleanText(topRecommendation.title),
      summary: cleanText(topRecommendation.summary),
    },
  });
}

function buildOutcomeReviewProposal(contact = {}) {
  if (!contact?.id) {
    return null;
  }

  return createDraft({
    id: `outcome-proposal:${cleanText(contact.id)}`,
    type: "outcome_review_proposal",
    title: "Outcome review suggestion",
    channel: "internal",
    subject: "Review contact outcome",
    body: [
      `Contact: ${cleanText(contact.displayName || contact.primaryEmail || contact.primaryPhone || "Unlabeled contact")}`,
      `Current state: ${cleanText(contact.lifecycleState || "active")}`,
      "Suggested review: Confirm whether a booking, quote, follow-up reply, or complaint resolution should be recorded.",
      "This proposal does not mark the outcome. Use the current deterministic workflow if a real result is confirmed.",
    ].join("\n"),
    confidence: "medium",
    rationale: "Copilot can prepare the review path, but owner confirmation still decides whether any deterministic outcome service should run.",
    targetSection: "contacts",
    targetId: cleanText(contact.id),
    actionType: "open_contact",
    surfaceLabel: "Open Contacts",
    source: {
      contactId: cleanText(contact.id),
    },
    structuredPayload: {
      contactId: cleanText(contact.id),
      requestedReview: "outcome_confirmation",
    },
  });
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
    summaryCards: [],
    recommendedNextActionId: "",
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
  const messages = normalizeArray(options.messages);
  const contacts = normalizeArray(options.contacts);
  const followUps = normalizeArray(options.followUps);
  const knowledgeFixes = normalizeArray(options.knowledgeFixes);
  const routingEvents = normalizeArray(options.routingEvents);
  const recentOutcomes = normalizeArray(options.recentOutcomes);
  const queueItems = normalizeArray(actionQueue.items);
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
  const complaintRiskContacts = contacts.filter((contact) =>
    ["complaint_risk", "support_issue"].includes(cleanText(contact.lifecycleState))
    || normalizeArray(contact.flags).includes("complaint")
  );
  const leadsNeedingFollowUp = contacts.filter((contact) =>
    ["active_lead", "qualified", "new"].includes(cleanText(contact.lifecycleState))
    && cleanText(contact.nextAction?.key) !== "no_action_needed"
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
  const loadWarnings = normalizeArray(options.loadWarnings).map((value) => cleanText(value)).filter(Boolean);

  const topComplaintRiskContact = findComplaintRiskContact(contacts);
  const topLeadContact = findLeadContact(contacts);
  const topOutcomeReviewContact = findOutcomeReviewContact(contacts);

  const recommendations = [];
  const supportRiskRecommendation = buildSupportRiskRecommendation(topComplaintRiskContact);
  if (supportRiskRecommendation) {
    recommendations.push(supportRiskRecommendation);
  }

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
      targetSection: "analytics",
      targetId: cleanText(item.key),
      actionType: "open_action_queue",
      surfaceLabel: "Open Outcomes",
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
      targetSection: cleanText(topLeadContact?.nextAction?.targetSection) || "contacts",
      targetId: cleanText(topLeadContact?.id || item.key),
      actionType: cleanText(topLeadContact?.nextAction?.actionType) || "open_contact",
      surfaceLabel: topLeadContact ? "Open Contacts" : "Open Outcomes",
    }));
  }

  const contactNextStepRecommendation = buildContactNextStepRecommendation(topLeadContact);
  if (contactNextStepRecommendation) {
    recommendations.push(contactNextStepRecommendation);
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
      targetSection: "analytics",
      targetId: cleanText(workflow.sourceActionKey || workflow.id),
      actionType: "open_action_queue",
      surfaceLabel: "Open Outcomes",
    }));
  }

  const outcomeReviewRecommendation = buildOutcomeReviewRecommendation(topOutcomeReviewContact);
  if (outcomeReviewRecommendation) {
    recommendations.push(outcomeReviewRecommendation);
  }

  if ((businessProfile.readiness?.missingSections || []).length) {
    recommendations.push(createRecommendation({
      id: "business-context:foundation",
      type: "business_context",
      title: "Fill the missing business context foundation",
      summary: cleanText(businessProfile.readiness.summary),
      priority: sparseData ? "medium" : "low",
      confidence: "high",
      rationale: "Copilot can stay useful with sparse data, but services, pricing, policies, and hours make follow-up drafts and recommendations more grounded.",
      source: {
        missingSections: businessProfile.readiness.missingSections || [],
      },
      targetSection: "customize",
      targetId: "business-context-setup",
      actionType: "open_business_context",
      surfaceLabel: "Open Customize",
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
      targetSection: "automations",
      targetId: cleanText(storedDraft.id),
      actionType: "open_follow_up",
      surfaceLabel: "Open Automations",
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
      targetSection: "analytics",
      targetId: cleanText(attentionQueueItems[0].key),
      actionType: "open_action_queue",
      surfaceLabel: "Open Outcomes",
    }));
  }

  const topRecommendation = recommendations[0] || null;
  const taskProposal = buildTaskProposal(topRecommendation);
  if (taskProposal) {
    drafts.push(taskProposal);
  }

  const outcomeReviewProposal = buildOutcomeReviewProposal(topOutcomeReviewContact);
  if (outcomeReviewProposal) {
    drafts.push(outcomeReviewProposal);
  }

  const topDraft = drafts[0] || null;
  const summaryCards = [
    createSummaryCard({
      id: "what_matters",
      label: "What matters today",
      text: sparseData
        ? "Stable-core activity is still sparse, so there is not enough live work to rank yet."
        : cleanText(topRecommendation?.summary) || "Today looks steady across the current stable core.",
      confidence: sparseData ? "low" : "high",
      rationale: sparseData
        ? "Copilot only has setup-level context so far."
        : "This summary is grounded in the action queue, contacts, follow-up workflows, and outcomes.",
      recommendationIds: topRecommendation ? [topRecommendation.id] : [],
    }),
    createSummaryCard({
      id: "lead_follow_up",
      label: "Leads needing follow-up",
      text: followUpCandidates.length
        ? `${pluralize(followUpCandidates.length, "follow-up workflow")} are already open for review.`
        : leadsNeedingFollowUp.length
          ? `${pluralize(leadsNeedingFollowUp.length, "lead")} still need a concrete next step.`
          : "No lead currently stands out as needing a fresh follow-up.",
      confidence: followUpCandidates.length ? "high" : "medium",
      rationale: "This is based on stored follow-up workflows plus deterministic contact next actions.",
      recommendationIds: recommendations
        .filter((entry) => ["contact_next_step", "pricing_gap"].includes(entry.type))
        .map((entry) => entry.id),
    }),
    createSummaryCard({
      id: "pricing_or_booking_interest",
      label: "Pricing or booking interest",
      text: pricingWithoutOutcomeItems.length
        ? `${pluralize(pricingWithoutOutcomeItems.length, "pricing conversation")} still has intent without a recorded outcome.`
        : "Copilot does not currently see a pricing or booking intent gap that lacks a recorded result.",
      confidence: "medium",
      rationale: "This summary comes from pricing-interest queue items and contact progression state.",
      recommendationIds: recommendations
        .filter((entry) => ["pricing_gap", "outcome_review"].includes(entry.type))
        .map((entry) => entry.id),
    }),
    createSummaryCard({
      id: "support_or_complaint_risk",
      label: "Support or complaint risk",
      text: complaintRiskContacts.length
        ? `${pluralize(complaintRiskContacts.length, "contact")} still shows complaint or support risk.`
        : "No unresolved complaint or support risk is visible in the stable core right now.",
      confidence: complaintRiskContacts.length ? "high" : "medium",
      rationale: "Complaint and support risk is drawn from deterministic contact lifecycle and task signals.",
      recommendationIds: recommendations
        .filter((entry) => entry.type === "support_risk_review")
        .map((entry) => entry.id),
    }),
    createSummaryCard({
      id: "recent_outcomes",
      label: "Recent outcomes",
      text: recentOutcomes.length
        ? `${pluralize(recentOutcomes.length, "recent outcome")} were recorded. Latest: ${cleanText(recentOutcomes[0].label || recentOutcomes[0].outcomeType)}.`
        : "No recent outcome is recorded yet across the stable core.",
      confidence: recentOutcomes.length ? "high" : "medium",
      rationale: "This is pulled from recorded outcomes rather than inferred from conversation text.",
    }),
  ];

  const answers = [
    createAnswer({
      key: "attention_today",
      question: COPILOT_QUESTIONS[0],
      answer: sparseData
        ? "Stable-core activity is still sparse, so there is nothing urgent to rank yet."
        : recommendations.length
          ? `${pluralize(recommendations.length, "recommendation")} stand out. ${cleanText(topRecommendation?.title || "Start with the top recommendation.")}`
          : "Nothing in stable-core data is currently marked urgent. Today looks steady.",
      confidence: sparseData ? "low" : "high",
      rationale: sparseData
        ? "Copilot only has setup-level context so far."
        : "This answer is grounded in recommendations built from contacts, queue, follow-up work, and outcomes.",
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
        .filter((entry) => ["contact_next_step", "pricing_gap"].includes(entry.type))
        .map((entry) => entry.id),
    }),
    createAnswer({
      key: "pricing_without_outcome",
      question: COPILOT_QUESTIONS[2],
      answer: pricingWithoutOutcomeItems.length
        ? `${pluralize(pricingWithoutOutcomeItems.length, "pricing conversation")} still has interest but no recorded outcome.`
        : "Copilot does not currently see an open pricing-without-outcome gap in stable-core data.",
      confidence: "medium",
      rationale: "This answer is based on pricing-interest queue items that still have no linked outcome.",
      recommendationIds: recommendations
        .filter((entry) => entry.type === "pricing_gap")
        .map((entry) => entry.id),
    }),
    createAnswer({
      key: "support_risk",
      question: COPILOT_QUESTIONS[3],
      answer: complaintRiskContacts.length
        ? `${pluralize(complaintRiskContacts.length, "contact")} still shows complaint or support risk and should be reviewed before it goes stale.`
        : "Copilot does not currently see an unresolved complaint or support risk in the stable core.",
      confidence: complaintRiskContacts.length ? "high" : "medium",
      rationale: "This answer uses deterministic complaint-risk and support-state signals from Contacts and operator tasks.",
      recommendationIds: recommendations
        .filter((entry) => entry.type === "support_risk_review")
        .map((entry) => entry.id),
    }),
    createAnswer({
      key: "recent_outcomes",
      question: COPILOT_QUESTIONS[4],
      answer: recentOutcomes.length
        ? `${pluralize(recentOutcomes.length, "recent outcome")} were recorded. Latest: ${cleanText(recentOutcomes[0].label || recentOutcomes[0].outcomeType)}.`
        : "No recent outcome is recorded yet across the stable core.",
      confidence: recentOutcomes.length ? "high" : "medium",
      rationale: "This answer is pulled from recorded conversion outcomes rather than inferred from chat alone.",
    }),
    createAnswer({
      key: "next_best_action",
      question: COPILOT_QUESTIONS[5],
      answer: cleanText(topRecommendation?.title) || "Copilot does not see a stronger next action than staying on top of Today right now.",
      confidence: cleanText(topRecommendation?.confidence) || "low",
      rationale: cleanText(topRecommendation?.rationale) || "There is not enough stable-core urgency to rank a stronger recommendation.",
      recommendationIds: topRecommendation ? [topRecommendation.id] : [],
    }),
    createAnswer({
      key: "front_desk_activity",
      question: COPILOT_QUESTIONS[6],
      answer: sparseData
        ? "The front desk is still mostly in setup mode, so Copilot only sees sparse stable-core activity."
        : `${pluralize(todaysMessages.length, "message")} arrived today. Website knowledge is ${websiteReady ? "ready" : "still limited"}, the widget is ${installLive ? "live or recently detected" : "not yet confirmed live"}, and ${pluralize(routingEvents.length, "routing event")} have been recorded.`,
      confidence: sparseData ? "low" : "high",
      rationale: "This summary combines messages, website knowledge state, install detection, and routing telemetry without depending on Google-connected beta data.",
    }),
    createAnswer({
      key: "draft_follow_up",
      question: COPILOT_QUESTIONS[7],
      answer: topDraft
        ? `${topDraft.title} is ready in draft-only mode and still requires owner approval before any send.`
        : "There is not enough stable-core contact context yet to prepare a safe follow-up draft.",
      confidence: cleanText(topDraft?.confidence) || "low",
      rationale: cleanText(topDraft?.rationale) || "Copilot only drafts when there is a stored follow-up or enough contact context to keep the draft grounded.",
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
      : cleanText(topRecommendation?.title)
        ? `${cleanText(topRecommendation.title)} is the clearest next move.`
        : "Today looks stable across the current core.",
    summary: sparseData
      ? "Copilot is intentionally read-first and draft-first. It will stay conservative until stable-core activity gives it something real to summarize."
      : `${cleanText(topRecommendation?.summary || "Copilot is summarizing stable-core data only.")} It is staying inside front desk activity, contacts, outcomes, follow-up workflows, action queue, and knowledge-fix context.`,
    questions: [...COPILOT_QUESTIONS],
    summaryCards,
    recommendedNextActionId: cleanText(topRecommendation?.id),
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
        businessProfile,
        websiteReady,
        installLive,
      }),
    },
  };
}
