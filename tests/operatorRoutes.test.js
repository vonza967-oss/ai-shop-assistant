import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import cors from "cors";
import express from "express";

import { createAgentRouter } from "../src/routes/agentRoutes.js";

function createApp(deps = {}) {
  const app = express();
  app.use(cors());
  app.use("/stripe/webhook", express.raw({ type: "application/json" }));
  app.use(express.json());
  app.use(createAgentRouter(deps));
  return app;
}

async function startServer(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer token",
      ...(options.headers || {}),
    },
    ...options,
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

function buildRouteDeps(overrides = {}) {
  return {
    getSupabaseClient: () => ({}),
    getAuthenticatedUser: async () => ({ id: "owner-1", email: "owner@example.com" }),
    requireActiveAgentAccess: async () => ({
      id: "agent-1",
      businessId: "business-1",
    }),
    getAgentWorkspaceSnapshot: async () => ({
      id: "agent-1",
      businessId: "business-1",
      name: "Vonza Operator",
      assistantName: "Vonza Operator",
    }),
    createGoogleConnectionStart: async () => ({
      ok: true,
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test",
    }),
    completeGoogleConnection: async () => ({
      redirectUrl: "/dashboard?google=connected",
    }),
    getOperatorWorkspaceSnapshot: async () => ({
      enabled: true,
      featureEnabled: true,
      status: {
        enabled: true,
        featureEnabled: true,
        googleConnected: true,
      },
      activation: {
        checklist: [{ key: "connect_google", complete: true }],
      },
      connectedAccounts: [{ status: "connected", accountEmail: "owner@example.com" }],
      inbox: { threads: [{ id: "thread-1" }], attentionCount: 1 },
      calendar: { events: [{ id: "event-1" }], suggestedSlots: [], dailySummary: "Busy day." },
      automations: { tasks: [{ id: "task-1" }], campaigns: [], followUps: [] },
      contacts: {
        list: [{ id: "contact-1", name: "Taylor Reed" }],
        filters: { quick: [{ key: "all", label: "All", count: 1 }], sources: [] },
        summary: { totalContacts: 1, contactsNeedingAttention: 1 },
        health: { persistenceAvailable: true, migrationRequired: false, loadError: "" },
      },
      summary: { inboxNeedingAttention: 1 },
      briefing: { text: "Review today." },
      nextAction: { key: "review_inbox", title: "Review inbox" },
    }),
    draftInboxReply: async () => ({
      draft: { id: "draft-1", subject: "Re: Hello" },
    }),
    sendInboxReply: async () => ({
      message: { id: "sent-1" },
    }),
    draftCalendarAction: async () => ({
      event: { id: "draft-event-1", approvalStatus: "pending_owner" },
    }),
    approveCalendarAction: async () => ({
      event: { id: "event-1", approvalStatus: "approved" },
    }),
    createCampaignDraft: async () => ({
      id: "campaign-1",
      steps: [{ id: "step-1" }],
      recipients: [{ id: "recipient-1" }],
    }),
    approveCampaignDraft: async () => ({
      id: "campaign-1",
      status: "active",
      recipients: [{ id: "recipient-1", nextSendAt: "2026-04-06T10:00:00.000Z" }],
    }),
    sendDueCampaignSteps: async () => ({
      campaignId: "campaign-1",
      sentRecipients: [{ id: "recipient-1" }],
    }),
    updateOperatorTaskStatus: async () => ({
      id: "task-1",
      status: "resolved",
    }),
    createManualFollowUpWorkflow: async () => ({
      followUp: { id: "follow-up-1", status: "draft" },
      persistenceAvailable: true,
    }),
    updateOperatorContactLifecycleState: async () => ({
      id: "contact-1",
      lifecycleState: "customer",
    }),
    updateOperatorOnboardingState: async () => ({
      googleConnected: true,
      inboxContextSelected: true,
      calendarContextSelected: true,
    }),
    ...overrides,
  };
}

