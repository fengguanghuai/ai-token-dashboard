---
name: migrate-usage-database
description: Initialize and verify ai-token-dashboard databases, configure DATABASE_URL, and migrate the existing data/usage.sqlite data into PostgreSQL, Supabase, or MySQL. Use when centralizing statistics from several devices, moving off SQLite, setting up a fresh shared database, checking a remote database connection, or onboarding another machine to an existing shared database.
---

# Migrate Usage Database

Centralize the dashboard's multi-device data without exposing credentials or losing the local SQLite source.

## Workflow

1. Locate the `ai-token-dashboard` root and inspect `.env`, `.env.example`, `data/usage.sqlite`, and the current Git status.
2. Read [references/database-options.md](references/database-options.md) when choosing a provider, URL type, SSL mode, or Supabase connection mode.
3. Keep `data/usage.sqlite` unchanged as the rollback source. Never commit `.env`, database URLs, passwords, or exported data.
4. Configure one target in `.env`:
   - PostgreSQL/Supabase: `DATABASE_URL=postgresql://...`
   - MySQL: `DATABASE_URL=mysql://...`
   - SQLite fallback: omit `DATABASE_URL` and retain `DB_PATH=data/usage.sqlite`.
5. Run the deterministic wrapper from this skill directory:

   ```bash
   node scripts/database.mjs preflight
   node scripts/database.mjs init
   node scripts/database.mjs migrate
   node scripts/database.mjs check
   ```

6. Compare `daily_usage`, `session_usage`, and `time_usage` source/target counts. Treat `collection_runs` as a bounded operational log: migrate it only when the target is empty.
7. Start the app with the same `.env`, request `/api/data` and `/api/hourly`, and confirm successful responses before switching additional devices.
8. Configure every other device with the same `DATABASE_URL`, run `node scripts/database.mjs init`, then collect normally. Do not rerun the original SQLite migration on machines that have no local history.

## Commands

- `preflight`: inspect the SQLite source and target configuration without writing target rows.
- `init`: create or upgrade the target schema. Safe to rerun.
- `migrate`: batch-upsert durable usage tables, optionally copy an empty target's run log, and verify counts.
- `check`: connect with the configured driver and print table counts.

Pass `--project /absolute/path` when the skill is not inside the repository. Pass migration options after the command, for example `--from /path/usage.sqlite` or `--skip-runs`.

## Safety rules

- Redact passwords whenever displaying a connection URL.
- Prefer Supabase's session pooler URL for long-running Node servers and IPv4 compatibility; require TLS.
- Stop before destructive target cleanup. The normal migration only creates tables and upserts rows.
- Run `preflight` before `migrate`, and keep the source SQLite file until verification succeeds.
- If a connection fails, distinguish DNS/IPv4, TLS, credentials, and schema errors before changing data.
