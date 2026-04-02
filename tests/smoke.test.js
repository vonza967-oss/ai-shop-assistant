import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import cors from "cors";
import express from "express";

import { createPublicRouter } from "../src/routes/publicRoutes.js";
import { createAgentRouter } from "../src/routes/agentRoutes.js";
import { createBusinessRouter } from "../src/routes/businessRoutes.js";
import {
  getPaidOwnerIdFromCheckoutSession,
  verifySuccessfulCheckout,
} from "../src/services/billing/checkoutService.js";
import {
  buildActionQueue,
  updateActionQueueStatus,
} from "../src/services/analytics/actionQueueService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const dashboardBundlePath = path.join(repoRoot, "frontend", "dashboard.js");

function withEnv(overrides, fn) {
  const previous = new Map();

  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

function createTestApp(agentDeps = {}) {
  const app = express();
  app.use(cors());
  app.use("/stripe/webhook", express.raw({ type: "application/json" }));
  app.use(express.json());
  app.use(express.static(path.join(repoRoot, "frontend")));
  app.use(createPublicRouter({ rootDir: repoRoot }));
  app.use(createAgentRouter(agentDeps));
  app.use(createBusinessRouter());
  return app;
}

function createFakeElement(id, options = {}) {
  const attributes = new Map(Object.entries(options.attributes || {}));

  return {
    id,
    hidden: false,
    textContent: options.textContent || "",
    dataset: {},
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
  };
}

function createMarketingHarness(options = {}) {
  const script = readFileSync(path.join(repoRoot, "frontend", "marketing.js"), "utf8");
  const storedSession = options.storedSession || null;
  const session = options.session === undefined ? storedSession : options.session;
  const storage = new Map();
  const authLink = createFakeElement("site-auth-link", {
    textContent: "Sign in",
    attributes: {
      href: "/dashboard?from=site",
      "data-app-link": "",
    },
  });
  const primaryCta = createFakeElement("site-primary-cta", {
    textContent: "Get started",
    attributes: {
      href: "/dashboard?from=site",
      "data-app-link": "",
    },
  });
  const footerAppLink = createFakeElement("footer-app-link", {
    textContent: "App",
    attributes: {
      href: "/dashboard?from=site",
      "data-app-link": "",
    },
  });
  let authChangeHandler = null;

  if (storedSession) {
    storage.set("sb-example-auth-token", JSON.stringify(storedSession));
  }

  const document = {
    getElementById(id) {
      if (id === "site-auth-link") return authLink;
      if (id === "site-primary-cta") return primaryCta;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-app-link]") {
        return [authLink, primaryCta, footerAppLink];
      }
      return [];
    },
  };

  const window = {
    VONZA_SUPABASE_URL: "https://example.supabase.co",
    VONZA_SUPABASE_ANON_KEY: "anon-key",
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
    supabase: {
      createClient() {
        return {
          auth: {
            async getSession() {
              return { data: { session } };
            },
            onAuthStateChange(callback) {
              authChangeHandler = callback;
              return {
                data: {
                  subscription: {
                    unsubscribe() {},
                  },
                },
              };
            },
          },
        };
      },
    },
  };

  const context = {
    window,
    document,
    console,
    URL,
    globalThis: null,
  };
  context.globalThis = context;

  vm.runInNewContext(script, context, { filename: "frontend/marketing.js" });

  return {
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    authLink,
    primaryCta,
    footerAppLink,
    triggerAuthChange(event, nextSession) {
      authChangeHandler?.(event, nextSession);
    },
  };
}

async function withMutedConsoleError(fn) {
  const original = console.error;
  console.error = () => {};

  try {
    return await fn();
  } finally {
    console.error = original;
  }
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

async function getText(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return {
    status: response.status,
    text: await response.text(),
    headers: response.headers,
  };
}

async function getJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let json = null;

  if (text) {
    json = JSON.parse(text);
  }

  return {
    status: response.status,
    json,
    text,
  };
}

