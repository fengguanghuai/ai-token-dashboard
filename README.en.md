# AI Token Dashboard

**English** | [中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.15-green)](https://nodejs.org)

A lightweight, privacy-first dashboard for tracking your local AI token usage across multiple agents and CLI tools.

Reads session logs directly from your machine, aggregates them into a local SQLite database, and serves a React UI — **no cloud, no telemetry, no third-party uploads by default.**

---

## Screenshots

![Token Studio dashboard — light](.github/assets/dashboard.png)

![Token Studio dashboard — dark](.github/assets/dashboard-dark.png)

> _Illustrative, using demo data. Run `npm run seed:demo` to generate the same dataset locally._

---

## Features

- **Multi-source collection** — Claude Code, Codex CLI, OpenCode, Gemini CLI, Hermes Agent, OpenClaw, Grok CLI, DeepSeek Harness, Pi Agent
- **Two views** — interactive usage dashboard (`/`) and a printable retrospective page (`/review`)
- **Light / dark theme** — follows the OS by default, toggles from the top-right, and the choice is remembered locally across both pages
- **Cost tracking** — per-model cost estimation via bundled LiteLLM + OpenRouter pricing caches
- **In-app collection** — trigger a local collection run from the dashboard's top-right **Collect** button (loopback only)
- **Multi-device** — optional push mode to aggregate usage from multiple machines into a single hub
- **Docker-ready** — one-command deployment as a central ingest server
- **Pure JavaScript** — no Rust toolchain, no native binaries, no extra CLIs required

---

## Supported Data Sources

| Tool | Data location |
|------|--------------|
| [Claude Code](https://claude.ai/code) | `~/.claude/projects/` |
| [Codex CLI](https://github.com/openai/codex) | `~/.codex/sessions/` |
| [OpenCode](https://github.com/sst/opencode) | `~/.local/share/opencode/` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `~/.gemini/tmp/` |
| Hermes Agent | `~/.hermes/state.db` (or `$HERMES_HOME/state.db`) |
| OpenClaw | `~/.openclaw/agents/` |
| Grok CLI | `~/.grok/sessions/` (override home with `GROK_HOME`) |
| DeepSeek Harness (DSH) | `~/.dsh/sessions/` (override home with `DSH_HOME`, or sessions with `DSH_SESSIONS`) |
| Pi Agent | `~/.pi/agent/sessions/` (override agent directory with `PI_CODING_AGENT_DIR`, or sessions with `PI_CODING_AGENT_SESSION_DIR`) |

Only the tools you actually have installed will produce data — others are silently skipped.

Grok counts completed turns by model. Cache and reasoning are split out of their inclusive input/output totals to avoid double counting. Recorded `costUsdTicks` takes priority; turns without a recorded cost use the pricing tables.

DSH reads plain `session.jsonl` and multi-frame `session.jsonl.zstd`. Final message usage replaces streaming usage, compaction calls are included, and fork seed history is excluded. Older chunk-only logs are also supported. Costs use model pricing. Compressed logs require the zstd API in Node 22.15+ or 23.8+; older runtimes warn and skip compressed files while still reading plain logs.

Pi reads assistant usage, explicit tool usage, and compaction/branch-summary usage from JSONL. Reasoning is split out of output to avoid double counting. Recorded costs take priority, with model pricing as a fallback. All billed branches remain counted; copied fork history is excluded only when a scanned parent has matching entry IDs, timestamps and usage.

Run `npm run pricing:update` to refresh the bundled price snapshots. Estimates use standard snapshot rates (including DeepSeek peak rates), without time-of-day discounts or automatic repricing of historical database rows.

---

## Requirements

- **Node.js ≥ 22.15.0** (the SQLite fallback uses the built-in `node:sqlite` module)

---

## Quick Start

```bash
# 1. Install locked dependencies from the project root
npm ci

# 2. Check the environment (missing database/build warnings are normal initially)
npm run doctor

# 3. Initialize the database and collect local usage
npm run db:init
npm run collect

# 4. Build the frontend
npm run build

# 5. Start the server
npm run serve
```

Open in your browser:

```
http://localhost:4173        # Usage dashboard
http://localhost:4173/review # Retrospective view
```

Usage data is written to `data/usage.sqlite`. The `data/` directory is gitignored and stays local.

For development, run `npm run dev` and open `http://127.0.0.1:5173/`. If a port is occupied, check whether the project is already running before starting another instance.

Run `npm run doctor` when startup or collection fails, or collection returns no data. It checks the environment, file metadata and the existing database without collecting, initializing tables, or changing historical costs. Missing paths for unused tools are expected; candidate files do not prove valid usage is present.

Use `npm run --silent doctor -- --json` for a shareable report (no connection strings, tokens, personal paths or raw collection errors). Use `--device <name>` for custom device names. See [diagnostic details](docs/doctor.md) for statuses and limitations.

Contributors can run `npm run test:onboarding` to verify the build, first/repeated collection, and pages/APIs with synthetic logs and a temporary database. It does not collect personal logs. CI runs this flow on macOS, Linux, and Windows.

### Shared multi-device database

The project supports SQLite, PostgreSQL (including Supabase), and MySQL. Copy `.env.example` to an untracked `.env` and configure one shared connection:

```bash
# Supabase / PostgreSQL (prefer a Supabase Session pooler URL)
DATABASE_URL=postgresql://user:password@host:5432/postgres?sslmode=require

# Or MySQL 8+
# DATABASE_URL=mysql://user:password@host:3306/ai_token_dashboard
```

Initialize a fresh database and migrate this machine's SQLite history:

```bash
npm run db:init
npm run db:migrate -- --from data/usage.sqlite
npm run db:check
```

Migration batch-upserts the three durable usage tables and verifies row counts, so it is safe to rerun. `collection_runs` is copied only when the target is empty to prevent duplicate operational logs. On other devices, configure the same `DATABASE_URL`, run `npm run db:init`, and collect normally. A project-level `$migrate-usage-database` skill is also included.

### Development

```bash
npm run dev   # Start both the API server and the Vite dev server
```

Development startup checks both ports before launching. A duplicate reports the occupied address without stopping existing processes or silently switching ports. Stop the original terminal with Ctrl+C before restarting. Override with `API_PORT=4273 CLIENT_PORT=5273 npm run dev` (POSIX shell).

Development mode uses two ports:

```
http://localhost:4173 # API server
http://localhost:5173 # Vite frontend with HMR
```

You can also start them separately:

```bash
npm run dev:server # API server only, default port 4173
npm run dev:client # Vite frontend only, port 5173
```

To preview the UI without real data (or to retake the README screenshots), generate a demo dataset:

```bash
npm run seed:demo                      # writes data/demo.sqlite, never touches data/usage.sqlite
DB_PATH=data/demo.sqlite npm run serve
```

The seed is deterministic, so the same command always paints the same dashboard.

The dashboard's **Collect** button calls `POST /api/collect` and waits for completion with `GET /api/collect/status?wait=1`, without a fixed polling delay. The collect endpoint is restricted to loopback requests.

Normal collection compares per-date input signatures: unchanged input skips usage-table reads and writes, while late records still reconcile their historical dates. Checkpoints commit with usage changes and preserve the existing historical-cost rules. See [collection performance](docs/collection-performance.md) for implementation boundaries and benchmark methodology.

---

## Multi-Device Setup

Collect from multiple machines and aggregate into a single dashboard.

**1. Start the hub on your central device:**

```bash
HOST=0.0.0.0 INGEST_TOKEN="your-secret-token" npm run serve
```

**2. On each device that uses AI tools, run collect with push:**

```bash
npm run collect -- \
  --device "my-laptop" \
  --push http://your-hub-host:4173/api/ingest \
  --token "your-secret-token"
```

The hub merges daily records and event details. Sign in with any username and `DASHBOARD_TOKEN` as the password (falls back to `INGEST_TOKEN`); clients use Bearer authentication. Use HTTPS at your reverse proxy for internet access. The first push includes all locally stored history; later pushes use destination-specific acknowledgments and can be retried after interruption.

---

## Docker

Best suited for running the hub/ingest server:

```bash
INGEST_TOKEN="your-secret-token" docker compose up -d
```

Data is written to the mounted `./data` volume. **Local log collection should run on the host**, as agent session files live in the host user's home directory.

### Scheduled Collection

The server has built-in scheduled collection. It is disabled by default. Once enabled, the server runs local collection at the configured interval; Docker and plain `npm run serve` use the same scheduler.

When collecting from Docker, mount the host user's AI tool log directory into the container. `docker-compose.yml` includes the required environment variables and mount. The default interval is 5 minutes and data is written to the same `./data/usage.sqlite` database.

Linux/macOS:

```bash
export INGEST_TOKEN="your-secret-token"
export AI_TOKEN_DASHBOARD_COLLECTOR_HOME="$HOME"
export SCHEDULED_COLLECT_ENABLED=true
export SCHEDULED_COLLECT_RUN_ON_START=true
export COLLECT_DEVICE="my-laptop"
export SCHEDULED_COLLECT_INTERVAL_SECONDS=300
docker compose up -d
```

PowerShell:

```powershell
$env:INGEST_TOKEN = "your-secret-token"
$env:AI_TOKEN_DASHBOARD_COLLECTOR_HOME = $env:USERPROFILE
$env:SCHEDULED_COLLECT_ENABLED = "true"
$env:SCHEDULED_COLLECT_RUN_ON_START = "true"
$env:COLLECT_DEVICE = "my-laptop"
$env:SCHEDULED_COLLECT_INTERVAL_SECONDS = "300"
docker compose up -d
```

Notes:

- Without `SCHEDULED_COLLECT_ENABLED`, the server only starts the dashboard/ingest service and does not collect automatically.
- `AI_TOKEN_DASHBOARD_COLLECTOR_HOME` must point to the host user directory that contains logs such as `.codex`, `.claude`, `.hermes`, and `.local/share/opencode`.
- Outside Docker, you can also configure `enabled`, `intervalSeconds`, `runOnStart`, and `device` under `scheduledCollect` in `config/collectors.json`.
- If AI tool data lives across multiple directories, provide a custom collector config with `AI_TOKEN_DASHBOARD_CONFIG`.

---

## Configuration

| Environment variable | Default | Description |
|---------------------|---------|-------------|
| `HOST` | `127.0.0.1` | Bind address; external access requires a token. Docker uses `0.0.0.0` |
| `PORT` | `4173` | HTTP server port |
| `API_PORT` | `4173` | API server port used by `npm run dev` |
| `CLIENT_PORT` | `5173` | Vite frontend port used by `npm run dev` |
| `DATABASE_URL` | _(unset)_ | PostgreSQL/Supabase or MySQL connection URL; takes precedence over SQLite |
| `DB_DRIVER` | `sqlite` | Database driver when `DATABASE_URL` is unset |
| `DB_PATH` | `data/usage.sqlite` | SQLite database path |
| `DB_POOL_SIZE` | `10` | PostgreSQL/MySQL connection pool size |
| `DB_CONNECT_TIMEOUT_MS` | `10000` | Remote database connection timeout in milliseconds |
| `DISPLAY_TZ` | Host timezone | IANA timezone for collection dates and hourly charts; set explicitly on UTC hosts. Keep it consistent across collectors and hub |
| `DASHBOARD_TOKEN` | _(unset)_ | Dashboard and read API password, falling back to `INGEST_TOKEN` |
| `INGEST_TOKEN` | _(unset)_ | Upload token, falling back to `DASHBOARD_TOKEN`. Without either token, only loopback binding is allowed |
| `SCHEDULED_COLLECT_ENABLED` | `false` | Enable the built-in scheduled collector |
| `SCHEDULED_COLLECT_INTERVAL_SECONDS` | `300` | Scheduled collection interval in seconds, minimum 10 seconds |
| `SCHEDULED_COLLECT_RUN_ON_START` | `false` | Run one collection shortly after server startup |
| `COLLECT_DEVICE` | hostname | Device label stored with scheduled collection records |
| `COLLECTION_RUNS_KEEP` | `500` | Keep only the newest N collection-run records; older ones are pruned whenever the database is opened |
| `PARSE_CACHE` | `1` | Incremental parse cache. When enabled, unchanged session files are skipped by file fingerprint (mtime + size); set to `0` to disable |
| `SUBSCRIPTION_QUOTA_ENABLED` | `true` | The subscription-window bars in the top bar (Claude/Codex 5-hour / 7-day utilization). **This is the only feature that makes network calls**: it uses the OAuth credentials already stored on your machine to call the vendors' own usage endpoints. Set to `false` to disable |

### Pricing Caches

The repository includes two bundled pricing caches:

- `data/pricing-litellm.json`
- `data/pricing-openrouter.json`

Normal collection prefers these local caches, so cost estimation does not need network access. To refresh upstream pricing manually, run:

```bash
npm run pricing:update
```

CLI flags for `npm run collect`:

| Flag | Example | Description |
|------|---------|-------------|
| `--device` | `my-laptop` | Device label stored with each record (defaults to hostname) |
| `--db` | `/path/to/db` | Override the SQLite path |
| `--push` | `http://hub:4173/api/ingest` | Push collected data to a remote hub |
| `--token` | `your-secret-token` | Bearer token for the remote hub |
| `--source` | `"Codex CLI"` | Process one source using its exact dashboard label |
| `--full` | — | Preview a complete device/source replacement without writing |
| `--apply` | — | With `--full`, back up and apply the replacement |
| `--dry-run` | — | Preview collection changes only |
| `--allow-empty` | — | With `--full --source`, explicitly allow clearing a scope with no logs |

Collection scans available history and writes changed rows, including late events. Existing amounts are preserved; only verified usage deltas add cost. Unknown historical pricing stays marked as unknown. Updating the price catalog does not reprice stored usage.

Preview a rebuild before applying it, and verify that the original logs are complete:

```bash
npm run collect -- --source "Codex CLI" --full
npm run collect -- --source "Codex CLI" --full --apply
```

Apply saves a scoped backup in `data/backups/`, then replaces daily, event and legacy workspace rows in one transaction. Preview recovery with `npm run db:restore -- --file <backup-path>`, and add `--apply` to restore. See [Usage accounting and upgrades](docs/usage-accuracy.md) for cost provenance, sync recovery and API contracts.


---

## Privacy & Security

- All data collection reads **local files only** — normal collection makes no network calls.
- `npm run pricing:update` intentionally contacts upstream pricing sources to refresh local caches.
- Nothing is uploaded unless you explicitly pass `--push`.
- `--push` sends data only to the URL you provide.
- The server binds to loopback by default. External binding requires authentication for the dashboard, read APIs and uploads.
- `POST /api/collect` only accepts loopback requests, so remote pages cannot trigger local log scans.
- Do not commit `data/usage.sqlite`, `.env`, or any exported data files.

### Subscription Quota & Account Info

The subscription-window bars in the top bar (`SUBSCRIPTION_QUOTA_ENABLED`, on by default) are the **only feature that actively goes online**. They read the login state that the official CLIs already store on your machine, query the vendors' own usage endpoints, and label each card with the currently signed-in account. All of this lives in `src/quota.mjs`; the data sources are fixed local files (each path overridable via the official environment variables):

| Information | Source |
|-------------|--------|
| Claude login token | macOS Keychain `Claude Code-credentials`; falls back to `~/.claude/.credentials.json` (directory overridable via `CLAUDE_CONFIG_DIR`) |
| Claude plan / login expiry | `subscriptionType` / `expiresAt` in the same credentials |
| Claude email / name | The `oauthAccount` field in `~/.claude.json` |
| Codex login token | `~/.codex/auth.json` (directory overridable via `CODEX_HOME`) |
| Codex email / name / plan | Parsed from the `id_token` (JWT) in that file |

Data-flow guarantees:

- **Outbound allowlist**: only `api.anthropic.com/api/oauth/usage` (Claude) and `chatgpt.com/backend-api/wham/usage` (Codex). Each token is sent only to its own vendor — the same destination the official CLIs use — never to any third party.
- **Emails are masked server-side** before reaching the client (e.g. `some***@example.com`); the raw address never leaves the server.
- **Tokens, account IDs, and other sensitive fields are never sent to the client** — they are only used server-side to make the requests above.
- Account and quota data are **live state**: never written to SQLite, never logged, never persisted to any file.
- The code contains **no account literals** — emails / tokens / IDs are all read from local files at runtime, used in memory, and discarded.
- Set `SUBSCRIPTION_QUOTA_ENABLED=false` to disable the feature entirely; no outbound requests are made and the cards are hidden.

---

## Project Structure

```
src/
├── collect.mjs          # CLI entry point for data collection
├── dev.mjs              # Development mode: API server + Vite
├── server.mjs           # HTTP server + API
├── db.mjs               # SQLite/PostgreSQL/MySQL adapter and upserts
├── db-init.mjs          # Initialize the database schema
├── db-migrate.mjs       # Migrate SQLite history
├── db-check.mjs         # Check connectivity and row counts
├── pricing.mjs          # LiteLLM + OpenRouter pricing lookup and cost estimation
├── update-pricing.mjs   # Refresh local pricing caches
├── collector-config.mjs # Reads config/collectors.json and expands paths
├── collectors/          # Per-tool data collectors
│   ├── claude-code.mjs
│   ├── codex.mjs
│   ├── opencode.mjs
│   ├── gemini.mjs
│   ├── hermes.mjs
│   ├── openclaw.mjs
│   └── utils.mjs
└── client/
    ├── dashboard/       # Main usage dashboard (React)
    ├── review/          # Retrospective view (React)
    └── shared/          # Shared utilities
data/
├── pricing-litellm.json     # Bundled LiteLLM pricing cache
└── pricing-openrouter.json  # Bundled OpenRouter pricing cache
db/
├── schema.sqlite.sql        # SQLite initialization schema
├── schema.postgres.sql      # PostgreSQL/Supabase initialization schema
└── schema.mysql.sql         # MySQL initialization schema
```

---

## Contributing

Contributions are welcome. To add support for a new tool, implement a collector in `src/collectors/` that exports a `collect()` function returning `{ graphJson, modelsJson, eventsJson }` — see existing collectors for the expected shape.

Please open an issue before submitting large changes.

---

## License

MIT — see [LICENSE](LICENSE).
