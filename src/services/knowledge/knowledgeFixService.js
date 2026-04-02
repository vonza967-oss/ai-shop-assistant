import { createHash } from "node:crypto";

import {
  ACTION_QUEUE_STATUS_TABLE,
  KNOWLEDGE_FIX_WORKFLOW_TABLE,
} from "../../config/constants.js";
import { updateAgentSettings } from "../agents/agentService.js";
import { buildRelevantContextBlock } from "../scraping/websiteContentService.js";
import { cleanText, tokenizeForMatching } from "../../utils/text.js";

export const KNOWLEDGE_FIX_WORKFLOW_STATUSES = [
  "draft",
  "ready",
  "applied",
  "dismissed",
  "failed",
];

export const SUPPORTED_KNOWLEDGE_FIX_ACTION_TYPES = [
  "knowledge_gap",
  "unanswered_question",
];

const SUPPORTED_ACTION_TYPE_SET = new Set(SUPPORTED_KNOWLEDGE_FIX_ACTION_TYPES);
const EDITABLE_KNOWLEDGE_FIX_STATUSES = new Set(["draft", "ready", "failed"]);
const ACTIVE_KNOWLEDGE_FIX_STATUSES = new Set(["draft", "ready", "failed"]);
const KNOWLEDGE_FIX_SELECT =
  "id, agent_id, owner_user_id, dedupe_key, source_action_key, linked_action_keys, action_type, status, target_type, target_label, topic, issue_key, issue_summary, matters_summary, proposed_guidance, last_generated_guidance, draft_edited_manually, evidence, occurrence_count, source_hash, applied_guidance, applied_at, dismissed_at, last_error, created_at, updated_at";

function isMissingRelationError(error, relationName) {
  const message = cleanText(error?.message || "");

  return (
    error?.code === "PGRST205" ||
    error?.code === "42P01" ||
    message.toLowerCase().includes(`'public.${relationName}'`) ||
    message.toLowerCase().includes(`${relationName} was not found`)
  );
}

function hashParts(parts = []) {
  return createHash("sha256")
    .update(parts.map((part) => cleanText(part)).join("|"))
    .digest("hex")
    .slice(0, 32);
}

function normalizeKnowledgeFixStatus(value, options = {}) {
  const normalized = cleanText(value).toLowerCase();

  if (!normalized) {
    return options.allowEmpty ? "" : "draft";
  }

  return KNOWLEDGE_FIX_WORKFLOW_STATUSES.includes(normalized)
    ? normalized
    : (options.allowEmpty ? "" : "draft");
}

function assertValidKnowledgeFixStatus(value) {
  const normalized = cleanText(value).toLowerCase();

  if (!KNOWLEDGE_FIX_WORKFLOW_STATUSES.includes(normalized)) {
    const error = new Error(`Invalid knowledge-fix status '${value}'`);
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function normalizeActionType(value) {
  const normalized = cleanText(value).toLowerCase();
  return SUPPORTED_ACTION_TYPE_SET.has(normalized) ? normalized : "";
}

function normalizeTargetType(value) {
  const normalized = cleanText(value).toLowerCase();
  return normalized === "system_prompt" ? normalized : "system_prompt";
}

function normalizeLinkedActionKeys(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => cleanText(entry)).filter(Boolean))];
  }

  const normalized = cleanText(value);
  return normalized ? [normalized] : [];
}

function normalizeEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return {
    question: cleanText(value.question),
    currentResponse: cleanText(value.currentResponse),
    conversationExcerpt: cleanText(value.conversationExcerpt),
    relevantContent: cleanText(value.relevantContent),
    currentSystemPrompt: cleanText(value.currentSystemPrompt),
    websiteUrl: cleanText(value.websiteUrl),
    knowledgeState: cleanText(value.knowledgeState).toLowerCase(),
    messageId: cleanText(value.messageId),
    lastSeenAt: value.lastSeenAt || null,
    actionKey: cleanText(value.actionKey),
  };
}

