# AI Token Dashboard

[English](README.en.md) | **中文**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-green)](https://nodejs.org)

一个轻量、隐私优先的本地 AI Token 用量看板，支持同时追踪多种 Agent 和 CLI 工具的使用情况。

直接读取本机的会话日志，聚合写入本地 SQLite，通过 React 应用展示——**默认零云端、零遥测、不上传任何数据。**

---

## 截图

![Token Studio 用量看板](.github/assets/dashboard.png)

> _示意图，使用演示数据。_

---

## 功能特性

- **多源采集** — 支持 Claude Code、Codex CLI、OpenCode、Gemini CLI、Hermes Agent、OpenClaw
- **双视图** — 交互式用量看板（`/`）和适合阅读与打印的复盘页（`/review`）
- **成本追踪** — 基于随仓库提供的 LiteLLM + OpenRouter 定价缓存，按模型估算 token 费用
- **页面内采集** — 在看板右上角点击「采集」即可触发一次本机采集（仅允许本机访问）
- **多设备汇聚** — 可选推送模式，将多台机器的用量合并到单一中心节点
- **Docker 支持** — 一条命令部署中心 ingest 服务
- **纯 JavaScript** — 无需 Rust 工具链、无本地二进制、无额外 CLI 依赖

---

## 支持的数据源

| 工具 | 数据位置 |
|------|---------|
| [Claude Code](https://claude.ai/code) | `~/.claude/projects/` |
| [Codex CLI](https://github.com/openai/codex) | `~/.codex/sessions/` |
| [OpenCode](https://github.com/sst/opencode) | `~/.local/share/opencode/` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `~/.gemini/tmp/` |
| Hermes Agent | `~/.hermes/state.db`（或 `$HERMES_HOME/state.db`） |
| OpenClaw | `~/.openclaw/agents/` |

只有实际安装了对应工具才会产生数据，未安装的会被静默跳过。

---

## 环境要求

- **Node.js ≥ 22.5.0**（SQLite 使用内置的 `node:sqlite` 模块）

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 采集所有本地工具的用量数据
npm run collect

# 3. 构建前端
npm run build

# 4. 启动服务
npm run serve
```

在浏览器中打开：

```
http://localhost:4173        # 用量看板
http://localhost:4173/review # 复盘视图
```

用量数据写入 `data/usage.sqlite`，`data/` 目录已加入 `.gitignore`，不会提交到 Git。

### 多设备统一数据库

项目支持 SQLite、PostgreSQL（包括 Supabase）和 MySQL。复制 `.env.example` 为不纳入 Git 的 `.env`，配置一个共享连接：

```bash
# Supabase / PostgreSQL（推荐使用 Supabase Session pooler URL）
DATABASE_URL=postgresql://user:password@host:5432/postgres?sslmode=require

# 或 MySQL 8+
# DATABASE_URL=mysql://user:password@host:3306/ai_token_dashboard
```

初始化新数据库，并把当前机器的 SQLite 历史数据迁移进去：

```bash
npm run db:init
npm run db:migrate -- --from data/usage.sqlite
npm run db:check
```

迁移会批量 Upsert 三张用量表并校验记录数，可安全重跑；`collection_runs` 仅在目标为空时迁移，避免重复日志。其他设备只需配置相同的 `DATABASE_URL`，执行 `npm run db:init` 后正常采集。仓库还提供项目级 skill：`$migrate-usage-database`。

### 前端开发模式

```bash
npm run dev   # 同时启动 API 服务和 Vite 开发服务器
```

开发模式会占用两个端口：

```
http://localhost:4173 # API 服务
http://localhost:5173 # Vite 前端开发页面（HMR）
```

如需分别启动：

```bash
npm run dev:server # 只启动 API 服务，默认端口 4173
npm run dev:client # 只启动 Vite 前端，端口 5173
```

看板右上角的「采集」按钮会调用本机接口 `POST /api/collect`，并通过 `GET /api/collect/status` 轮询进度。该接口只允许 loopback 本机访问。

---

## 多设备汇聚

从多台机器采集数据并合并到一个看板。

**第一步：在中心设备启动 hub 服务：**

```bash
INGEST_TOKEN="your-secret-token" npm run serve
```

**第二步：在每台使用 AI 工具的设备上，带 push 参数运行采集：**

```bash
npm run collect -- \
  --device "my-laptop" \
  --push http://your-hub-host:4173/api/ingest \
  --token "your-secret-token"
```

hub 会将所有设备的每日记录和会话记录合并写入同一个 SQLite，并在 Web 页面统一展示。

---

## Docker

适合作为中心看板和 ingest 服务部署：

```bash
INGEST_TOKEN="your-secret-token" docker compose up -d
```

数据写入挂载的 `./data` 目录。**本机日志采集建议在宿主机执行**，因为各 Agent/CLI 的会话文件保存在宿主机用户目录中。

### 定时采集

服务内置定时采集能力，默认关闭。开启后，服务会按配置间隔自动执行一次本机采集；Docker 和普通 `npm run serve` 启动走的是同一套逻辑。

如果用 Docker 采集，需要把宿主机的 AI 工具日志目录挂载进容器。`docker-compose.yml` 已内置相关环境变量和挂载，默认每 5 分钟运行一次采集，并写入同一个 `./data/usage.sqlite`。

Linux/macOS 示例：

```bash
export INGEST_TOKEN="your-secret-token"
export AI_TOKEN_DASHBOARD_COLLECTOR_HOME="$HOME"
export SCHEDULED_COLLECT_ENABLED=true
export SCHEDULED_COLLECT_RUN_ON_START=true
export COLLECT_DEVICE="my-laptop"
export SCHEDULED_COLLECT_INTERVAL_SECONDS=300
docker compose up -d
```

PowerShell 示例：

```powershell
$env:INGEST_TOKEN = "your-secret-token"
$env:AI_TOKEN_DASHBOARD_COLLECTOR_HOME = $env:USERPROFILE
$env:SCHEDULED_COLLECT_ENABLED = "true"
$env:SCHEDULED_COLLECT_RUN_ON_START = "true"
$env:COLLECT_DEVICE = "my-laptop"
$env:SCHEDULED_COLLECT_INTERVAL_SECONDS = "300"
docker compose up -d
```

注意：

- 不开启 `SCHEDULED_COLLECT_ENABLED` 时，只会启动看板和 ingest 服务，不会自动采集。
- `AI_TOKEN_DASHBOARD_COLLECTOR_HOME` 必须指向保存 `.codex`、`.claude`、`.hermes`、`.local/share/opencode` 等日志的宿主机用户目录。
- 非 Docker 场景也可以在 `config/collectors.json` 的 `scheduledCollect` 中配置 `enabled`、`intervalSeconds`、`runOnStart` 和 `device`。
- 如果 AI 工具数据分散在多个目录，可以通过 `AI_TOKEN_DASHBOARD_CONFIG` 提供自定义 collector 配置。

---

## 配置项

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `PORT` | `4173` | HTTP 服务端口 |
| `API_PORT` | `4173` | `npm run dev` 中 API 服务端口 |
| `DATABASE_URL` | _未设置_ | PostgreSQL/Supabase 或 MySQL 连接 URL；设置后优先于 SQLite |
| `DB_DRIVER` | `sqlite` | 未设置 `DATABASE_URL` 时的数据库驱动 |
| `DB_PATH` | `data/usage.sqlite` | SQLite 数据库路径 |
| `DB_POOL_SIZE` | `10` | PostgreSQL/MySQL 连接池大小 |
| `DB_CONNECT_TIMEOUT_MS` | `10000` | 远程数据库连接超时毫秒数 |
| `INGEST_TOKEN` | _未设置_ | 设置后，`/api/ingest` 接口需要 `Authorization: Bearer <token>` |
| `SCHEDULED_COLLECT_ENABLED` | `false` | 是否启用服务内置定时采集 |
| `SCHEDULED_COLLECT_INTERVAL_SECONDS` | `300` | 定时采集间隔秒数，最低 10 秒 |
| `SCHEDULED_COLLECT_RUN_ON_START` | `false` | 服务启动后是否立即采集一次 |
| `COLLECT_DEVICE` | 主机名 | 定时采集写入记录的设备标签 |
| `COLLECTION_RUNS_KEEP` | `500` | 只保留最近 N 条采集运行记录，超出的会在每次打开数据库时清理 |
| `PARSE_CACHE` | `1` | 增量解析缓存。开启时按文件指纹（mtime+大小）跳过未变化的会话文件；设为 `0` 关闭 |
| `SUBSCRIPTION_QUOTA_ENABLED` | `true` | 顶栏的订阅窗口进度条（Claude/Codex 的 5 小时 / 7 天利用率）。**这是唯一会联网的功能**：它用本机已存的 OAuth 凭据调用厂商自家的用量接口。设为 `false` 关闭 |

### 定价缓存

仓库内置两份定价缓存：

- `data/pricing-litellm.json`
- `data/pricing-openrouter.json`

正常采集会优先使用这些本地缓存，因此不会为了估算价格而访问网络。需要刷新上游价格时可手动运行：

```bash
npm run pricing:update
```

`npm run collect` 的 CLI 参数：

| 参数 | 示例 | 说明 |
|------|------|------|
| `--device` | `my-laptop` | 写入记录的设备标签（默认为主机名） |
| `--db` | `/path/to/db` | 覆盖 SQLite 路径 |
| `--push` | `http://hub:4173/api/ingest` | 将采集数据推送到远程 hub |
| `--token` | `your-secret-token` | 远程 hub 的 Bearer token |

---

## 隐私与安全

- 所有采集操作只读取**本机文件**，正常采集过程中不发起任何网络请求。
- `npm run pricing:update` 会主动访问上游定价源，用于刷新本地价格缓存。
- 除非显式传入 `--push`，否则不会上传任何数据。
- `--push` 只向你提供的 URL 发送数据。
- 设置 `INGEST_TOKEN` 后，`/api/ingest` 接口需要 Bearer token 鉴权。
- `POST /api/collect` 仅允许从本机触发，避免远程页面随意扫描你的本地日志。
- 不要将 `data/usage.sqlite`、`.env` 或任何采集导出文件提交到 Git。

### 订阅额度与账号信息

顶栏的订阅窗口进度条（`SUBSCRIPTION_QUOTA_ENABLED`，默认开启）是**唯一会主动联网**的功能。它读取本机上官方 CLI 自己保存的登录态，去查厂商自家的用量接口，并在卡片上标出当前登录的账号。逻辑全部在 `src/quota.mjs`，数据来源固定为以下本地文件（均支持官方环境变量覆盖路径）：

| 信息 | 读取位置 |
|------|----------|
| Claude 登录 token | macOS 钥匙串 `Claude Code-credentials`；读不到时回退 `~/.claude/.credentials.json`（`CLAUDE_CONFIG_DIR` 可覆盖目录） |
| Claude 套餐 / 登录过期时间 | 同上凭据中的 `subscriptionType` / `expiresAt` |
| Claude 邮箱 / 名称 | `~/.claude.json` 的 `oauthAccount` 字段 |
| Codex 登录 token | `~/.codex/auth.json`（`CODEX_HOME` 可覆盖目录） |
| Codex 邮箱 / 名称 / 套餐 | 上述文件中 `id_token`（JWT）解析得到 |

数据流约束：

- **出站请求白名单**：仅 `api.anthropic.com/api/oauth/usage`（Claude）和 `chatgpt.com/backend-api/wham/usage`（Codex）两个厂商接口。每个 token 只发给它本来的厂商，与官方 CLI 的去向一致，不经任何第三方。
- **邮箱在服务端脱敏**后才下发前端（如 `some***@example.com`），原始地址不出服务端。
- **token、account_id 等敏感字段绝不下发前端**，仅在服务端用于发起上述请求。
- 账号与额度信息属于**实时状态**，从不写入 SQLite、不写日志、不落任何文件。
- 代码中**不含任何账号字面量**（邮箱 / token / ID 均为运行时从本地文件读取，内存内使用后即弃）。
- 设 `SUBSCRIPTION_QUOTA_ENABLED=false` 可彻底关闭该功能，届时不发起任何出站请求，卡片也不显示。

---

## 项目结构

```
src/
├── collect.mjs          # 数据采集 CLI 入口
├── dev.mjs              # 开发模式：同时启动 API 与 Vite
├── server.mjs           # HTTP 服务器 + API
├── db.mjs               # SQLite/PostgreSQL/MySQL 适配与 upsert
├── db-init.mjs          # 初始化数据库 schema
├── db-migrate.mjs       # SQLite 历史数据迁移
├── db-check.mjs         # 连接与记录数检查
├── pricing.mjs          # LiteLLM + OpenRouter 定价匹配与成本估算
├── update-pricing.mjs   # 刷新本地定价缓存
├── collector-config.mjs # 读取 config/collectors.json 与路径展开
├── collectors/          # 各工具采集器
│   ├── claude-code.mjs
│   ├── codex.mjs
│   ├── opencode.mjs
│   ├── gemini.mjs
│   ├── hermes.mjs
│   ├── openclaw.mjs
│   └── utils.mjs
└── client/
    ├── dashboard/       # 主用量看板（React）
    ├── review/          # 复盘视图（React）
    └── shared/          # 共享工具函数
data/
├── pricing-litellm.json     # 随仓库提供的 LiteLLM 定价缓存
└── pricing-openrouter.json  # 随仓库提供的 OpenRouter 定价缓存
db/
├── schema.sqlite.sql        # SQLite 初始化 schema
├── schema.postgres.sql      # PostgreSQL/Supabase 初始化 schema
└── schema.mysql.sql         # MySQL 初始化 schema
```

---

## 参与贡献

欢迎贡献。如需新增工具支持，请在 `src/collectors/` 中实现一个 collector，导出返回 `{ graphJson, modelsJson }` 的 `collect()` 函数——可参考现有 collector 了解预期数据结构。

提交较大改动前，请先开 issue 讨论。

---

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
