import test from "node:test";
import assert from "node:assert/strict";

import { updateAgentSettings } from "../src/services/agents/agentService.js";

function createSupabaseStub(initialState) {
  const state = {
    agents: (initialState.agents || []).map((row) => ({ ...row })),
    businesses: (initialState.businesses || []).map((row) => ({ ...row })),
    widget_configs: (initialState.widget_configs || []).map((row) => ({ ...row })),
  };

  class QueryBuilder {
    constructor(table) {
      this.table = table;
      this.operation = "select";
      this.filters = [];
      this.values = null;
      this.selectUsed = false;
    }

    select() {
      this.selectUsed = true;
      return this;
    }

    eq(column, value) {
      this.filters.push([column, value]);
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

    #getRows() {
      return state[this.table];
    }

    #getMatches() {
      return this.#getRows().filter((row) =>
        this.filters.every(([column, value]) => row[column] === value)
      );
    }

    #executeSingle() {
      if (this.operation !== "select") {
        const result = this.#execute();
        const rows = Array.isArray(result.data) ? result.data : [];
        return {
          data: rows[0] ? { ...rows[0] } : null,
          error: result.error || null,
        };
      }

      const matches = this.#getMatches();
      return {
        data: matches[0] ? { ...matches[0] } : null,
        error: null,
      };
    }

    #execute() {
      if (this.operation === "select") {
        return {
          data: this.#getMatches().map((row) => ({ ...row })),
          error: null,
        };
      }

      if (this.operation === "update") {
        const matches = this.#getMatches();
        matches.forEach((row) => Object.assign(row, this.values));
        return this.selectUsed
          ? { data: matches.map((row) => ({ ...row })), error: null }
          : { error: null };
      }

      if (this.operation === "upsert") {
        const rows = this.#getRows();
        const conflictColumn = this.table === "widget_configs" ? "agent_id" : "id";
        const existingRow = rows.find((row) => row[conflictColumn] === this.values[conflictColumn]);

        if (existingRow) {
          Object.assign(existingRow, this.values);
        } else {
          rows.push({ ...this.values });
        }

        const persistedRow =
          rows.find((row) => row[conflictColumn] === this.values[conflictColumn]) || null;

        return this.selectUsed
          ? { data: persistedRow ? [{ ...persistedRow }] : [], error: null }
          : { error: null };
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

test("updateAgentSettings normalizes website URLs and reuses an existing business row", async () => {
  const { state, ...supabase } = createSupabaseStub({
    agents: [
      {
        id: "agent-1",
        business_id: "business-1",
        client_id: "client-1",
        owner_user_id: "owner-1",
        access_status: "active",
        public_agent_key: "agent-key",
        name: "Vonza",
        purpose: "help",
        system_prompt: "old guidance",
        tone: "friendly",
        language: "English",
        is_active: true,
      },
    ],
    businesses: [
      {
        id: "business-1",
        name: "Old Business",
        website_url: "https://old-example.com",
      },
      {
        id: "business-2",
        name: "New Business",
        website_url: "https://new-example.com",
      },
    ],
    widget_configs: [
      {
        id: "widget-1",
        agent_id: "agent-1",
        assistant_name: "Vonza",
        welcome_message: "Hello there",
        button_label: "Chat now",
        primary_color: "#14b8a6",
        secondary_color: "#0f766e",
        launcher_text: "Chat now",
        theme_mode: "light",
      },
    ],
  });

  const result = await updateAgentSettings(supabase, {
    agentId: "agent-1",
    assistantName: "Vonza Pro",
    tone: "professional",
    buttonLabel: "Ask Vonza",
    websiteUrl: "new-example.com/",
    welcomeMessage: "Welcome to Vonza",
    systemPrompt: "Keep answers concise",
    primaryColor: "#111111",
    secondaryColor: "#222222",
  });

  assert.equal(result.assistantName, "Vonza Pro");
  assert.equal(result.tone, "professional");
  assert.equal(result.buttonLabel, "Ask Vonza");
  assert.equal(result.websiteUrl, "https://new-example.com/");
  assert.equal(result.welcomeMessage, "Welcome to Vonza");
  assert.equal(result.primaryColor, "#111111");
  assert.equal(result.secondaryColor, "#222222");
  assert.equal(result.systemPrompt, "Keep answers concise");
  assert.equal(state.agents[0].business_id, "business-2");
  assert.equal(state.businesses[0].website_url, "https://old-example.com");
  assert.equal(state.widget_configs[0].assistant_name, "Vonza Pro");
  assert.equal(state.widget_configs[0].button_label, "Ask Vonza");
});

test("updateAgentSettings persists a website-only change without disturbing other customize fields", async () => {
  const { state, ...supabase } = createSupabaseStub({
    agents: [
      {
        id: "agent-1",
        business_id: "business-1",
        client_id: "client-1",
        owner_user_id: "owner-1",
        access_status: "active",
        public_agent_key: "agent-key",
        name: "Vonza",
        purpose: "help",
        system_prompt: "stay helpful",
        tone: "friendly",
        language: "English",
        is_active: true,
      },
    ],
    businesses: [
      {
        id: "business-1",
        name: "Vonza",
        website_url: "https://old-example.com",
      },
    ],
    widget_configs: [
      {
        id: "widget-1",
        agent_id: "agent-1",
        assistant_name: "Vonza",
        welcome_message: "Hello there",
        button_label: "Chat now",
        primary_color: "#14b8a6",
        secondary_color: "#0f766e",
        launcher_text: "Chat now",
        theme_mode: "light",
      },
    ],
  });

  const result = await updateAgentSettings(supabase, {
    agentId: "agent-1",
    websiteUrl: "https://new-example.com",
  });

  assert.equal(result.websiteUrl, "https://new-example.com/");
  assert.equal(result.assistantName, "Vonza");
  assert.equal(result.tone, "friendly");
  assert.equal(result.buttonLabel, "Chat now");
  assert.equal(result.welcomeMessage, "Hello there");
  assert.equal(result.primaryColor, "#14b8a6");
  assert.equal(result.secondaryColor, "#0f766e");
  assert.equal(state.businesses[0].website_url, "https://new-example.com/");
});

test("updateAgentSettings keeps a stable install id while refreshing allowed domains", async () => {
  const { state, ...supabase } = createSupabaseStub({
    agents: [
      {
        id: "agent-1",
        business_id: "business-1",
        client_id: "client-1",
        owner_user_id: "owner-1",
        access_status: "active",
        public_agent_key: "agent-key",
        name: "Vonza",
        purpose: "help",
        system_prompt: "stay helpful",
        tone: "friendly",
        language: "English",
        is_active: true,
      },
    ],
    businesses: [
      {
        id: "business-1",
        name: "Example",
        website_url: "https://example.com",
      },
    ],
    widget_configs: [
      {
        id: "widget-1",
        agent_id: "agent-1",
        assistant_name: "Vonza",
        welcome_message: "Hello there",
        button_label: "Chat now",
        primary_color: "#14b8a6",
        secondary_color: "#0f766e",
        launcher_text: "Chat now",
        theme_mode: "light",
        install_id: "11111111-1111-1111-1111-111111111111",
        allowed_domains: ["example.com"],
      },
    ],
  });

  const result = await updateAgentSettings(supabase, {
    agentId: "agent-1",
    allowedDomains: "example.com\nshop.example.com",
  });

  assert.equal(result.installId, "11111111-1111-1111-1111-111111111111");
  assert.deepEqual(result.allowedDomains, ["example.com", "shop.example.com"]);
  assert.deepEqual(state.widget_configs[0].allowed_domains, ["example.com", "shop.example.com"]);
});

test("updateAgentSettings keeps unchanged values persisted and rejects invalid website URLs", async () => {
  const { state, ...supabase } = createSupabaseStub({
    agents: [
      {
        id: "agent-1",
        business_id: "business-1",
        client_id: "client-1",
        owner_user_id: "owner-1",
        access_status: "active",
        public_agent_key: "agent-key",
        name: "Vonza",
        purpose: "help",
        system_prompt: "old guidance",
        tone: "friendly",
        language: "English",
        is_active: true,
      },
    ],
    businesses: [
      {
        id: "business-1",
        name: "Old Business",
        website_url: "https://example.com",
      },
    ],
    widget_configs: [
      {
        id: "widget-1",
        agent_id: "agent-1",
        assistant_name: "Vonza",
        welcome_message: "Hello there",
        button_label: "Chat now",
        primary_color: "#14b8a6",
        secondary_color: "#0f766e",
        launcher_text: "Chat now",
        theme_mode: "light",
      },
    ],
  });

  const unchangedResult = await updateAgentSettings(supabase, {
    agentId: "agent-1",
    assistantName: "Vonza",
    tone: "friendly",
    buttonLabel: "Chat now",
    websiteUrl: "https://example.com",
    welcomeMessage: "Hello there",
    systemPrompt: "old guidance",
    primaryColor: "#14b8a6",
    secondaryColor: "#0f766e",
  });

  assert.equal(unchangedResult.websiteUrl, "https://example.com/");
  assert.equal(state.agents[0].business_id, "business-1");
  assert.equal(state.widget_configs[0].assistant_name, "Vonza");

  await assert.rejects(
    () =>
      updateAgentSettings(supabase, {
        agentId: "agent-1",
        websiteUrl: "notaurl",
      }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /valid public https URL/i);
      return true;
    }
  );
});