function normalizeWorkflow(row = {}) {
  const source = row && typeof row === "object" ? row : {};
  const evidence = normalizeEvidence(source.evidence);

  return {
    id: cleanText(source.id),
    agentId: cleanText(source.agentId || source.agent_id),
    ownerUserId: cleanText(source.ownerUserId || source.owner_user_id),
    dedupeKey: cleanText(source.dedupeKey || source.dedupe_key),
    sourceActionKey: cleanText(source.sourceActionKey || source.source_action_key),
    linkedActionKeys: normalizeLinkedActionKeys(source.linkedActionKeys || source.linked_action_keys),
    actionType: normalizeActionType(source.actionType || source.action_type),
    status: normalizeKnowledgeFixStatus(source.status),
    targetType: normalizeTargetType(source.targetType || source.target_type),
    targetLabel: cleanText(source.targetLabel || source.target_label) || "Advanced guidance / system prompt",
    topic: cleanText(source.topic),
    issueKey: cleanText(source.issueKey || source.issue_key),
    issueSummary: cleanText(source.issueSummary || source.issue_summary),
    mattersSummary: cleanText(source.mattersSummary || source.matters_summary),
    proposedGuidance: cleanText(source.proposedGuidance || source.proposed_guidance),
    lastGeneratedGuidance: cleanText(source.lastGeneratedGuidance || source.last_generated_guidance),
    draftEditedManually: source.draftEditedManually === true || source.draft_edited_manually === true,
    evidence,
    occurrenceCount: Math.max(
      normalizeLinkedActionKeys(source.linkedActionKeys || source.linked_action_keys).length || 0,
      Number(source.occurrenceCount || source.occurrence_count || 0),
      1
    ),
    sourceHash: cleanText(source.sourceHash || source.source_hash),
    appliedGuidance: cleanText(source.appliedGuidance || source.applied_guidance),
    appliedAt: source.appliedAt || source.applied_at || null,
    dismissedAt: source.dismissedAt || source.dismissed_at || null,
    lastError: cleanText(source.lastError || source.last_error),
    createdAt: source.createdAt || source.created_at || null,
    updatedAt: source.updatedAt || source.updated_at || null,
  };
}

function buildComparableRecord(record = {}) {
  const normalized = normalizeWorkflow(record);
  return JSON.stringify({
    dedupeKey: normalized.dedupeKey,
    sourceActionKey: normalized.sourceActionKey,
    linkedActionKeys: normalized.linkedActionKeys,
    actionType: normalized.actionType,
    status: normalized.status,
    targetType: normalized.targetType,
    targetLabel: normalized.targetLabel,
    topic: normalized.topic,
    issueKey: normalized.issueKey,
    issueSummary: normalized.issueSummary,
    mattersSummary: normalized.mattersSummary,
    proposedGuidance: normalized.proposedGuidance,
    lastGeneratedGuidance: normalized.lastGeneratedGuidance,
    draftEditedManually: normalized.draftEditedManually,
    evidence: normalized.evidence,
    occurrenceCount: normalized.occurrenceCount,
    sourceHash: normalized.sourceHash,
    appliedGuidance: normalized.appliedGuidance,
    appliedAt: normalized.appliedAt,
    dismissedAt: normalized.dismissedAt,
    lastError: normalized.lastError,
  });
}

