import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOperatorBusinessProfilePrefill,
  buildBusinessProfileReadiness,
  getOperatorBusinessProfile,
  upsertOperatorBusinessProfile,
} from "../src/services/operator/operatorBusinessProfileService.js";

test("business profile readiness reports missing operator context clearly", () => {
  const readiness = buildBusinessProfileReadiness({
    businessSummary: "Family-owned plumbing service.",
    services: [{ name: "Emergency plumbing" }],
    pricing: [],
    policies: [],
    serviceAreas: [],
    operatingHours: [],
    approvedContactChannels: ["website_chat"],
    approvalPreferences: {
      followUpDrafts: "owner_required",
    },
  });

  assert.equal(readiness.completedSections, 4);
  assert.equal(readiness.missingCount, 4);
  assert.match(readiness.summary, /Missing: Pricing, Policies, Service areas, Operating hours\./);
});

test("business profile read falls back safely when persistence is unavailable", async () => {
  const supabase = {
    from(tableName) {
      assert.equal(tableName, "operator_business_profiles");
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    async maybeSingle() {
                      return {
                        data: null,
                        error: {
                          code: "42P01",
                          message: "relation 'public.operator_business_profiles' does not exist",
                        },
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
  };

  const profile = await getOperatorBusinessProfile(supabase, {
    agent: {
      id: "agent-1",
      businessId: "business-1",
      contactEmail: "owner@example.com",
      contactPhone: "+1 555 0100",
    },
    ownerUserId: "owner-1",
  });

  assert.equal(profile.persistenceAvailable, false);
  assert.equal(profile.migrationRequired, true);
  assert.deepEqual(Array.from(profile.approvedContactChannels), ["website_chat", "email", "phone"]);
  assert.match(profile.readiness.summary, /Missing:/);
});

test("business profile prefill mines website knowledge and current contact settings safely", () => {
  const prefill = buildOperatorBusinessProfilePrefill({
    agent: {
      contactEmail: "owner@example.com",
      contactPhone: "+1 555 0100",
      businessHoursNote: "Mon-Fri | 9am-5pm",
    },
    websiteContent: {
      metaDescription: "Family-owned plumbing team for emergency repairs and installs.",
      content: [
        "Headings:",
        "Emergency plumbing",
        "Water heater installation",
        "Pricing starts at $149 for diagnostics",
        "Serving Austin and Round Rock",
        "Mon-Fri | 9am-5pm",
        "Cancellation policy | Please give 24 hours notice",
      ].join("\n"),
    },
    profile: {},
  });

  assert.equal(prefill.available, true);
  assert.match(prefill.suggestions.businessSummary.value, /Family-owned plumbing/i);
  assert.ok(prefill.suggestions.services.some((entry) => /Emergency plumbing/i.test(entry.name)));
  assert.ok(prefill.suggestions.pricing.some((entry) => /\$149/i.test(entry.amount || entry.details)));
  assert.ok(prefill.suggestions.policies.some((entry) => /24 hours notice/i.test(entry.details)));
  assert.ok(prefill.suggestions.serviceAreas.some((entry) => /Austin/i.test(entry.name)));
  assert.ok(prefill.suggestions.operatingHours.some((entry) => /9am-5pm/i.test(entry.hours)));
  assert.deepEqual(Array.from(prefill.suggestions.approvedContactChannels), ["website_chat", "email", "phone"]);
});

test("business profile upsert persists structured operator context", async () => {
  const captured = [];
  const supabase = {
    from(tableName) {
      assert.equal(tableName, "operator_business_profiles");
      return {
        upsert(payload) {
          captured.push(payload);
          return {
            select() {
              return {
                async single() {
                  return {
                    data: {
                      id: "profile-1",
                      ...payload,
                      created_at: "2026-04-04T10:00:00.000Z",
                      updated_at: "2026-04-04T10:00:00.000Z",
                    },
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

  const result = await upsertOperatorBusinessProfile(supabase, {
    agent: {
      id: "agent-1",
      businessId: "business-1",
    },
    ownerUserId: "owner-1",
    profile: {
      businessSummary: "Emergency plumbing and water heater installs.",
      services: [{ name: "Emergency plumbing", note: "Same-day response" }],
      pricing: [{ label: "Diagnostics", amount: "$149", details: "Starting price" }],
      approvedContactChannels: ["website_chat", "email"],
      approvalPreferences: {
        followUpDrafts: "owner_required",
        contactNextSteps: "recommend_only",
      },
    },
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].agent_id, "agent-1");
  assert.equal(captured[0].owner_user_id, "owner-1");
  assert.equal(captured[0].services[0].name, "Emergency plumbing");
  assert.equal(result.businessSummary, "Emergency plumbing and water heater installs.");
  assert.equal(result.approvalPreferences.contactNextSteps, "recommend_only");
});
