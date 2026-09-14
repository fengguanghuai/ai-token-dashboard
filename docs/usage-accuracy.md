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

## Existing databases

Installing updated collectors does not repair stored historical statistics by
itself. The incremental collector keeps a recent overlap window and historical
costs are locked. Changes to event identities also require rebuilding time rows
before continuing normal collection against an existing database.

`--full` rebuilds time rows but does **not** remove obsolete daily/workspace rows
or unlock historical daily costs. Do not assume that this flag alone repairs an
old database. Before applying these changes to existing data, back up the usage
database, verify the original logs are available, build and compare results in
an isolated database, then plan a device/source-scoped replacement. Do not run
normal incremental collection against the old database during this migration.

Node 22.5 requires `--experimental-sqlite`; Node 22.13+ exposes SQLite without
that flag. Zstd archives require Node 22.15+ or 23.8+; older runtimes warn and
skip them. Gzip and plain JSONL do not require zstd support.

## Validation

Run `npm test` and `npm run build`. Regression tests use temporary synthetic
sessions and databases, covering response copies, same-name files, model
switches, live WAL writes, compressed copies, embedded Codex turns, recorded
zero costs and long-context boundaries. They do not modify personal histories.
