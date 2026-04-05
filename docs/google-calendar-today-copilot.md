# Google Calendar-First Today/Copilot

This slice keeps the operator workspace approval-first and intentionally narrow:

- Google OAuth requests only basic identity plus read-only Google Calendar access.
- OAuth uses offline access so refresh-token-based sync remains possible.
- Today surfaces:
  - a Google connect empty state
  - today's schedule
  - appointments needing follow-up
  - appointments not linked to a contact
- Copilot stays read-only and draft-first. It can propose follow-up drafts, operator tasks, and outcome review suggestions, but it does not auto-send, auto-create, or auto-run anything.

Required env vars:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `GOOGLE_TOKEN_ENCRYPTION_SECRET`
- `VONZA_OPERATOR_WORKSPACE_V1`
- `VONZA_TODAY_COPILOT_V1`

Google Cloud setup notes:

- Configure a Web application OAuth client.
- Add the deployed `/google/oauth/callback` URL as an authorized redirect URI.
- Enable Google Calendar API access for the project.
