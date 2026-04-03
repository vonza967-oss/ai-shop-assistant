import test from "node:test";
import assert from "node:assert/strict";

import { buildActionQueue } from "../src/services/analytics/actionQueueService.js";
import {
  applyLeadCaptureAction,
  hydrateActionQueueWithLeadCaptures,
  processLiveChatLeadCapture,
} from "../src/services/leads/liveLeadCaptureService.js";

function createFakeSupabase(initialState = {}) {
  const state = {
    messages: (initialState.messages || []).map((row) => ({ ...row })),
    agent_follow_up_workflows: (initialState.agent_follow_up_workflows || []).map((row) => ({ ...row })),
    agent_action_queue_statuses: (initialState.agent_action_queue_statuses || []).map((row) => ({ ...row })),
    agent_contact_leads: (initialState.agent_contact_leads || []).map((row) => ({ ...row })),
  };
  const counters = new Map();

  const nextId = (table) => {
    const current = (counters.get(table) || 0) + 1;
    counters.set(table, current);

    if (table === "agent_follow_up_workflows") {
      return `follow-up-${current}`;
    }

    if (table === "agent_contact_leads") {
      return `lead-${current}`;
    }

    return `${table}-${current}`;
  };

  class QueryBuilder {
    constructor(table) {
      this.table = table;
      this.mode = "select";
      this.filters = [];
      this.orderBy = null;
      this.limitValue = null;
      this.payload = null;
      this.onConflict = "";
      this.expectSingle = false;
      this.expectMaybeSingle = false;
    }

    select() {
      return this;
    }

    insert(payload) {
      this.mode = "insert";
      this.payload = Array.isArray(payload) ? payload : [payload];
      return this;
    }

    update(payload) {
      this.mode = "update";
      this.payload = payload;
      return this;
    }

    upsert(payload, options = {}) {
      this.mode = "upsert";
      this.payload = Array.isArray(payload) ? payload : [payload];
      this.onConflict = options.onConflict || "";
      return this;
    }

    eq(field, value) {
      this.filters.push({ type: "eq", field, value });
      return this;
    }

    order(field, options = {}) {
      this.orderBy = {
        field,
        ascending: options.ascending !== false,
      };
      return this;
    }

    limit(value) {
      this.limitValue = value;
      return this;
    }

    single() {
      this.expectSingle = true;
      return this.execute();
    }

    maybeSingle() {
      this.expectMaybeSingle = true;
      return this.execute();
    }

    then(resolve, reject) {
      return this.execute().then(resolve, reject);
    }

    async execute() {
      const rows = state[this.table];

      if (!rows) {
        return {
          data: null,
          error: { code: "42P01", message: `relation '${this.table}' does not exist` },
        };
      }

      if (this.mode === "insert") {
        const inserted = this.payload.map((entry) => {
          const row = {
            id: entry.id || nextId(this.table),
            created_at: entry.created_at || new Date().toISOString(),
            ...entry,
          };
          rows.push(row);
          return { ...row };
        });
        return this.finish(inserted);
      }

      if (this.mode === "update") {
        const updated = this.applyFilters(rows).map((row) => {
          Object.assign(row, this.payload);
          return { ...row };
        });
        return this.finish(updated);
      }

      if (this.mode === "upsert") {
        const updated = this.payload.map((entry) => {
          const conflictFields = this.onConflict.split(",").map((field) => field.trim()).filter(Boolean);
          const existing = rows.find((row) =>
            conflictFields.length
              ? conflictFields.every((field) => String(row[field] ?? "") === String(entry[field] ?? ""))
              : row.id === entry.id
          );

          if (existing) {
            Object.assign(existing, entry);
            return { ...existing };
          }

          const row = {
            id: entry.id || nextId(this.table),
            created_at: entry.created_at || new Date().toISOString(),
            ...entry,
          };
          rows.push(row);
          return { ...row };
        });
        return this.finish(updated);
      }

      return this.finish(this.applyFilters(rows).map((row) => ({ ...row })));
    }

    applyFilters(rows) {
      let result = rows.filter((row) =>
        this.filters.every((filter) => {
          if (filter.type === "eq") {
            return String(row[filter.field] ?? "") === String(filter.value ?? "");
          }
          return true;
        })
      );

      if (this.orderBy) {
        const { field, ascending } = this.orderBy;
        result = result.sort((left, right) => {
          const leftValue = new Date(left[field] || 0).getTime();
          const rightValue = new Date(right[field] || 0).getTime();
          return ascending ? leftValue - rightValue : rightValue - leftValue;
        });
      }

      if (Number.isFinite(this.limitValue)) {
        result = result.slice(0, this.limitValue);
      }

      return result;
    }

    finish(rows) {
      if (this.expectMaybeSingle) {
        return Promise.resolve({
          data: rows[0] || null,
          error: null,
        });
      }

      if (this.expectSingle) {
        return Promise.resolve({
          data: rows[0] || null,
          error: null,
        });
      }

      return Promise.resolve({
        data: rows,
        error: null,
      });
    }
  }

  return {
    state,
    from(table) {
      return new QueryBuilder(table);
    },
  };
}

