import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const dashboardBundlePath = path.join(repoRoot, "frontend", "dashboard.js");

function createStorageMock() {
  const store = new Map();

  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

function createDashboardHarness({
  search = "?from=app",
  session = {
    access_token: "token-1",
    user: {
      id: "owner-1",
      email: "owner@example.com",
    },
  },
  agents = [],
  getSessionError = null,
  customFetch = null,
  operatorWorkspaceFlag = true,
} = {}) {
  const script = readFileSync(dashboardBundlePath, "utf8");
  const elements = new Map();
  const fetchCalls = [];

  class TestElement {
    constructor(id = "") {
      this.id = id;
      this.dataset = {};
      this.style = {};
      this.hidden = false;
      this.disabled = false;
      this.value = "";
      this.attributes = new Map();
      this.listeners = new Map();
      this._innerHTML = "";
      this._textContent = "";
    }

    get innerHTML() {
      return this._innerHTML;
    }

    set innerHTML(value) {
      this._innerHTML = String(value || "");
      const idMatches = [...this._innerHTML.matchAll(/id="([^"]+)"/g)];

      idMatches.forEach((match) => {
        if (!elements.has(match[1])) {
          elements.set(match[1], new TestElement(match[1]));
        }
      });
    }

    get textContent() {
      return this._textContent;
    }

    set textContent(value) {
      this._textContent = String(value || "");
    }

    addEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }

    removeEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      this.listeners.set(type, handlers.filter((entry) => entry !== handler));
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }
  }

  const document = {
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
  };

  elements.set("dashboard-root", new TestElement("dashboard-root"));
  elements.set("status-banner", new TestElement("status-banner"));
  elements.set("topbar-meta", new TestElement("topbar-meta"));

  const location = {
    origin: "https://vonza-assistant.onrender.com",
    pathname: "/dashboard",
    search,
    href: `https://vonza-assistant.onrender.com/dashboard${search}`,
    reload() {},
  };

  const buildResponse = ({ status = 200, body, text } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    async text() {
      if (text !== undefined) {
        return text;
      }

      return body === undefined ? "" : JSON.stringify(body);
    },
  });

  const fetchImpl = async (input, options = {}) => {
    const resolvedUrl = new URL(String(input), location.origin);
    fetchCalls.push({
      url: resolvedUrl.toString(),
      pathname: resolvedUrl.pathname,
      options,
    });

    if (typeof customFetch === "function") {
      const customResponse = await customFetch({
        url: resolvedUrl.toString(),
        pathname: resolvedUrl.pathname,
        options,
        buildResponse,
      });

      if (customResponse) {
        return customResponse;
      }
    }

    const resolvedAgents = typeof agents === "function" ? agents() : agents;

    if (resolvedUrl.pathname === "/product-events") {
      return buildResponse({ status: 200, body: { ok: true } });
    }

    if (resolvedUrl.pathname === "/agents/list") {
      return buildResponse({
        status: 200,
        body: {
          agents: resolvedAgents,
          bridgeAgent: null,
        },
      });
    }

    if (resolvedUrl.pathname === "/agents/messages") {
      return buildResponse({
        status: 200,
        body: {
          messages: [],
        },
      });
    }

    if (resolvedUrl.pathname === "/agents/action-queue") {
      return buildResponse({
        status: 200,
        body: {
          items: [],
          people: [],
          peopleSummary: {},
          summary: {},
          persistenceAvailable: true,
          migrationRequired: false,
        },
      });
    }

    if (resolvedUrl.pathname === "/agents/operator-workspace") {
      return buildResponse({
        status: 200,
        body: {
          connectedAccounts: [],
          inbox: {
            threads: [],
            attentionCount: 0,
          },
          calendar: {
            events: [],
            suggestedSlots: [],
            dailySummary: "Connect Google Calendar to see your day, open slots, and booking opportunities here.",
            missedBookingOpportunities: [],
          },
          automations: {
            tasks: [],
            campaigns: [],
            followUps: [],
          },
          summary: {},
          capabilities: {
            featureEnabled: true,
            googleAvailable: true,
            googleMissingEnv: [],
            persistenceAvailable: true,
            migrationRequired: false,
            missingTables: [],
            status: "ready",
          },
          alerts: [],
        },
      });
    }

    return buildResponse({ status: 404, body: { error: `Unhandled fetch path: ${resolvedUrl.pathname}` } });
  };

  const storage = createStorageMock();
  const sessionStorage = createStorageMock();
  const window = {
    document,
    location,
    history: {
      replaceState(_state, _title, nextUrl) {
        const parsed = new URL(nextUrl, location.origin);
        location.href = parsed.toString();
        location.search = parsed.search;
      },
    },
    localStorage: storage,
    sessionStorage,
    requestAnimationFrame(callback) {
      callback();
    },
    addEventListener() {},
    setTimeout,
    clearTimeout,
    crypto: {
      randomUUID() {
        return "client-1";
      },
    },
    VONZA_PUBLIC_APP_URL: "https://vonza-assistant.onrender.com",
    VONZA_OPERATOR_WORKSPACE_V1: operatorWorkspaceFlag,
    VONZA_SUPABASE_URL: "https://example.supabase.co",
    VONZA_SUPABASE_ANON_KEY: "anon-key",
    VONZA_DEV_FAKE_BILLING: false,
    supabase: {
      createClient() {
        return {
          auth: {
            async getSession() {
              if (getSessionError) {
                throw getSessionError;
              }

              return { data: { session } };
            },
            async signOut() {
              return { error: null };
            },
            onAuthStateChange() {},
          },
        };
      },
    },
  };

  const context = {
    window,
    document,
    console,
    fetch: fetchImpl,
    FormData: class {
      constructor(form) {
        this.entriesList = Array.isArray(form?.__formDataEntries)
          ? form.__formDataEntries.map(([key, value]) => [key, value])
          : [];
      }

      get(name) {
        const match = this.entriesList.find(([key]) => key === name);
        return match ? match[1] : null;
      }

      has(name) {
        return this.entriesList.some(([key]) => key === name);
      }

      entries() {
        return this.entriesList[Symbol.iterator]();
      }

      [Symbol.iterator]() {
        return this.entries();
      }
    },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    globalThis: null,
  };

  context.globalThis = context;
  window.fetch = fetchImpl;

  vm.runInNewContext(script, context, { filename: "frontend/dashboard.js" });

  return {
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    getRootHtml() {
      return elements.get("dashboard-root")?.innerHTML || "";
    },
    getStatus() {
      return elements.get("status-banner")?.textContent || "";
    },
    getGlobal(name) {
      return context[name];
    },
    fetchCalls,
  };
}

