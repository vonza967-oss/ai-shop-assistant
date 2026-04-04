export const SUPABASE_MIGRATIONS_DIR = "supabase/migrations";

export const SUPABASE_MIGRATIONS = Object.freeze([
  Object.freeze({
    id: "initial_schema_base",
    version: "20260404000000",
    name: "initial_schema_base",
    file: "supabase/migrations/20260404000000_initial_schema_base.sql",
    legacySources: Object.freeze(["db/schema.sql"]),
    tier: "foundation",
    note: "Bootstrap baseline for pre-CLI projects. Covers the pre-increment foundation only so later ordered migrations still carry the real schema history.",
  }),
  Object.freeze({
    id: "owner_access",
    version: "20260404000100",
    name: "owner_access",
    file: "supabase/migrations/20260404000100_owner_access.sql",
    legacySources: Object.freeze(["db/owner_access.sql"]),
    tier: "full-current-main",
    note: "Adds agents.owner_user_id and access_status. Required before action queue ownership backfills when legacy databases are behind.",
  }),
  Object.freeze({
    id: "messages_visitor_identity",
    version: "20260404000200",
    name: "messages_visitor_identity",
    file: "supabase/migrations/20260404000200_messages_visitor_identity.sql",
    legacySources: Object.freeze(["db/messages_visitor_identity.sql"]),
    tier: "startup-critical",
    note: "Adds messages.session_key for startup-safe message persistence and session-aware chat history.",
  }),
  Object.freeze({
    id: "install_verification_activation_loop",
    version: "20260404000300",
    name: "install_verification_activation_loop",
    file: "supabase/migrations/20260404000300_install_verification_activation_loop.sql",
    legacySources: Object.freeze(["db/install_verification_activation_loop.sql"]),
    tier: "startup-critical",
    note: "Adds install verification fields plus agent_widget_events telemetry storage required by startup install and widget telemetry probes.",
  }),
  Object.freeze({
    id: "live_conversion_loop",
    version: "20260404000400",
    name: "live_conversion_loop",
    file: "supabase/migrations/20260404000400_live_conversion_loop.sql",
    legacySources: Object.freeze(["db/live_conversion_loop.sql"]),
    tier: "startup-critical",
    note: "Adds agent_contact_leads for live lead capture. Required by startup lead-capture validation.",
  }),
  Object.freeze({
    id: "action_queue_statuses",
    version: "20260404000500",
    name: "action_queue_statuses",
    file: "supabase/migrations/20260404000500_action_queue_statuses.sql",
    legacySources: Object.freeze(["db/action_queue_statuses.sql"]),
    tier: "startup-critical",
    note: "Adds owner-scoped action queue persistence used during startup. Legacy backfill behavior depends on owner_access already existing.",
  }),
  Object.freeze({
    id: "agent_follow_up_workflows",
    version: "20260404000600",
    name: "agent_follow_up_workflows",
    file: "supabase/migrations/20260404000600_agent_follow_up_workflows.sql",
    legacySources: Object.freeze(["db/agent_follow_up_workflows.sql"]),
    tier: "startup-critical",
    note: "Adds follow-up workflow persistence required by startup workflow validation.",
  }),
  Object.freeze({
    id: "agent_knowledge_fix_workflows",
    version: "20260404000700",
    name: "agent_knowledge_fix_workflows",
    file: "supabase/migrations/20260404000700_agent_knowledge_fix_workflows.sql",
    legacySources: Object.freeze(["db/agent_knowledge_fix_workflows.sql"]),
    tier: "startup-critical",
    note: "Adds knowledge-fix workflow persistence required by startup workflow validation.",
  }),
  Object.freeze({
    id: "conversion_outcomes",
    version: "20260404000800",
    name: "conversion_outcomes",
    file: "supabase/migrations/20260404000800_conversion_outcomes.sql",
    legacySources: Object.freeze(["db/conversion_outcomes.sql"]),
    tier: "startup-critical",
    note: "Adds agent_conversion_outcomes and success URL persistence required by startup conversion outcome validation.",
  }),
  Object.freeze({
    id: "direct_conversion_routing",
    version: "20260404000900",
    name: "direct_conversion_routing",
    file: "supabase/migrations/20260404000900_direct_conversion_routing.sql",
    legacySources: Object.freeze(["db/direct_conversion_routing.sql"]),
    tier: "feature-gated",
    note: "Adds direct CTA routing fields on widget_configs. Useful for routing behavior, but not required to boot current main.",
  }),
  Object.freeze({
    id: "connected_operator_workspace",
    version: "20260404001000",
    name: "connected_operator_workspace",
    file: "supabase/migrations/20260404001000_connected_operator_workspace.sql",
    legacySources: Object.freeze(["db/connected_operator_workspace.sql"]),
    tier: "operator-only",
    note: "Adds Google/operator inbox, calendar, and campaign workspace tables. Operator-only and not startup-critical.",
  }),
  Object.freeze({
    id: "contacts_people_workspace",
    version: "20260404001100",
    name: "contacts_people_workspace",
    file: "supabase/migrations/20260404001100_contacts_people_workspace.sql",
    legacySources: Object.freeze(["db/contacts_people_workspace.sql"]),
    tier: "operator-only",
    note: "Adds operator contact graph tables and contact foreign keys across operator flows. Operator-only and not startup-critical.",
  }),
  Object.freeze({
    id: "cross_channel_outcomes",
    version: "20260404001200",
    name: "cross_channel_outcomes",
    file: "supabase/migrations/20260404001200_cross_channel_outcomes.sql",
    legacySources: Object.freeze(["db/cross_channel_outcomes.sql"]),
    tier: "operator-only",
    note: "Extends conversion outcomes with cross-channel operator attribution fields. Operator-only and not startup-critical.",
  }),
  Object.freeze({
    id: "operator_business_profiles",
    version: "20260404001300",
    name: "operator_business_profiles",
    file: "supabase/migrations/20260404001300_operator_business_profiles.sql",
    legacySources: Object.freeze(["db/operator_business_profiles.sql"]),
    tier: "operator-only",
    note: "Adds durable operator-focused business profile context for Today + Copilot summaries and approval-first drafts.",
  }),
]);

export const SUPABASE_MIGRATION_FILE_BY_ID = Object.freeze(
  Object.fromEntries(SUPABASE_MIGRATIONS.map((migration) => [migration.id, migration.file]))
);

export const SUPABASE_MIGRATION_IDS = Object.freeze(
  SUPABASE_MIGRATIONS.map((migration) => migration.id)
);

export const LEGACY_SOURCE_TO_SUPABASE_FILE = Object.freeze(
  Object.fromEntries(
    SUPABASE_MIGRATIONS.flatMap((migration) =>
      migration.legacySources.map((legacySource) => [legacySource, migration.file])
    )
  )
);

export function getSupabaseMigration(migrationId) {
  return SUPABASE_MIGRATIONS.find((migration) => migration.id === migrationId) || null;
}

export function getSupabaseMigrationFiles(migrationIds = []) {
  return migrationIds
    .map((migrationId) => getSupabaseMigration(migrationId)?.file || "")
    .filter(Boolean);
}

export function getSupabaseMigrationLegacySources(migrationIds = []) {
  return migrationIds.flatMap(
    (migrationId) => getSupabaseMigration(migrationId)?.legacySources || []
  );
}