function buildAgent(ownerUserId = "owner-1") {
  return {
    id: "agent-1",
    ownerUserId,
    name: "Vonza Front Desk",
  };
}

function buildBusiness() {
  return {
    id: "business-1",
    name: "Acme Services",
  };
}

function buildWidgetConfig() {
  return {
    assistantName: "Acme Front Desk",
    installId: "00000000-0000-0000-0000-000000000001",
  };
}

function buildConversationRows(messages, sessionKey = "session-1", startAt = "2026-04-03T09:00:00.000Z") {
  const baseTime = new Date(startAt).getTime();
  const rows = [];

  messages.forEach((message, index) => {
    rows.push({
      id: message.id || `message-${index + 1}`,
      agent_id: "agent-1",
      role: message.role,
      content: message.content,
      session_key: message.sessionKey || sessionKey,
      created_at: new Date(baseTime + index * 1000).toISOString(),
    });
  });

  return rows;
}

test("pricing intent triggers a prompt-ready lead capture state", async () => {
  const supabase = createFakeSupabase({
    messages: buildConversationRows([
      { role: "user", content: "How much does it cost for a quote?" },
      { role: "assistant", content: "Pricing depends on scope, but I can explain the options." },
    ]),
  });

  const result = await processLiveChatLeadCapture(supabase, {
    agent: buildAgent(),
    business: buildBusiness(),
    widgetConfig: buildWidgetConfig(),
    sessionKey: "session-1",
    userMessage: "How much does it cost for a quote?",
    language: "English",
    pageUrl: "https://example.com/pricing",
    origin: "https://example.com",
  });

  assert.equal(result.state, "prompt_ready");
  assert.equal(result.shouldPrompt, true);
  assert.match(result.prompt.body, /pricing details/i);
});

test("booking intent triggers a prompt-ready lead capture state", async () => {
  const supabase = createFakeSupabase({
    messages: buildConversationRows([
      { role: "user", content: "Can I book an appointment for next week?" },
      { role: "assistant", content: "Yes, I can help with the next step." },
    ], "session-2"),
  });

  const result = await processLiveChatLeadCapture(supabase, {
    agent: buildAgent(),
    business: buildBusiness(),
    widgetConfig: buildWidgetConfig(),
    sessionKey: "session-2",
    userMessage: "Can I book an appointment for next week?",
    language: "English",
  });

  assert.equal(result.state, "prompt_ready");
  assert.equal(result.shouldPrompt, true);
  assert.match(result.prompt.body, /follow up and help arrange the next step/i);
});

test("explicit callback or quote language triggers the live handoff prompt", async () => {
  const supabase = createFakeSupabase({
    messages: buildConversationRows([
      { role: "user", content: "Can someone call me back with an estimate?" },
      { role: "assistant", content: "Yes, I can help move that forward." },
    ], "session-3"),
  });

  const result = await processLiveChatLeadCapture(supabase, {
    agent: buildAgent(),
    business: buildBusiness(),
    widgetConfig: buildWidgetConfig(),
    sessionKey: "session-3",
    userMessage: "Can someone call me back with an estimate?",
    language: "English",
  });

  assert.equal(result.state, "prompt_ready");
  assert.equal(result.shouldPrompt, true);
  assert.match(result.trigger, /quote_request|pricing_interest|direct_follow_up/);
});

