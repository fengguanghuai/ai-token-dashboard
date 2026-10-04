# Contributing / 参与贡献

Use a feature branch and a pull request against `main`. Describe the user-visible change, validation, and remaining limits. CI must pass before merge. For larger changes, first discuss the scope in an [issue](https://github.com/fengguanghuai/ai-token-dashboard/issues/new).

在功能分支开发并向 `main` 提交 PR，说明行为变化、验证和限制，CI 通过后再合并。较大改动先通过 [Issue](https://github.com/fengguanghuai/ai-token-dashboard/issues/new) 讨论范围。

## Local validation

Requires Node ≥22.15. Use locked dependencies:

```sh
npm ci
npm test
npm run test:release
npx playwright install chromium
npm run test:browser
```

`test:release` uses only synthetic logs and temporary SQLite databases. It verifies installation, upgrade from the frozen schema preceding PR #30, historical values, HTTP synchronization, restart and backup restoration. `npm test` skips remote integration tests unless dedicated `TEST_POSTGRES_URL` / `TEST_MYSQL_URL` test databases are provided; those tests write data, so never point them at a personal or production database. CI runs both remote services. See [release evidence and limits](docs/release.md).

For query measurements, use `npm run benchmark:query -- 100000` (or `1000000`). Each sample opens a synthetic database in a fresh process; it never reads the application's `.env` or personal usage database.

## Collector changes

Implement `collect()` in `src/collectors/` using the existing `{ graphJson, modelsJson, eventsJson }` contract (`eventsJson` is optional). Add sanitized fixtures covering real format differences, repeated/forked events and missing usage fields. Do not infer tokens or prices that the source cannot establish. Preserve recorded zero cost, historical estimates and source event identities. Document whether the source provides event timestamps and project paths; aggregate-only data must not appear as precise events.

Keep current work and acceptance boundaries in [project status](docs/project-status.md). Update the corresponding behavior document when contracts change. Never run a full replacement or pricing rewrite against a contributor's real history for a test.

## Bug reports / 问题反馈

Open an [issue](https://github.com/fengguanghuai/ai-token-dashboard/issues/new) with the commit/version, OS, Node version, database driver, affected collector, reproduction steps, expected/actual result and sanitized error. A minimal synthetic log is preferable to a whole session archive. `npm run doctor -- --json` provides a diagnostic report; review it before sharing.

不要上传 `.env`、访问令牌、数据库连接串、OAuth 文件、个人用量数据库或完整会话日志。可提供脱敏后的最小复现、错误信息和诊断报告；若无法脱敏，先描述问题，不附原始文件。
