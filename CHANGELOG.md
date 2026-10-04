# Changelog

## Unreleased

This is a source release candidate. The `0.1.0` package field is not evidence of a published release. See [upgrade and release checks](docs/release.md) before upgrading a shared database.

- Transactional incremental synchronization with persistent acknowledgments per destination, device and source; replay after an interrupted upload is idempotent. The first upload establishes a baseline. [PR #30](https://github.com/fengguanghuai/ai-token-dashboard/pull/30)
- Server-defined display timezone across date filters, comparisons and exports; bounded hourly/quota request caching; compressed, conditional static responses; separate dashboard/review bundles and browser regression coverage. [PR #30](https://github.com/fengguanghuai/ai-token-dashboard/pull/30)
- Optional Codex byte continuation with `CODEX_LOG_APPEND_ONLY=1`. Full-prefix verification remains the default. The option assumes earlier log content will not change. [PR #31](https://github.com/fengguanghuai/ai-token-dashboard/pull/31)
- CSV exports use one consistent read snapshot, spool to a private temporary file, then release the database transaction before download. This requires temporary disk space roughly equal to the CSV size. [PR #31](https://github.com/fengguanghuai/ai-token-dashboard/pull/31)
- Release acceptance combines a clean-install smoke flow with a frozen pre-journal SQLite upgrade, historical-cost preservation, first synchronization, restart, backup restoration and re-upgrade. Existing backend integration tests cover PostgreSQL/MySQL separately.

Historical costs are retained, not repriced. All processes writing a shared database must upgrade together. Existing daily buckets are not rebuilt when `DISPLAY_TZ` changes. Other collectors do not yet support byte continuation. Exact limitations and evidence are tracked in [project status](docs/project-status.md).
