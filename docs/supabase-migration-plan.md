# Vonza Supabase Migration Plan

`supabase/migrations/` is now the release source of truth. `db/schema.sql` remains the canonical snapshot, and the legacy `db/*.sql` files remain as audited source references only.

## Ordered mapping

| Supabase migration | Source mapping | Notes |
| --- | --- | --- |
| `supabase/migrations/20260404000000_initial_schema_base.sql` | `db/schema.sql` foundational snapshot only | Bootstrap baseline for pre-CLI projects. Intentionally excludes later feature tables/columns so subsequent ordered migrations still matter. |
| `supabase/migrations/20260404000100_owner_access.sql` | `db/owner_access.sql` | Must precede `action_queue_statuses`. |
| `supabase/migrations/20260404000200_messages_visitor_identity.sql` | `db/messages_visitor_identity.sql` | Startup-critical. |
| `supabase/migrations/20260404000300_install_verification_activation_loop.sql` | `db/install_verification_activation_loop.sql` | Startup-critical. |
| `supabase/migrations/20260404000400_live_conversion_loop.sql` | `db/live_conversion_loop.sql` | Startup-critical and required before connected operator workspace tables that reference leads. |
| `supabase/migrations/20260404000500_action_queue_statuses.sql` | `db/action_queue_statuses.sql` | Startup-critical, assumes `owner_access` ran first. |
| `supabase/migrations/20260404000600_agent_follow_up_workflows.sql` | `db/agent_follow_up_workflows.sql` | Startup-critical and required before connected operator workspace tables that reference follow-up rows. |
| `supabase/migrations/20260404000700_agent_knowledge_fix_workflows.sql` | `db/agent_knowledge_fix_workflows.sql` | Startup-critical. |
| `supabase/migrations/20260404000800_conversion_outcomes.sql` | `db/conversion_outcomes.sql` | Startup-critical and required before contact/cross-channel extensions. |
| `supabase/migrations/20260404000900_direct_conversion_routing.sql` | `db/direct_conversion_routing.sql` | Feature-gated, not startup-critical. |
| `supabase/migrations/20260404001000_connected_operator_workspace.sql` | `db/connected_operator_workspace.sql` | Operator-only. Requires leads + follow-up tables already present. |
| `supabase/migrations/20260404001100_contacts_people_workspace.sql` | `db/contacts_people_workspace.sql` | Operator-only. Requires connected operator workspace + conversion outcomes. |
| `supabase/migrations/20260404001200_cross_channel_outcomes.sql` | `db/cross_channel_outcomes.sql` | Operator-only. Must run after conversion outcomes. |
| `supabase/migrations/20260404001300_operator_business_profiles.sql` | `db/operator_business_profiles.sql` | Operator-only. Adds Today + Copilot business profile persistence. |

## Release flow

1. Merge to `main`.
2. GitHub Actions runs tests and `npm run check:schema-sync`.
3. The production workflow links the production Supabase project and runs `supabase db push`.
4. The workflow runs `supabase migration list` and fails if local and remote versions are not identical.
5. Only after migration confirmation does the workflow trigger the Render deploy hook.

## Existing projects

This repo already had production schema applied manually. The baseline migration is intentionally idempotent so the first CI-driven `supabase db push` can establish migration history on the existing project instead of requiring a destructive reset. If remote history ever drifts, use Supabase's `migration repair` flow deliberately and document the repair in the next release note.
