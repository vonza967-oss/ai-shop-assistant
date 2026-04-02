import test from "node:test";
import assert from "node:assert/strict";

import {
  applyKnowledgeFixToSystemPrompt,
  listKnowledgeFixWorkflows,
  syncKnowledgeFixWorkflows,
  updateKnowledgeFixWorkflow,
} from "../src/services/knowledge/knowledgeFixService.js";

function createSupabaseStub(initialState = {}) {
  const state = {
    agent_knowledge_fix_workflows: (initialState.agent_knowledge_fix_workflows || []).map((row) => ({ ...row })),
    agent_action_queue_statuses: (initialState.agent_action_queue_statuses || []).map((row) => ({ ...row })),
  };
  let knowledgeFixCounter = state.agent_knowledge_fix_workflows.length;

  class QueryBuilder {
    constructor(table) {
      this.table = table;
      this.operation = "select";
      this.filters = [];
      this.values = null;
      this.selectUsed = false;
      this.orderBy = null;
    }

    select() {
      this.selectUsed = true;
      return this;
    }

    eq(column, value) {
      this.filters.push([column, value]);
      return this;
    }

    order(column, options = {}) {
      this.orderBy = { column, ascending: options.ascending !== false };
      return this;
    }

    insert(values) {
      this.operation = "insert";
      this.values = values;
      return this;
    }

    update(values) {
      this.operation = "update";
      this.values = values;
      return this;
    }

    upsert(values) {
      this.operation = "upsert";
      this.values = values;
      return this;
    }

    maybeSingle() {
      return Promise.resolve(this.#executeSingle());
    }

    single() {
      return Promise.resolve(this.#executeSingle());
    }

    then(resolve, reject) {
      return Promise.resolve(this.#execute()).then(resolve, reject);
    }

    #rows() {
      return state[this.table];
    }

    #matches(row) {
      return this.filters.every(([column, value]) => row[column] === value);
    }

    #sorted(rows) {
      if (!this.orderBy) {
        return rows;
      }

      const direction = this.orderBy.ascending ? 1 : -1;
      return [...rows].sort((left, right) => {
        const leftValue = left[this.orderBy.column];
        const rightValue = right[this.orderBy.column];
        return String(leftValue || "").localeCompare(String(rightValue || "")) * direction;
      });
    }

    #executeSingle() {
      const result = this.#execute();
      const rows = Array.isArray(result.data) ? result.data : [];
      return {
        data: rows[0] ? { ...rows[0] } : null,
        error: result.error || null,
      };
    }

    #execute() {
      if (this.operation === "select") {
        return {
          data: this.#sorted(this.#rows().filter((row) => this.#matches(row))).map((row) => ({ ...row })),
          error: null,
        };
      }

      if (this.operation === "insert") {
        const payload = {
          ...this.values,
        };

        if (this.table === "agent_knowledge_fix_workflows" && !payload.id) {
          knowledgeFixCounter += 1;
          payload.id = `knowledge-fix-${knowledgeFixCounter}`;
        }

        this.#rows().push(payload);
        return {
          data: this.selectUsed ? [{ ...payload }] : null,
          error: null,
        };
      }

      if (this.operation === "update") {
        const matches = this.#rows().filter((row) => this.#matches(row));
        matches.forEach((row) => Object.assign(row, this.values));
        return {
          data: this.selectUsed ? matches.map((row) => ({ ...row })) : null,
          error: null,
        };
      }

      if (this.operation === "upsert") {
        const rows = this.#rows();
        const conflictRow = this.table === "agent_action_queue_statuses"
          ? rows.find((row) => row.agent_id === this.values.agent_id && row.action_key === this.values.action_key)
          : rows.find((row) => row.id === this.values.id);

        if (conflictRow) {
          Object.assign(conflictRow, this.values);
        } else {
          rows.push({ ...this.values });
        }

        const persisted = this.table === "agent_action_queue_statuses"
          ? rows.find((row) => row.agent_id === this.values.agent_id && row.action_key === this.values.action_key)
          : rows.find((row) => row.id === this.values.id);

        return {
          data: this.selectUsed && persisted ? [{ ...persisted }] : null,
          error: null,
        };
      }

      throw new Error(`Unsupported operation: ${this.operation}`);
    }
  }

  return {
    from(table) {
      return new QueryBuilder(table);
    },
    state,
  };
}

function buildQueueItem(overrides = {}) {
  return {
    key: "conversation-1",
    actionType: "unanswered_question",
    question: "What are your opening hours on Saturday?",
    reply: "",
    snippet: "Visitor asked: What are your opening hours on Saturday?",
    whyFlagged: "Flagged because the conversation did not receive a clear answer yet.",
    label: "Unresolved conversation",
    intent: "general",
    lastSeenAt: "2026-04-01T10:00:00.000Z",
    messageId: "message-1",
    ...overrides,
  };
}