async function requestWithHost(baseUrl, pathname, { method = "GET", host, headers = {}, body } = {}) {
  const url = new URL(pathname, baseUrl);
  const payload = body ? (typeof body === "string" ? body : JSON.stringify(body)) : null;
  const finalHeaders = { ...headers };

  if (payload && !finalHeaders["Content-Type"]) {
    finalHeaders["Content-Type"] = "application/json";
  }

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          Host: host,
          ...finalHeaders,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            text: data,
            json: data ? JSON.parse(data) : null,
          });
        });
      }
    );

    req.on("error", reject);

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

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
  search = "?from=site",
  session = {
    access_token: "token-1",
    user: {
      id: "owner-1",
      email: "owner@example.com",
    },
  },
  agents = [],
  checkoutResponse = {
    status: 200,
    body: {
      ok: true,
      url: "https://checkout.stripe.test/session",
      session_id: "cs_test_checkout",
    },
  },
  customFetch = null,
} = {}) {
  const script = readFileSync(dashboardBundlePath, "utf8");
  const elements = new Map();
  let assignedUrl = null;
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
      this._innerHTML = "";
      this._textContent = "";
      this.listeners = new Map();
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

    async dispatch(type) {
      const handlers = this.listeners.get(type) || [];

      for (const handler of handlers) {
        await handler({
          type,
          currentTarget: this,
          preventDefault() {},
        });
      }
    }

    async click() {
      await this.dispatch("click");
    }
  }

  class TestFormData {
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
  };

  elements.set("dashboard-root", new TestElement("dashboard-root"));
  elements.set("status-banner", new TestElement("status-banner"));
  elements.set("topbar-meta", new TestElement("topbar-meta"));

  const location = {
    origin: "https://vonza-assistant.onrender.com",
    pathname: "/dashboard",
    search,
    href: `https://vonza-assistant.onrender.com/dashboard${search}`,
    assign(url) {
      assignedUrl = url;
      this.href = String(url || "");
    },
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

    if (resolvedUrl.pathname === "/create-checkout-session") {
      return buildResponse(checkoutResponse);
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
    setTimeout,
    clearTimeout,
    crypto: {
      randomUUID() {
        return "client-1";
      },
    },
    VONZA_PUBLIC_APP_URL: "https://vonza-assistant.onrender.com",
    VONZA_SUPABASE_URL: "https://example.supabase.co",
    VONZA_SUPABASE_ANON_KEY: "anon-key",
    VONZA_DEV_FAKE_BILLING: false,
    supabase: {
      createClient() {
        return {
          auth: {
            async getSession() {
              return { data: { session } };
            },
            async signOut() {
              return { error: null };
            },
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
    FormData: TestFormData,
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
    getElement(id) {
      return elements.get(id) || null;
    },
    getStatus() {
      return elements.get("status-banner")?.textContent || "";
    },
    getAssignedUrl() {
      return assignedUrl;
    },
    getGlobal(name) {
      return context[name];
    },
    fetchCalls,
  };
}

function createAgentTestDeps(state) {
  if (!state.actionQueueStatuses) {
    state.actionQueueStatuses = new Map();
  }

  return {
    getSupabaseClient: () => ({ test: true }),
    getAuthenticatedUser: async () => ({
      id: "owner-1",
      email: "owner@example.com",
    }),
    createAgentForBusinessName: async (_supabase, businessName, websiteUrl, clientId, ownerUserId) => {
      assert.equal(ownerUserId, "owner-1", "owner context should flow into createAgentForBusinessName");
      state.hasAgent = true;
      state.businessName = businessName;
      return {
        business: {
          id: "business-1",
          name: businessName,
          website_url: websiteUrl,
        },
        agent: {
          id: "agent-1",
          businessId: "business-1",
          clientId: clientId || "client-1",
          ownerUserId,
          accessStatus: state.accessStatus,
          publicAgentKey: "agent-key",
          name: businessName,
        },
      };
    },
    listAgents: async (_supabase, options) => {
      assert.equal(options.ownerUserId, "owner-1", "owner context should flow into listAgents");
      if (state.hasAgent === false) {
        return {
          agents: [],
          bridgeAgent: null,
        };
      }

      return {
        agents: [
          {
            id: "agent-1",
            name: "Vonza Assistant",
            assistantName: "Vonza Assistant",
            websiteUrl: "https://example.com",
            accessStatus: state.accessStatus,
          },
        ],
        bridgeAgent: null,
      };
    },
    requireActiveAgentAccess: async (_supabase, options) => {
      assert.equal(options.ownerUserId, "owner-1", "active-access checks should run in owner context");
      if (state.accessStatus !== "active") {
        const error = new Error("Forbidden");
        error.statusCode = 403;
        throw error;
      }

      return {
        id: options.agentId || "agent-1",
        accessStatus: state.accessStatus,
      };
    },
    requireAgentAccess: async (_supabase, options) => {
      if (options.clientId && options.clientId === "client-1") {
        return {
          id: options.agentId || "agent-1",
          accessStatus: state.accessStatus,
        };
      }

      const error = new Error("Forbidden");
      error.statusCode = 403;
      throw error;
    },
    listAgentMessages: async () =>
      state.messages || [
        {
          id: "message-1",
          role: "user",
          content: "Do you offer pricing?",
          createdAt: "2026-04-01T10:00:00.000Z",
        },
      ],
    listActionQueueStatuses: async () =>
      ({
        records: [...state.actionQueueStatuses.entries()].map(([actionKey, item]) => ({
          agentId: "agent-1",
          ownerUserId: "owner-1",
          actionKey,
          ...item,
        })),
        persistenceAvailable: true,
      }),
    updateActionQueueStatus: async (
      _supabase,
      { agentId, ownerUserId, actionKey, status, note, outcome, nextStep, followUpNeeded, followUpCompleted, contactStatus }
    ) => {
      const previous = state.actionQueueStatuses.get(actionKey) || {};
      const nextItem = {
        ...previous,
        status: status ?? previous.status ?? "new",
        note: note ?? previous.note ?? "",
        outcome: outcome ?? previous.outcome ?? "",
        nextStep: nextStep ?? previous.nextStep ?? "",
        followUpNeeded: followUpNeeded ?? previous.followUpNeeded ?? null,
        followUpCompleted: followUpCompleted ?? previous.followUpCompleted ?? null,
        contactStatus: contactStatus ?? previous.contactStatus ?? "",
      };
      state.actionQueueStatuses.set(actionKey, nextItem);
      return {
        item: {
          agentId,
          ownerUserId,
          actionKey,
          ...nextItem,
          updatedAt: new Date().toISOString(),
        },
        persistenceAvailable: true,
      };
    },
    updateOwnedAccessStatus: async (_supabase, { ownerUserId, accessStatus }) => {
      assert.equal(ownerUserId, "owner-1", "simulate unlock should target the authenticated owner");
      state.accessStatus = accessStatus;
      return { ok: true };
    },
    updateAgentSettings: async (_supabase, payload) => ({
      id: payload.agentId,
      assistantName: payload.assistantName,
      updated: true,
    }),
    deleteAgent: async (_supabase, agentId) => ({
      ok: true,
      agentId,
    }),
    resolveAgentContext: async () => ({
      agent: {
        id: "agent-1",
      },
      business: {
        id: "business-1",
        website_url: "https://example.com",
      },
    }),
    extractBusinessWebsiteContent: async () => ({
      ok: true,
      pageCount: 1,
      content: "Imported website content",
    }),
    importBusinessWebsiteKnowledge: async (_supabase, options) => ({
      ok: true,
      businessId: options.businessId || "business-1",
      websiteUrl: options.websiteUrl || "https://example.com",
      pageCount: 1,
      content: "Imported website content",
      knowledge: {
        state: "ready",
        description: "Your assistant has website knowledge and is ready to answer real customer questions.",
        pageCount: 1,
        contentLength: "Imported website content".length,
        importedWebsiteUrl: options.websiteUrl || "https://example.com",
        updatedAt: new Date().toISOString(),
      },
      import: {
        status: "success",
        lastImportedUrl: options.websiteUrl || "https://example.com",
        lastImportedAt: new Date().toISOString(),
      },
    }),
    createHostedCheckoutSession: async ({ user, email }) => ({
      id: "cs_test_checkout",
      url: `https://checkout.stripe.test/session?owner=${encodeURIComponent(user.id)}&email=${encodeURIComponent(email || user.email || "")}`,
    }),
  };
}

function createUnauthedBridgeDeps(state) {
  return {
    ...createAgentTestDeps(state),
    getAuthenticatedUser: async () => {
      const error = new Error("Unauthorized");
      error.statusCode = 401;
      throw error;
    },
  };
}

async function runStartupSmoke() {
  return await new Promise((resolve, reject) => {
    const child = spawn("node", ["index.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: "0",
        PUBLIC_APP_URL: "",
        SUPABASE_URL: "",
        SUPABASE_ANON_KEY: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
        OPENAI_API_KEY: "",
        ADMIN_TOKEN: "",
        STRIPE_SECRET_KEY: "",
        STRIPE_PRICE_ID: "",
        STRIPE_WEBHOOK_SECRET: "",
        DEV_FAKE_BILLING: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      if (error) {
        reject(error);
      } else {
        resolve(output);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for app startup.\n${output}`));
    }, 10000);

    const onChunk = (chunk) => {
      output += chunk.toString();
      if (output.includes("Server running on")) {
        clearTimeout(timer);
        finish();
      }
    };

    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("error", (error) => {
      clearTimeout(timer);
      finish(error);
    });
    child.on("exit", (code) => {
      if (!settled && code !== 0) {
        clearTimeout(timer);
        finish(new Error(`Startup process exited early with code ${code}.\n${output}`));
      }
    });
  });
}

test("app boot smoke: startup warnings appear and the server still starts", { concurrency: false }, async () => {
  const output = await runStartupSmoke();

  assert.match(output, /\[startup\] Missing env:/, "expected missing-env startup warning");
  assert.match(output, /DEV_FAKE_BILLING is enabled/, "expected dev fake billing startup notice");
  assert.match(output, /Server running on/, "expected the app to boot successfully");
});

test("marketing homepage and app routes load without broken handoff paths", { concurrency: false }, async () => {
  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "anon-key-present",
      ADMIN_TOKEN: "admin-1234",
      DEV_FAKE_BILLING: "false",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp());

      try {
        const marketingHome = await getText(server.baseUrl, "/");
        assert.equal(marketingHome.status, 200);
        assert.match(marketingHome.text, /Make your website feel like it already has a smart first salesperson/);
        assert.match(marketingHome.text, /create an account with email and password/i);
        assert.match(marketingHome.text, /href="\/dashboard\?from=site"/);
        assert.match(marketingHome.text, /id="site-auth-link"/);
        assert.match(marketingHome.text, /id="site-primary-cta"/);
        assert.match(marketingHome.text, /data-app-link/);
        assert.match(marketingHome.text, /Vonza workspace/);
        assert.match(marketingHome.text, /see what visitors want and what to improve next/i);
        assert.match(marketingHome.text, /\/marketing\.js/);

        const dashboard = await getText(server.baseUrl, "/dashboard");
        assert.equal(dashboard.status, 200);
        assert.match(dashboard.text, /dashboard-root/);
        assert.match(dashboard.text, /\/public-config\.js/);
        assert.match(dashboard.text, /\/supabase-auth\.js/);
        assert.match(dashboard.text, /\/dashboard\.js/);

        const widget = await getText(server.baseUrl, "/widget");
        assert.equal(widget.status, 200);
        assert.match(widget.text, /chat-container/);
        assert.match(widget.text, /Powered by Vonza AI/);

        const authScript = await getText(server.baseUrl, "/supabase-auth.js");
        assert.equal(authScript.status, 200);

        const dashboardScript = await getText(server.baseUrl, "/dashboard.js");
        assert.equal(dashboardScript.status, 200);

        const marketingScript = await getText(server.baseUrl, "/marketing.js");
        assert.equal(marketingScript.status, 200);

        const adminAllowed = await getText(server.baseUrl, "/admin?token=admin-1234");
        assert.equal(adminAllowed.status, 200);

        const adminBlocked = await getText(server.baseUrl, "/admin?token=wrong-token");
        assert.equal(adminBlocked.status, 403);
      } finally {
        await server.close();
      }
    }
  );
});

test("dashboard bundle exposes password auth entry, purchase-first handoff, and paid workspace tabs", { concurrency: false }, async () => {
  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "anon-key-present",
      DEV_FAKE_BILLING: "false",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp());

      try {
        const dashboardScript = await getText(server.baseUrl, "/dashboard.js");
        assert.equal(dashboardScript.status, 200);
        assert.match(dashboardScript.text, /Create your Vonza account/);
        assert.match(dashboardScript.text, /Sign in to continue into Vonza/);
        assert.match(dashboardScript.text, /Create account/);
        assert.match(dashboardScript.text, /Sign in/);
        assert.match(dashboardScript.text, /Send reset link/);
        assert.match(dashboardScript.text, /Use email link instead/);
        assert.match(dashboardScript.text, /Choose your new password/);
        assert.match(dashboardScript.text, /signInWithPassword/);
        assert.match(dashboardScript.text, /signUp\(/);
        assert.match(dashboardScript.text, /resetPasswordForEmail/);
        assert.match(dashboardScript.text, /updateUser/);
        assert.match(dashboardScript.text, /signInWithOtp/);
        assert.match(dashboardScript.text, /Unlock Vonza to open your setup workspace/);
        assert.match(dashboardScript.text, /Overview/);
        assert.match(dashboardScript.text, /Customize/);
        assert.match(dashboardScript.text, /Analytics/);
        assert.match(dashboardScript.text, /Continue setup/);
        assert.match(dashboardScript.text, /Add to website/);
        assert.match(dashboardScript.text, /High-intent signals/);
        assert.match(dashboardScript.text, /Answers needing work/);
        assert.match(dashboardScript.text, /Top customer questions/);
        assert.match(dashboardScript.text, /Lead \/ contact/);
        assert.match(dashboardScript.text, /Action queue/);
        assert.match(dashboardScript.text, /No actionable items yet/);
        assert.match(dashboardScript.text, /Reviewed/);
        assert.match(dashboardScript.text, /Follow-up needed/);
        assert.match(dashboardScript.text, /Attention now/);
        assert.match(dashboardScript.text, /Resolved items/);
        assert.match(dashboardScript.text, /Returning people/);
        assert.match(dashboardScript.text, /Owner attention now/);
        assert.match(dashboardScript.text, /Owner follow-up state/);
        assert.match(dashboardScript.text, /Conversation summary/);
        assert.match(dashboardScript.text, /Visitor thread/);
        assert.match(dashboardScript.text, /People view/);
        assert.match(dashboardScript.text, /Open owner handoff/);
        assert.match(dashboardScript.text, /Save owner handoff/);
        assert.match(dashboardScript.text, /No weak-answer signal yet/);

        const marketingScript = await getText(server.baseUrl, "/marketing.js");
        assert.equal(marketingScript.status, 200);
        assert.match(marketingScript.text, /My Account/);
        assert.match(marketingScript.text, /\/dashboard/);
        assert.match(marketingScript.text, /auth\.onAuthStateChange/);
      } finally {
        await server.close();
      }
    }
  );
});

test("signed-in unpaid owners see the checkout-focused locked state", { concurrency: false }, async () => {
  const harness = createDashboardHarness();
  await harness.settle();

  assert.match(harness.getRootHtml(), /Unlock Vonza to open your setup workspace/);
  assert.ok(harness.getElement("unlock-vonza-button"));
  assert.ok(harness.getElement("checkout-feedback"));
});

test("clicking Unlock Vonza from the unpaid state creates checkout and redirects", { concurrency: false }, async () => {
  const harness = createDashboardHarness();
  await harness.settle();

  const unlockButton = harness.getElement("unlock-vonza-button");
  assert.ok(unlockButton);

  await unlockButton.click();
  await harness.settle();

  const checkoutCall = harness.fetchCalls.find((call) => call.pathname === "/create-checkout-session");
  assert.ok(checkoutCall);
  assert.equal(checkoutCall.options.method, "POST");
  assert.equal(checkoutCall.options.headers.Authorization, "Bearer token-1");
  assert.match(String(checkoutCall.options.body || ""), /owner@example\.com/);
  assert.equal(harness.getAssignedUrl(), "https://checkout.stripe.test/session");
  assert.equal(harness.getElement("checkout-feedback")?.textContent, "Redirecting you to secure checkout...");
});

test("checkout unlock failures surface a readable inline error instead of a silent no-op", { concurrency: false }, async () => {
  const harness = createDashboardHarness({
    checkoutResponse: {
      status: 502,
      text: "<html><body>Bad gateway</body></html>",
    },
  });
  await harness.settle();

  const unlockButton = harness.getElement("unlock-vonza-button");
  assert.ok(unlockButton);

  await unlockButton.click();
  await harness.settle();

  assert.equal(harness.getAssignedUrl(), null);
  assert.equal(harness.getElement("checkout-feedback")?.dataset.state, "error");
  assert.match(harness.getElement("checkout-feedback")?.textContent || "", /Bad gateway/i);
  assert.doesNotMatch(harness.getElement("checkout-feedback")?.textContent || "", /Unexpected token|JSON/i);
  assert.match(harness.getStatus(), /Bad gateway/i);
});

test("signed-out marketing header keeps the normal CTA", async () => {
  const harness = createMarketingHarness({ storedSession: null, session: null });
  await harness.settle();

  assert.equal(harness.primaryCta.textContent, "Get started");
  assert.equal(harness.primaryCta.getAttribute("href"), "/dashboard?from=site");
  assert.equal(harness.authLink.hidden, false);
  assert.equal(harness.footerAppLink.getAttribute("href"), "/dashboard?from=site");
});

test("signed-in marketing header hydrates My Account immediately from stored auth state", async () => {
  const storedSession = {
    access_token: "token-1",
    refresh_token: "refresh-1",
    user: {
      id: "user-1",
      email: "owner@example.com",
    },
  };
  const harness = createMarketingHarness({ storedSession });
  await harness.settle();

  assert.equal(harness.primaryCta.textContent, "My Account");
  assert.equal(harness.primaryCta.getAttribute("href"), "/dashboard");
  assert.equal(harness.authLink.hidden, true);
  assert.equal(harness.footerAppLink.getAttribute("href"), "/dashboard");
});

test("dashboard save automatically imports website knowledge after a real website URL change", async () => {
  const state = {
    agent: {
      id: "agent-1",
      businessId: "business-1",
      accessStatus: "active",
      name: "Vonza Assistant",
      assistantName: "Vonza Assistant",
      publicAgentKey: "agent-key",
      tone: "friendly",
      systemPrompt: "",
      websiteUrl: "https://old-example.com/",
      welcomeMessage: "Welcome",
      buttonLabel: "Chat",
      primaryColor: "#14b8a6",
      secondaryColor: "#0f766e",
      installStatus: {
        state: "not_detected",
        label: "Not detected on a live site yet",
      },
      knowledge: {
        state: "ready",
        description: "Knowledge is ready.",
        pageCount: 2,
        contentLength: 1200,
        importedWebsiteUrl: "https://old-example.com/",
        updatedAt: "2026-04-01T10:00:00.000Z",
      },
    },
  };
  let importCalls = 0;

  const harness = createDashboardHarness({
    search: "?from=app",
    agents: () => [state.agent],
    customFetch: async ({ pathname, buildResponse }) => {
      if (pathname === "/agents/update") {
        state.agent = {
          ...state.agent,
          businessId: "business-2",
          websiteUrl: "https://new-example.com/",
        };

        return buildResponse({
          status: 200,
          body: {
            ok: true,
            agent: {
              ...state.agent,
              websiteSync: {
                previousUrl: "https://old-example.com/",
                currentUrl: "https://new-example.com/",
                changed: true,
              },
            },
          },
        });
      }

      if (pathname === "/knowledge/import") {
        importCalls += 1;
        state.agent = {
          ...state.agent,
          knowledge: {
            state: "ready",
            description: "Your assistant has website knowledge and is ready to answer real customer questions.",
            pageCount: 4,
            contentLength: 2400,
            importedWebsiteUrl: "https://new-example.com/",
            updatedAt: "2026-04-02T18:00:00.000Z",
          },
        };

        return buildResponse({
          status: 200,
          body: {
            ok: true,
            websiteUrl: "https://new-example.com/",
            pageCount: 4,
            content: "Fresh website content",
            knowledge: {
              state: "ready",
              description: "Your assistant has website knowledge and is ready to answer real customer questions.",
              pageCount: 4,
              contentLength: 2400,
              importedWebsiteUrl: "https://new-example.com/",
              updatedAt: "2026-04-02T18:00:00.000Z",
            },
            import: {
              status: "success",
              lastImportedUrl: "https://new-example.com/",
              lastImportedAt: "2026-04-02T18:00:00.000Z",
            },
          },
        });
      }

      return null;
    },
  });

  await harness.settle();

  const saveAssistant = harness.getGlobal("saveAssistant");
  const submitButton = { disabled: false };
  const saveState = {
    textContent: "",
    className: "",
    removeAttribute() {},
  };
  const form = {
    __formDataEntries: [
      ["assistant_name", "Vonza Assistant"],
      ["tone", "friendly"],
      ["system_prompt", ""],
      ["welcome_message", "Welcome"],
      ["button_label", "Chat"],
      ["website_url", "https://new-example.com"],
      ["primary_color", "#14b8a6"],
      ["secondary_color", "#0f766e"],
    ],
    querySelector(selector) {
      if (selector === 'button[type="submit"]') {
        return submitButton;
      }

      if (selector === "[data-save-state]") {
        return saveState;
      }

      return null;
    },
  };

  await saveAssistant(
    {
      preventDefault() {},
      currentTarget: form,
    },
    state.agent
  );
  await harness.settle();

  assert.equal(importCalls, 1);
  assert.equal(harness.getStatus(), "Website saved and website knowledge is ready.");
  assert.match(harness.getRootHtml(), /https:\/\/new-example\.com\//);
});

test("dashboard save skips redundant website import when the normalized URL does not change", async () => {
  const state = {
    agent: {
      id: "agent-1",
      businessId: "business-1",
      accessStatus: "active",
      name: "Vonza Assistant",
      assistantName: "Vonza Assistant",
      publicAgentKey: "agent-key",
      tone: "friendly",
      systemPrompt: "",
      websiteUrl: "https://example.com/",
      welcomeMessage: "Welcome",
      buttonLabel: "Chat",
      primaryColor: "#14b8a6",
      secondaryColor: "#0f766e",
      installStatus: {
        state: "not_detected",
        label: "Not detected on a live site yet",
      },
      knowledge: {
        state: "ready",
        description: "Knowledge is ready.",
        pageCount: 2,
        contentLength: 1200,
        importedWebsiteUrl: "https://example.com/",
        updatedAt: "2026-04-01T10:00:00.000Z",
      },
    },
  };

  const harness = createDashboardHarness({
    search: "?from=app",
    agents: () => [state.agent],
    customFetch: async ({ pathname, buildResponse }) => {
      if (pathname === "/agents/update") {
        return buildResponse({
          status: 200,
          body: {
            ok: true,
            agent: {
              ...state.agent,
              websiteSync: {
                previousUrl: "https://example.com/",
                currentUrl: "https://example.com/",
                changed: false,
              },
            },
          },
        });
      }

      if (pathname === "/knowledge/import") {
        assert.fail("Knowledge import should not run when the normalized website URL is unchanged.");
      }

      return null;
    },
  });

  await harness.settle();

  const saveAssistant = harness.getGlobal("saveAssistant");
  const form = {
    __formDataEntries: [
      ["assistant_name", "Vonza Assistant"],
      ["tone", "friendly"],
      ["system_prompt", ""],
      ["welcome_message", "Welcome"],
      ["button_label", "Chat"],
      ["website_url", "https://example.com"],
      ["primary_color", "#14b8a6"],
      ["secondary_color", "#0f766e"],
    ],
    querySelector(selector) {
      if (selector === 'button[type="submit"]') {
        return { disabled: false };
      }

      if (selector === "[data-save-state]") {
        return {
          textContent: "",
          className: "",
          removeAttribute() {},
        };
      }

      return null;
    },
  };

  await saveAssistant(
    {
      preventDefault() {},
      currentTarget: form,
    },
    state.agent
  );
  await harness.settle();

  assert.equal(harness.getStatus(), "Your assistant has been updated.");
  assert.equal(
    harness.fetchCalls.filter((call) => call.pathname === "/knowledge/import").length,
    0
  );
});

test("dashboard save keeps the website URL and shows a retry state when auto import fails", async () => {
  const state = {
    agent: {
      id: "agent-1",
      businessId: "business-1",
      accessStatus: "active",
      name: "Vonza Assistant",
      assistantName: "Vonza Assistant",
      publicAgentKey: "agent-key",
      tone: "friendly",
      systemPrompt: "",
      websiteUrl: "https://old-example.com/",
      welcomeMessage: "Welcome",
      buttonLabel: "Chat",
      primaryColor: "#14b8a6",
      secondaryColor: "#0f766e",
      installStatus: {
        state: "not_detected",
        label: "Not detected on a live site yet",
      },
      knowledge: {
        state: "ready",
        description: "Knowledge is ready.",
        pageCount: 2,
        contentLength: 1200,
        importedWebsiteUrl: "https://old-example.com/",
        updatedAt: "2026-04-01T10:00:00.000Z",
      },
    },
  };

  const harness = createDashboardHarness({
    search: "?from=app",
    agents: () => [state.agent],
    customFetch: async ({ pathname, buildResponse }) => {
      if (pathname === "/agents/update") {
        state.agent = {
          ...state.agent,
          websiteUrl: "https://new-example.com/",
        };

        return buildResponse({
          status: 200,
          body: {
            ok: true,
            agent: {
              ...state.agent,
              websiteSync: {
                previousUrl: "https://old-example.com/",
                currentUrl: "https://new-example.com/",
                changed: true,
              },
            },
          },
        });
      }

      if (pathname === "/knowledge/import") {
        return buildResponse({
          status: 500,
          body: {
            error: "Website saved, but importing website knowledge failed. Retry in a moment.",
            import: {
              status: "failed",
              message: "Website saved, but importing website knowledge failed. Retry in a moment.",
            },
          },
        });
      }

      return null;
    },
  });

  await harness.settle();

  const saveAssistant = harness.getGlobal("saveAssistant");
  const form = {
    __formDataEntries: [
      ["assistant_name", "Vonza Assistant"],
      ["tone", "friendly"],
      ["system_prompt", ""],
      ["welcome_message", "Welcome"],
      ["button_label", "Chat"],
      ["website_url", "https://new-example.com"],
      ["primary_color", "#14b8a6"],
      ["secondary_color", "#0f766e"],
    ],
    querySelector(selector) {
      if (selector === 'button[type="submit"]') {
        return { disabled: false };
      }

      if (selector === "[data-save-state]") {
        return {
          textContent: "",
          className: "",
          title: "",
          removeAttribute() {},
        };
      }

      return null;
    },
  };

  await saveAssistant(
    {
      preventDefault() {},
      currentTarget: form,
    },
    state.agent
  );
  await harness.settle();

  assert.equal(
    harness.getStatus(),
    "Website saved, but importing website knowledge failed. Retry in a moment."
  );
  assert.match(harness.getRootHtml(), /https:\/\/new-example\.com\//);
  assert.match(harness.getRootHtml(), /Retry website import/);
});

test("dashboard deduplicates repeated import requests while one is already pending", async () => {
  const state = {
    agent: {
      id: "agent-1",
      businessId: "business-1",
      accessStatus: "active",
      name: "Vonza Assistant",
      assistantName: "Vonza Assistant",
      publicAgentKey: "agent-key",
      tone: "friendly",
      systemPrompt: "",
      websiteUrl: "https://example.com/",
      welcomeMessage: "Welcome",
      buttonLabel: "Chat",
      primaryColor: "#14b8a6",
      secondaryColor: "#0f766e",
      installStatus: {
        state: "not_detected",
        label: "Not detected on a live site yet",
      },
      knowledge: {
        state: "missing",
        description: "Website knowledge has not been imported yet.",
        pageCount: 0,
        contentLength: 0,
        importedWebsiteUrl: "",
        updatedAt: null,
      },
    },
  };
  let resolveImport;
  let importCalls = 0;
  const importResponse = new Promise((resolve) => {
    resolveImport = resolve;
  });

  const harness = createDashboardHarness({
    search: "?from=app",
    agents: () => [state.agent],
    customFetch: async ({ pathname, buildResponse }) => {
      if (pathname === "/knowledge/import") {
        importCalls += 1;
        await importResponse;
        state.agent = {
          ...state.agent,
          knowledge: {
            state: "ready",
            description: "Knowledge is ready.",
            pageCount: 1,
            contentLength: 800,
            importedWebsiteUrl: "https://example.com/",
            updatedAt: "2026-04-02T18:30:00.000Z",
          },
        };

        return buildResponse({
          status: 200,
          body: {
            ok: true,
            websiteUrl: "https://example.com/",
            content: "Imported content",
            pageCount: 1,
            knowledge: {
              state: "ready",
              description: "Knowledge is ready.",
              pageCount: 1,
              contentLength: 800,
              importedWebsiteUrl: "https://example.com/",
              updatedAt: "2026-04-02T18:30:00.000Z",
            },
            import: {
              status: "success",
              lastImportedUrl: "https://example.com/",
              lastImportedAt: "2026-04-02T18:30:00.000Z",
            },
          },
        });
      }

      return null;
    },
  });

  await harness.settle();

  const runKnowledgeImport = harness.getGlobal("runKnowledgeImport");
  const firstImport = runKnowledgeImport(state.agent);
  const secondImport = runKnowledgeImport(state.agent);

  resolveImport();
  await Promise.all([firstImport, secondImport]);
  await harness.settle();

  assert.equal(importCalls, 1);
});

test("setup doctor is only available in local dev mode and never exposes values", { concurrency: false }, async () => {
  const positiveEnv = {
    PUBLIC_APP_URL: "http://localhost:3000",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-present",
    SUPABASE_SERVICE_ROLE_KEY: "service-present",
    OPENAI_API_KEY: "sensitive-openai-value",
    ADMIN_TOKEN: "sensitive-admin-value",
    STRIPE_SECRET_KEY: "sensitive-stripe-key",
    STRIPE_PRICE_ID: "price_123",
    STRIPE_WEBHOOK_SECRET: "whsec_sensitive",
    DEV_FAKE_BILLING: "true",
    NODE_ENV: "development",
  };

  await withEnv(positiveEnv, async () => {
    const server = await startServer(createTestApp());

    try {
      const allowed = await getJson(server.baseUrl, "/setup-doctor");
      assert.equal(allowed.status, 200);
      assert.equal(allowed.json.ok, true);
      assert.equal(allowed.json.dev_fake_billing, true);
      assert.ok(Array.isArray(allowed.json.checks));
      assert.ok(allowed.json.checks.every((check) => typeof check.key === "string" && typeof check.present === "boolean"));
      assert.doesNotMatch(allowed.text, /sensitive-openai-value|sensitive-admin-value|sensitive-stripe-key|whsec_sensitive/);
    } finally {
      await server.close();
    }
  });

  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "false",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp());
      try {
        const result = await getJson(server.baseUrl, "/setup-doctor");
        assert.equal(result.status, 404);
      } finally {
        await server.close();
      }
    }
  );

  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "true",
      NODE_ENV: "production",
    },
    async () => {
      const server = await startServer(createTestApp());
      try {
        const result = await getJson(server.baseUrl, "/setup-doctor");
        assert.equal(result.status, 404);
      } finally {
        await server.close();
      }
    }
  );

  await withEnv(
    {
      PUBLIC_APP_URL: "https://app.example.com",
      DEV_FAKE_BILLING: "true",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp());
      try {
        const result = await requestWithHost(server.baseUrl, "/setup-doctor", {
          host: "app.example.com",
        });
        assert.equal(result.status, 404);
      } finally {
        await server.close();
      }
    }
  );
});

test("locked owners stay blocked until local dev fake billing simulates activation, then access persists", { concurrency: false }, async () => {
  const state = { accessStatus: "pending" };

  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "true",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp(createAgentTestDeps(state)));

      try {
        const ownedList = await getJson(server.baseUrl, "/agents/list");
        assert.equal(ownedList.status, 200);
        assert.equal(ownedList.json.agents[0].accessStatus, "pending");

        const lockedMessages = await withMutedConsoleError(() =>
          getJson(server.baseUrl, "/agents/messages?agent_id=agent-1")
        );
        assert.equal(lockedMessages.status, 403);

        const lockedActionQueue = await withMutedConsoleError(() =>
          getJson(server.baseUrl, "/agents/action-queue?agent_id=agent-1")
        );
        assert.equal(lockedActionQueue.status, 403);

        const lockedUpdate = await withMutedConsoleError(() =>
          getJson(server.baseUrl, "/agents/update", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              agent_id: "agent-1",
              assistant_name: "Blocked update",
            }),
          })
        );
        assert.equal(lockedUpdate.status, 403);

        const lockedDelete = await withMutedConsoleError(() =>
          getJson(server.baseUrl, "/agents/delete", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              agent_id: "agent-1",
            }),
          })
        );
        assert.equal(lockedDelete.status, 403);

        const lockedImport = await withMutedConsoleError(() =>
          getJson(server.baseUrl, "/knowledge/import", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              agent_key: "agent-key",
              client_id: "client-1",
            }),
          })
        );
        assert.equal(lockedImport.status, 403);

        const simulated = await getJson(server.baseUrl, "/create-checkout-session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action: "simulate",
          }),
        });
        assert.equal(simulated.status, 200);
        assert.equal(simulated.json.simulated, true);
        assert.equal(state.accessStatus, "active");

        const unlockedList = await getJson(server.baseUrl, "/agents/list");
        assert.equal(unlockedList.status, 200);
        assert.equal(unlockedList.json.agents[0].accessStatus, "active");

        const unlockedMessages = await getJson(server.baseUrl, "/agents/messages?agent_id=agent-1");
        assert.equal(unlockedMessages.status, 200);
        assert.equal(unlockedMessages.json.messages.length, 1);

        const refreshList = await getJson(server.baseUrl, "/agents/list");
        assert.equal(refreshList.status, 200);
        assert.equal(refreshList.json.agents[0].accessStatus, "active");
      } finally {
        await server.close();
      }
    }
  );
});

test("action queue creates separate owner items for important individual conversations", { concurrency: false }, async () => {
  const state = {
    accessStatus: "active",
    messages: [
      {
        role: "user",
        content: "Can I book a consultation next week?",
        createdAt: "2026-04-01T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "Please contact the business directly for that.",
        createdAt: "2026-04-01T10:00:05.000Z",
      },
      {
        role: "user",
        content: "What are your prices for a monthly plan?",
        createdAt: "2026-04-01T10:02:00.000Z",
      },
      {
        role: "assistant",
        content: "Packages start at $99 per month.",
        createdAt: "2026-04-01T10:02:05.000Z",
      },
      {
        role: "user",
        content: "Can someone call me at +1 555 111 2222 about the premium option?",
        createdAt: "2026-04-01T10:02:30.000Z",
      },
      {
        role: "assistant",
        content: "Please reach out directly.",
        createdAt: "2026-04-01T10:02:35.000Z",
      },
      {
        role: "user",
        content: "Can someone email me at hello@example.com about the best option?",
        createdAt: "2026-04-01T10:03:00.000Z",
      },
      {
        role: "assistant",
        content: "Please reach out directly.",
        createdAt: "2026-04-01T10:03:05.000Z",
      },
      {
        role: "user",
        content: "My order is broken and I need support today.",
        createdAt: "2026-04-01T10:04:00.000Z",
      },
      {
        role: "assistant",
        content: "I don't know the current support policy.",
        createdAt: "2026-04-01T10:04:05.000Z",
      },
      {
        role: "user",
        content: "Do you have parking on site?",
        createdAt: "2026-04-01T10:05:00.000Z",
      },
      {
        role: "assistant",
        content: "I'm not sure.",
        createdAt: "2026-04-01T10:05:05.000Z",
      },
    ],
  };

  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "false",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp(createAgentTestDeps(state)));

      try {
        const result = await getJson(server.baseUrl, "/agents/action-queue?agent_id=agent-1");
        assert.equal(result.status, 200);
        assert.ok(Array.isArray(result.json.items));
        assert.equal(result.json.summary.total, 6);
        assert.equal(result.json.items.length, 6);
        assert.ok(result.json.items.some((item) => item.type === "booking"));
        assert.ok(result.json.items.some((item) => item.type === "pricing"));
        assert.equal(result.json.items.filter((item) => item.type === "contact").length, 2);
        assert.ok(result.json.items.some((item) => item.type === "support"));
        assert.ok(result.json.items.some((item) => item.type === "weak_answer"));
        assert.ok(result.json.items.every((item) => item.ownerWorkflow && typeof item.ownerWorkflow.label === "string"));
        assert.ok(result.json.items.every((item) => String(item.key || "").startsWith("conversation:")));

        const contactItem = result.json.items.find((item) => item.contactInfo?.email === "hello@example.com");
        assert.equal(contactItem.contactCaptured, true);
        assert.equal(contactItem.contactInfo.email, "hello@example.com");
        assert.match(contactItem.snippet, /Visitor asked:/);
      } finally {
        await server.close();
      }
    }
  );
});

test("action queue groups repeat interactions under one lightweight person thread when contact identity is captured", () => {
  const messages = [
    {
      id: "message-1",
      role: "user",
      content: "Email me at hello@example.com with pricing for the monthly plan.",
      createdAt: "2026-04-01T10:00:00.000Z",
    },
    {
      id: "message-2",
      role: "assistant",
      content: "Pricing starts at $99 per month.",
      createdAt: "2026-04-01T10:00:05.000Z",
    },
    {
      id: "message-3",
      role: "user",
      content: "hello@example.com again here. Can you explain the premium pricing too?",
      createdAt: "2026-04-02T09:00:00.000Z",
    },
    {
      id: "message-4",
      role: "assistant",
      content: "Premium pricing depends on scope.",
      createdAt: "2026-04-02T09:00:05.000Z",
    },
  ];

  const result = buildActionQueue(messages, []);

  assert.equal(result.people.length, 1);
  assert.equal(result.peopleSummary.total, 1);
  assert.equal(result.peopleSummary.returning, 1);
  assert.equal(result.people[0].identityType, "email");
  assert.equal(result.people[0].interactionCount, 2);
  assert.equal(result.people[0].queueItemCount, 2);
  assert.match(result.people[0].story, /pricing 2 times/i);
  assert.equal(new Set(result.items.map((item) => item.person?.key)).size, 1);
});

test("action queue links multiple queue items to the same person when session continuity is the only shared signal", () => {
  const messages = [
    {
      id: "message-1",
      role: "user",
      content: "Can someone call me about the premium option?",
      sessionKey: "visitor-session-1",
      createdAt: "2026-04-01T10:00:00.000Z",
    },
    {
      id: "message-2",
      role: "assistant",
      content: "Please reach out directly.",
      sessionKey: "visitor-session-1",
      createdAt: "2026-04-01T10:00:05.000Z",
    },
    {
      id: "message-3",
      role: "user",
      content: "I am back. My order is broken and I need support today.",
      sessionKey: "visitor-session-1",
      createdAt: "2026-04-03T10:00:00.000Z",
    },
    {
      id: "message-4",
      role: "assistant",
      content: "I don't know the current support policy.",
      sessionKey: "visitor-session-1",
      createdAt: "2026-04-03T10:00:05.000Z",
    },
  ];

  const result = buildActionQueue(messages, []);
  const personKeys = new Set(result.items.map((item) => item.person?.key));

  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].identityType, "session");
  assert.equal(result.people[0].queueItemCount, 2);
  assert.equal(personKeys.size, 1);
  assert.equal(result.items[0].person?.relatedQueueItemCount, 2);
  assert.equal(result.items[0].person?.relatedInteractionCount, 2);
});

test("action queue keeps unknown identities separate instead of over-stitching visitors", () => {
  const messages = [
    {
      id: "message-1",
      role: "user",
      content: "What are your prices for a monthly plan?",
      createdAt: "2026-04-01T10:00:00.000Z",
    },
    {
      id: "message-2",
      role: "assistant",
      content: "Packages start at $99 per month.",
      createdAt: "2026-04-01T10:00:05.000Z",
    },
    {
      id: "message-3",
      role: "user",
      content: "My order is broken and I need support today.",
      createdAt: "2026-04-02T10:00:00.000Z",
    },
    {
      id: "message-4",
      role: "assistant",
      content: "I don't know the current support policy.",
      createdAt: "2026-04-02T10:00:05.000Z",
    },
  ];

  const result = buildActionQueue(messages, []);

  assert.equal(result.items.length, 2);
  assert.equal(result.people.length, 2);
  assert.equal(result.peopleSummary.returning, 0);
  assert.equal(new Set(result.items.map((item) => item.person?.key)).size, 2);
  assert.ok(result.people.every((person) => person.identityType === "unknown"));
});

test("action queue stays honestly empty when there are no actionable conversation signals", { concurrency: false }, async () => {
  const state = {
    accessStatus: "active",
    messages: [
      {
        role: "user",
        content: "What do you do?",
        createdAt: "2026-04-01T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "We help businesses add a website assistant.",
        createdAt: "2026-04-01T10:00:05.000Z",
      },
    ],
  };

  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "false",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp(createAgentTestDeps(state)));

      try {
        const result = await getJson(server.baseUrl, "/agents/action-queue?agent_id=agent-1");
        assert.equal(result.status, 200);
        assert.equal(result.json.items.length, 0);
        assert.equal(result.json.summary.total, 0);
      } finally {
        await server.close();
      }
    }
  );
});

test("action queue status changes persist cleanly through the lightweight owner workflow", { concurrency: false }, async () => {
  const state = {
    accessStatus: "active",
    messages: [
      {
        role: "user",
        content: "Can someone email me at hello@example.com about the best option?",
        createdAt: "2026-04-01T10:03:00.000Z",
      },
      {
        role: "assistant",
        content: "Please reach out directly.",
        createdAt: "2026-04-01T10:03:05.000Z",
      },
    ],
  };

  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "false",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp(createAgentTestDeps(state)));

      try {
        const initial = await getJson(server.baseUrl, "/agents/action-queue?agent_id=agent-1");
        assert.equal(initial.status, 200);
        const contactActionKey = initial.json.items.find((item) => item.type === "contact")?.key;
        assert.ok(contactActionKey);

        const updated = await getJson(server.baseUrl, "/agents/action-queue/status", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agent_id: "agent-1",
            action_key: contactActionKey,
            status: "reviewed",
            note: "Owner reviewed the lead and wants a follow-up tomorrow.",
            outcome: "Asked the team to reach out with package details.",
            next_step: "Call the lead tomorrow morning.",
            follow_up_needed: true,
            follow_up_completed: false,
            contact_status: "attempted",
          }),
        });

        assert.equal(updated.status, 200);
        assert.equal(updated.json.ok, true);
        assert.equal(updated.json.item.status, "reviewed");
        assert.equal(updated.json.item.note, "Owner reviewed the lead and wants a follow-up tomorrow.");
        assert.equal(updated.json.item.outcome, "Asked the team to reach out with package details.");
        assert.equal(updated.json.item.nextStep, "Call the lead tomorrow morning.");
        assert.equal(updated.json.item.followUpNeeded, true);
        assert.equal(updated.json.item.followUpCompleted, false);
        assert.equal(updated.json.item.contactStatus, "attempted");
        assert.ok(updated.json.queue);
        assert.ok(updated.json.queue.summary.followUpNeeded >= 1);
        assert.ok(updated.json.queue.summary.attentionNeeded >= 1);

        const refreshed = await getJson(server.baseUrl, "/agents/action-queue?agent_id=agent-1");
        assert.equal(refreshed.status, 200);
        const contactItem = refreshed.json.items.find((item) => item.key === contactActionKey);
        assert.equal(contactItem.status, "reviewed");
        assert.equal(contactItem.note, "Owner reviewed the lead and wants a follow-up tomorrow.");
        assert.equal(contactItem.outcome, "Asked the team to reach out with package details.");
        assert.equal(contactItem.nextStep, "Call the lead tomorrow morning.");
        assert.equal(contactItem.followUpNeeded, true);
        assert.equal(contactItem.followUpCompleted, false);
        assert.equal(contactItem.contactStatus, "attempted");
        assert.equal(contactItem.ownerWorkflow.label, "Follow-up in progress");
        assert.ok(refreshed.json.summary.followUpNeeded >= 1);
        assert.ok(refreshed.json.summary.attentionNeeded >= 1);
      } finally {
        await server.close();
      }
    }
  );
});

test("action queue prioritizes owner follow-up and reports attention cleanly", () => {
  const messages = [
    {
      role: "user",
      content: "Can someone email me at hello@example.com?",
      createdAt: "2026-04-01T10:03:00.000Z",
    },
    {
      role: "assistant",
      content: "Yes, our team can follow up.",
      createdAt: "2026-04-01T10:03:05.000Z",
    },
    {
      role: "user",
      content: "What are your prices for monthly support?",
      createdAt: "2026-04-01T10:05:00.000Z",
    },
    {
      role: "assistant",
      content: "Packages start at $99 per month.",
      createdAt: "2026-04-01T10:05:05.000Z",
    },
  ];
  const baseline = buildActionQueue(messages, []);
  const contactKey = baseline.items.find((item) => item.type === "contact")?.key;
  const pricingKey = baseline.items.find((item) => item.type === "pricing")?.key;
  const result = buildActionQueue(messages, [
    {
      action_key: contactKey,
      status: "reviewed",
      note: "Owner called the lead.",
      next_step: "Send pricing details this afternoon.",
      follow_up_needed: true,
      follow_up_completed: false,
    },
    {
      action_key: pricingKey,
      status: "done",
      outcome: "Quote already shared and no follow-up is needed.",
      follow_up_needed: false,
      follow_up_completed: true,
    },
  ]);

  assert.equal(result.items[0].key, contactKey);
  assert.equal(result.items[0].ownerWorkflow.label, "Follow-up in progress");
  assert.equal(result.items[1].key, pricingKey);
  assert.equal(result.items[1].ownerWorkflow.label, "Resolved");
  assert.equal(result.summary.followUpNeeded, 1);
  assert.equal(result.summary.resolved, 1);
  assert.equal(result.summary.attentionNeeded, 1);
});

test("lightweight owner handoff updates auto-advance queue status when appropriate", async () => {
  let capturedPayload = null;
  let persistedRow = null;
  const supabase = {
    from(tableName) {
      assert.equal(tableName, "agent_action_queue_statuses");
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        async maybeSingle() {
                          return {
                            data: persistedRow,
                            error: null,
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
        upsert(payload) {
          capturedPayload = payload;
          persistedRow = payload;
          return {
            select() {
              return {
                async single() {
                  return {
                    data: payload,
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  const reviewed = await updateActionQueueStatus(supabase, {
    agentId: "agent-1",
    ownerUserId: "owner-1",
    actionKey: "intent:contact",
    status: "new",
    note: "Owner called the lead.",
    nextStep: "Send pricing details this afternoon.",
    followUpNeeded: true,
    followUpCompleted: false,
  });

  assert.equal(capturedPayload.status, "reviewed");
  assert.equal(reviewed.item.status, "reviewed");

  const resolved = await updateActionQueueStatus(supabase, {
    agentId: "agent-1",
    ownerUserId: "owner-1",
    actionKey: "intent:contact",
    status: "reviewed",
    outcome: "Lead booked a consultation.",
    followUpNeeded: false,
    followUpCompleted: true,
  });

  assert.equal(capturedPayload.status, "done");
  assert.equal(resolved.item.status, "done");
});

test("action queue returns a clear persistence error instead of silently falling back to read-only mode", { concurrency: false }, async () => {
  const state = {
    accessStatus: "active",
    messages: [
      {
        role: "user",
        content: "Can someone email me at hello@example.com about the best option?",
        createdAt: "2026-04-01T10:03:00.000Z",
      },
      {
        role: "assistant",
        content: "Please reach out directly.",
        createdAt: "2026-04-01T10:03:05.000Z",
      },
    ],
  };

  const deps = {
    ...createAgentTestDeps(state),
    listActionQueueStatuses: async () => {
      const error = new Error("Action queue persistence is not ready on the server yet. Apply the action queue migration and try again.");
      error.statusCode = 503;
      throw error;
    },
  };

  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "false",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp(deps));

      try {
        const result = await getJson(server.baseUrl, "/agents/action-queue?agent_id=agent-1");
        assert.equal(result.status, 503);
        assert.equal(
          result.json.error,
          "Action queue persistence is not ready on the server yet. Apply the action queue migration and try again."
        );
      } finally {
        await server.close();
      }
    }
  );
});

test("action queue follow-up persists through website re-imports", { concurrency: false }, async () => {
  const state = {
    accessStatus: "active",
    messages: [
      {
        role: "user",
        content: "Can someone email me at hello@example.com about the best option?",
        createdAt: "2026-04-01T10:03:00.000Z",
      },
      {
        role: "assistant",
        content: "Please reach out directly.",
        createdAt: "2026-04-01T10:03:05.000Z",
      },
    ],
  };

  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "false",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp(createAgentTestDeps(state)));

      try {
        const initial = await getJson(server.baseUrl, "/agents/action-queue?agent_id=agent-1");
        assert.equal(initial.status, 200);
        const actionKey = initial.json.items.find((item) => item.type === "contact")?.key;
        assert.ok(actionKey);

        const updated = await getJson(server.baseUrl, "/agents/action-queue/status", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agent_id: "agent-1",
            action_key: actionKey,
            status: "reviewed",
            note: "Owner called the lead.",
            next_step: "Send pricing details.",
            follow_up_needed: true,
            follow_up_completed: false,
          }),
        });

        assert.equal(updated.status, 200);
        assert.equal(updated.json.item.status, "reviewed");

        const imported = await getJson(server.baseUrl, "/knowledge/import", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agent_key: "agent-key",
            client_id: "client-1",
          }),
        });

        assert.equal(imported.status, 200);

        const refreshed = await getJson(server.baseUrl, "/agents/action-queue?agent_id=agent-1");
        assert.equal(refreshed.status, 200);
        const refreshedItem = refreshed.json.items.find((item) => item.key === actionKey);
        assert.equal(refreshedItem.status, "reviewed");
        assert.equal(refreshedItem.note, "Owner called the lead.");
        assert.equal(refreshedItem.nextStep, "Send pricing details.");
        assert.equal(refreshedItem.followUpNeeded, true);
        assert.equal(refreshedItem.followUpCompleted, false);
      } finally {
        await server.close();
      }
    }
  );
});

test("knowledge import still supports the unauthenticated client bridge during onboarding", { concurrency: false }, async () => {
  const state = { accessStatus: "pending" };

  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "false",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp(createUnauthedBridgeDeps(state)));
      try {
        const imported = await getJson(server.baseUrl, "/knowledge/import", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agent_key: "agent-key",
            client_id: "client-1",
          }),
        });
        assert.equal(imported.status, 200);
        assert.equal(imported.json.ok, true);
      } finally {
        await server.close();
      }
    }
  );
});

test("agent updates return specific validation errors for customize saves", { concurrency: false }, async () => {
  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "false",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(
        createTestApp({
          ...createAgentTestDeps({ accessStatus: "active" }),
          updateAgentSettings: async () => {
            const error = new Error("Enter a valid public https URL, like https://example.com.");
            error.statusCode = 400;
            throw error;
          },
        })
      );

      try {
        const result = await withMutedConsoleError(() =>
          getJson(server.baseUrl, "/agents/update", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              agent_id: "agent-1",
              website_url: "not-a-valid-url",
            }),
          })
        );

        assert.equal(result.status, 400);
        assert.equal(
          result.json.error,
          "Enter a valid public https URL, like https://example.com."
        );
      } finally {
        await server.close();
      }
    }
  );
});

test("first-time owner assistant creation stays allowed before payment and returns pending access state", { concurrency: false }, async () => {
  const state = { accessStatus: "pending" };

  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "false",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp(createAgentTestDeps(state)));
      try {
        const created = await getJson(server.baseUrl, "/agents/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: "client-1",
            business_name: "Vonza Studio",
            website_url: "https://example.com",
            assistant_name: "Vonza Studio",
          }),
        });

        assert.equal(created.status, 200);
        assert.equal(created.json.agent_id, "agent-1");
        assert.equal(created.json.agent_key, "agent-key");
        assert.equal(created.json.access_status, "pending");
      } finally {
        await server.close();
      }
    }
  );
});

test("checkout creation quietly seeds a draft assistant for signed-in unpaid owners with no agent yet", { concurrency: false }, async () => {
  const state = { accessStatus: "pending", hasAgent: false, businessName: null };

  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "false",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp(createAgentTestDeps(state)));
      try {
        const checkout = await getJson(server.baseUrl, "/create-checkout-session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: "owner@example.com",
          }),
        });

        assert.equal(checkout.status, 200);
        assert.equal(checkout.json.ok, true);
        assert.equal(checkout.json.session_id, "cs_test_checkout");
        assert.match(checkout.json.url, /checkout\.stripe\.test/);
        assert.equal(state.hasAgent, true);
        assert.match(state.businessName, /Vonza setup/);
      } finally {
        await server.close();
      }
    }
  );
});

test("checkout creation requires an authenticated session and returns a clear error", { concurrency: false }, async () => {
  const state = { accessStatus: "pending", hasAgent: false };

  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "false",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp(createUnauthedBridgeDeps(state)));
      try {
        const checkout = await getJson(server.baseUrl, "/create-checkout-session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: "owner@example.com",
          }),
        });

        assert.equal(checkout.status, 401);
        assert.equal(checkout.json.error, "Your sign-in session expired. Please sign in again to open checkout.");
      } finally {
        await server.close();
      }
    }
  );
});

test("checkout creation returns a clear config error when the Stripe price is below the currency minimum", { concurrency: false }, async () => {
  const state = { accessStatus: "pending", hasAgent: true };
  const deps = {
    ...createAgentTestDeps(state),
    createHostedCheckoutSession: async () => {
      throw new Error("The Checkout Session's total amount due must add up to at least 175.00 Ft huf");
    },
  };

  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "false",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp(deps));
      try {
        const checkout = await getJson(server.baseUrl, "/create-checkout-session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: "owner@example.com",
          }),
        });

        assert.equal(checkout.status, 500);
        assert.match(
          checkout.json.error,
          /update STRIPE_PRICE_ID to a valid Stripe price in the same account and mode/i
        );
      } finally {
        await server.close();
      }
    }
  );
});

test("dev fake billing simulate path stays blocked outside local dev guard conditions", { concurrency: false }, async () => {
  const state = { accessStatus: "pending" };

  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "false",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp(createAgentTestDeps(state)));
      try {
        const blocked = await getJson(server.baseUrl, "/create-checkout-session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action: "simulate",
          }),
        });
        assert.equal(blocked.status, 404);
      } finally {
        await server.close();
      }
    }
  );

  await withEnv(
    {
      PUBLIC_APP_URL: "http://localhost:3000",
      DEV_FAKE_BILLING: "true",
      NODE_ENV: "production",
    },
    async () => {
      const server = await startServer(createTestApp(createAgentTestDeps(state)));
      try {
        const blocked = await getJson(server.baseUrl, "/create-checkout-session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action: "simulate",
          }),
        });
        assert.equal(blocked.status, 404);
      } finally {
        await server.close();
      }
    }
  );

  await withEnv(
    {
      PUBLIC_APP_URL: "https://app.example.com",
      DEV_FAKE_BILLING: "true",
      NODE_ENV: "development",
    },
    async () => {
      const server = await startServer(createTestApp(createAgentTestDeps(state)));
      try {
        const blocked = await requestWithHost(server.baseUrl, "/create-checkout-session", {
          method: "POST",
          host: "app.example.com",
          body: {
            action: "simulate",
          },
        });
        assert.equal(blocked.status, 404);
      } finally {
        await server.close();
      }
    }
  );
});

test("protected scrape route is no longer public", { concurrency: false }, async () => {
  await withEnv(
    {
      ADMIN_TOKEN: "admin-1234",
    },
    async () => {
      const server = await startServer(createTestApp());
      try {
        const blocked = await getJson(server.baseUrl, "/businesses/business-1/scrape");
        assert.equal(blocked.status, 401);
      } finally {
        await server.close();
      }
    }
  );
});

test("Stripe billing verification only accepts the configured Vonza price", { concurrency: false }, async () => {
  const matchingStripe = {
    checkout: {
      sessions: {
        retrieve: async (sessionId) => ({
          id: sessionId,
          payment_status: "paid",
          metadata: {
            owner_user_id: "owner-1",
          },
        }),
        listLineItems: async () => ({
          data: [
            {
              price: {
                id: "price_vonza",
              },
            },
          ],
        }),
      },
    },
  };

  const wrongPriceStripe = {
    checkout: {
      sessions: {
        retrieve: async (sessionId) => ({
          id: sessionId,
          payment_status: "paid",
          metadata: {
            owner_user_id: "owner-1",
          },
        }),
        listLineItems: async () => ({
          data: [
            {
              price: {
                id: "price_other",
              },
            },
          ],
        }),
      },
    },
  };

  const verified = await verifySuccessfulCheckout(
    {
      sessionId: "cs_test_ok",
      ownerUserId: "owner-1",
    },
    {
      stripe: matchingStripe,
      expectedPriceId: "price_vonza",
    }
  );
  assert.equal(verified.id, "cs_test_ok");

  await assert.rejects(
    () =>
      verifySuccessfulCheckout(
        {
          sessionId: "cs_test_wrong",
          ownerUserId: "owner-1",
        },
        {
          stripe: wrongPriceStripe,
          expectedPriceId: "price_vonza",
        }
      ),
    /configured Vonza access price/
  );

  const paidOwner = await getPaidOwnerIdFromCheckoutSession(
    {
      id: "cs_test_paid",
      payment_status: "paid",
      metadata: {
        owner_user_id: "owner-1",
      },
    },
    {
      stripe: matchingStripe,
      expectedPriceId: "price_vonza",
    }
  );
  assert.equal(paidOwner, "owner-1");

  const rejectedOwner = await getPaidOwnerIdFromCheckoutSession(
    {
      id: "cs_test_rejected",
      payment_status: "paid",
      metadata: {
        owner_user_id: "owner-1",
      },
    },
    {
      stripe: wrongPriceStripe,
      expectedPriceId: "price_vonza",
    }
  );
  assert.equal(rejectedOwner, null);
});