test("low-intent chat does not trigger live contact capture", async () => {
  const supabase = createFakeSupabase({
    messages: buildConversationRows([
      { role: "user", content: "What services do you offer?" },
      { role: "assistant", content: "We handle design, install, and maintenance." },
    ], "session-4"),
  });

  const result = await processLiveChatLeadCapture(supabase, {
    agent: buildAgent(),
    business: buildBusiness(),
    widgetConfig: buildWidgetConfig(),
    sessionKey: "session-4",
    userMessage: "What services do you offer?",
    language: "English",
  });

  assert.equal(result.state, "none");
  assert.equal(result.shouldPrompt, false);
});

test("declined capture is respected and not re-prompted immediately", async () => {
  const supabase = createFakeSupabase({
    messages: buildConversationRows([
      { role: "user", content: "How much does it cost?" },
      { role: "assistant", content: "It depends on scope." },
    ], "session-5"),
  });

  await applyLeadCaptureAction(supabase, {
    agent: buildAgent(),
    business: buildBusiness(),
    widgetConfig: buildWidgetConfig(),
    action: "prompt_shown",
    sessionKey: "session-5",
    language: "English",
    userMessage: "How much does it cost?",
  });

  const declined = await applyLeadCaptureAction(supabase, {
    agent: buildAgent(),
    business: buildBusiness(),
    widgetConfig: buildWidgetConfig(),
    action: "decline",
    sessionKey: "session-5",
    language: "English",
    userMessage: "How much does it cost?",
  });

  assert.equal(declined.state, "declined");

  supabase.state.messages.push(...buildConversationRows([
    { role: "user", content: "What would the price be for a bigger job?" },
    { role: "assistant", content: "We can price that once we know the scope." },
  ], "session-5", "2026-04-03T09:05:00.000Z"));

  const result = await processLiveChatLeadCapture(supabase, {
    agent: buildAgent(),
    business: buildBusiness(),
    widgetConfig: buildWidgetConfig(),
    sessionKey: "session-5",
    userMessage: "What would the price be for a bigger job?",
    language: "English",
  });

  assert.equal(result.state, "declined");
  assert.equal(result.shouldPrompt, false);
});

test("successful capture creates a durable lead and updates the follow-up draft", async () => {
  const supabase = createFakeSupabase({
    messages: buildConversationRows([
      { role: "user", content: "How much does it cost?" },
      { role: "assistant", content: "We can tailor pricing to the scope." },
    ], "session-6"),
  });

  await applyLeadCaptureAction(supabase, {
    agent: buildAgent(),
    business: buildBusiness(),
    widgetConfig: buildWidgetConfig(),
    action: "prompt_shown",
    sessionKey: "session-6",
    language: "English",
    userMessage: "How much does it cost?",
  });

  const captured = await applyLeadCaptureAction(supabase, {
    agent: buildAgent(),
    business: buildBusiness(),
    widgetConfig: buildWidgetConfig(),
    action: "submit",
    sessionKey: "session-6",
    language: "English",
    userMessage: "How much does it cost?",
    email: "buyer@example.com",
    name: "Jordan Blake",
    preferredChannel: "email",
  });

  assert.equal(captured.state, "captured");
  assert.equal(supabase.state.agent_contact_leads.length, 1);
  assert.equal(supabase.state.agent_contact_leads[0].contact_email, "buyer@example.com");
  assert.equal(supabase.state.agent_follow_up_workflows.length, 1);
  assert.equal(supabase.state.agent_follow_up_workflows[0].status, "draft");
  assert.equal(supabase.state.agent_follow_up_workflows[0].contact_email, "buyer@example.com");
  assert.equal(supabase.state.agent_action_queue_statuses.length, 1);
  assert.equal(supabase.state.agent_action_queue_statuses[0].follow_up_needed, true);
});

