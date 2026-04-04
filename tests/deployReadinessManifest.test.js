import test from "node:test";
import assert from "node:assert/strict";

import {
  DEPLOY_READINESS_DOCS,
  FEATURE_GATED_MIGRATION_IDS,
  getManifestMigrationFiles,
  OPERATOR_ONLY_MIGRATION_IDS,
  STARTUP_CRITICAL_MIGRATION_IDS,
  STARTUP_SCHEMA_CHECKS,
} from "../src/services/schema/deployReadinessManifest.js";
import {
  evaluateDeployReadinessManifest,
  extractBundleSourceFiles,
  readRepoFile,
} from "../scripts/lib/deployReadiness.js";

test("startup recovery bundle order matches manifest and startup validators", () => {
  const startupBundleSources = extractBundleSourceFiles(readRepoFile(DEPLOY_READINESS_DOCS.startupBundle));
  const expectedSources = getManifestMigrationFiles(STARTUP_CRITICAL_MIGRATION_IDS);
  const validatorSources = [...new Set(STARTUP_SCHEMA_CHECKS.flatMap((check) => getManifestMigrationFiles(check.migrationIds)))];

  assert.deepEqual(startupBundleSources, expectedSources);
  assert.deepEqual(validatorSources, expectedSources);
});

test("feature-gated and operator-only migrations stay outside startup-critical rollout", () => {
  const startupSet = new Set(STARTUP_CRITICAL_MIGRATION_IDS);

  FEATURE_GATED_MIGRATION_IDS.forEach((migrationId) => {
    assert.equal(startupSet.has(migrationId), false, `${migrationId} should not be startup-critical`);
  });

  OPERATOR_ONLY_MIGRATION_IDS.forEach((migrationId) => {
    assert.equal(startupSet.has(migrationId), false, `${migrationId} should not be startup-critical`);
  });
});

test("deploy readiness manifest remains internally consistent", () => {
  assert.deepEqual(evaluateDeployReadinessManifest(), []);
});
