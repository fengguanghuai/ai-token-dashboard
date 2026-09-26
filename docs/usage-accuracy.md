# Usage accounting and upgrades

Collectors read local usage metadata. They do not send session content to model
providers. Prices are estimates unless the source records a billed amount.

## Accounting rules

- Codex output already includes reasoning tokens. The reasoning column is a
  detail, not an additional charge. Daily and workspace costs sum request costs.
- Claude response copies are matched by session and message identity. A copied
  side conversation is excluded only when the parent response is available.
  Advisor usage remains attributed to its own model.
- OpenCode reads both `message` and `session_message` SQLite tables and legacy
  JSON. Different messages are not duplicates merely because their token counts
  match. Files without IDs use their canonical paths; WAL changes invalidate
  cached database reads.
- Hermes uses per-model/provider usage when available and retains session totals
  for sessions without usable detail. Workspace totals combine providers without
  dropping a model.
- OpenClaw reads JSONL, gzip/zstd archives, per-agent SQLite transcripts and cold
  archive blobs. Stable event IDs prevent counting stored copies twice.
  Checkpoint snapshots are not new requests. Dedicated `agent/codex-home`
  rollouts belong to OpenClaw; a corresponding mirrored response is excluded
  only after its underlying turn has been read. Shared external Codex homes are
  not reassigned automatically.
- Pi preserves total-only usage as unclassified tokens. It does not invent an
  input/output split or price for unknown token types. Known billed costs,
  including explicit zero, remain available.
- Gemini's recorded input includes cached prompt tokens. With no total hint,
  the collector retains the cache-inclusive interpretation.
- Known OpenAI and xAI long-context model families use prompt-wide thresholds,
  including cached input, and switch the entire request to the relevant rate.
  Aggregated daily records must not be treated as individual long requests.
- Price refresh retains entries absent from the latest catalog for historical
  model lookup. Current model entries are replaced as a unit so obsolete tiers
  are not carried forward. This is not a date-versioned tariff archive.

## Stored amounts and provenance

An unchanged event or daily summary retains its stored amount when prices are
refreshed. A late event adds its cost to an existing day only when all token
component deltas reconcile. Backfilling detail already included in a daily
summary does not charge the day again. Unexplained differences remain visible;
they are not silently replaced by a fresh estimate. Normal collection also
retains a stored day when missing/rotated logs would otherwise reduce it without
matching event corrections.

`costBasis` is one of `recorded`, `estimated`, `mixed`, `unknown`, or
`legacy_unknown`. `pricingVersion` identifies the available catalog snapshot,
not a historical tariff archive. Existing rows gain `legacy_unknown` metadata;
the schema upgrade does not change their amounts. Zero with unknown provenance
is not proof of free usage.

Project counts and rankings use only event details with a real filesystem path.
Session IDs and lifetime workspace totals are not substitutes for dated project
activity. Sources without timestamp/project detail (including Gemini's current
daily-only collector) are absent from those views. The UI shows coverage and
summary/detail differences; precise-view errors require retry, and an empty
precise range remains empty.

## Existing databases and scoped recovery

Normal collection stores a rebuildable per-device/source input checkpoint in
the database. Unchanged inputs skip usage-table reads; changed date buckets are
reconciled with their stored history. Event IDs, times, models, project metadata,
token components and cost metadata participate in the signature. This is not an
event-time cutoff: late historical usage still invalidates its date. Usage and
checkpoint writes commit together. Imports, restores and storage upserts
invalidate the relevant scope, including empty replacements. Missing, corrupt
or incompatible checkpoints fall back to complete reconciliation. See
[collection performance](collection-performance.md) for scope and validation.

Installing code does not automatically rebuild personal history. Node 22.15+
is the supported baseline for built-in SQLite and zstd readers. Stop scheduled
collection while replacing/restoring a scope, and verify that its original logs
are available. Work on a database copy first when event identities have changed.

```bash
# Read-only preview of the chosen device/source (device defaults to hostname)
npm run collect -- --device my-laptop --source "Codex CLI" --full
# Save a backup, then replace all three usage tables for this scope
npm run collect -- --device my-laptop --source "Codex CLI" --full --apply
# Preview and apply recovery from the printed backup path
npm run db:restore -- --file data/backups/usage-....json
npm run db:restore -- --file data/backups/usage-....json --apply
```

