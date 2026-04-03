import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAnalyticsSummary,
  createEmptyAnalyticsSummary,
} from "../src/services/analytics/analyticsSummaryService.js";

test("analytics summary keeps live message, CTA, and contact counts aligned", () => {
  const summary = buildAnalyticsSummary({
    messages: [
      { role: "user", content: "How much does it cost?", createdAt: "2026-04-03T09:00:00.000Z" },
      { role: "assistant", content: "Pricing depends on scope.", createdAt: "2026-04-03T09:00:05.000Z" },
      { role: "user", content: "Can someone contact me?", createdAt: "2026-04-03T09:01:00.000Z" },
      { role: "assistant", content: "Yes, share the best email.", createdAt: "2026-04-03T09:01:05.000Z" },
    ],
    actionQueue: {
      items: [
        { actionType: "pricing_interest" },
        { actionType: "lead_follow_up", weakAnswer: true },
      ],
      summary: {
        attentionNeeded: 1,
      },
      conversionSummary: {
        highIntentConversations: 2,
        directCtasShown: 1,
        ctaClicks: 1,
        ctaClickThroughRate: 1,
        contactsCaptured: 1,
      },
      outcomeSummary: {
        assistedConversions: 1,
      },
    },
    widgetMetrics: {
      conversationsSinceInstall: 2,
    },
    installStatus: {
      state: "seen_recently",
    },
  });

  assert.equal(summary.totalMessages, 4);
  assert.equal(summary.visitorQuestions, 2);
  assert.equal(summary.highIntentSignals, 2);
  assert.equal(summary.directCtasShown, 1);
  assert.equal(summary.ctaClicks, 1);
  assert.equal(summary.ctaClickThroughRate, 1);
  assert.equal(summary.contactsCaptured, 1);
  assert.equal(summary.assistedOutcomes, 1);
  assert.equal(summary.weakAnswerCount, 1);
  assert.equal(summary.attentionNeeded, 1);
  assert.equal(summary.syncState, "ready");
  assert.match(summary.operatorSignal.copy, /high-intent customer signal/i);
});

test("analytics summary exposes pending sync instead of misleading zeros", () => {
  const summary = buildAnalyticsSummary({
    messages: [],
    actionQueue: {
      ...createEmptyAnalyticsSummary(),
    },
    widgetMetrics: {
      conversationsSinceInstall: 1,
      lastConversationAt: "2026-04-03T10:00:00.000Z",
    },
    installStatus: {
      state: "seen_recently",
      lastSeenAt: "2026-04-03T10:00:00.000Z",
    },
  });

  assert.equal(summary.totalMessages, 0);
  assert.equal(summary.visitorQuestions, 0);
  assert.equal(summary.syncState, "pending");
  assert.match(summary.recentActivity.description, /syncing/i);
});
