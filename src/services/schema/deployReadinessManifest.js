import {
  ACTION_QUEUE_STATUS_TABLE,
  CONVERSION_OUTCOME_TABLE,
  FOLLOW_UP_WORKFLOW_TABLE,
  KNOWLEDGE_FIX_WORKFLOW_TABLE,
  LEAD_CAPTURE_TABLE,
  MESSAGES_TABLE,
} from "../../config/constants.js";
import { assertWidgetTelemetrySchemaReady } from "../analytics/widgetTelemetryService.js";
import { assertActionQueueSchemaReady } from "../analytics/actionQueueService.js";
import { assertMessagesSchemaReady } from "../chat/messageService.js";
import { assertConversionOutcomeSchemaReady } from "../conversion/conversionOutcomeService.js";
import { assertFollowUpWorkflowSchemaReady } from "../followup/followUpService.js";
import { assertInstallSchemaReady } from "../install/installPresenceService.js";
import { assertKnowledgeFixWorkflowSchemaReady } from "../knowledge/knowledgeFixService.js";
import { assertLeadCaptureSchemaReady } from "../leads/liveLeadCaptureService.js";
import {
  getSupabaseMigration,
  getSupabaseMigrationFiles,
  getSupabaseMigrationLegacySources,
  SUPABASE_MIGRATIONS,
} from "./supabaseMigrationCatalog.js";

export const DEPLOY_READINESS_DOCS = Object.freeze({
  migrationPlan: "docs/supabase-migration-plan.md",
  startupBundle: "docs/sql/prod_recovery_startup.sql",
  fullCurrentMainBundle: "docs/sql/prod_recovery_full_current_main.sql",
  deployNote: "docs/render-supabase-deploy.md",
  releaseChecklist: "docs/release-checklist.md",
});

export const REQUIRED_STARTUP_ENV_VARS = Object.freeze([
  {
    name: "PUBLIC_APP_URL",
    note: "Render production base URL used for redirects, callback defaults, and health/build verification.",
  },
  {
    name: "SUPABASE_URL",
    note: "Supabase project URL required for server startup and live readiness verification.",
  },
  {
    name: "SUPABASE_ANON_KEY",
    note: "Browser/runtime public key required for dashboard and public app flows.",
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    note: "Server-side Supabase key required for boot-time schema validation and data access.",
  },
]);

const DEPLOY_MIGRATIONS = SUPABASE_MIGRATIONS;

export const DEPLOY_MIGRATION_MANIFEST = Object.freeze(
  Object.fromEntries(DEPLOY_MIGRATIONS.map((migration) => [migration.id, Object.freeze({ ...migration })]))
);

export const FULL_CURRENT_MAIN_MIGRATION_IDS = Object.freeze(
  DEPLOY_MIGRATIONS.map((migration) => migration.id)
);

export const STARTUP_CRITICAL_MIGRATION_IDS = Object.freeze(
  DEPLOY_MIGRATIONS
    .filter((migration) => migration.tier === "startup-critical")
    .map((migration) => migration.id)
);

export const FEATURE_GATED_MIGRATION_IDS = Object.freeze(
  DEPLOY_MIGRATIONS
    .filter((migration) => migration.tier === "feature-gated")
    .map((migration) => migration.id)
);

export const OPERATOR_ONLY_MIGRATION_IDS = Object.freeze(
  DEPLOY_MIGRATIONS
    .filter((migration) => migration.tier === "operator-only")
    .map((migration) => migration.id)
);

