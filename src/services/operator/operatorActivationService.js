import {
  CONNECTED_ACCOUNT_TABLE,
  OPERATOR_ACTIVATION_TABLE,
} from "../../config/constants.js";
import { cleanText } from "../../utils/text.js";

export const OPERATOR_CHECKLIST_KEYS = [
  "connect_google",
  "choose_context",
  "run_first_sync",
  "review_inbox",
  "review_calendar",
  "create_first_automation",
];

const OPERATOR_ACTIVATION_SELECT = [
  "id",
  "agent_id",
  "business_id",
  "owner_user_id",
  "operator_workspace_enabled",
  "google_connected",
  "inbox_context_selected",
  "calendar_context_selected",
  "inbox_synced",
  "calendar_synced",
  "first_inbox_review_completed",
  "first_reply_draft_created",
  "first_campaign_draft_created",
  "first_calendar_action_reviewed",
  "activation_completed_at",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const DEFAULT_MAILBOX_OPTIONS = [
  {
    value: "INBOX",
    label: "Primary inbox",
    description: "Sync the main inbox and approval-first reply drafts.",
  },
  {
    value: "IMPORTANT",
    label: "Important first",
    description: "Prioritize messages Google already marks as important.",
  },
  {
    value: "STARRED",
    label: "Starred only",
    description: "Start narrow if you want Vonza focused on a handpicked queue.",
  },
];

function isMissingRelationError(error, relationName) {
  const message = cleanText(error?.message || "").toLowerCase();

  return (
    error?.code === "PGRST205"
    || error?.code === "42P01"
    || message.includes(`'public.${relationName}'`)
    || message.includes(`${relationName} was not found`)
  );
}

function normalizeBoolean(value) {
  return value === true;
}

function nowIso() {
  return new Date().toISOString();
}

export function createDefaultOperatorActivationState(overrides = {}) {
  return {
    id: "",
    agentId: cleanText(overrides.agentId),
    businessId: cleanText(overrides.businessId),
    ownerUserId: cleanText(overrides.ownerUserId),
    operatorWorkspaceEnabled: overrides.operatorWorkspaceEnabled !== false,
    googleConnected: normalizeBoolean(overrides.googleConnected),
    inboxContextSelected: normalizeBoolean(overrides.inboxContextSelected),
    calendarContextSelected: normalizeBoolean(overrides.calendarContextSelected),
    inboxSynced: normalizeBoolean(overrides.inboxSynced),
    calendarSynced: normalizeBoolean(overrides.calendarSynced),
    firstInboxReviewCompleted: normalizeBoolean(overrides.firstInboxReviewCompleted),
    firstReplyDraftCreated: normalizeBoolean(overrides.firstReplyDraftCreated),
    firstCampaignDraftCreated: normalizeBoolean(overrides.firstCampaignDraftCreated),
    firstCalendarActionReviewed: normalizeBoolean(overrides.firstCalendarActionReviewed),
    activationCompletedAt: overrides.activationCompletedAt || null,
    metadata: overrides.metadata && typeof overrides.metadata === "object" ? overrides.metadata : {},
    createdAt: overrides.createdAt || null,
    updatedAt: overrides.updatedAt || null,
    persistenceAvailable: overrides.persistenceAvailable !== false,
    migrationRequired: overrides.migrationRequired === true,
  };
}

function mapActivationRow(row) {
  if (!row) {
    return null;
  }

  return createDefaultOperatorActivationState({
    id: cleanText(row.id),
    agentId: cleanText(row.agent_id),
    businessId: cleanText(row.business_id),
    ownerUserId: cleanText(row.owner_user_id),
    operatorWorkspaceEnabled: row.operator_workspace_enabled !== false,
    googleConnected: row.google_connected === true,
    inboxContextSelected: row.inbox_context_selected === true,
    calendarContextSelected: row.calendar_context_selected === true,
    inboxSynced: row.inbox_synced === true,
    calendarSynced: row.calendar_synced === true,
    firstInboxReviewCompleted: row.first_inbox_review_completed === true,
    firstReplyDraftCreated: row.first_reply_draft_created === true,
    firstCampaignDraftCreated: row.first_campaign_draft_created === true,
    firstCalendarActionReviewed: row.first_calendar_action_reviewed === true,
    activationCompletedAt: row.activation_completed_at || null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  });
}

function buildActivationCompletion(state) {
  const shouldComplete = Boolean(
    state.googleConnected
    && state.inboxContextSelected
    && state.calendarContextSelected
    && state.inboxSynced
    && state.calendarSynced
    && state.firstInboxReviewCompleted
    && state.firstCalendarActionReviewed
    && state.firstCampaignDraftCreated
  );

  return shouldComplete
    ? (state.activationCompletedAt || nowIso())
    : null;
}

export async function probeOperatorActivationPersistence(supabase) {
  const [connectedAccountProbe, activationProbe] = await Promise.all([
    supabase.from(CONNECTED_ACCOUNT_TABLE).select("id").limit(1),
    supabase.from(OPERATOR_ACTIVATION_TABLE).select("id").limit(1),
  ]);

  const errors = [connectedAccountProbe.error, activationProbe.error].filter(Boolean);
  const missingError = errors.find((error) =>
    isMissingRelationError(error, CONNECTED_ACCOUNT_TABLE) || isMissingRelationError(error, OPERATOR_ACTIVATION_TABLE)
  );

  if (missingError) {
    return {
      persistenceAvailable: false,
      migrationRequired: true,
    };
  }

  const fatalError = errors[0];

  if (fatalError) {
    throw fatalError;
  }

  return {
    persistenceAvailable: true,
    migrationRequired: false,
  };
}

export async function getOperatorActivationState(
  supabase,
  {
    agent,
    ownerUserId,
    createIfMissing = true,
  } = {}
) {
  const agentId = cleanText(agent?.id);
  const businessId = cleanText(agent?.businessId);
  const normalizedOwnerUserId = cleanText(ownerUserId);

  const defaultState = createDefaultOperatorActivationState({
    agentId,
    businessId,
    ownerUserId: normalizedOwnerUserId,
  });

  if (!agentId || !normalizedOwnerUserId) {
    return defaultState;
  }

  const { data, error } = await supabase
    .from(OPERATOR_ACTIVATION_TABLE)
    .select(OPERATOR_ACTIVATION_SELECT)
    .eq("agent_id", agentId)
    .eq("owner_user_id", normalizedOwnerUserId)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error, OPERATOR_ACTIVATION_TABLE)) {
      return createDefaultOperatorActivationState({
        ...defaultState,
        persistenceAvailable: false,
        migrationRequired: true,
      });
    }

    throw error;
  }

  if (data?.id) {
    return mapActivationRow(data);
  }

  if (!createIfMissing) {
    return defaultState;
  }

  const insertPayload = {
    agent_id: agentId,
    business_id: businessId || null,
    owner_user_id: normalizedOwnerUserId,
    operator_workspace_enabled: true,
    google_connected: false,
    inbox_context_selected: false,
    calendar_context_selected: false,
    inbox_synced: false,
    calendar_synced: false,
    first_inbox_review_completed: false,
    first_reply_draft_created: false,
    first_campaign_draft_created: false,
    first_calendar_action_reviewed: false,
    metadata: {},
    updated_at: nowIso(),
  };

  const insertResult = await supabase
    .from(OPERATOR_ACTIVATION_TABLE)
    .insert(insertPayload)
    .select(OPERATOR_ACTIVATION_SELECT)
    .single();

  if (insertResult.error) {
    if (isMissingRelationError(insertResult.error, OPERATOR_ACTIVATION_TABLE)) {
      return createDefaultOperatorActivationState({
        ...defaultState,
        persistenceAvailable: false,
        migrationRequired: true,
      });
    }

    throw insertResult.error;
  }

  return mapActivationRow(insertResult.data);
}