test("repeat high-intent visitor updates the existing lead and follow-up instead of duplicating", async () => {
  const supabase = createFakeSupabase({
    messages: buildConversationRows([
      { role: "user", content: "How much does it cost?" },
      { role: "assistant", content: "We can tailor pricing to the scope." },
      { role: "user", content: "Okay, can someone contact me about pricing?" },
      { role: "assistant", content: "Yes, I can help with the next step." },
    ], "session-7"),
  });

  await applyLeadCaptureAction(supabase, {
    agent: buildAgent(),
    business: buildBusiness(),
    widgetConfig: buildWidgetConfig(),
    action: "submit",
    sessionKey: "session-7",
    language: "English",
    userMessage: "Okay, can someone contact me about pricing?",
    email: "repeat@example.com",
    name: "Taylor Stone",
  });

  const firstLeadId = supabase.state.agent_contact_leads[0].id;
  const firstFollowUpId = supabase.state.agent_follow_up_workflows[0].id;

  supabase.state.messages.push(...buildConversationRows([
    { role: "user", content: "I'm back. Can I book a time to talk?" },
    { role: "assistant", content: "Yes, I can help with that next step." },
  ], "session-7", "2026-04-03T10:00:00.000Z"));

  const result = await processLiveChatLeadCapture(supabase, {
    agent: buildAgent(),
    business: buildBusiness(),
    widgetConfig: buildWidgetConfig(),
    sessionKey: "session-7",
    userMessage: "I'm back. Can I book a time to talk?",
    language: "English",
  });

  assert.equal(result.state, "captured");
  assert.equal(supabase.state.agent_contact_leads.length, 1);
  assert.equal(supabase.state.agent_contact_leads[0].id, firstLeadId);
  assert.equal(supabase.state.agent_follow_up_workflows.length, 1);
  assert.equal(supabase.state.agent_follow_up_workflows[0].id, firstFollowUpId);
});

test("queue hydration exposes live conversion summary and recent captured leads", async () => {
  const messages = buildConversationRows([
    { role: "user", content: "How much does it cost?" },
    { role: "assistant", content: "We can tailor pricing to the scope." },
    { role: "user", content: "Can I book next week?" },
    { role: "assistant", content: "Yes, let's help with the next step." },
  ], "session-8");
  const actionQueue = buildActionQueue(messages, []);
  const hydrated = hydrateActionQueueWithLeadCaptures(actionQueue, {
    records: [
      {
        id: "lead-1",
        agent_id: "agent-1",
        owner_user_id: "owner-1",
        lead_key: "email:buyer@example.com",
        capture_state: "captured",
        contact_email: "buyer@example.com",
        latest_action_type: "pricing_interest",
        latest_message_id: "message-1",
        related_action_keys: [actionQueue.items[0].key],
        prompt_count: 1,
        capture_reason: "Flagged because this visitor asked about pricing.",
      },
    ],
    followUps: [
      {
        id: "follow-up-1",
        sourceActionKey: actionQueue.items[0].key,
        linkedActionKeys: [actionQueue.items[0].key],
        status: "draft",
      },
    ],
    persistenceAvailable: true,
  });

  assert.equal(hydrated.conversionSummary.highIntentConversations, 2);
  assert.equal(hydrated.conversionSummary.capturePromptsShown, 1);
  assert.equal(hydrated.conversionSummary.contactsCaptured, 1);
  assert.equal(hydrated.conversionSummary.followUpsPrepared, 1);
  assert.equal(hydrated.recentLeadCaptures.length, 1);
  assert.equal(hydrated.items[0].leadCapture.state, "captured");
});

test("owner scoping stays strict when live capture runs without an owner", async () => {
  const supabase = createFakeSupabase({
    messages: buildConversationRows([
      { role: "user", content: "How much does it cost?" },
      { role: "assistant", content: "We can tailor pricing to the scope." },
    ], "session-9"),
  });

  const result = await processLiveChatLeadCapture(supabase, {
    agent: buildAgent(""),
    business: buildBusiness(),
    widgetConfig: buildWidgetConfig(),
    sessionKey: "session-9",
    userMessage: "How much does it cost?",
    language: "English",
  });

  assert.equal(result.state, "blocked");
  assert.equal(supabase.state.agent_contact_leads.length, 0);
  assert.equal(supabase.state.agent_follow_up_workflows.length, 0);
});
