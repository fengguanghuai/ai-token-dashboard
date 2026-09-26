# AI Token Dashboard

[English](README.en.md) | **中文**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.15-green)](https://nodejs.org)

一个轻量、隐私优先的本地 AI Token 用量看板，支持同时追踪多种 Agent 和 CLI 工具的使用情况。

直接读取本机的会话日志，聚合写入本地 SQLite，通过 React 应用展示——**默认零云端、零遥测、不上传任何数据。**

---

## 截图

![Token Studio 用量看板 · 亮色](.github/assets/dashboard.png)

![Token Studio 用量看板 · 暗色](.github/assets/dashboard-dark.png)

> _示意图，使用演示数据。运行 `npm run seed:demo` 可在本机生成同一份数据。_

---

## 功能特性

- **多源采集** — 支持 Claude Code、Codex CLI、OpenCode、Gemini CLI、Hermes Agent、OpenClaw、Grok CLI、DeepSeek Harness、Pi Agent
- **双视图** — 交互式用量看板（`/`）和适合阅读与打印的复盘页（`/review`）
- **亮色 / 暗色主题** — 默认跟随系统，右上角一键切换，选择记在本机，两个页面共用
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
| Grok CLI | `~/.grok/sessions/`（可用 `GROK_HOME` 指定 home） |
| DeepSeek Harness (DSH) | `~/.dsh/sessions/`（可用 `DSH_HOME` 指定 home，或 `DSH_SESSIONS` 指定会话目录） |
| Pi Agent | `~/.pi/agent/sessions/`（可用 `PI_CODING_AGENT_DIR` 指定 agent 目录，或 `PI_CODING_AGENT_SESSION_DIR` 指定会话目录） |

只有实际安装了对应工具才会产生数据，未安装的会被静默跳过。

Grok 按已完成回合的模型用量统计：缓存和 reasoning 从其所属的 input/output 中拆出，避免重复累计；优先使用日志中的 `costUsdTicks` 费用，没有记录时按定价表估算。

DSH 支持明文 `session.jsonl` 和多帧 `session.jsonl.zstd`。优先采用最终消息用量，同时计入上下文压缩调用，排除 fork 继承的历史；旧版仅含流式 usage 的日志也能采集。DSH 费用按模型定价估算。压缩日志需要 Node 22.15+ 或 23.8+ 的 zstd API，不支持时提示并跳过压缩文件，明文日志仍可采集。

Pi 读取 JSONL 中的 assistant 用量、显式 tool 用量及带 usage 的上下文压缩/分支摘要。reasoning 从 output 中拆出，避免重复累计；费用优先使用日志记录值，缺失时按模型价格估算。保留已发生调用的所有分支，只在父会话也位于扫描范围内且记录 ID、时间和用量匹配时排除 fork 复制的历史。

使用 `npm run pricing:update` 更新随项目保存的价格快照。估算采用快照标准价格（包括 DeepSeek 的峰时标准价），不会自动按调用时段折扣，也不会重算数据库中已经保存的历史费用。

---

## 环境要求

- **Node.js ≥ 22.15.0**（SQLite 使用内置的 `node:sqlite` 模块）

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

开发启动会先检查两个端口。重复启动会提示占用地址，不会关闭已有进程，也不会自动换端口。需要重启时在原终端按 Ctrl+C。可用 `API_PORT=4273 CLIENT_PORT=5273 npm run dev` 指定其他端口。

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

想在没有真实数据时预览界面（或重拍 README 截图），可以生成一份演示数据：

```bash
npm run seed:demo                      # 写入 data/demo.sqlite，不碰 data/usage.sqlite
DB_PATH=data/demo.sqlite npm run serve
```

生成结果是确定性的（固定随机种子），同样的命令永远得到同样的看板。

看板右上角的「采集」按钮会调用本机接口 `POST /api/collect`，并通过 `GET /api/collect/status?wait=1` 等待完成通知，无需等待固定轮询间隔。采集触发接口只允许 loopback 本机访问。

正常采集按日期签名核对变化：无变化时跳过用量表读取与写入；补入旧记录时仍会核对对应的历史日期。签名与用量在同一事务提交，历史费用保留规则不变。实现边界与基准方法见 [采集性能](docs/collection-performance.md)。

---

## 多设备汇聚

从多台机器采集数据并合并到一个看板。

**第一步：在中心设备启动 hub 服务：**

```bash
HOST=0.0.0.0 INGEST_TOKEN="your-secret-token" npm run serve
```

**第二步：在每台使用 AI 工具的设备上，带 push 参数运行采集：**

```bash
npm run collect -- \
  --device "my-laptop" \
  --push http://your-hub-host:4173/api/ingest \
  --token "your-secret-token"
```

hub 会合并每日记录和事件明细。浏览器登录时用户名任意，密码为 `DASHBOARD_TOKEN`（未设置时使用 `INGEST_TOKEN`）；程序使用 Bearer token。跨公网部署请在反向代理上启用 HTTPS。首次推送包括本地数据库已有历史，之后按目标地址独立记录成功确认的内容，中断后可重试。

---

## Docker

适合作为中心看板和 ingest 服务部署：

```bash
INGEST_TOKEN="your-secret-token" docker compose up -d
```

数据写入挂载的 `./data` 目录。**本机日志采集建议在宿主机执行**，因为各 Agent/CLI 的会话文件保存在宿主机用户目录中。

### 定时采集

服务内置定时采集能力，默认关闭。开启后，服务会按配置间隔自动执行一次本机采集；Docker 和普通 `npm run serve` 启动走的是同一套逻辑。

如果用 Docker 采集，需要把宿主机的 AI 工具日志目录挂载进容器。`docker-compose.yml` 已内置相关环境变量和挂载，默认采集间隔为 5 分钟（默认未启用定时采集），并写入同一个 `./data/usage.sqlite`。

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
| `HOST` | `127.0.0.1` | 监听地址；外部访问需设置 token，Docker 为 `0.0.0.0` |
| `PORT` | `4173` | HTTP 服务端口 |
| `API_PORT` | `4173` | `npm run dev` 中 API 服务端口 |
| `CLIENT_PORT` | `5173` | `npm run dev` 中 Vite 页面端口 |
| `DATABASE_URL` | _未设置_ | PostgreSQL/Supabase 或 MySQL 连接 URL；设置后优先于 SQLite |
| `DB_DRIVER` | `sqlite` | 未设置 `DATABASE_URL` 时的数据库驱动 |
| `DB_PATH` | `data/usage.sqlite` | SQLite 数据库路径 |
| `DB_POOL_SIZE` | `10` | PostgreSQL/MySQL 连接池大小 |
| `DB_CONNECT_TIMEOUT_MS` | `10000` | 远程数据库连接超时毫秒数 |
| `DISPLAY_TZ` | 主机时区 | 采集日期、热力图日期及小时所用的时区（IANA 名称，如 `Asia/Shanghai`）。默认跟随运行服务器的本机时区；部署在 UTC 主机（如 Render/Docker）上时显式指定，否则热力图会按 UTC 显示 |
| `DASHBOARD_TOKEN` | _未设置_ | 看板及读取 API 的密码，未设置时复用 `INGEST_TOKEN` |
| `INGEST_TOKEN` | _未设置_ | 推送鉴权；未设置时复用 `DASHBOARD_TOKEN`。两个都未设置时仅允许本机监听 |
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
| `--source` | `"Codex CLI"` | 仅处理指定来源（使用看板中的完整名称） |
| `--full` | — | 预览指定设备/来源的完整替换，不写库 |
| `--apply` | — | 配合 `--full`，备份后执行替换 |
| `--dry-run` | — | 只预览本次采集变化 |
| `--allow-empty` | — | 配合 `--full --source`，明确允许以空日志清空该范围 |

默认扫描可用历史并仅写入变化的记录，不再用最近事件时间截断迟到数据。已存费用保持原值，只补能够与新增事件核对的费用；旧口径无法还原时显示“未知口径”。价格快照更新不会重算历史费用。

重建先预览，再显式执行（请先确认原始日志齐全）：

```bash
npm run collect -- --source "Codex CLI" --full
npm run collect -- --source "Codex CLI" --full --apply
```

执行时先在 `data/backups/` 保存该设备/来源的完整用量备份，再事务性替换日汇总、事件和旧工作区统计，清除过时记录。备份可用 `npm run db:restore -- --file <备份路径>` 预览恢复，加 `--apply` 执行。详细费用口径、同步恢复和 API 契约见 [Usage accounting and upgrades](docs/usage-accuracy.md)。

---

## 隐私与安全

- 所有采集操作只读取**本机文件**，正常采集过程中不发起任何网络请求。
- `npm run pricing:update` 会主动访问上游定价源，用于刷新本地价格缓存。
- 除非显式传入 `--push`，否则不会上传任何数据。
- `--push` 只向你提供的 URL 发送数据。
- 默认只监听本机；外部监听必须设置 token，看板、读取 API 和写入 API 均鉴权。
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

欢迎贡献。如需新增工具支持，请在 `src/collectors/` 中实现一个 collector，导出返回 `{ graphJson, modelsJson, eventsJson }` 的 `collect()` 函数——可参考现有 collector 了解预期数据结构。

提交较大改动前，请先开 issue 讨论。

---

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