export const STARTUP_SCHEMA_CHECKS = Object.freeze([
  Object.freeze({
    id: "messages",
    label: "message persistence",
    table: MESSAGES_TABLE,
    migrationIds: Object.freeze(["messages_visitor_identity"]),
    prerequisiteMigrationIds: Object.freeze([]),
    note: "Startup probes message history with messages.session_key present.",
    assertReady: assertMessagesSchemaReady,
  }),
  Object.freeze({
    id: "install",
    label: "install verification",
    table: "widget_configs + agent_installations",
    migrationIds: Object.freeze(["install_verification_activation_loop"]),
    prerequisiteMigrationIds: Object.freeze([]),
    note: "Startup expects widget install verification fields and installation tracking columns.",
    assertReady: assertInstallSchemaReady,
  }),
  Object.freeze({
    id: "widget_telemetry",
    label: "widget telemetry",
    table: "agent_widget_events",
    migrationIds: Object.freeze(["install_verification_activation_loop"]),
    prerequisiteMigrationIds: Object.freeze([]),
    note: "Startup expects the agent_widget_events table used by widget telemetry ingestion.",
    assertReady: assertWidgetTelemetrySchemaReady,
  }),
  Object.freeze({
    id: "lead_capture",
    label: "live lead-capture",
    table: LEAD_CAPTURE_TABLE,
    migrationIds: Object.freeze(["live_conversion_loop"]),
    prerequisiteMigrationIds: Object.freeze([]),
    note: "Startup expects agent_contact_leads for live conversion and lead capture flows.",
    assertReady: assertLeadCaptureSchemaReady,
  }),
  Object.freeze({
    id: "action_queue",
    label: "action queue",
    table: ACTION_QUEUE_STATUS_TABLE,
    migrationIds: Object.freeze(["action_queue_statuses"]),
    prerequisiteMigrationIds: Object.freeze(["owner_access"]),
    note: "Startup expects action queue persistence. If owner_access coverage is uncertain, use the full current-main bundle.",
    assertReady: assertActionQueueSchemaReady,
  }),
  Object.freeze({
    id: "follow_up_workflows",
    label: "follow-up workflow",
    table: FOLLOW_UP_WORKFLOW_TABLE,
    migrationIds: Object.freeze(["agent_follow_up_workflows"]),
    prerequisiteMigrationIds: Object.freeze([]),
    note: "Startup expects follow-up workflow persistence to exist before boot.",
    assertReady: assertFollowUpWorkflowSchemaReady,
  }),
  Object.freeze({
    id: "knowledge_fix_workflows",
    label: "knowledge-fix workflow",
    table: KNOWLEDGE_FIX_WORKFLOW_TABLE,
    migrationIds: Object.freeze(["agent_knowledge_fix_workflows"]),
    prerequisiteMigrationIds: Object.freeze([]),
    note: "Startup expects knowledge-fix workflow persistence to exist before boot.",
    assertReady: assertKnowledgeFixWorkflowSchemaReady,
  }),
  Object.freeze({
    id: "conversion_outcomes",
    label: "conversion outcomes",
    table: CONVERSION_OUTCOME_TABLE,
    migrationIds: Object.freeze(["conversion_outcomes"]),
    prerequisiteMigrationIds: Object.freeze([]),
    note: "Startup expects conversion outcome storage to exist before boot.",
    assertReady: assertConversionOutcomeSchemaReady,
  }),
]);

export function getManifestMigration(migrationId) {
  return getSupabaseMigration(migrationId);
}

export function getManifestMigrationFiles(migrationIds = []) {
  return getSupabaseMigrationFiles(migrationIds);
}

export function getManifestLegacySources(migrationIds = []) {
  return getSupabaseMigrationLegacySources(migrationIds);
}

export function getStartupSchemaCheck(checkId) {
  return STARTUP_SCHEMA_CHECKS.find((check) => check.id === checkId) || null;
}

export function buildStartupSchemaManifestMessage({ phase, check, cause }) {
  const migrationFiles = getManifestMigrationFiles(check.migrationIds);
  const prerequisiteFiles = getManifestMigrationFiles(check.prerequisiteMigrationIds);
  const legacyFiles = getManifestLegacySources(check.migrationIds);
  const detail = String(cause?.message || "").trim();
  const segments = [
    `[${phase}] Startup schema check '${check.label}' failed for '${check.table}'.`,
    `Required migration(s): ${migrationFiles.join(", ")}.`,
  ];

  if (prerequisiteFiles.length) {
    segments.push(`Prerequisite migration(s): ${prerequisiteFiles.join(", ")}.`);
  }

  if (legacyFiles.length) {
    segments.push(`Legacy source mapping: ${legacyFiles.join(", ")}.`);
  }

  segments.push(`Migration plan: ${DEPLOY_READINESS_DOCS.migrationPlan}.`);
  segments.push(`Startup recovery bundle: ${DEPLOY_READINESS_DOCS.startupBundle}.`);
  segments.push(`Full current-main bundle: ${DEPLOY_READINESS_DOCS.fullCurrentMainBundle}.`);
  segments.push(`Manifest note: ${check.note}`);

  if (detail) {
    segments.push(`Original check: ${detail}`);
  }

  return segments.join(" ");
}