test("syncKnowledgeFixWorkflows creates a deterministic draft for unanswered questions", async () => {
  const { state, ...supabase } = createSupabaseStub();

  const result = await syncKnowledgeFixWorkflows(supabase, {
    agentId: "agent-1",
    ownerUserId: "owner-1",
    queueItems: [buildQueueItem()],
    agentProfile: {
      systemPrompt: "Stay grounded in the website.",
      websiteUrl: "https://example.com",
      knowledge: { state: "ready" },
    },
    websiteContent: {
      content: "Title: Example\nBody:\nContact us for details.",
    },
  });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].status, "draft");
  assert.equal(result.records[0].targetType, "system_prompt");
  assert.match(result.records[0].issueSummary, /did not deliver a usable answer/i);
  assert.equal(state.agent_action_queue_statuses[0].status, "reviewed");
});

test("syncKnowledgeFixWorkflows dedupes repeated similar gaps and strengthens one record", async () => {
  const { ...supabase } = createSupabaseStub();

  await syncKnowledgeFixWorkflows(supabase, {
    agentId: "agent-1",
    ownerUserId: "owner-1",
    queueItems: [
      buildQueueItem({
        key: "conversation-1",
        actionType: "knowledge_gap",
        reply: "I am not sure.",
        question: "What are your opening hours on Saturday?",
      }),
    ],
    agentProfile: {
      systemPrompt: "",
      websiteUrl: "https://example.com",
      knowledge: { state: "ready" },
    },
    websiteContent: {
      content: "Title: Example\nBody:\nContact us for details.",
    },
  });

  const result = await syncKnowledgeFixWorkflows(supabase, {
    agentId: "agent-1",
    ownerUserId: "owner-1",
    queueItems: [
      buildQueueItem({
        key: "conversation-2",
        actionType: "knowledge_gap",
        reply: "I could not find that on the website.",
        question: "When are you open on Saturday?",
      }),
    ],
    agentProfile: {
      systemPrompt: "",
      websiteUrl: "https://example.com",
      knowledge: { state: "ready" },
    },
    websiteContent: {
      content: "Title: Example\nBody:\nContact us for details.",
    },
  });

  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0].linkedActionKeys.sort(), ["conversation-1", "conversation-2"]);
  assert.equal(result.records[0].occurrenceCount, 2);
});

test("dismissed knowledge fixes preserve history, survive reload, and stay scoped to the right owner", async () => {
  const { ...supabase } = createSupabaseStub();

  const synced = await syncKnowledgeFixWorkflows(supabase, {
    agentId: "agent-1",
    ownerUserId: "owner-1",
    queueItems: [buildQueueItem()],
    agentProfile: {
      systemPrompt: "",
      websiteUrl: "https://example.com",
      knowledge: { state: "limited" },
    },
    websiteContent: {
      content: "Title: Example\nBody:\nContact us for details.",
    },
  });

  const workflow = synced.records[0];
  const dismissed = await updateKnowledgeFixWorkflow(supabase, {
    agentId: "agent-1",
    ownerUserId: "owner-1",
    knowledgeFixId: workflow.id,
    status: "dismissed",
  });

  assert.equal(dismissed.knowledgeFix.status, "dismissed");
  assert.equal(dismissed.queueSync.status, "dismissed");

  const reloaded = await listKnowledgeFixWorkflows(supabase, {
    agentId: "agent-1",
    ownerUserId: "owner-1",
  });
  assert.equal(reloaded.records.length, 1);
  assert.equal(reloaded.records[0].status, "dismissed");

  await assert.rejects(
    () =>
      updateKnowledgeFixWorkflow(supabase, {
        agentId: "agent-1",
        ownerUserId: "owner-2",
        knowledgeFixId: workflow.id,
        status: "draft",
      }),
    /not found/i
  );
});

test("applyKnowledgeFixToSystemPrompt updates one managed block instead of duplicating it", () => {
  const workflow = {
    dedupeKey: "knowledge_gap:hours-saturday",
    topic: "Saturday opening hours",
    proposedGuidance: "Say clearly when the website does not include Saturday opening hours and offer the next best contact path.",
  };

  const first = applyKnowledgeFixToSystemPrompt("Stay grounded in the website.", workflow);
  const second = applyKnowledgeFixToSystemPrompt(first, {
    ...workflow,
    proposedGuidance: "Use the clearest website detail first, then state the missing Saturday-hours detail plainly.",
  });

  assert.match(first, /VONZA_KNOWLEDGE_FIX knowledge_gap:hours-saturday/);
  assert.equal((second.match(/VONZA_KNOWLEDGE_FIX knowledge_gap:hours-saturday/g) || []).length, 1);
  assert.match(second, /Use the clearest website detail first/);
});
