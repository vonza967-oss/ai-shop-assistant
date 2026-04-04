# Render and Supabase Deploy Note

Render deploys Vonza application code only. Supabase migrations now run in GitHub Actions first, and Render should deploy only after that workflow succeeds.

Current main has three deploy-readiness migration groups:

- Startup-critical migrations: required for the app process to boot. If these tables or columns are missing, startup schema validation exits the process. Recovery bundle: `docs/sql/prod_recovery_startup.sql`
- Full current-main migrations: the full audited Supabase migration order for current `main`, including the bootstrap baseline plus all later schema layers. Recovery bundle: `docs/sql/prod_recovery_full_current_main.sql`
- Feature-gated / operator-only migrations: later routing, workspace, and attribution layers that should never be confused with startup-critical rollout requirements.

Practical deploy flow:

1. Merge to `main`.
2. GitHub Actions runs tests, `npm run check:schema-sync`, and `npm run validate:clean-db`.
3. The workflow links the production Supabase project, runs `supabase db push`, then runs `supabase migration list` and fails if local and remote versions differ.
4. Only after the migration state is confirmed does the workflow call the Render deploy hook.
5. Verify `GET /build`, `GET /health`, and `GET /dashboard`.

Render enforcement:

- `render.yaml` now sets `autoDeploy: false`. The Render service must stay hook-driven so a plain git push cannot race ahead of Supabase migrations.
- If the service was created outside the Blueprint flow, set the Render dashboard to `Auto-Deploy: Off` and keep the deploy hook configured in `RENDER_DEPLOY_HOOK_URL`.
- `render.yaml` still runs `npm run verify:deploy-readiness` during the build step.
- `npm run start:prod` still performs deploy-readiness verification before boot.
- Startup schema diagnostics now point directly at the manifest-backed `supabase/migrations` mapping and recovery bundles.

Emergency recovery:

- Prefer fixing CI and re-running the workflow.
- If production is already broken and you need manual intervention, `docs/sql/prod_recovery_startup.sql` and `docs/sql/prod_recovery_full_current_main.sql` remain SQL Editor recovery bundles.
- Manual SQL Editor fixes should be rare and followed by reconciling migration history.