function buildActivationPatch(existingState, changes = {}) {
  const nextState = createDefaultOperatorActivationState({
    ...existingState,
    ...changes,
    metadata: {
      ...(existingState?.metadata || {}),
      ...(changes?.metadata && typeof changes.metadata === "object" ? changes.metadata : {}),
    },
  });

  nextState.activationCompletedAt = buildActivationCompletion(nextState);

  return {
    operator_workspace_enabled: nextState.operatorWorkspaceEnabled !== false,
    google_connected: nextState.googleConnected === true,
    inbox_context_selected: nextState.inboxContextSelected === true,
    calendar_context_selected: nextState.calendarContextSelected === true,
    inbox_synced: nextState.inboxSynced === true,
    calendar_synced: nextState.calendarSynced === true,
    first_inbox_review_completed: nextState.firstInboxReviewCompleted === true,
    first_reply_draft_created: nextState.firstReplyDraftCreated === true,
    first_campaign_draft_created: nextState.firstCampaignDraftCreated === true,
    first_calendar_action_reviewed: nextState.firstCalendarActionReviewed === true,
    activation_completed_at: nextState.activationCompletedAt,
    metadata: nextState.metadata,
    updated_at: nowIso(),
  };
}

export async function patchOperatorActivationState(
  supabase,
  {
    agent,
    ownerUserId,
    changes = {},
  } = {}
) {
  const existingState = await getOperatorActivationState(supabase, {
    agent,
    ownerUserId,
    createIfMissing: true,
  });

  if (existingState.persistenceAvailable === false) {
    return createDefaultOperatorActivationState({
      ...existingState,
      ...changes,
      metadata: {
        ...(existingState.metadata || {}),
        ...(changes.metadata && typeof changes.metadata === "object" ? changes.metadata : {}),
      },
      activationCompletedAt: buildActivationCompletion(createDefaultOperatorActivationState({
        ...existingState,
        ...changes,
        metadata: {
          ...(existingState.metadata || {}),
          ...(changes.metadata && typeof changes.metadata === "object" ? changes.metadata : {}),
        },
      })),
      persistenceAvailable: false,
      migrationRequired: true,
    });
  }

  const { data, error } = await supabase
    .from(OPERATOR_ACTIVATION_TABLE)
    .update(buildActivationPatch(existingState, changes))
    .eq("agent_id", cleanText(agent?.id))
    .eq("owner_user_id", cleanText(ownerUserId))
    .select(OPERATOR_ACTIVATION_SELECT)
    .single();

  if (error) {
    if (isMissingRelationError(error, OPERATOR_ACTIVATION_TABLE)) {
      return createDefaultOperatorActivationState({
        ...existingState,
        ...changes,
        persistenceAvailable: false,
        migrationRequired: true,
      });
    }

    throw error;
  }

  return mapActivationRow(data);
}

