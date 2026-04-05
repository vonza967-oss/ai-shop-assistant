import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCalendarDailySummary,
  buildCampaignSequence,
  buildReplyDraft,
  classifyInboxThread,
  createEmptyOperatorWorkspaceSnapshot,
  getOperatorWorkspaceCapabilities,
  suggestCalendarSlots,
} from "../src/services/operator/operatorWorkspaceService.js";

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

function createSchemaProbeSupabase(failures = {}) {
  return {
    from(tableName) {
      return {
        select() {
          return {
            limit() {
              const failure = failures[tableName];

              if (failure) {
                return Promise.resolve({
                  data: null,
                  error: failure,
                });
              }

              return Promise.resolve({
                data: [],
                error: null,
              });
            },
          };
        },
      };
    },
  };
}

test("inbox classifier identifies complaint and billing threads", () => {
  assert.equal(classifyInboxThread({
    subject: "Refund request",
    snippet: "I am very frustrated and need this fixed.",
    messages: [],
  }), "complaint");

  assert.equal(classifyInboxThread({
    subject: "Invoice question",
    snippet: "Can you check the charge on my card?",
    messages: [],
  }), "billing");
});

test("reply draft generation stays approval-first and complaint aware", () => {
  const draft = buildReplyDraft({
    classification: "complaint",
    subject: "Bad experience",
    participants: ["customer@example.com"],
    messages: [
      {
        direction: "inbound",
        sender: "Customer <customer@example.com>",
        senderEmail: "customer@example.com",
        bodyText: "I am unhappy with the service.",
      },
    ],
  }, {
    businessName: "Vonza Plumbing",
    senderName: "Vonza Plumbing",
  });

  assert.equal(draft.to, "customer@example.com");
  assert.match(draft.subject, /sorry/i);
  assert.match(draft.body, /make this right/i);
});

test("slot suggestion avoids busy events and finds business-hour availability", () => {
  const slots = suggestCalendarSlots([
    {
      startAt: "2026-04-06T09:00:00.000Z",
      endAt: "2026-04-06T10:00:00.000Z",
      status: "confirmed",
    },
    {
      startAt: "2026-04-06T13:00:00.000Z",
      endAt: "2026-04-06T14:00:00.000Z",
      status: "confirmed",
    },
  ], {
    now: "2026-04-06T08:00:00.000Z",
  });

  assert.ok(slots.length > 0);
  assert.equal(slots[0].startAt, "2026-04-06T10:00:00.000Z");
  assert.equal(slots[0].endAt, "2026-04-06T11:00:00.000Z");
});

test("calendar summary includes conflicts, complaints, and best next slot", () => {
  const summary = buildCalendarDailySummary({
    events: [
      {
        title: "Morning booking",
        startAt: "2026-04-06T09:00:00.000Z",
        endAt: "2026-04-06T10:00:00.000Z",
      },
    ],
    tasks: [
      { taskType: "calendar_conflict", status: "open" },
      { taskType: "complaint_queue", status: "open" },
    ],
    slots: [
      { label: "Mon, Apr 6, 11:00 AM" },
    ],
    followUpItems: [
      { id: "event-1" },
    ],
    unlinkedItems: [
      { id: "event-2" },
    ],
  });

  assert.match(summary, /Morning booking/);
  assert.match(summary, /conflict/i);
  assert.match(summary, /complaint/i);
  assert.match(summary, /recent appointment/i);
  assert.match(summary, /not linked to a contact/i);
  assert.match(summary, /11:00 AM/);
});

test("campaign sequence stays deterministic for quote follow-up", () => {
  const sequence = buildCampaignSequence("quote_follow_up", "Vonza Painting");

  assert.equal(sequence.length, 2);
  assert.equal(sequence[0].stepOrder, 0);
  assert.equal(sequence[1].timingOffsetHours, 72);
  assert.match(sequence[0].subject, /quote request/i);
});

test("empty operator workspace snapshot starts in a safe disabled state", () => {
  const snapshot = createEmptyOperatorWorkspaceSnapshot();

  assert.equal(snapshot.connectedAccounts.length, 0);
  assert.equal(snapshot.capabilities.featureEnabled, false);
  assert.equal(snapshot.capabilities.persistenceAvailable, false);
  assert.deepEqual(snapshot.alerts, []);
});

test("operator workspace capabilities report disabled rollout without probing schema", async () => {
  await withEnv({
    VONZA_OPERATOR_WORKSPACE_V1: "false",
  }, async () => {
    const capabilities = await getOperatorWorkspaceCapabilities(createSchemaProbeSupabase());

    assert.equal(capabilities.featureEnabled, false);
    assert.equal(capabilities.status, "disabled");
    assert.match(capabilities.alerts[0], /disabled/i);
  });
});

test("operator workspace capabilities surface missing Google env without breaking persistence", async () => {
  await withEnv({
    VONZA_OPERATOR_WORKSPACE_V1: "true",
    GOOGLE_CLIENT_ID: undefined,
    GOOGLE_CLIENT_SECRET: undefined,
    GOOGLE_OAUTH_REDIRECT_URI: undefined,
    GOOGLE_TOKEN_ENCRYPTION_SECRET: undefined,
  }, async () => {
    const capabilities = await getOperatorWorkspaceCapabilities(createSchemaProbeSupabase());

    assert.equal(capabilities.featureEnabled, true);
    assert.equal(capabilities.googleAvailable, false);
    assert.equal(capabilities.persistenceAvailable, true);
    assert.equal(capabilities.status, "google_unavailable");
    assert.ok(capabilities.googleMissingEnv.includes("GOOGLE_CLIENT_ID"));
    assert.ok(capabilities.googleMissingEnv.includes("GOOGLE_CLIENT_SECRET"));
    assert.ok(capabilities.alerts.some((alert) => /Google integration is unavailable/i.test(alert)));
  });
});

test("operator workspace capabilities surface missing tables as migration required", async () => {
  await withEnv({
    VONZA_OPERATOR_WORKSPACE_V1: "true",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_OAUTH_REDIRECT_URI: "https://example.com/google/oauth/callback",
    GOOGLE_TOKEN_ENCRYPTION_SECRET: "secret-value",
  }, async () => {
    const capabilities = await getOperatorWorkspaceCapabilities(createSchemaProbeSupabase({
      google_connected_accounts: {
        code: "42P01",
        message: "relation public.google_connected_accounts does not exist",
      },
      operator_inbox_threads: {
        code: "42P01",
        message: "relation public.operator_inbox_threads does not exist",
      },
    }));

    assert.equal(capabilities.featureEnabled, true);
    assert.equal(capabilities.persistenceAvailable, false);
    assert.equal(capabilities.migrationRequired, true);
    assert.equal(capabilities.status, "migration_required");
    assert.ok(capabilities.missingTables.includes("google_connected_accounts"));
    assert.ok(capabilities.missingTables.includes("operator_inbox_threads"));
  });
});
