import test from "node:test";
import assert from "node:assert/strict";

import { FEATURE_STATES, getPublicLaunchProfile } from "../src/config/publicLaunch.js";

test("public launch profile defines the stable core plus optional Google beta", () => {
  const profile = getPublicLaunchProfile({
    operatorWorkspaceEnabled: true,
  });

  assert.equal(profile.mode, "public_cohort_v1");
  assert.equal(profile.icp.key, "service_businesses_with_inbound_leads");
  assert.equal(profile.matrix.front_desk.state, FEATURE_STATES.STABLE);
  assert.equal(profile.matrix.today.state, FEATURE_STATES.STABLE);
  assert.equal(profile.matrix.contacts.state, FEATURE_STATES.STABLE);
  assert.equal(profile.matrix.outcomes.state, FEATURE_STATES.STABLE);
  assert.equal(profile.matrix.inbox.state, FEATURE_STATES.BETA);
  assert.equal(profile.matrix.calendar.state, FEATURE_STATES.BETA);
  assert.equal(profile.matrix.automations.state, FEATURE_STATES.BETA);
  assert.equal(profile.matrix.advanced_guidance.state, FEATURE_STATES.HIDDEN);
  assert.equal(profile.matrix.manual_outcome_marks.state, FEATURE_STATES.HIDDEN);
  assert.equal(profile.matrix.knowledge_fix_workflows.state, FEATURE_STATES.HIDDEN);
});

test("public launch profile hides operator beta surfaces when the workspace flag is off", () => {
  const profile = getPublicLaunchProfile({
    operatorWorkspaceEnabled: false,
  });

  assert.equal(profile.matrix.contacts.state, FEATURE_STATES.HIDDEN);
  assert.equal(profile.matrix.google_connect.state, FEATURE_STATES.HIDDEN);
  assert.equal(profile.matrix.inbox.state, FEATURE_STATES.HIDDEN);
  assert.equal(profile.matrix.calendar.state, FEATURE_STATES.HIDDEN);
  assert.equal(profile.matrix.automations.state, FEATURE_STATES.HIDDEN);
});
