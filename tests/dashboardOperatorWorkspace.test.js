import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function createFakeElement(id) {
  return {
    id,
    hidden: false,
    textContent: "",
    innerHTML: "",
    value: "",
    dataset: {},
    style: {},
    className: "",
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    focus() {},
    reset() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    matches() {
      return false;
    },
  };
}

function createDashboardHarness({ windowFlags = {}, fetchImpl } = {}) {
  const script = readFileSync(path.join(repoRoot, "frontend", "dashboard.js"), "utf8")
    .replace(/\nboot\(\);\s*$/, "\n");
  const storage = new Map();
  const elements = new Map();
  const document = {
    body: createFakeElement("body"),
    documentElement: createFakeElement("documentElement"),
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, createFakeElement(id));
      }
      return elements.get(id);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    createElement(tagName) {
      return createFakeElement(tagName);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const window = {
    ...windowFlags,
    document,
    location: {
      origin: "http://127.0.0.1:3000",
      href: "http://127.0.0.1:3000/dashboard",
      search: "",
      pathname: "/dashboard",
    },
    history: {
      replaceState() {},
      pushState() {},
    },
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    crypto: {
      randomUUID() {
        return "client-test-id";
      },
    },
    navigator: {
      clipboard: {
        async writeText() {},
      },
    },
    matchMedia() {
      return {
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      };
    },
    setTimeout,
    clearTimeout,
  };
  const context = {
    window,
    document,
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl || (async () => ({
      ok: true,
      async json() {
        return {};
      },
    })),
    globalThis: null,
  };
  context.globalThis = context;

  vm.runInNewContext(script, context, { filename: "frontend/dashboard.js" });
  return context;
}

test("dashboard flag resolver prefers the canonical browser flag and falls back safely", () => {
  const canonicalHarness = createDashboardHarness({
    windowFlags: {
      VONZA_OPERATOR_WORKSPACE_V1_ENABLED: true,
    },
  });
  assert.equal(canonicalHarness.isOperatorWorkspaceFlagEnabled(), true);

  const legacyHarness = createDashboardHarness({
    windowFlags: {
      VONZA_OPERATOR_WORKSPACE_V1: true,
    },
  });
  assert.equal(legacyHarness.isOperatorWorkspaceFlagEnabled(), true);

  const canonicalOffHarness = createDashboardHarness({
    windowFlags: {
      VONZA_OPERATOR_WORKSPACE_V1_ENABLED: false,
      VONZA_OPERATOR_WORKSPACE_V1: true,
    },
  });
  assert.equal(canonicalOffHarness.isOperatorWorkspaceFlagEnabled(), false);
});

test("dashboard normalizes sparse operator payloads without forcing the legacy shell", async () => {
  const harness = createDashboardHarness({
    windowFlags: {
      VONZA_OPERATOR_WORKSPACE_V1_ENABLED: true,
    },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          enabled: true,
          featureEnabled: true,
          status: {
            enabled: true,
            featureEnabled: true,
            googleConnected: false,
            migrationRequired: true,
          },
          connectedAccounts: null,
          contacts: {
            health: {
              migrationRequired: true,
            },
          },
        };
      },
    }),
  });

  const workspace = await harness.loadOperatorWorkspace("agent-1");

  assert.equal(workspace.enabled, true);
  assert.deepEqual(Array.from(workspace.connectedAccounts), []);
  assert.deepEqual(Array.from(workspace.inbox.threads), []);
  assert.deepEqual(Array.from(workspace.calendar.events), []);
  assert.deepEqual(Array.from(workspace.automations.tasks), []);
  assert.deepEqual(Array.from(workspace.contacts.list), []);
  assert.deepEqual(
    Array.from(harness.getAvailableShellSections(workspace)),
    ["overview", "contacts", "inbox", "calendar", "automations", "customize", "analytics"]
  );

  assert.match(harness.buildInboxPanel({}, workspace), /Connect Google to unlock Inbox/);
  assert.match(harness.buildCalendarPanel({}, workspace), /Connect Google to unlock Calendar/);
  assert.match(harness.buildAutomationsPanel({}, workspace), /Approval-first automations start after connection/);
});

test("dashboard renders inbox threads safely when thread messages are missing", async () => {
  const harness = createDashboardHarness({
    windowFlags: {
      VONZA_OPERATOR_WORKSPACE_V1_ENABLED: true,
    },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          enabled: true,
          featureEnabled: true,
          status: {
            enabled: true,
            featureEnabled: true,
            googleConnected: true,
          },
          activation: {
            inboxSynced: true,
          },
          connectedAccounts: [
            {
              status: "connected",
              accountEmail: "owner@example.com",
            },
          ],
          inbox: {
            threads: [
              {
                id: "thread-1",
                subject: "Need help",
              },
            ],
          },
        };
      },
    }),
  });

  const workspace = await harness.loadOperatorWorkspace("agent-1");
  const markup = harness.buildInboxPanel({}, workspace);

  assert.equal(Array.isArray(workspace.inbox.threads[0].messages), true);
  assert.match(markup, /Need help/);
});

test("dashboard keeps the legacy shell only when the operator flag is off", async () => {
  let fetchCalls = 0;
  const harness = createDashboardHarness({
    windowFlags: {
      VONZA_OPERATOR_WORKSPACE_V1_ENABLED: false,
      VONZA_OPERATOR_WORKSPACE_V1: true,
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        async json() {
          return {};
        },
      };
    },
  });

  const workspace = await harness.loadOperatorWorkspace("agent-1");

  assert.equal(fetchCalls, 0);
  assert.equal(workspace.enabled, false);
  assert.deepEqual(
    Array.from(harness.getAvailableShellSections(workspace)),
    ["overview", "customize", "analytics"]
  );
});
