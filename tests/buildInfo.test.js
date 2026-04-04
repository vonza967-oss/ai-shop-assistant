import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import { createPublicRouter } from "../src/routes/publicRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

async function startServer(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function withEnv(overrides, fn) {
  const previous = new Map();

  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("health and build endpoints expose version and build metadata", async () => {
  await withEnv({
    VONZA_OPERATOR_WORKSPACE_V1: "true",
    VONZA_TODAY_COPILOT_V1: "true",
    RENDER_GIT_COMMIT: "abc123def456",
    npm_package_version: "1.0.0",
  }, async () => {
    const app = express();
    app.use(createPublicRouter({ rootDir: repoRoot }));
    const server = await startServer(app);

    try {
      const healthResponse = await fetch(`${server.baseUrl}/health`);
      const buildResponse = await fetch(`${server.baseUrl}/build`);
      const health = await healthResponse.json();
      const build = await buildResponse.json();

      assert.equal(health.ok, true);
      assert.equal(health.buildSha, "abc123def456");
      assert.equal(health.operatorWorkspaceV1Enabled, true);
      assert.equal(build.version, "1.0.0");
      assert.equal(build.buildSha, "abc123def456");
    } finally {
      await server.close();
    }
  });
});

test("public config exposes the today copilot browser flag", async () => {
  await withEnv({
    VONZA_OPERATOR_WORKSPACE_V1: "true",
    VONZA_TODAY_COPILOT_V1: "true",
  }, async () => {
    const app = express();
    app.use(createPublicRouter({ rootDir: repoRoot }));
    const server = await startServer(app);

    try {
      const response = await fetch(`${server.baseUrl}/public-config.js`);
      const text = await response.text();

      assert.match(text, /VONZA_TODAY_COPILOT_V1_ENABLED = true/);
    } finally {
      await server.close();
    }
  });
});