`--db /absolute/path.sqlite` selects an isolated SQLite file. Without it, the
configured database is used. Preview requires an existing initialized database.
Apply first saves a portable scoped JSON backup with restrictive permissions in
`data/backups/`; each device/source replacement is transactional and clears
obsolete daily, event and legacy workspace rows. Restore itself backs up the
current scope before replacing it. Backups contain private usage metadata and
must not be committed. Empty logs cannot erase existing history unless both
`--source` and `--allow-empty` are explicitly supplied. A rebuild can remove
obsolete rows, but does not reprice unchanged surviving records.

`npm run pricing:backfill` now previews recoverable zero-cost daily rows. Add
`--apply` to back up and fill only amounts supported by complete stored event
costs. Recorded zero amounts are left unchanged. Missing/incomplete detail is
left unknown; the command no longer estimates historical totals at today's rate.

## Synchronization

The first `--push` sends all locally stored history. Subsequent pushes compare
row content against destination/device-specific acknowledgments under
`data/sync-state/`. Late records and older corrections are included. A failed
chunk does not advance the manifest, so retrying the same command is safe.
Changing the destination starts a separate manifest. Uploads require the current
hub version; upgrade the hub before upgrading collectors.

An applied `--full --push <url>` replaces each explicitly collected scope on the
hub, including an explicitly empty scope. Replacement payloads are atomic per
source and limited to 48 MiB; an oversized source fails instead of partially
replacing it. Keep backups on both sides before replacing remote history. If a
hub database is reset behind the same URL, remove the local acknowledgment file
(or the `data/sync-state/` directory) and push again to resend local history.
Avoid simultaneous collectors writing the same device/source.

## HTTP contracts

- Default bind: `HOST=127.0.0.1`. External binding requires `DASHBOARD_TOKEN` or
  `INGEST_TOKEN`; Docker sets `HOST=0.0.0.0` and therefore requires a token.
- Read/page authentication uses `DASHBOARD_TOKEN`, falling back to `INGEST_TOKEN`.
  Upload authentication uses `INGEST_TOKEN`, falling back to `DASHBOARD_TOKEN`.
  Browsers use Basic auth with any username and the token as password; clients
  can send `Authorization: Bearer <token>`. Use HTTPS on externally hosted hubs.
- `GET /api/data?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` returns daily summaries,
  `projectDaily`, `eventRange`, and reconciliation fields. Dates are optional.
  `sessions` remains an empty compatibility field.
- `GET /api/time?start=<ISO timestamp>&end=<ISO timestamp>&limit=2000` returns
  `{ range, time, nextCursor }`. Without bounds it defaults to the latest 30 days.
  Send `cursor=<nextCursor>` with the same bounds until `nextCursor` is null.
  A page limit must be 1–2000; invalid cursors/ranges return 400.
- `POST /api/ingest` requires JSON. Missing `mode` means `incremental`; `full`
  requires explicit `scopes: [{ device, source }]` and every row must be within
  them. Empty full scopes deliberately clear all three usage tables. Invalid
  dates, negative/nonfinite costs, and negative/fractional tokens are rejected
  before any write.
- `POST /api/collect` remains restricted to direct loopback requests. Foreign
  browser origins and local DNS rebinding requests are rejected.

Set the same IANA `DISPLAY_TZ` on collectors and the hub. SQLite now uses that
zone for hourly and cross-midnight date buckets; PostgreSQL/MySQL follow it as
well. MySQL requires its time-zone tables to be installed. Changing the zone does
not rewrite old stored daily buckets; compare a scoped rebuild before applying.

## Validation

Run `npm test` and `npm run build`. Tests use temporary synthetic sessions and
databases, covering collector fixtures, preserved amounts, late records, scoped
backup/restore, authentication, invalid ingest, pagination, timezone boundaries,
and interrupted sync. They do not modify personal histories. CI runs Node tests
and builds on Linux, macOS and Windows, plus real PostgreSQL/MySQL integration
using isolated service databases.
