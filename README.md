# AI Token Dashboard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-green)](https://nodejs.org)

A lightweight, privacy-first dashboard for tracking your local AI token usage across multiple agents and CLI tools.

Reads session logs directly from your machine, aggregates them into a local SQLite database, and serves a React UI — **no cloud, no telemetry, no third-party uploads by default.**

---

<!-- Replace with actual screenshots -->
## Screenshots

> _Screenshots coming soon._

---

## Features

- **Multi-source collection** — Claude Code, Codex CLI, Gemini CLI, Hermes Agent, OpenClaw
- **Two views** — interactive usage dashboard (`/`) and a printable retrospective page (`/review`)
- **Cost tracking** — per-model cost estimation via LiteLLM pricing data
- **Multi-device** — optional push mode to aggregate usage from multiple machines into a single hub
- **Docker-ready** — one-command deployment as a central ingest server
- **Pure JavaScript** — no Rust toolchain, no native binaries, no extra CLIs required

---

## Supported Data Sources

| Tool | Data location |
|------|--------------|
| [Claude Code](https://claude.ai/code) | `~/.claude/projects/` |
| [Codex CLI](https://github.com/openai/codex) | `~/.codex/sessions/` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `~/.gemini/tmp/` |
| Hermes Agent | `~/.hermes/state.db` (or `$HERMES_HOME/state.db`) |
| OpenClaw | `~/.openclaw/agents/` |

Only the tools you actually have installed will produce data — others are silently skipped.

---

## Requirements

- **Node.js ≥ 22.5.0** (uses the built-in `node:sqlite` module)

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Collect usage data from all local tools
npm run collect

# 3. Build the frontend
npm run build

# 4. Start the server
npm run serve
```

Open in your browser:

```
http://localhost:4173        # Usage dashboard
http://localhost:4173/review # Retrospective view
```

Usage data is written to `data/usage.sqlite`. The `data/` directory is gitignored and stays local.

### Development

```bash
npm run dev   # Vite dev server with HMR on http://localhost:5173
```

---

## Multi-Device Setup

Collect from multiple machines and aggregate into a single dashboard.

**1. Start the hub on your central device:**

```bash
INGEST_TOKEN="your-secret-token" npm run serve
```

**2. On each device that uses AI tools, run collect with push:**

```bash
npm run collect -- \
  --device "my-laptop" \
  --push http://your-hub-host:4173/api/ingest \
  --token "your-secret-token"
```

The hub merges all devices' daily and session records into one SQLite database and displays them together in the UI.

---

## Docker

Best suited for running the hub/ingest server:

```bash
INGEST_TOKEN="your-secret-token" docker compose up -d
```

Data is written to the mounted `./data` volume. **Local log collection should run on the host**, as agent session files live in the host user's home directory.

---

## Configuration

| Environment variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `4173` | HTTP server port |
| `DB_PATH` | `data/usage.sqlite` | SQLite database path |
| `INGEST_TOKEN` | _(unset)_ | If set, `/api/ingest` requires `Authorization: Bearer <token>` |

CLI flags for `npm run collect`:

| Flag | Example | Description |
|------|---------|-------------|
| `--device` | `my-laptop` | Device label stored with each record (defaults to hostname) |
| `--db` | `/path/to/db` | Override the SQLite path |
| `--push` | `http://hub:4173/api/ingest` | Push collected data to a remote hub |
| `--token` | `your-secret-token` | Bearer token for the remote hub |

---

## Privacy & Security

- All data collection reads **local files only** — no network calls are made during collection.
- Nothing is uploaded unless you explicitly pass `--push`.
- `--push` sends data only to the URL you provide.
- When `INGEST_TOKEN` is set, the `/api/ingest` endpoint requires a Bearer token.
- Do not commit `data/usage.sqlite`, `.env`, or any exported data files.

---

## Project Structure

```
src/
├── collect.mjs          # CLI entry point for data collection
├── server.mjs           # HTTP server + API
├── db.mjs               # SQLite schema and upsert helpers
├── pricing.mjs          # LiteLLM-based cost estimation
├── collectors/          # Per-tool data collectors
│   ├── claude-code.mjs
│   ├── codex.mjs
│   ├── gemini.mjs
│   ├── hermes.mjs
│   ├── openclaw.mjs
│   └── utils.mjs
└── client/
    ├── dashboard/       # Main usage dashboard (React)
    ├── review/          # Retrospective view (React)
    └── shared/          # Shared utilities
```

---

## Contributing

Contributions are welcome. To add support for a new tool, implement a collector in `src/collectors/` that exports a `collect()` function returning `{ graphJson, modelsJson }` — see existing collectors for the expected shape.

Please open an issue before submitting large changes.

---

## License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

一个轻量的本地 AI Token 用量看板，读取本机多种 Agent/CLI 的使用记录，统一写入 SQLite，通过 React 应用提供两个视图：

- `/`：交互式用量看板，包含趋势、来源、模型、项目/会话和采集记录。
- `/review`：复盘页，按周期生成适合阅读和打印的总结。

**默认不会上传任何数据。** 只有显式传入 `--push` 时，才会把本机汇总结果上报到你指定的中心节点。

### 本地运行

```bash
npm install
npm run collect
npm run build
npm run serve
```

访问 `http://localhost:4173`，数据写入 `data/usage.sqlite`（已 gitignore，不会提交）。

### Docker 部署（中心节点）

```bash
INGEST_TOKEN="your-secret-token" docker compose up -d
```

### 隐私说明

采集过程只读取本机文件，不会调用任何上传命令。`--push` 只发送到你提供的 URL，`INGEST_TOKEN` 开启后接口需要 Bearer token 鉴权。
