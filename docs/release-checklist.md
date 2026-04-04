# Vonza Release Checklist

1. Merge the tested branch to `main`.
2. Confirm the `Production Deploy` workflow passes:
   - `npm run test:smoke`
   - `npm run check:schema-sync`
   - `npm run validate:clean-db`
   - `supabase db push`
   - `supabase migration list` with matching local and remote versions
3. Confirm Render deploy hook fires only after migrations succeed.
4. Verify `GET /build`, `GET /health`, and `GET /dashboard` on the deployed service.
5. If CI or production needs manual recovery, use:
   - `docs/sql/prod_recovery_startup.sql` for startup-only repair on an existing database
   - `docs/sql/prod_recovery_full_current_main.sql` for full current-main parity
