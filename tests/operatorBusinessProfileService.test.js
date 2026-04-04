import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBusinessProfileReadiness,
  getOperatorBusinessProfile,
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
