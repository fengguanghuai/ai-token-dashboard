# AI Token Dashboard

[English](README.en.md) | **中文**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-green)](https://nodejs.org)

一个轻量、隐私优先的本地 AI Token 用量看板，支持同时追踪多种 Agent 和 CLI 工具的使用情况。

直接读取本机的会话日志，聚合写入本地 SQLite，通过 React 应用展示——**默认零云端、零遥测、不上传任何数据。**

---

<!-- 替换为实际截图 -->
## 截图

> _截图即将上线。_

---

## 功能特性

- **多源采集** — 支持 Claude Code、Codex CLI、Gemini CLI、Hermes Agent、OpenClaw
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
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `~/.gemini/tmp/` |
| Hermes Agent | `~/.hermes/state.db`（或 `$HERMES_HOME/state.db`） |
| OpenClaw | `~/.openclaw/agents/` |

只有实际安装了对应工具才会产生数据，未安装的会被静默跳过。

---

## 环境要求

- **Node.js ≥ 22.5.0**（使用内置的 `node:sqlite` 模块）

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

---

## 配置项

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `PORT` | `4173` | HTTP 服务端口 |
| `API_PORT` | `4173` | `npm run dev` 中 API 服务端口 |
| `DB_PATH` | `data/usage.sqlite` | SQLite 数据库路径 |
| `INGEST_TOKEN` | _未设置_ | 设置后，`/api/ingest` 接口需要 `Authorization: Bearer <token>` |

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

---

## 项目结构

```
src/
├── collect.mjs          # 数据采集 CLI 入口
├── dev.mjs              # 开发模式：同时启动 API 与 Vite
├── server.mjs           # HTTP 服务器 + API
├── db.mjs               # SQLite schema 与 upsert 辅助函数
├── pricing.mjs          # LiteLLM + OpenRouter 定价匹配与成本估算
├── update-pricing.mjs   # 刷新本地定价缓存
├── collectors/          # 各工具采集器
│   ├── claude-code.mjs
│   ├── codex.mjs
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
```

---

## 参与贡献

欢迎贡献。如需新增工具支持，请在 `src/collectors/` 中实现一个 collector，导出返回 `{ graphJson, modelsJson }` 的 `collect()` 函数——可参考现有 collector 了解预期数据结构。

提交较大改动前，请先开 issue 讨论。

---

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
