import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { logSupabaseStartupCheck } from "../../src/clients/supabaseClient.js";
import {
  DEPLOY_MIGRATION_MANIFEST,
  DEPLOY_READINESS_DOCS,
  FEATURE_GATED_MIGRATION_IDS,
  FULL_CURRENT_MAIN_MIGRATION_IDS,
  getManifestMigrationFiles,
  OPERATOR_ONLY_MIGRATION_IDS,
  REQUIRED_STARTUP_ENV_VARS,
  STARTUP_CRITICAL_MIGRATION_IDS,
  STARTUP_SCHEMA_CHECKS,
} from "../../src/services/schema/deployReadinessManifest.js";
import { validateStartupSchemaReady } from "../../src/services/schema/startupSchemaService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const BUNDLE_SOURCE_PATTERN = /^-- Source:\s+((?:supabase\/migrations|db)\/[^\s]+\.sql)$/gm;

export function getRepoRoot() {
  return REPO_ROOT;
}

export function readRepoFile(relativePath) {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

export function extractBundleSourceFiles(sqlText) {
  return Array.from(String(sqlText || "").matchAll(BUNDLE_SOURCE_PATTERN), (match) => match[1]);
}

export function getMissingStartupEnvVars(env = process.env) {
  return REQUIRED_STARTUP_ENV_VARS.filter(({ name }) => !String(env[name] || "").trim());
}

function unique(values = []) {
  return [...new Set(values)];
}

function isSubset(subset = [], full = []) {
  const fullSet = new Set(full);
  return subset.every((value) => fullSet.has(value));
}

function formatManifestFiles(migrationIds = []) {
  return getManifestMigrationFiles(migrationIds).join(", ");
}

export function evaluateDeployReadinessManifest() {
  const errors = [];
  const manifestIds = Object.keys(DEPLOY_MIGRATION_MANIFEST);

  if (manifestIds.length !== FULL_CURRENT_MAIN_MIGRATION_IDS.length) {
    errors.push("Full current-main migration order does not cover every manifest migration exactly once.");
  }

  if (!isSubset(STARTUP_CRITICAL_MIGRATION_IDS, FULL_CURRENT_MAIN_MIGRATION_IDS)) {
    errors.push("Startup-critical migrations must be a subset of full-current-main migrations.");
  }

  if (!isSubset(FEATURE_GATED_MIGRATION_IDS, FULL_CURRENT_MAIN_MIGRATION_IDS)) {
    errors.push("Feature-gated migrations must be a subset of full-current-main migrations.");
  }

  if (!isSubset(OPERATOR_ONLY_MIGRATION_IDS, FULL_CURRENT_MAIN_MIGRATION_IDS)) {
    errors.push("Operator-only migrations must be a subset of full-current-main migrations.");
  }

  const startupSet = new Set(STARTUP_CRITICAL_MIGRATION_IDS);

  FEATURE_GATED_MIGRATION_IDS.forEach((migrationId) => {
    if (startupSet.has(migrationId)) {
      errors.push(`Feature-gated migration '${migrationId}' cannot also be startup-critical.`);
    }
  });

  OPERATOR_ONLY_MIGRATION_IDS.forEach((migrationId) => {
    if (startupSet.has(migrationId)) {
      errors.push(`Operator-only migration '${migrationId}' cannot also be startup-critical.`);
    }
  });

  FULL_CURRENT_MAIN_MIGRATION_IDS.forEach((migrationId) => {
    const migration = DEPLOY_MIGRATION_MANIFEST[migrationId];

    if (!migration) {
      errors.push(`Manifest is missing migration '${migrationId}'.`);
      return;
    }

    if (!existsSync(path.join(REPO_ROOT, migration.file))) {
      errors.push(`Manifest references missing migration file '${migration.file}'.`);
    }
  });

  const startupBundleSources = extractBundleSourceFiles(readRepoFile(DEPLOY_READINESS_DOCS.startupBundle));
  const expectedStartupSources = getManifestMigrationFiles(STARTUP_CRITICAL_MIGRATION_IDS);

  if (startupBundleSources.join("|") !== expectedStartupSources.join("|")) {
    errors.push(
      `Startup recovery bundle order does not match the startup-critical manifest. Expected ${expectedStartupSources.join(", ")} but found ${startupBundleSources.join(", ")}.`
    );
  }

  const fullBundleSources = extractBundleSourceFiles(readRepoFile(DEPLOY_READINESS_DOCS.fullCurrentMainBundle));
  const expectedFullSources = getManifestMigrationFiles(FULL_CURRENT_MAIN_MIGRATION_IDS);

  if (fullBundleSources.join("|") !== expectedFullSources.join("|")) {
    errors.push(
      `Full current-main bundle order does not match the manifest. Expected ${expectedFullSources.join(", ")} but found ${fullBundleSources.join(", ")}.`
    );
  }

  const directStartupMigrationIds = unique(
    STARTUP_SCHEMA_CHECKS.flatMap((check) => check.migrationIds)
  );

  if (directStartupMigrationIds.join("|") !== STARTUP_CRITICAL_MIGRATION_IDS.join("|")) {
    errors.push(
      `Startup schema validators do not align with startup-critical manifest migrations. Validators cover ${formatManifestFiles(directStartupMigrationIds)} while manifest expects ${formatManifestFiles(STARTUP_CRITICAL_MIGRATION_IDS)}.`
    );
  }

  STARTUP_SCHEMA_CHECKS.forEach((check) => {
    if (!check.migrationIds.length) {
      errors.push(`Startup schema check '${check.id}' is missing required migration mappings.`);
    }

    check.migrationIds.forEach((migrationId) => {
      if (!STARTUP_CRITICAL_MIGRATION_IDS.includes(migrationId)) {
        errors.push(
          `Startup schema check '${check.id}' references non-startup migration '${migrationId}'.`
        );
      }
    });

    check.prerequisiteMigrationIds.forEach((migrationId) => {
      if (!FULL_CURRENT_MAIN_MIGRATION_IDS.includes(migrationId)) {
        errors.push(
          `Startup schema check '${check.id}' references unknown prerequisite migration '${migrationId}'.`
        );
      }
    });
  });

  return errors;
}

export async function verifyLiveStartupSchema({ env = process.env, logger = console } = {}) {
  const supabaseUrl = String(env.SUPABASE_URL || "").trim();
  const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!supabaseUrl || !serviceRoleKey) {
    return {
      skipped: true,
      reason: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.",
    };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  await logSupabaseStartupCheck(supabase);
  await validateStartupSchemaReady(supabase, { phase: "deploy-readiness" });
  logger.log("Live Supabase startup schema verification passed.");

  return {
    skipped: false,
  };
}

export function buildDeployReadinessError(issues = []) {
  return new Error(
    ["Deploy readiness verification failed:", ...issues.map((issue) => `- ${issue}`)].join("\n")
  );
}

export async function runDeployReadinessVerification({ env = process.env, logger = console } = {}) {
  const issues = [];
  const missingEnvVars = getMissingStartupEnvVars(env);

  if (missingEnvVars.length) {
    issues.push(
      ...missingEnvVars.map(
        ({ name, note }) => `Missing required startup env var '${name}'. ${note}`
      )
    );
  }

  issues.push(...evaluateDeployReadinessManifest());

  if (issues.length) {
    throw buildDeployReadinessError(issues);
  }

  logger.log("Required startup env vars: OK");
  logger.log("Deploy readiness manifest: OK");

  const liveResult = await verifyLiveStartupSchema({ env, logger });

  if (liveResult.skipped) {
    logger.log(`Live Supabase startup schema verification skipped: ${liveResult.reason}`);
  }
}
