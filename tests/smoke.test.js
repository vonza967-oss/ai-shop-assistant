import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "cors";
import express from "express";

import { createPublicRouter } from "../src/routes/publicRoutes.js";
import { createAgentRouter } from "../src/routes/agentRoutes.js";
import { createBusinessRouter } from "../src/routes/businessRoutes.js";
import {
  getPaidOwnerIdFromCheckoutSession,
  verifySuccessfulCheckout,
} from "../src/services/billing/checkoutService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

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

function createAgentTestDeps(state) {
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
    listAgentMessages: async () => [
      {
        id: "message-1",
        role: "user",
        content: "Do you offer pricing?",
      },
    ],
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

test("public dashboard/auth surface loads without broken routes", { concurrency: false }, async () => {
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
        const dashboard = await getText(server.baseUrl, "/dashboard");
        assert.equal(dashboard.status, 200);
        assert.match(dashboard.text, /dashboard-root/);
        assert.match(dashboard.text, /\/public-config\.js/);
        assert.match(dashboard.text, /\/supabase-auth\.js/);
        assert.match(dashboard.text, /\/dashboard\.js/);

        const authScript = await getText(server.baseUrl, "/supabase-auth.js");
        assert.equal(authScript.status, 200);

        const dashboardScript = await getText(server.baseUrl, "/dashboard.js");
        assert.equal(dashboardScript.status, 200);

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

test("dashboard bundle exposes the canonical purchase-first flow and paid workspace tabs", { concurrency: false }, async () => {
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
        assert.match(dashboardScript.text, /Unlock Vonza to open your setup workspace/);
        assert.match(dashboardScript.text, /Continue with email/);
        assert.match(dashboardScript.text, /Overview/);
        assert.match(dashboardScript.text, /Customize/);
        assert.match(dashboardScript.text, /Analytics/);
      } finally {
        await server.close();
      }
    }
  );
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