export async function updateOperatorOnboardingState(
  supabase,
  {
    agent,
    ownerUserId,
    selectedMailbox = "",
    calendarContext = "",
    markInboxReviewed = false,
    markCalendarReviewed = false,
  } = {}
) {
  const normalizedMailbox = cleanText(selectedMailbox).toUpperCase();
  const normalizedCalendarContext = cleanText(calendarContext).toLowerCase() || "primary";
  const mailboxSelectionChanged = Boolean(normalizedMailbox);
  let connectedAccountUpdateApplied = false;

  if (normalizedMailbox) {
    const updateResult = await supabase
      .from(CONNECTED_ACCOUNT_TABLE)
      .update({
        selected_mailbox: normalizedMailbox,
        updated_at: nowIso(),
      })
      .eq("agent_id", cleanText(agent?.id))
      .eq("owner_user_id", cleanText(ownerUserId))
      .eq("status", "connected")
      .select("id")
      .maybeSingle();

    if (updateResult.error && !isMissingRelationError(updateResult.error, CONNECTED_ACCOUNT_TABLE)) {
      throw updateResult.error;
    }

    connectedAccountUpdateApplied = Boolean(updateResult.data?.id);
  }

  return patchOperatorActivationState(supabase, {
    agent,
    ownerUserId,
    changes: {
      inboxContextSelected: mailboxSelectionChanged || undefined,
      calendarContextSelected: Boolean(normalizedCalendarContext),
      firstInboxReviewCompleted: markInboxReviewed === true || undefined,
      firstCalendarActionReviewed: markCalendarReviewed === true || undefined,
      metadata: {
        selectedMailbox: mailboxSelectionChanged ? normalizedMailbox : undefined,
        calendarContext: normalizedCalendarContext,
        contextUpdatedAt: mailboxSelectionChanged || markInboxReviewed || markCalendarReviewed ? nowIso() : undefined,
        connectedAccountUpdateApplied,
      },
    },
  });
}

function isOpenTask(task = {}) {
  return cleanText(task.status).toLowerCase() === "open";
}

function getPriorityRank(priority = "") {
  switch (cleanText(priority).toLowerCase()) {
    case "high":
      return 0;
    case "medium":
      return 1;
    default:
      return 2;
  }
}

function getTaskOrderScore(task = {}) {
  return [
    getPriorityRank(task.priority),
    cleanText(task.taskType) === "complaint_queue" ? 0 : 1,
    task.updatedAt || task.createdAt || "",
  ].join("|");
}