function createActiveAgent(overrides = {}) {
  return {
    id: "agent-1",
    accessStatus: "active",
    name: "Vonza Assistant",
    assistantName: "Vonza Assistant",
    websiteUrl: "https://example.com/",
    publicAgentKey: "agent-key",
    tone: "friendly",
    welcomeMessage: "Welcome",
    installStatus: {
      state: "not_detected",
      label: "Not detected on a live site yet",
    },
    knowledge: {
      state: "ready",
      description: "Knowledge is ready.",
      pageCount: 2,
      contentLength: 1200,
    },
    ...overrides,
  };
}

test("dashboard bundle parses cleanly", () => {
  const bundle = readFileSync(dashboardBundlePath, "utf8");
  assert.doesNotThrow(() => {
    new vm.Script(bundle, { filename: "frontend/dashboard.js" });
  });
});

test("dashboard shows a visible loading state before workspace data resolves", async () => {
  const agent = createActiveAgent();
  let resolveList;
  const listPromise = new Promise((resolve) => {
    resolveList = resolve;
  });

  const harness = createDashboardHarness({
    agents: () => [agent],
    customFetch: async ({ pathname, buildResponse }) => {
      if (pathname === "/agents/list") {
        await listPromise;
        return buildResponse({
          status: 200,
          body: {
            agents: [agent],
            bridgeAgent: null,
          },
        });
      }

      return null;
    },
  });

  assert.match(harness.getRootHtml(), /Loading your Vonza workspace/i);

  resolveList();
  await harness.settle();
});

test("dashboard renders visible shell content when data loads normally", async () => {
  const harness = createDashboardHarness({
    agents: () => [createActiveAgent()],
  });
  await harness.settle();

  assert.match(harness.getRootHtml(), /workspace-shell/);
  assert.match(harness.getRootHtml(), /Vonza Assistant/);
  assert.match(harness.getRootHtml(), /Today/);
  assert.match(harness.getRootHtml(), /Customize/);
  assert.match(harness.getRootHtml(), /Outcomes/);
});

