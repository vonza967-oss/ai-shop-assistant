import test from "node:test";
import assert from "node:assert/strict";

import { trackWidgetEvent } from "../src/services/analytics/widgetTelemetryService.js";
import { getWidgetBootstrap } from "../src/services/agents/agentService.js";
import {
  buildInstallStatus,
  recordInstallPing,
  verifyAgentInstallation,
} from "../src/services/install/installPresenceService.js";

function createSupabaseStub(initialState = {}) {
  const state = {
    agents: (initialState.agents || []).map((row) => ({ ...row })),
    businesses: (initialState.businesses || []).map((row) => ({ ...row })),
    widget_configs: (initialState.widget_configs || []).map((row) => ({ ...row })),
    agent_installations: (initialState.agent_installations || []).map((row) => ({ ...row })),
    agent_widget_events: (initialState.agent_widget_events || []).map((row) => ({ ...row })),
  };

  class QueryBuilder {
    constructor(table) {
      this.table = table;
      this.operation = "select";
      this.filters = [];
      this.values = null;
      this.selectUsed = false;
      this.limitCount = null;
    }

    select() {
      this.selectUsed = true;
      return this;
    }

    eq(column, value) {
      this.filters.push((row) => row[column] === value);
      return this;
    }

    in(column, values) {
      const lookup = new Set(values);
      this.filters.push((row) => lookup.has(row[column]));
      return this;
    }

    order() {
      return this;
    }

    limit(count) {
      this.limitCount = count;
      return this;
    }

    update(values) {
      this.operation = "update";
      this.values = values;
      return this;
    }

    insert(values) {
      this.operation = "insert";
      this.values = values;
      return Promise.resolve(this.#execute());
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
      let rows = this.#getRows().filter((row) => this.filters.every((filter) => filter(row)));
      if (this.limitCount !== null) {
        rows = rows.slice(0, this.limitCount);
      }
      return rows;
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

      if (this.operation === "insert") {
        const values = Array.isArray(this.values) ? this.values : [this.values];
        const rows = this.#getRows();

        if (this.table === "agent_widget_events") {
          const duplicate = values.find((value) => rows.some((row) => row.dedupe_key === value.dedupe_key));
          if (duplicate) {
            return {
              data: null,
              error: {
                code: "23505",
                message: "duplicate key value violates unique constraint",
              },
            };
          }
        }

        values.forEach((value, index) => {
          rows.push({
            id: value.id || `${this.table}-${rows.length + index + 1}`,
            ...value,
          });
        });

        return {
          data: values.map((value) => ({ ...value })),
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

function createInstallState() {
  return createSupabaseStub({
    agents: [
      {
        id: "agent-1",
        business_id: "business-1",
        public_agent_key: "agent-key",
        name: "Vonza",
        is_active: true,
      },
    ],
    businesses: [
      {
        id: "business-1",
        name: "Example Co",
        website_url: "https://example.com",
      },
    ],
    widget_configs: [
      {
        id: "widget-1",
        agent_id: "agent-1",
        assistant_name: "Vonza",
        welcome_message: "Welcome",
        button_label: "Chat",
        primary_color: "#10a37f",
        secondary_color: "#0c7f75",
        launcher_text: "Chat",
        theme_mode: "dark",
        install_id: "11111111-1111-1111-1111-111111111111",
        allowed_domains: ["example.com"],
      },
    ],
  });
}

test("widget bootstrap only initializes on allowed domains", async () => {
  const supabase = createInstallState();

  const allowed = await getWidgetBootstrap(supabase, {
    installId: "11111111-1111-1111-1111-111111111111",
    origin: "https://www.example.com",
    pageUrl: "https://www.example.com/pricing",
  });

  assert.equal(allowed.install.installId, "11111111-1111-1111-1111-111111111111");
  assert.equal(allowed.agent.publicAgentKey, "agent-key");

  await assert.rejects(
    () =>
      getWidgetBootstrap(supabase, {
        installId: "11111111-1111-1111-1111-111111111111",
        origin: "https://bad.example.net",
        pageUrl: "https://bad.example.net",
      }),
    (error) => error.statusCode === 403
  );
});

test("install ping sets last seen state and fields", async () => {
  const supabase = createInstallState();

  const result = await recordInstallPing(supabase, {
    installId: "11111111-1111-1111-1111-111111111111",
    origin: "https://www.example.com",
    pageUrl: "https://www.example.com/products",
    sessionId: "session-1",
    fingerprint: "fp-1",
  });

  assert.equal(result.ok, true);
  assert.equal(supabase.state.agent_installations.length, 1);
  assert.equal(supabase.state.agent_installations[0].host, "example.com");
  assert.equal(supabase.state.agent_installations[0].page_url, "https://www.example.com/products");
  assert.equal(supabase.state.agent_installations[0].last_session_id, "session-1");
  assert.equal(supabase.state.agent_installations[0].last_fingerprint, "fp-1");

  const status = buildInstallStatus(
    supabase.state.agent_installations,
    supabase.state.widget_configs[0],
    "https://example.com"
  );

  assert.equal(status.state, "seen_recently");
  assert.equal(status.host, "example.com");
  assert.equal(status.lastSeenUrl, "https://www.example.com/products");
});

test("server verification detects snippet presence and mismatch", async () => {
  const foundSupabase = createInstallState();
  const found = await verifyAgentInstallation(foundSupabase, {
    agentId: "agent-1",
    fetchImpl: async () => ({
      status: 200,
      url: "https://example.com",
      async text() {
        return '<html><head><script async defer src="https://vonza.app/embed.js" data-install-id="11111111-1111-1111-1111-111111111111"></script></head></html>';
      },
    }),
  });

  assert.equal(found.status, "found");
  assert.equal(found.matchedInstallId, true);
  assert.equal(foundSupabase.state.widget_configs[0].last_verification_status, "found");

  const mismatchSupabase = createInstallState();
  const mismatch = await verifyAgentInstallation(mismatchSupabase, {
    agentId: "agent-1",
    fetchImpl: async () => ({
      status: 200,
      url: "https://example.com",
      async text() {
        return '<html><head><script async defer src="https://vonza.app/embed.js" data-install-id="22222222-2222-2222-2222-222222222222"></script></head></html>';
      },
    }),
  });

  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.matchedInstallId, false);
  assert.deepEqual(mismatch.foundInstallIds, ["22222222-2222-2222-2222-222222222222"]);
});

test("install status maps backend verification states", async () => {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  assert.equal(
    buildInstallStatus(
      [],
      {
        install_id: "install-1",
        allowed_domains: ["example.com"],
        last_verification_status: "found",
        last_verified_at: now,
        last_verification_details: { matchedInstallId: true },
      },
      "https://example.com"
    ).state,
    "installed_unseen"
  );

  assert.equal(
    buildInstallStatus(
      [{ host: "example.com", page_url: "https://example.com", first_seen_at: stale, last_seen_at: stale }],
      {
        install_id: "install-1",
        allowed_domains: ["example.com"],
      },
      "https://example.com"
    ).state,
    "seen_stale"
  );

  assert.equal(
    buildInstallStatus(
      [],
      {
        install_id: "install-1",
        allowed_domains: ["example.com"],
        last_verification_status: "mismatch",
        last_verification_details: { matchedInstallId: false },
      },
      "https://example.com"
    ).state,
    "domain_mismatch"
  );

  assert.equal(
    buildInstallStatus(
      [],
      {
        install_id: "install-1",
        allowed_domains: ["example.com"],
        last_verification_status: "not_found",
      },
      "https://example.com"
    ).state,
    "verify_failed"
  );
});

test("widget telemetry accepts valid events and deduplicates duplicates", async () => {
  const supabase = createInstallState();

  const first = await trackWidgetEvent(supabase, {
    installId: "11111111-1111-1111-1111-111111111111",
    eventName: "conversation_started",
    sessionId: "session-1",
    origin: "https://example.com",
    pageUrl: "https://example.com",
    dedupeKey: "conversation-started-1",
  });
  const duplicate = await trackWidgetEvent(supabase, {
    installId: "11111111-1111-1111-1111-111111111111",
    eventName: "conversation_started",
    sessionId: "session-1",
    origin: "https://example.com",
    pageUrl: "https://example.com",
    dedupeKey: "conversation-started-1",
  });

  assert.equal(first.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(supabase.state.agent_widget_events.length, 1);
});