function getOpenTaskCounts(tasks = []) {
  const openTasks = tasks.filter(isOpenTask);

  return {
    complaintsNeedingReview: openTasks.filter((task) => task.taskType === "complaint_queue").length,
    supportNeedingReview: openTasks.filter((task) => task.taskType === "support_follow_up").length,
    leadsNeedingAction: openTasks.filter((task) =>
      ["lead_inbox_follow_up", "missed_booking_opportunity"].includes(cleanText(task.taskType))
    ).length,
    campaignsAwaitingApproval: openTasks.filter((task) => task.taskType === "campaign_approval").length,
  };
}

function getOpenTaskHeadline(tasks = []) {
  const nextTask = tasks
    .filter(isOpenTask)
    .slice()
    .sort((left, right) => getTaskOrderScore(left).localeCompare(getTaskOrderScore(right)))[0];

  if (!nextTask) {
    return "";
  }

  return cleanText(nextTask.title || nextTask.description);
}

export function buildOperatorSingleNextAction({
  status = {},
  activation = createDefaultOperatorActivationState(),
  summary = {},
  tasks = [],
  threads = [],
  followUps = [],
  campaigns = [],
  events = [],
  suggestedSlots = [],
} = {}) {
  const googleConnected = status.googleConnected === true;
  const googleConnectReady = status.googleConnectReady !== false;
  const needsFirstSync = googleConnected && (!activation.inboxSynced || !activation.calendarSynced);
  const inboxThreads = Array.isArray(threads) ? threads : [];
  const openTasks = (tasks || []).filter(isOpenTask);
  const urgentComplaintTask = openTasks
    .filter((task) => cleanText(task.taskType) === "complaint_queue")
    .sort((left, right) => getTaskOrderScore(left).localeCompare(getTaskOrderScore(right)))[0];
  const urgentSupportTask = openTasks
    .filter((task) => cleanText(task.taskType) === "support_follow_up")
    .sort((left, right) => getTaskOrderScore(left).localeCompare(getTaskOrderScore(right)))[0];
  const overdueThread = inboxThreads.find((thread) => thread.needsReply && cleanText(thread.riskLevel) === "high");
  const leadTask = openTasks.find((task) => cleanText(task.taskType) === "missed_booking_opportunity");

  if (!googleConnected) {
    return {
      key: "connect_google",
      title: googleConnectReady ? "Connect Google" : "Finish Google setup",
      description: googleConnectReady
        ? "Connect Gmail and Calendar so Vonza can build your inbox, calendar, and operator summary."
        : "Google connection is not configured on this deployment yet. Add the Google env vars before owner activation.",
      buttonLabel: googleConnectReady ? "Connect Google" : "Review deployment setup",
      actionType: googleConnectReady ? "connect_google" : "open_customize",
      targetSection: googleConnectReady ? "overview" : "customize",
      disabled: googleConnectReady !== true,
    };
  }

  if (!activation.inboxContextSelected || !activation.calendarContextSelected) {
    return {
      key: "choose_context",
      title: "Choose your operator context",
      description: "Pick the inbox Vonza should watch first and confirm the calendar context before syncing live data.",
      buttonLabel: "Save context",
      actionType: "review_context",
      targetSection: "overview",
    };
  }

  if (needsFirstSync) {
    return {
      key: "run_first_sync",
      title: "Run first sync",
      description: "Pull in the inbox and calendar now so Overview can show what actually needs attention today.",
      buttonLabel: "Run first sync",
      actionType: "run_first_sync",
      targetSection: "overview",
    };
  }

  if (urgentComplaintTask) {
    return {
      key: "review_complaint",
      title: urgentComplaintTask.title || "Review complaint queue",
      description: urgentComplaintTask.description || "A complaint needs owner review before it goes stale.",
      buttonLabel: "Review complaints",
      actionType: "open_automations",
      targetSection: "automations",
    };
  }

  if (urgentSupportTask) {
    return {
      key: "review_support",
      title: urgentSupportTask.title || "Review support follow-up",
      description: urgentSupportTask.description || "A support issue needs owner attention.",
      buttonLabel: "Open support queue",
      actionType: "open_automations",
      targetSection: "automations",
    };
  }

  if (overdueThread && !activation.firstInboxReviewCompleted) {
    return {
      key: "review_inbox",
      title: overdueThread.subject || "Review inbox classifications",
      description: "Start with the inbox so urgent threads and reply drafts are reviewed before they go cold.",
      buttonLabel: "Review inbox",
      actionType: "open_inbox",
      targetSection: "inbox",
    };
  }

  if (!activation.firstCalendarActionReviewed && (events.length || suggestedSlots.length)) {
    return {
      key: "review_calendar",
      title: "Review today’s calendar",
      description: "Check today’s events, open gaps, and any scheduling opportunities before automations.",
      buttonLabel: "Review calendar",
      actionType: "open_calendar",
      targetSection: "calendar",
    };
  }

  if (!activation.firstCampaignDraftCreated) {
    return {
      key: "create_first_automation",
      title: "Create your first automation draft",
      description: "Generate one approval-first campaign so the workspace becomes useful beyond passive monitoring.",
      buttonLabel: "Create automation",
      actionType: "open_automations",
      targetSection: "automations",
    };
  }

  if (leadTask) {
    return {
      key: "review_follow_up",
      title: leadTask.title || "Review follow-up",
      description: leadTask.description || "A lead needs the next step defined.",
      buttonLabel: "Review lead follow-up",
      actionType: "open_automations",
      targetSection: "automations",
    };
  }

  if ((followUps || []).length) {
    return {
      key: "review_follow_ups",
      title: "Review follow-ups waiting on you",
      description: "Vonza has prepared follow-ups that still need owner review or approval.",
      buttonLabel: "Open automations",
      actionType: "open_automations",
      targetSection: "automations",
    };
  }

  if ((campaigns || []).length) {
    return {
      key: "review_campaigns",
      title: "Review active automations",
      description: "Check queued campaigns and send timing so the workspace stays current.",
      buttonLabel: "Open automations",
      actionType: "open_automations",
      targetSection: "automations",
    };
  }

  return {
    key: "operator_overview",
    title: "Review operator overview",
    description: cleanText(summary.operatorLoad) > "0"
      ? "Overview is ready with the current workload and approvals."
      : "Overview is connected and ready for the next owner decision.",
    buttonLabel: "Stay on Overview",
    actionType: "stay_put",
    targetSection: "overview",
  };
}

