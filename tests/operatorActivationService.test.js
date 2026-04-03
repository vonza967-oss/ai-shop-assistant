import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOperatorActivationChecklist,
  buildOperatorBriefing,
  buildOperatorSingleNextAction,
  buildOperatorTodaySummary,
  createDefaultOperatorActivationState,
} from "../src/services/operator/operatorActivationService.js";

test("single next action points to Google connection before operator setup begins", () => {
  const nextAction = buildOperatorSingleNextAction({
    status: {
      featureEnabled: true,
      googleConnected: false,
      googleConnectReady: true,
    },
    activation: createDefaultOperatorActivationState(),
  });

  assert.equal(nextAction.key, "connect_google");
  assert.equal(nextAction.actionType, "connect_google");
});

test("single next action requests first sync after Google connects", () => {
  const nextAction = buildOperatorSingleNextAction({
    status: {
      featureEnabled: true,
      googleConnected: true,
      googleConnectReady: true,
    },
    activation: createDefaultOperatorActivationState({
      googleConnected: true,
      inboxContextSelected: true,
      calendarContextSelected: true,
      inboxSynced: false,
      calendarSynced: false,
    }),
  });

  assert.equal(nextAction.key, "run_first_sync");
  assert.equal(nextAction.actionType, "run_first_sync");
});

test("single next action escalates urgent complaint work once synced", () => {
  const nextAction = buildOperatorSingleNextAction({
    status: {
      featureEnabled: true,
      googleConnected: true,
      googleConnectReady: true,
    },
    activation: createDefaultOperatorActivationState({
      googleConnected: true,
      inboxContextSelected: true,
      calendarContextSelected: true,
      inboxSynced: true,
      calendarSynced: true,
      firstInboxReviewCompleted: true,
    }),
    tasks: [
      {
        taskType: "complaint_queue",
        title: "Complaint needs review: Refund request",
        description: "Customer is frustrated and waiting for a response.",
        status: "open",
        priority: "high",
      },
    ],
  });

  assert.equal(nextAction.key, "review_complaint");
  assert.match(nextAction.title, /refund request/i);
});

test("activation checklist reflects durable first-run progress", () => {
  const checklist = buildOperatorActivationChecklist({
    status: {
      googleConnected: true,
      googleConnectReady: true,
    },
    activation: createDefaultOperatorActivationState({
      googleConnected: true,
      inboxContextSelected: true,
      calendarContextSelected: true,
      inboxSynced: true,
      calendarSynced: false,
      firstInboxReviewCompleted: true,
      firstCampaignDraftCreated: false,
    }),
    threads: [{ id: "thread-1" }],
    events: [],
    suggestedSlots: [],
  });

  assert.equal(checklist.find((step) => step.key === "connect_google")?.complete, true);
  assert.equal(checklist.find((step) => step.key === "choose_context")?.complete, true);
  assert.equal(checklist.find((step) => step.key === "run_first_sync")?.complete, false);
  assert.equal(checklist.find((step) => step.key === "review_inbox")?.complete, true);
  assert.equal(checklist.find((step) => step.key === "create_first_automation")?.complete, false);
});

test("operator briefing uses structured fallback copy before sync", () => {
  const briefing = buildOperatorBriefing({
    status: {
      featureEnabled: true,
      googleConnected: true,
      googleConnectReady: true,
    },
    activation: createDefaultOperatorActivationState({
      googleConnected: true,
      inboxContextSelected: true,
      calendarContextSelected: true,
      inboxSynced: false,
      calendarSynced: false,
    }),
  });

  assert.match(briefing.text, /first sync/i);
});

test("operator briefing summarizes live workload with next recommendation", () => {
  const briefing = buildOperatorBriefing({
    status: {
      featureEnabled: true,
      googleConnected: true,
      googleConnectReady: true,
    },
    activation: createDefaultOperatorActivationState({
      googleConnected: true,
      inboxContextSelected: true,
      calendarContextSelected: true,
      inboxSynced: true,
      calendarSynced: true,
      firstInboxReviewCompleted: true,
      firstCampaignDraftCreated: true,
    }),
    summary: {
      inboxNeedingAttention: 3,
      overdueThreads: 1,
      activeCampaigns: 1,
    },
    tasks: [
      {
        taskType: "complaint_queue",
        status: "open",
        priority: "high",
      },
    ],
    events: [
      {
        title: "Morning booking",
        startAt: "2026-04-06T09:00:00.000Z",
      },
    ],
    nextAction: {
      title: "Review complaints",
    },
  });

  assert.match(briefing.text, /3 inbox threads need attention/i);
  assert.match(briefing.text, /1 complaint needs review/i);
  assert.match(briefing.text, /recommended next step: Review complaints/i);
});

test("today summary includes people-centered attention counts", () => {
  const today = buildOperatorTodaySummary({
    summary: {
      inboxNeedingAttention: 1,
    },
    contactsSummary: {
      contactsNeedingAttention: 4,
      complaintRiskContacts: 2,
      leadsWithoutNextStep: 1,
      customersAwaitingFollowUp: 3,
    },
  });

  assert.equal(today.contactsNeedingAttention, 4);
  assert.equal(today.complaintRiskContacts, 2);
  assert.equal(today.leadsWithoutNextStep, 1);
  assert.equal(today.customersAwaitingFollowUp, 3);
});
