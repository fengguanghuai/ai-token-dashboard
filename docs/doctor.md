# Doctor / 环境诊断

```bash
npm run doctor
npm run --silent doctor -- --json
npm run doctor -- --device my-laptop
```

从项目根目录运行。与启动/采集命令一样读取 `.env`，已有进程环境变量优先；数据库配置遵循 `DATABASE_URL` → `DB_DRIVER`/`DB_PATH` → 本地 SQLite。`--device` 仅选择要检查的历史采集记录，默认使用当前主机名，不修改设备身份。

Run from the project root. The command loads `.env` with existing process environment variables taking precedence. Database selection follows the app: `DATABASE_URL`, then `DB_DRIVER`/`DB_PATH`, then local SQLite. `--device` selects historical run records; it defaults to the hostname and does not change device identity.

## 状态 / Status

| Status | 含义 / Meaning | 下一步 / Next step |
| --- | --- | --- |
| `ok` | 该项检查通过 / This check passed | 仅限该项范围 / Limited to that check |
| `warn` | 缺少可选来源、尚未初始化、已有端口占用或历史记录需关注 / Optional source absent, setup incomplete, occupied port, or historical run warning | 按提示判断是否适用 / Follow the suggested action if applicable |
| `error` | 配置无效、权限或数据库检查失败 / Invalid configuration, permissions or database failure | 修复后重跑 / Fix and rerun |

退出码：`0` 没有 error（可能有 warn）；`1` 有 error 或诊断未完成；`2` 参数错误。JSON 的 `version: 1`、检查 `id` 和状态可供脚本使用，不要解析展示文案。纯 JSON 使用 `npm run --silent doctor -- --json`；Node 的 SQLite 实验性提示可能出现在 stderr，不影响 stdout JSON。

Exit codes: `0` means no errors (warnings may remain), `1` means an error or incomplete diagnosis, and `2` means invalid arguments. Scripts should use JSON `version: 1`, check IDs and statuses, not display messages. Use the silent npm form above for JSON-only stdout; Node may emit its SQLite experimental warning on stderr.

## 常见问题 / Common cases

- 首次安装：数据库缺失时执行 `npm run db:init`，然后 `npm run collect`、`npm run build`、`npm run serve`。
- 端口占用：已有实例可直接访问；否则检查占用进程或配置不同的 `API_PORT` / `CLIENT_PORT`（开发）或 `PORT`（serve）。命令不会停止进程。
- 采集为空：检查 `config/collectors.json` 和工具对应环境变量。`missing` 是路径不存在，`empty` 是空目录或空数据库文件，`unreadable` 是读取失败，`invalid` 是路径类型或 OpenCode 数据库文件名无效。
- 表结构失败：先备份已有数据库，再确认是否需要 `npm run db:init`；诊断命令不会自动修复或升级表。
- 上次采集 `error` / `empty`：这是指定设备的历史记录，不表示当前失败，也不表示历史用量为零；检查来源后重跑采集。

- Fresh install: run `npm run db:init`, `npm run collect`, `npm run build`, then `npm run serve`.
- Port occupied: reuse the existing instance when appropriate, otherwise inspect the owner or configure distinct development ports (`API_PORT` / `CLIENT_PORT`) or the serve port (`PORT`). No processes are stopped.
- Empty collection: check collector paths and environment overrides. Root states distinguish missing paths, empty directories/files, unreadable paths, and invalid path types/OpenCode database names.
- Schema failure: back up existing data before deciding to run `npm run db:init`. Doctor never repairs or upgrades tables.
- Last run `error` / `empty`: historical evidence for the selected device, not a current execution result or proof of zero historical usage.

## 检查边界 / Scope

来源检查复用采集器的路径解析函数，仅枚举目录和检查读取权限，不读取会话内容、不打开来源数据库、不创建解析缓存、不请求价格或额度接口。每个目录最多检查 2,000 个条目、32 层，并在条目之间检查 250 ms 预算；单次文件系统调用不受此预算中断。遇到限制或符号链接会标记扫描未完成。候选文件按名称粗筛，可能不属于实际可采集日志，也不会验证日志格式或费用准确性。

Source checks reuse collector path resolvers and inspect directory entries/read access only. They do not read conversations, open source databases, write parse caches, or call pricing/quota APIs. Each directory root is limited to 2,000 entries and 32 levels, with a 250 ms budget checked between entries; a filesystem call itself cannot be interrupted by that budget. Limits or symlinks mark the scan incomplete. Filename candidates may not be collectable logs and do not validate formats or costs.

用量数据库以只读模式打开，仅执行连接、关键字段及当前设备最近采集状态的 SELECT，不执行 DDL/DML，不全表汇总。远程连接使用现有适配器和 `DB_CONNECT_TIMEOUT_MS`（默认 10 秒）。连接成功不验证写入权限、完整 schema、历史账单准确性或远程数据库服务的整体健康。页面只检查文件是否存在，不证明构建最新或浏览器渲染正常。

The usage database is opened in read-only mode for SELECT checks of connectivity, key columns and latest per-source run statuses for the selected device. No DDL/DML or full usage aggregation runs. Remote connections use the existing adapters and `DB_CONNECT_TIMEOUT_MS` (10 seconds by default). Success does not validate write permissions, every schema detail, historical bill accuracy or overall remote database health. The frontend check verifies file presence, not build freshness or browser rendering.

报告不输出个人路径、主机名、数据库 URL、令牌、日志内容或原始异常文本；保留来源名称、候选数量、端口、错误码和采集时间，分享前仍可按需审阅。它不会向外部服务上传报告。

Reports omit personal paths, hostnames, database URLs, tokens, log contents and raw exceptions. They retain source names, candidate counts, ports, error codes and run timestamps; review these before sharing if needed. Reports are never uploaded by the command.

## 自动验收 / Onboarding smoke test

```bash
npm ci
npm run test:onboarding
npm test
```

冒烟流程构建真实前端，在隔离环境里依次执行 doctor、db:init、两次 Pi 合成日志采集、db:check、doctor，再启动临时服务验证看板/复盘 HTML、构建资源和用量 API。断言 110 tokens、$0.25 和一条记录在重复采集后不重复增长，结束时清理临时数据库和进程。浏览器交互仍需单独验收。

The smoke test builds the frontend, then runs doctor, database initialization, two collections of synthetic Pi logs, database verification and doctor again in isolation. A temporary server checks dashboard/review HTML, built assets and usage APIs. It asserts 110 tokens, $0.25 and one record after repeated collection, then removes its temporary database and process. Browser interaction requires separate validation.