export function buildOperatorActivationChecklist({
  activation = createDefaultOperatorActivationState(),
  status = {},
  threads = [],
  events = [],
  suggestedSlots = [],
} = {}) {
  const googleConnectReady = status.googleConnectReady !== false;
  const googleConnected = status.googleConnected === true;

  return [
    {
      key: "connect_google",
      title: "Connect Google",
      description: googleConnectReady
        ? "Authorize Gmail and Calendar so Vonza can build the operator workspace."
        : "Google env vars still need to be configured before owners can connect.",
      complete: googleConnected,
    },
    {
      key: "choose_context",
      title: "Choose inbox and calendar context",
      description: "Select the inbox focus and confirm the calendar context for first-run sync.",
      complete: activation.inboxContextSelected && activation.calendarContextSelected,
    },
    {
      key: "run_first_sync",
      title: "Run first sync",
      description: "Pull in the current inbox and calendar so Overview stops feeling empty.",
      complete: activation.inboxSynced && activation.calendarSynced,
    },
    {
      key: "review_inbox",
      title: "Review inbox classifications",
      description: (threads || []).length
        ? "Confirm the first important thread bucket so replies and complaints are grounded."
        : "Open the inbox state even if there are no synced threads yet so the workflow is clear.",
      complete: activation.firstInboxReviewCompleted,
    },
    {
      key: "review_calendar",
      title: "Review today’s calendar summary",
      description: (events || []).length || (suggestedSlots || []).length
        ? "Review today’s schedule, open slots, and the first recommended calendar action."
        : "Acknowledge the calendar state so the owner still gets a useful empty summary.",
      complete: activation.firstCalendarActionReviewed,
    },
    {
      key: "create_first_automation",
      title: "Create first automation draft",
      description: "Generate one approval-first campaign so Vonza becomes operational, not just connected.",
      complete: activation.firstCampaignDraftCreated,
    },
  ];
}

