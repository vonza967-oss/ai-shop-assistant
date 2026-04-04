import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTodayCopilotSnapshot,
  createEmptyTodayCopilotState,
} from "../src/services/operator/todayCopilotService.js";

test("copilot feature flag off keeps the contract inert", () => {
  const copilot = buildTodayCopilotSnapshot({
    featureEnabled: false,
  });

  assert.equal(copilot.enabled, false);
  assert.equal(copilot.featureEnabled, false);
  assert.equal(copilot.readOnly, true);
  assert.equal(copilot.autonomousActionsEnabled, false);
  assert.deepEqual(Array.from(copilot.summaryCards), []);
  assert.deepEqual(Array.from(copilot.answers), []);
});

test("copilot produces read-only answers, recommendations, and drafts from stable-core data", () => {
  const copilot = buildTodayCopilotSnapshot({
    featureEnabled: true,
    now: "2026-04-04T12:00:00.000Z",
    agent: {
      id: "agent-1",
      businessId: "business-1",
      name: "Vonza Plumbing",
      assistantName: "Vonza Plumbing",
      knowledge: { state: "ready" },
      installStatus: { state: "seen_recently" },
    },
    messages: [
      { createdAt: "2026-04-04T08:00:00.000Z", role: "user", content: "How much does emergency plumbing cost?" },
      { createdAt: "2026-04-04T08:01:00.000Z", role: "assistant", content: "Pricing depends on scope." },
    ],
    actionQueue: {
      items: [
        {
          key: "operator:pricing-1",
          status: "reviewed",
          actionType: "pricing_interest",
          suggestedAction: "Follow up with pricing details",
          operatorSummary: "A visitor asked about pricing and still has no recorded outcome.",
          ownerWorkflow: { attention: true },
          outcomes: { count: 0 },
          contactInfo: { name: "Taylor Reed", email: "taylor@example.com" },
        },
      ],
    },
    followUps: [
      {
        id: "follow-up-1",
        status: "draft",
        contactName: "Taylor Reed",
        contactId: "contact-1",
        sourceActionKey: "operator:pricing-1",
        channel: "email",
        subject: "Vonza Plumbing: following up on pricing",
        draftContent: "Hi Taylor,\n\nFollowing up on the pricing details you asked for.\n\nVonza Plumbing",
        whyPrepared: "Pricing interest was captured without a recorded outcome.",
      },
    ],
    knowledgeFixes: [],
    contacts: [
      {
        id: "contact-1",
        displayName: "Taylor Reed",
        lifecycleState: "active_lead",
        hasMeaningfulOutcome: false,
        nextAction: { key: "draft_quote_follow_up" },
      },
      {
        id: "contact-2",
        displayName: "Jordan Lane",
        lifecycleState: "complaint_risk",
        flags: ["complaint"],
        nextAction: {
          key: "reply_to_complaint",
          title: "Reply to complaint",
          description: "A support complaint still needs review.",
          targetSection: "contacts",
          targetId: "contact-2",
          actionType: "open_contact",
        },
      },
    ],
    recentOutcomes: [
      {
        label: "Quote requested",
        outcomeType: "quote_requested",
      },
    ],
    routingEvents: [
      { eventName: "cta_shown" },
    ],
    businessProfile: {
      readiness: {
        totalSections: 8,
        completedSections: 8,
        missingCount: 0,
        missingSections: [],
        summary: "All core business context areas are filled for Copilot.",
      },
    },
  });

  assert.equal(copilot.enabled, true);
  assert.equal(copilot.readOnly, true);
  assert.equal(copilot.draftOnly, true);
  assert.equal(copilot.autonomousActionsEnabled, false);
  assert.equal(copilot.sparseData, false);
  assert.ok(copilot.summaryCards.some((card) => card.id === "what_matters"));
  assert.ok(copilot.answers.some((answer) => answer.key === "attention_today"));
  assert.ok(copilot.recommendations.some((recommendation) => recommendation.type === "pricing_gap"));
  assert.ok(copilot.recommendations.some((recommendation) => recommendation.type === "support_risk_review"));
  assert.ok(copilot.recommendations.every((recommendation) => recommendation.writeBehavior === "recommendation_only"));
  assert.ok(copilot.recommendations.some((recommendation) => recommendation.targetSection));
  assert.equal(copilot.drafts[0].approvalRequired, true);
  assert.equal(copilot.drafts[0].writeBehavior, "draft_only");
  assert.match(copilot.drafts[0].subject, /pricing/i);
  assert.ok(copilot.drafts.some((draft) => draft.type === "task_proposal"));
  assert.equal(copilot.recommendedNextActionId.length > 0, true);
});

test("copilot sparse-data fallback stays honest and guidance-first", () => {
  const copilot = buildTodayCopilotSnapshot({
    featureEnabled: true,
    agent: {
      id: "agent-1",
      businessId: "business-1",
      name: "Vonza Painting",
      knowledge: { state: "missing" },
      installStatus: { state: "not_detected" },
    },
    messages: [],
    actionQueue: { items: [] },
    followUps: [],
    knowledgeFixes: [],
    contacts: [],
    recentOutcomes: [],
    routingEvents: [],
    businessProfile: {
      readiness: {
        totalSections: 8,
        completedSections: 2,
        missingCount: 6,
        missingSections: ["Services", "Pricing", "Policies"],
        summary: "2 of 8 business context areas are filled. Missing: Services, Pricing, Policies.",
      },
    },
  });

  assert.equal(copilot.sparseData, true);
  assert.match(copilot.headline, /not enough live operating data/i);
  assert.match(copilot.fallback.description, /not enough stable-core activity/i);
  assert.ok(copilot.fallback.guidance.some((entry) => /Re-import website knowledge/i.test(entry)));
  assert.ok(copilot.fallback.guidance.some((entry) => /Fill the business context foundation next/i.test(entry)));
  assert.ok(copilot.summaryCards.some((card) => card.id === "what_matters"));
});

test("empty copilot state defaults to no autonomous writes", () => {
  const copilot = createEmptyTodayCopilotState({
    featureEnabled: true,
  });

  assert.equal(copilot.readOnly, true);
  assert.equal(copilot.draftOnly, true);
  assert.equal(copilot.autonomousActionsEnabled, false);
});