test("google connect start route returns an auth URL for the owner workspace", async () => {
  const server = await startServer(createApp(buildRouteDeps()));

  try {
    const response = await requestJson(server.baseUrl, "/agents/google/connect/start", {
      method: "POST",
      body: JSON.stringify({
        agent_id: "agent-1",
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.json.authUrl, /accounts\.google\.com/);
  } finally {
    await server.close();
  }
});

test("operator workspace route exposes inbox, calendar, and automations surfaces", async () => {
  const server = await startServer(createApp(buildRouteDeps()));

  try {
    const response = await requestJson(server.baseUrl, "/agents/operator-workspace?agent_id=agent-1");

    assert.equal(response.status, 200);
    assert.equal(response.json.enabled, true);
    assert.equal(response.json.inbox.attentionCount, 1);
    assert.equal(response.json.calendar.events[0].id, "event-1");
    assert.equal(response.json.automations.tasks[0].id, "task-1");
    assert.equal(response.json.contacts.list[0].id, "contact-1");
    assert.equal(response.json.nextAction.key, "review_inbox");
  } finally {
    await server.close();
  }
});

test("operator activation route persists onboarding progress for the owner scope", async () => {
  const server = await startServer(createApp(buildRouteDeps()));

  try {
    const response = await requestJson(server.baseUrl, "/agents/operator/activation", {
      method: "POST",
      body: JSON.stringify({
        agent_id: "agent-1",
        selected_mailbox: "IMPORTANT",
        mark_inbox_reviewed: true,
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.activation.inboxContextSelected, true);
    assert.equal(response.json.activation.calendarContextSelected, true);
  } finally {
    await server.close();
  }
});

test("feature-flag-off snapshot falls back safely without operator surfaces", async () => {
  const server = await startServer(createApp(buildRouteDeps({
    getOperatorWorkspaceSnapshot: async () => ({
      enabled: false,
      featureEnabled: false,
      status: {
        enabled: false,
        featureEnabled: false,
        googleConnected: false,
      },
      activation: {
        checklist: [],
      },
      connectedAccounts: [],
      inbox: { threads: [], attentionCount: 0 },
      calendar: { events: [], suggestedSlots: [], dailySummary: "Disabled." },
      automations: { tasks: [], campaigns: [], followUps: [] },
      summary: { inboxNeedingAttention: 0 },
      nextAction: { key: "legacy_workspace", title: "Continue setup" },
    }),
  })));

  try {
    const response = await requestJson(server.baseUrl, "/agents/operator-workspace?agent_id=agent-1");

    assert.equal(response.status, 200);
    assert.equal(response.json.enabled, false);
    assert.equal(response.json.nextAction.key, "legacy_workspace");
  } finally {
    await server.close();
  }
});

test("operator mutation routes cover reply drafting, calendar approvals, and campaigns", async () => {
  const server = await startServer(createApp(buildRouteDeps()));

  try {
    const draftReply = await requestJson(server.baseUrl, "/agents/operator/inbox/draft-reply", {
      method: "POST",
      body: JSON.stringify({
        agent_id: "agent-1",
        thread_id: "thread-1",
      }),
    });
    assert.equal(draftReply.status, 200);
    assert.equal(draftReply.json.draft.id, "draft-1");

    const approveCalendar = await requestJson(server.baseUrl, "/agents/operator/calendar/approve", {
      method: "POST",
      body: JSON.stringify({
        agent_id: "agent-1",
        event_id: "event-1",
      }),
    });
    assert.equal(approveCalendar.status, 200);
    assert.equal(approveCalendar.json.event.approvalStatus, "approved");

    const draftCampaign = await requestJson(server.baseUrl, "/agents/operator/campaigns/draft", {
      method: "POST",
      body: JSON.stringify({
        agent_id: "agent-1",
        goal: "welcome",
      }),
    });
    assert.equal(draftCampaign.status, 200);
    assert.equal(draftCampaign.json.campaign.id, "campaign-1");

    const draftContactFollowUp = await requestJson(server.baseUrl, "/agents/operator/contacts/follow-up/draft", {
      method: "POST",
      body: JSON.stringify({
        agent_id: "agent-1",
        contact_email: "contact@example.com",
      }),
    });
    assert.equal(draftContactFollowUp.status, 200);
    assert.equal(draftContactFollowUp.json.followUp.id, "follow-up-1");
  } finally {
    await server.close();
  }
});

test("contact lifecycle route preserves owner-scoped lifecycle updates", async () => {
  const server = await startServer(createApp(buildRouteDeps()));

  try {
    const response = await requestJson(server.baseUrl, "/agents/operator/contacts/update", {
      method: "POST",
      body: JSON.stringify({
        agent_id: "agent-1",
        contact_id: "contact-1",
        lifecycle_state: "customer",
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.contact.id, "contact-1");
    assert.equal(response.json.contact.lifecycleState, "customer");
  } finally {
    await server.close();
  }
});

test("campaign approval and send routes preserve owner approval before outbound send", async () => {
  const server = await startServer(createApp(buildRouteDeps()));

  try {
    const approve = await requestJson(server.baseUrl, "/agents/operator/campaigns/approve", {
      method: "POST",
      body: JSON.stringify({
        agent_id: "agent-1",
        campaign_id: "campaign-1",
      }),
    });
    assert.equal(approve.status, 200);
    assert.equal(approve.json.campaign.status, "active");
    assert.ok(approve.json.campaign.recipients[0].nextSendAt);

    const sendDue = await requestJson(server.baseUrl, "/agents/operator/campaigns/send-due", {
      method: "POST",
      body: JSON.stringify({
        agent_id: "agent-1",
        campaign_id: "campaign-1",
      }),
    });
    assert.equal(sendDue.status, 200);
    assert.equal(sendDue.json.sentRecipients.length, 1);
  } finally {
    await server.close();
  }
});

test("operator routes enforce active agent access", async () => {
  const server = await startServer(createApp(buildRouteDeps({
    requireActiveAgentAccess: async () => {
      const error = new Error("Forbidden");
      error.statusCode = 403;
      throw error;
    },
  })));

  try {
    const response = await requestJson(server.baseUrl, "/agents/operator/tasks/update", {
      method: "POST",
      body: JSON.stringify({
        agent_id: "agent-1",
        task_id: "task-1",
        status: "resolved",
      }),
    });

    assert.equal(response.status, 403);
    assert.equal(response.json.error, "Forbidden");
  } finally {
    await server.close();
  }
});