export function buildOperatorBriefing({
  status = {},
  summary = {},
  tasks = [],
  nextAction = null,
  activation = createDefaultOperatorActivationState(),
  events = [],
  suggestedSlots = [],
  followUps = [],
} = {}) {
  if (status.featureEnabled === false) {
    return {
      title: "Operator briefing unavailable",
      text: "Operator Workspace v1 is off, so Vonza is still showing the legacy setup workspace.",
    };
  }

  if (status.googleConnected !== true) {
    return {
      title: "Start by connecting Google",
      text: "Google is not connected yet, so Vonza cannot summarize inbox work, calendar load, or approval-first automations today.",
    };
  }

  if (!activation.inboxSynced || !activation.calendarSynced) {
    return {
      title: "Run the first sync",
      text: "Google is connected, but the first sync has not finished yet, so Overview is still waiting on live inbox and calendar data.",
    };
  }

  const taskCounts = getOpenTaskCounts(tasks);
  const parts = [];

  if (Number(summary.inboxNeedingAttention || 0) > 0) {
    parts.push(`${summary.inboxNeedingAttention} inbox thread${summary.inboxNeedingAttention === 1 ? " needs" : "s need"} attention`);
  } else {
    parts.push("the inbox is currently quiet");
  }

  if (taskCounts.complaintsNeedingReview > 0) {
    parts.push(`${taskCounts.complaintsNeedingReview} complaint${taskCounts.complaintsNeedingReview === 1 ? " needs" : "s need"} review`);
  } else if (taskCounts.supportNeedingReview > 0) {
    parts.push(`${taskCounts.supportNeedingReview} support item${taskCounts.supportNeedingReview === 1 ? " needs" : "s need"} follow-up`);
  }

  if (Number(summary.overdueThreads || 0) > 0) {
    parts.push(`${summary.overdueThreads} thread${summary.overdueThreads === 1 ? " is" : "s are"} overdue`);
  }

  if ((events || []).length > 0) {
    parts.push(`${events.length} calendar event${events.length === 1 ? " is" : "s are"} visible today`);
  } else if ((suggestedSlots || []).length > 0) {
    parts.push(`the best open slot is ${suggestedSlots[0].label}`);
  }

  if (taskCounts.leadsNeedingAction > 0) {
    parts.push(`${taskCounts.leadsNeedingAction} lead or follow-up item${taskCounts.leadsNeedingAction === 1 ? " still needs" : "s still need"} action`);
  }

  if (Number(summary.activeCampaigns || 0) > 0) {
    parts.push(`${summary.activeCampaigns} automation${summary.activeCampaigns === 1 ? " is" : "s are"} active`);
  } else if ((followUps || []).length > 0) {
    parts.push(`${followUps.length} prepared follow-up${followUps.length === 1 ? " is" : "s are"} waiting`);
  }

  const recommendation = cleanText(nextAction?.title || nextAction?.description);

  return {
    title: "Operator briefing",
    text: `${parts.join(". ")}.${recommendation ? ` Recommended next step: ${recommendation}.` : ""}`.replace(/\.\./g, "."),
  };
}

export function buildOperatorTodaySummary({
  summary = {},
  tasks = [],
  events = [],
  suggestedSlots = [],
  campaigns = [],
  followUps = [],
} = {}) {
  const taskCounts = getOpenTaskCounts(tasks);
  const nextEvent = (events || [])
    .filter((event) => event.startAt || event.start_at)
    .slice()
    .sort((left, right) => String(left.startAt || left.start_at).localeCompare(String(right.startAt || right.start_at)))[0];

  return {
    googleConnectionLabel: "",
    inboxNeedingAttention: Number(summary.inboxNeedingAttention || 0),
    complaintsNeedingReview: taskCounts.complaintsNeedingReview,
    supportNeedingReview: taskCounts.supportNeedingReview,
    leadsNeedingAction: taskCounts.leadsNeedingAction,
    campaignsAwaitingApproval: taskCounts.campaignsAwaitingApproval,
    followUpsAwaitingApproval: Number(summary.followUpsNeedingApproval || 0),
    activeCampaigns: Number(summary.activeCampaigns || 0),
    upcomingBookings: Number(summary.upcomingBookings || 0),
    nextEventTitle: cleanText(nextEvent?.title),
    nextEventAt: nextEvent?.startAt || nextEvent?.start_at || null,
    openAvailabilityCount: Number(summary.openAvailabilityCount || suggestedSlots.length || 0),
    campaignCount: (campaigns || []).length,
    followUpCount: (followUps || []).length,
    topTask: getOpenTaskHeadline(tasks),
  };
}

export function getOperatorMailboxOptions() {
  return DEFAULT_MAILBOX_OPTIONS.slice();
}