function uniqueText(values = []) {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function truncateText(value, maxLength = 320) {
  const normalized = cleanText(value);

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function canonicalizeIssueToken(token) {
  const normalized = cleanText(token).toLowerCase();

  if (!normalized) {
    return "";
  }

  if (["are", "you", "your", "the", "and", "for", "with", "that", "this", "from", "have", "want", "when", "what", "where", "which", "does", "do", "did", "can", "could", "would", "should", "still", "there", "about", "into", "need", "please", "tell"].includes(normalized)) {
    return "";
  }

  if (["price", "pricing", "cost", "costs", "quote", "quotes", "fee", "fees", "package", "packages"].includes(normalized)) {
    return "pricing";
  }

  if (["book", "booking", "bookings", "appointment", "appointments", "schedule", "scheduled"].includes(normalized)) {
    return "booking";
  }

  if (["contact", "email", "emails", "phone", "call", "reach"].includes(normalized)) {
    return "contact";
  }

  if (["hours", "opening", "open", "closed", "times"].includes(normalized)) {
    return "hours";
  }

  if (["refund", "refunds", "cancel", "cancellation", "support", "problem", "issue", "issues"].includes(normalized)) {
    return "support";
  }

  if (["location", "address", "where"].includes(normalized)) {
    return "location";
  }

  if (["service", "services", "offer", "offers", "offering", "offerings"].includes(normalized)) {
    return "services";
  }

  if (["faq", "faqs", "question", "questions", "website", "site", "assistant", "business", "company", "customer", "visitor"].includes(normalized)) {
    return "";
  }

  return normalized;
}

function buildIssueTokens(item = {}) {
  const sourceText = cleanText(item.question)
    || cleanText(item.snippet)
    || cleanText(item.topic)
    || cleanText(item.label);
  const tokens = tokenizeForMatching(sourceText)
    .map((token) => canonicalizeIssueToken(token))
    .filter(Boolean);

  return [...new Set(tokens)].slice(0, 5);
}

function buildIssueKey(item = {}) {
  const tokens = buildIssueTokens(item);

  if (tokens.length) {
    return tokens.sort().join("-");
  }

  return hashParts([item.question, item.reply, item.actionType || item.type]).slice(0, 12);
}

function buildTopic(item = {}, issueKey = "") {
  const normalizedQuestion = cleanText(item.question);

  if (normalizedQuestion) {
    return truncateText(normalizedQuestion, 96);
  }

  if (issueKey) {
    return issueKey
      .split("-")
      .filter(Boolean)
      .map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1)}`)
      .join(" ");
  }

  return "Answer quality gap";
}

function buildConversationEvidence(item = {}) {
  return uniqueText([
    cleanText(item.snippet),
    cleanText(item.question) ? `Visitor asked: ${cleanText(item.question)}` : "",
    cleanText(item.reply) ? `Vonza replied: ${cleanText(item.reply)}` : "Vonza did not send a usable answer.",
  ]).join("\n");
}

function buildIssueSummary(item = {}, agentProfile = {}) {
  const question = cleanText(item.question) || "this visitor question";
  const knowledgeState = cleanText(agentProfile.knowledge?.state).toLowerCase();

  if (item.actionType === "unanswered_question") {
    return `Vonza did not deliver a usable answer for "${question}".${knowledgeState === "missing" ? " Website knowledge is still missing for this assistant." : ""}`;
  }

  return `Vonza answered "${question}" weakly or uncertainly, so the guidance should be tightened before the next similar visitor asks.${knowledgeState === "limited" ? " Imported website knowledge is still limited here." : ""}`;
}

function buildMattersSummary(item = {}, agentProfile = {}) {
  const knowledgeState = cleanText(agentProfile.knowledge?.state).toLowerCase();

  switch (cleanText(item.intent).toLowerCase()) {
    case "pricing":
      return `Pricing questions signal real buying intent. A weak answer here can lose a ready-to-convert visitor.${knowledgeState === "limited" ? " The imported website knowledge is also still limited, which raises the risk of vague answers." : ""}`;
    case "booking":
      return "Booking and availability questions happen close to conversion. Friction here makes the assistant feel like a blocker instead of a front desk.";
    case "contact":
      return "Contact-path questions should turn into a clear next step immediately. If the assistant stalls, the lead goes cold.";
    case "support":
      return "Support-style questions carry frustration. Missing or weak guidance here increases distrust and can create repeat contacts.";
    default:
      return "This came from a real visitor conversation, so fixing it improves how Vonza handles the next similar question instead of leaving the same gap in place.";
  }
}

function buildRelevantContentExcerpt(websiteContent, question) {
  if (!websiteContent?.content) {
    return "";
  }

  return truncateText(buildRelevantContextBlock(websiteContent, question || "") || "", 1600);
}

function buildProposedGuidance(item = {}, context = {}) {
  const topic = cleanText(context.topic) || "this topic";
  const weakReply = cleanText(item.reply);
  const hasRelevantContent = Boolean(cleanText(context.relevantContent));
  const base = [
    `When visitors ask about ${topic}, answer with the most concrete detail available from the imported website content before offering any next step.`,
  ];

  if (hasRelevantContent) {
    base.push("Use the matching website detail directly instead of defaulting to a vague fallback.");
  } else {
    base.push("If the website content does not answer it, say that plainly in the first answer sentence and do not guess.");
  }

  if (item.actionType === "unanswered_question") {
    base.push("If the answer is missing, respond with a short honest limitation plus one practical next step instead of leaving the visitor without a useful reply.");
  } else {
    base.push("Avoid soft or generic wording when the website only partially covers the question. State the known detail, then name the missing piece clearly.");
  }

  switch (cleanText(item.intent).toLowerCase()) {
    case "pricing":
      base.push("For pricing questions, if exact pricing is not shown on the site, say that clearly and guide the visitor toward the quote path instead of saying only \"contact the business directly.\"");
      break;
    case "booking":
      base.push("For booking or availability questions, give the clearest current path from the site, then ask only one short next-step question if needed.");
      break;
    case "contact":
      base.push("For contact questions, surface the actual contact path if it exists and suggest what the visitor should include in the message.");
      break;
    case "support":
      base.push("For support questions, be direct about what is and is not known from the site, then guide the visitor toward the safest next action.");
      break;
    default:
      break;
  }

  if (weakReply) {
    base.push(`Avoid repeating this weak pattern: "${truncateText(weakReply, 180)}"`);
  }

  return base.join(" ");
}

function buildCandidate(item = {}, agentProfile = {}, websiteContent = null) {
  const actionType = normalizeActionType(item.actionType || item.action_type || item.type);

  if (!actionType) {
    return null;
  }

  const issueKey = buildIssueKey(item);
  const topic = buildTopic(item, issueKey);
  const relevantContent = buildRelevantContentExcerpt(websiteContent, item.question || item.snippet || "");
  const evidence = normalizeEvidence({
    question: item.question,
    currentResponse: item.reply,
    conversationExcerpt: buildConversationEvidence(item),
    relevantContent,
    currentSystemPrompt: agentProfile.systemPrompt,
    websiteUrl: agentProfile.websiteUrl,
    knowledgeState: agentProfile.knowledge?.state || "",
    messageId: item.messageId,
    lastSeenAt: item.lastSeenAt || null,
    actionKey: item.key,
  });

  const proposedGuidance = buildProposedGuidance(item, {
    topic,
    relevantContent,
  });
  const linkedActionKeys = normalizeLinkedActionKeys([
    item.key,
    ...(Array.isArray(item.relatedActionKeys) ? item.relatedActionKeys : []),
  ]);

  return normalizeWorkflow({
    agentId: agentProfile.agentId,
    ownerUserId: agentProfile.ownerUserId,
    dedupeKey: `${actionType}:${issueKey}`,
    sourceActionKey: cleanText(item.key),
    linkedActionKeys,
    actionType,
    status: "draft",
    targetType: "system_prompt",
    targetLabel: "Advanced guidance / system prompt",
    topic,
    issueKey,
    issueSummary: buildIssueSummary(item, agentProfile),
    mattersSummary: buildMattersSummary(item, agentProfile),
    proposedGuidance,
    lastGeneratedGuidance: proposedGuidance,
    draftEditedManually: false,
    evidence,
    occurrenceCount: linkedActionKeys.length || 1,
    sourceHash: hashParts([
      actionType,
      item.question,
      item.reply,
      item.whyFlagged,
      relevantContent,
      agentProfile.systemPrompt,
      agentProfile.websiteUrl,
      agentProfile.knowledge?.state || "",
    ]),
  });
}

function findExistingWorkflow(records = [], candidate) {
  return records.find((record) => record.dedupeKey === candidate.dedupeKey) || null;
}

function buildSyncedWorkflowPayload(existing, candidate) {
  const normalizedExisting = existing ? normalizeWorkflow(existing) : null;
  const nextStatus = normalizedExisting?.status && !ACTIVE_KNOWLEDGE_FIX_STATUSES.has(normalizedExisting.status)
    ? normalizedExisting.status
    : normalizedExisting?.status || "draft";
  const linkedActionKeys = normalizeLinkedActionKeys([
    ...(normalizedExisting?.linkedActionKeys || []),
    ...candidate.linkedActionKeys,
  ]);
  const nextEvidence = normalizeEvidence({
    ...candidate.evidence,
    actionKey: normalizedExisting?.evidence?.actionKey || candidate.evidence.actionKey,
    messageId: candidate.evidence.messageId || normalizedExisting?.evidence?.messageId || "",
    lastSeenAt: candidate.evidence.lastSeenAt || normalizedExisting?.evidence?.lastSeenAt || null,
    conversationExcerpt: uniqueText([
      normalizedExisting?.evidence?.conversationExcerpt,
      candidate.evidence.conversationExcerpt,
    ]).join("\n"),
  });

  return normalizeWorkflow({
    ...candidate,
    id: normalizedExisting?.id,
    sourceActionKey: normalizedExisting?.sourceActionKey || candidate.sourceActionKey,
    linkedActionKeys,
    status: nextStatus,
    proposedGuidance: normalizedExisting?.draftEditedManually
      ? normalizedExisting.proposedGuidance
      : candidate.proposedGuidance,
    lastGeneratedGuidance: candidate.proposedGuidance,
    draftEditedManually: normalizedExisting?.draftEditedManually === true,
    evidence: nextEvidence,
    occurrenceCount: linkedActionKeys.length || normalizedExisting?.occurrenceCount || 1,
    sourceHash: candidate.sourceHash,
    appliedGuidance: normalizedExisting?.appliedGuidance || "",
    appliedAt: normalizedExisting?.appliedAt || null,
    dismissedAt: nextStatus === "dismissed" ? (normalizedExisting?.dismissedAt || new Date().toISOString()) : null,
    lastError: nextStatus === "failed" ? normalizedExisting?.lastError || "Knowledge fix failed." : "",
  });
}

function shouldPersistWorkflow(existing, nextWorkflow) {
  return buildComparableRecord(existing || {}) !== buildComparableRecord(nextWorkflow || {});
}

function mapKnowledgeFixStatusToQueueState(workflow) {
  const normalized = normalizeWorkflow(workflow);

  if (normalized.status === "applied") {
    return {
      status: "done",
    };
  }

  if (normalized.status === "dismissed") {
    return {
      status: "dismissed",
    };
  }

  return {
    status: "reviewed",
  };
}

async function persistQueueSyncForKnowledgeFix(supabase, options = {}) {
  const workflow = normalizeWorkflow(options.knowledgeFix);
  const queueState = mapKnowledgeFixStatusToQueueState(workflow);
  const actionKeys = uniqueText([
    workflow.sourceActionKey,
    ...workflow.linkedActionKeys,
  ]);

  await Promise.all(actionKeys.map(async (actionKey) => {
    const { error } = await supabase
      .from(ACTION_QUEUE_STATUS_TABLE)
      .upsert(
        {
          agent_id: workflow.agentId,
          owner_user_id: workflow.ownerUserId,
          action_key: actionKey,
          status: queueState.status,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "agent_id,action_key" }
      );

    if (error) {
      console.error("[knowledge-fix] Failed syncing queue state:", {
        knowledgeFixId: workflow.id || null,
        actionKey,
        status: queueState.status,
        message: error.message,
      });
      throw error;
    }
  }));

  console.info("[knowledge-fix] Synced queue state from knowledge fix.", {
    knowledgeFixId: workflow.id || null,
    actionKeys,
    knowledgeFixStatus: workflow.status,
    queueStatus: queueState.status,
  });

  return queueState;
}

async function insertKnowledgeFixWorkflow(supabase, workflow) {
  const payload = {
    agent_id: workflow.agentId,
    owner_user_id: workflow.ownerUserId,
    dedupe_key: workflow.dedupeKey,
    source_action_key: workflow.sourceActionKey,
    linked_action_keys: workflow.linkedActionKeys,
    action_type: workflow.actionType,
    status: workflow.status,
    target_type: workflow.targetType,
    target_label: workflow.targetLabel,
    topic: workflow.topic || null,
    issue_key: workflow.issueKey || null,
    issue_summary: workflow.issueSummary || null,
    matters_summary: workflow.mattersSummary || null,
    proposed_guidance: workflow.proposedGuidance || null,
    last_generated_guidance: workflow.lastGeneratedGuidance || null,
    draft_edited_manually: workflow.draftEditedManually === true,
    evidence: workflow.evidence || {},
    occurrence_count: workflow.occurrenceCount || 1,
    source_hash: workflow.sourceHash || null,
    applied_guidance: workflow.appliedGuidance || null,
    applied_at: workflow.appliedAt || null,
    dismissed_at: workflow.dismissedAt || null,
    last_error: workflow.lastError || null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from(KNOWLEDGE_FIX_WORKFLOW_TABLE)
    .insert(payload)
    .select(KNOWLEDGE_FIX_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return normalizeWorkflow(data);
}

async function updateKnowledgeFixWorkflowRecord(supabase, workflow) {
  const payload = {
    dedupe_key: workflow.dedupeKey,
    source_action_key: workflow.sourceActionKey,
    linked_action_keys: workflow.linkedActionKeys,
    action_type: workflow.actionType,
    status: workflow.status,
    target_type: workflow.targetType,
    target_label: workflow.targetLabel,
    topic: workflow.topic || null,
    issue_key: workflow.issueKey || null,
    issue_summary: workflow.issueSummary || null,
    matters_summary: workflow.mattersSummary || null,
    proposed_guidance: workflow.proposedGuidance || null,
    last_generated_guidance: workflow.lastGeneratedGuidance || null,
    draft_edited_manually: workflow.draftEditedManually === true,
    evidence: workflow.evidence || {},
    occurrence_count: workflow.occurrenceCount || 1,
    source_hash: workflow.sourceHash || null,
    applied_guidance: workflow.appliedGuidance || null,
    applied_at: workflow.appliedAt || null,
    dismissed_at: workflow.dismissedAt || null,
    last_error: workflow.lastError || null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from(KNOWLEDGE_FIX_WORKFLOW_TABLE)
    .update(payload)
    .eq("id", workflow.id)
    .select(KNOWLEDGE_FIX_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return normalizeWorkflow(data);
}

export async function listKnowledgeFixWorkflows(supabase, options = {}) {
  const agentId = cleanText(options.agentId);
  const ownerUserId = cleanText(options.ownerUserId);

  if (!agentId || !ownerUserId) {
    return {
      records: [],
      persistenceAvailable: true,
    };
  }

  const { data, error } = await supabase
    .from(KNOWLEDGE_FIX_WORKFLOW_TABLE)
    .select(KNOWLEDGE_FIX_SELECT)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .order("updated_at", { ascending: false });

  if (error) {
    if (isMissingRelationError(error, KNOWLEDGE_FIX_WORKFLOW_TABLE)) {
      return {
        records: [],
        persistenceAvailable: false,
      };
    }

    console.error(error);
    throw error;
  }

  return {
    records: (data || []).map((row) => normalizeWorkflow(row)),
    persistenceAvailable: true,
  };
}

export async function syncKnowledgeFixWorkflows(supabase, options = {}) {
  const agentId = cleanText(options.agentId);
  const ownerUserId = cleanText(options.ownerUserId);
  const queueItems = Array.isArray(options.queueItems) ? options.queueItems : [];
  const agentProfile = {
    agentId,
    ownerUserId,
    systemPrompt: cleanText(options.agentProfile?.systemPrompt),
    websiteUrl: cleanText(options.agentProfile?.websiteUrl),
    knowledge: {
      state: cleanText(options.agentProfile?.knowledge?.state).toLowerCase() || "missing",
    },
  };
  const websiteContent = options.websiteContent && typeof options.websiteContent === "object"
    ? options.websiteContent
    : null;

  if (!agentId || !ownerUserId) {
    return {
      records: [],
      persistenceAvailable: true,
    };
  }

  const listed = await listKnowledgeFixWorkflows(supabase, {
    agentId,
    ownerUserId,
  });

  if (listed.persistenceAvailable === false) {
    return listed;
  }

  const records = [...listed.records];

  for (const item of queueItems) {
    const candidate = buildCandidate(item, agentProfile, websiteContent);

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
        ? await updateKnowledgeFixWorkflowRecord(supabase, {
          ...nextWorkflow,
          id: existing.id,
        })
        : await insertKnowledgeFixWorkflow(supabase, nextWorkflow);
    } catch (error) {
      if (isMissingRelationError(error, KNOWLEDGE_FIX_WORKFLOW_TABLE)) {
        return {
          records,
          persistenceAvailable: false,
        };
      }

      console.error("[knowledge-fix] Failed to sync knowledge fix workflow:", {
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

    console.info(existing?.id ? "[knowledge-fix] Refreshed knowledge fix draft." : "[knowledge-fix] Created knowledge fix draft.", {
      knowledgeFixId: persisted.id,
      sourceActionKey: persisted.sourceActionKey,
      actionType: persisted.actionType,
      status: persisted.status,
      topic: persisted.topic,
      occurrenceCount: persisted.occurrenceCount,
    });

    await persistQueueSyncForKnowledgeFix(supabase, {
      knowledgeFix: persisted,
    });
  }

  return {
    records,
    persistenceAvailable: true,
  };
}

async function getKnowledgeFixWorkflowById(supabase, options = {}) {
  const knowledgeFixId = cleanText(options.knowledgeFixId);
  const agentId = cleanText(options.agentId);
  const ownerUserId = cleanText(options.ownerUserId);

  if (!knowledgeFixId || !agentId || !ownerUserId) {
    const error = new Error("knowledge_fix_id, agent_id, and owner_user_id are required");
    error.statusCode = 400;
    throw error;
  }

  const { data, error } = await supabase
    .from(KNOWLEDGE_FIX_WORKFLOW_TABLE)
    .select(KNOWLEDGE_FIX_SELECT)
    .eq("id", knowledgeFixId)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error, KNOWLEDGE_FIX_WORKFLOW_TABLE)) {
      return {
        record: null,
        persistenceAvailable: false,
      };
    }

    console.error(error);
    throw error;
  }

  return {
    record: data ? normalizeWorkflow(data) : null,
    persistenceAvailable: true,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyKnowledgeFixToSystemPrompt(systemPrompt, workflow) {
  const normalizedPrompt = String(systemPrompt || "").replace(/\r/g, "").trim();
  const normalizedWorkflow = normalizeWorkflow(workflow);
  const blockStart = `[VONZA_KNOWLEDGE_FIX ${normalizedWorkflow.dedupeKey}]`;
  const blockEnd = "[/VONZA_KNOWLEDGE_FIX]";
  const blockRegex = new RegExp(`${escapeRegExp(blockStart)}[\\s\\S]*?${escapeRegExp(blockEnd)}`, "g");
  const nextBody = [
    blockStart,
    `Topic: ${normalizedWorkflow.topic || "Knowledge fix"}`,
    normalizedWorkflow.proposedGuidance,
    blockEnd,
  ].filter(Boolean).join("\n");
  const strippedPrompt = normalizedPrompt.replace(blockRegex, "").trim();

  if (!strippedPrompt) {
    return nextBody;
  }

  return `${strippedPrompt}\n\n${nextBody}`.trim();
}

export async function updateKnowledgeFixWorkflow(supabase, options = {}) {
  const agentId = cleanText(options.agentId);
  const ownerUserId = cleanText(options.ownerUserId);
  const knowledgeFixId = cleanText(options.knowledgeFixId);
  const requestedStatus = options.status === undefined ? "" : assertValidKnowledgeFixStatus(options.status);
  const requestedIssueSummary = options.issueSummary === undefined ? undefined : cleanText(options.issueSummary);
  const requestedMattersSummary = options.mattersSummary === undefined ? undefined : cleanText(options.mattersSummary);
  const requestedProposedGuidance = options.proposedGuidance === undefined ? undefined : cleanText(options.proposedGuidance);
  const requestedErrorMessage = options.errorMessage === undefined ? undefined : cleanText(options.errorMessage);
  const agentProfile = options.agentProfile && typeof options.agentProfile === "object"
    ? options.agentProfile
    : null;

  const lookup = await getKnowledgeFixWorkflowById(supabase, {
    knowledgeFixId,
    agentId,
    ownerUserId,
  });

  if (lookup.persistenceAvailable === false) {
    return {
      knowledgeFix: null,
      persistenceAvailable: false,
    };
  }

  const existing = normalizeWorkflow(lookup.record);

  if (!existing?.id) {
    const error = new Error("Knowledge fix workflow not found");
    error.statusCode = 404;
    throw error;
  }

  const nextStatus = requestedStatus || existing.status;
  const nextIssueSummary = requestedIssueSummary === undefined ? existing.issueSummary : requestedIssueSummary;
  const nextMattersSummary = requestedMattersSummary === undefined ? existing.mattersSummary : requestedMattersSummary;
  const nextProposedGuidance = requestedProposedGuidance === undefined ? existing.proposedGuidance : requestedProposedGuidance;
  const statusChanged = nextStatus !== existing.status;

  if ((existing.status === "applied" || existing.status === "dismissed") && statusChanged) {
    const error = new Error("This knowledge fix is closed. Create or sync a new draft if the issue reappears.");
    error.statusCode = 400;
    throw error;
  }

  if (["draft", "ready", "applied"].includes(nextStatus) && !nextProposedGuidance) {
    const error = new Error("Proposed guidance cannot be empty.");
    error.statusCode = 400;
    throw error;
  }

  let nextWorkflow = normalizeWorkflow({
    ...existing,
    status: nextStatus,
    issueSummary: nextIssueSummary,
    mattersSummary: nextMattersSummary,
    proposedGuidance: nextProposedGuidance,
    draftEditedManually:
      requestedIssueSummary !== undefined ||
      requestedMattersSummary !== undefined ||
      requestedProposedGuidance !== undefined
        ? (
          nextIssueSummary !== existing.issueSummary ||
          nextMattersSummary !== existing.mattersSummary ||
          nextProposedGuidance !== existing.lastGeneratedGuidance ||
          existing.draftEditedManually
        )
        : existing.draftEditedManually,
    lastError: nextStatus === "failed"
      ? (requestedErrorMessage || existing.lastError || "Knowledge fix failed.")
      : "",
    dismissedAt: nextStatus === "dismissed"
      ? (existing.dismissedAt || new Date().toISOString())
      : null,
    appliedAt: nextStatus === "applied"
      ? (existing.appliedAt || new Date().toISOString())
      : existing.appliedAt,
    appliedGuidance: nextStatus === "applied"
      ? nextProposedGuidance
      : existing.appliedGuidance,
  });

  let updatedAgent = null;

  if (nextStatus === "applied") {
    if (normalizeTargetType(existing.targetType) !== "system_prompt") {
      const error = new Error("This knowledge fix target is not supported for direct apply yet.");
      error.statusCode = 400;
      throw error;
    }

    if (!agentProfile?.agentId || cleanText(agentProfile.agentId) !== agentId) {
      const error = new Error("Current assistant context is required before applying this knowledge fix.");
      error.statusCode = 400;
      throw error;
    }

    try {
      const nextSystemPrompt = applyKnowledgeFixToSystemPrompt(agentProfile.systemPrompt || "", nextWorkflow);
      updatedAgent = await updateAgentSettings(supabase, {
        agentId,
        systemPrompt: nextSystemPrompt,
      });
      nextWorkflow = normalizeWorkflow({
        ...nextWorkflow,
        appliedGuidance: nextProposedGuidance,
        appliedAt: nextWorkflow.appliedAt || new Date().toISOString(),
      });
    } catch (error) {
      const failedWorkflow = normalizeWorkflow({
        ...existing,
        status: "failed",
        issueSummary: nextIssueSummary,
        mattersSummary: nextMattersSummary,
        proposedGuidance: nextProposedGuidance,
        draftEditedManually: nextWorkflow.draftEditedManually,
        lastError: cleanText(error.message) || "Knowledge fix apply failed.",
      });
      const persistedFailure = await updateKnowledgeFixWorkflowRecord(supabase, failedWorkflow);
      await persistQueueSyncForKnowledgeFix(supabase, {
        knowledgeFix: persistedFailure,
      });
      console.error("[knowledge-fix] Failed to apply knowledge fix.", {
        knowledgeFixId: persistedFailure.id,
        sourceActionKey: persistedFailure.sourceActionKey,
        targetType: persistedFailure.targetType,
        message: persistedFailure.lastError,
      });
      error.statusCode = error.statusCode || 500;
      throw error;
    }
  }

  const persisted = await updateKnowledgeFixWorkflowRecord(supabase, nextWorkflow);
  const queueSync = await persistQueueSyncForKnowledgeFix(supabase, {
    knowledgeFix: persisted,
  });

  if (persisted.status === "applied") {
    console.info("[knowledge-fix] Applied knowledge fix.", {
      knowledgeFixId: persisted.id,
      sourceActionKey: persisted.sourceActionKey,
      targetType: persisted.targetType,
      appliedAt: persisted.appliedAt,
    });
  } else if (persisted.status === "dismissed") {
    console.info("[knowledge-fix] Dismissed knowledge fix.", {
      knowledgeFixId: persisted.id,
      sourceActionKey: persisted.sourceActionKey,
    });
  } else if (persisted.status === "failed") {
    console.warn("[knowledge-fix] Recorded knowledge fix failure.", {
      knowledgeFixId: persisted.id,
      sourceActionKey: persisted.sourceActionKey,
      lastError: persisted.lastError,
    });
  } else {
    console.info("[knowledge-fix] Updated knowledge fix draft.", {
      knowledgeFixId: persisted.id,
      sourceActionKey: persisted.sourceActionKey,
      status: persisted.status,
    });
  }

  return {
    knowledgeFix: persisted,
    queueSync,
    updatedAgent,
    persistenceAvailable: true,
  };
}