test("auth bootstrap failures render a visible error state instead of a blank shell", async () => {
  const harness = createDashboardHarness({
    getSessionError: new Error("Malformed session payload"),
  });
  await harness.settle();

  assert.match(harness.getRootHtml(), /We couldn&#39;t load your Vonza workspace/);
  assert.match(harness.getRootHtml(), /Try again/);
  assert.match(harness.getStatus(), /Malformed session payload/);
  assert.equal(
    harness.fetchCalls.some((call) => call.pathname === "/agents/list"),
    false
  );
});

test("one failed sub-request keeps the dashboard visible and surfaces an explicit warning", async () => {
  const harness = createDashboardHarness({
    agents: () => [createActiveAgent()],
    customFetch: async ({ pathname, buildResponse }) => {
      if (pathname === "/agents/action-queue") {
        return buildResponse({
          status: 500,
          body: {
            error: "Missing required message persistence schema for 'messages'. Apply the latest database migration before running this build.",
          },
        });
      }

      return null;
    },
  });
  await harness.settle();

  assert.match(harness.getRootHtml(), /workspace-shell/);
  assert.match(harness.getRootHtml(), /Analytics and action queue data are unavailable right now/);
  assert.match(harness.getRootHtml(), /Missing required message persistence schema/);
});

test("operator workspace disabled still keeps the dashboard visible", async () => {
  const harness = createDashboardHarness({
    agents: () => [createActiveAgent()],
    operatorWorkspaceFlag: false,
  });
  await harness.settle();

  assert.match(harness.getRootHtml(), /workspace-shell/);
  assert.match(harness.getRootHtml(), /Today/);
  assert.match(harness.getRootHtml(), /Customize/);
  assert.match(harness.getRootHtml(), /Outcomes/);
  assert.doesNotMatch(harness.getRootHtml(), /data-shell-target="inbox"/);
  assert.doesNotMatch(harness.getRootHtml(), /data-shell-target="calendar"/);
  assert.doesNotMatch(harness.getRootHtml(), /data-shell-target="automations"/);
  assert.doesNotMatch(harness.getRootHtml(), /data-shell-target="contacts"/);
  assert.equal(
    harness.fetchCalls.some((call) => call.pathname === "/agents/operator-workspace"),
    false
  );
});

test("missing Google env shows a visible non-breaking operator fallback state", async () => {
  const harness = createDashboardHarness({
    agents: () => [createActiveAgent()],
    customFetch: async ({ pathname, buildResponse }) => {
      if (pathname === "/agents/operator-workspace") {
        return buildResponse({
          status: 200,
          body: {
            capabilities: {
              featureEnabled: true,
              googleAvailable: false,
              googleMissingEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
              persistenceAvailable: true,
              migrationRequired: false,
              missingTables: [],
              status: "google_unavailable",
            },
            alerts: [
              "Google integration is not configured on this deployment yet. Set the required Google OAuth env vars to unlock Gmail and Calendar connection.",
            ],
          },
        });
      }

      return null;
    },
  });
  await harness.settle();

  assert.match(harness.getRootHtml(), /workspace-shell/);
  assert.match(harness.getRootHtml(), /Google integration is not configured on this deployment yet/i);
});

test("missing operator tables show a visible migration fallback state", async () => {
  const harness = createDashboardHarness({
    agents: () => [createActiveAgent()],
    customFetch: async ({ pathname, buildResponse }) => {
      if (pathname === "/agents/operator-workspace") {
        return buildResponse({
          status: 200,
          body: {
            capabilities: {
              featureEnabled: true,
              googleAvailable: true,
              googleMissingEnv: [],
              persistenceAvailable: false,
              migrationRequired: true,
              missingTables: ["google_connected_accounts", "operator_inbox_threads"],
              status: "migration_required",
            },
            alerts: [
              "Operator workspace tables are missing on this deployment. Run the production deploy workflow so Supabase applies the latest workspace migrations before enabling connected Inbox, Calendar, and Automations. Missing tables: google_connected_accounts, operator_inbox_threads.",
            ],
          },
        });
      }

      return null;
    },
  });
  await harness.settle();

  assert.match(harness.getRootHtml(), /workspace-shell/);
  assert.match(harness.getRootHtml(), /Operator workspace tables are missing on this deployment/i);
});

test("a failed operator workspace sub-request does not blank the dashboard", async () => {
  const harness = createDashboardHarness({
    agents: () => [createActiveAgent()],
    customFetch: async ({ pathname, buildResponse }) => {
      if (pathname === "/agents/operator-workspace") {
        return buildResponse({
          status: 500,
          body: {
            error: "operator workspace fetch failed",
          },
        });
      }

      return null;
    },
  });
  await harness.settle();

  assert.match(harness.getRootHtml(), /workspace-shell/);
  assert.match(harness.getRootHtml(), /Inbox, Calendar, and Automations are temporarily unavailable/i);
});

test("dashboard shows visible empty states when no analytics data exists", async () => {
  const harness = createDashboardHarness({
    agents: () => [createActiveAgent()],
  });
  await harness.settle();

  assert.match(harness.getRootHtml(), /No actionable items yet/);
  assert.match(harness.getRootHtml(), /No real customer question themes yet/);
});

test("tab switching still leaves the selected section rendered as the active view", async () => {
  const agent = createActiveAgent();
  const harness = createDashboardHarness({
    agents: () => [agent],
  });
  await harness.settle();

  harness.getGlobal("setActiveShellSection")("analytics");
  harness.getGlobal("renderReadyState")(agent, [], harness.getGlobal("createEmptyActionQueue")());

  assert.equal(harness.getGlobal("getActiveShellSection")(), "analytics");
  assert.match(
    harness.getRootHtml(),
    /workspace-tab active" type="button" data-shell-target="analytics"/
  );
  assert.match(harness.getRootHtml(), /See what customers are asking/);
});
