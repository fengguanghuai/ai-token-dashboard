# AI Token Dashboard

一个轻量的本地 AI Token 用量看板。它会读取本机多种 Agent/CLI 的本地使用记录，统一写入 SQLite，并通过一个 React 应用提供两个视图：

- `/`：交互式用量看板，包含趋势、来源、模型、项目/会话和采集记录。
- `/review`：复盘页，按周期生成更适合阅读和打印的总结。

默认采集只读取本机文件和本机 SQLite，不会调用第三方上传命令。只有显式传入 `--push` 时，才会把本机汇总结果上报到你指定的中心节点。

## 支持的数据源

项目只保留纯 JavaScript 本地采集器，目前覆盖：

- Claude Code：读取 `~/.claude/projects/` 下的 JSONL 会话。
- Hermes Agent：读取 `~/.hermes/state.db` 或 `$HERMES_HOME/state.db`。
- Codex CLI：读取 `~/.codex/sessions/` 下的 JSONL 会话。
- Gemini CLI：读取 `~/.gemini/tmp/` 下的 JSON/JSONL 会话。
- OpenClaw：读取 `~/.openclaw/agents/` 以及历史兼容目录下的 JSONL transcript。

`npm run collect` 会直接执行这些本地 collectors，不需要 Rust、本地二进制或额外 CLI 包。

## 本地运行

```bash
npm install
npm run collect
npm run build
npm run serve
```

默认访问：

```text
http://localhost:4173
http://localhost:4173/review
```

数据库默认写入：

```text
data/usage.sqlite
```

`data/` 是本机私有数据目录，默认不会进入 Git。

## 多设备采集

中心设备启动 Web 服务：

```bash
INGEST_TOKEN="change-me" npm run serve
```

每台使用 AI 的设备部署这个项目，定时运行：

```bash
npm run collect -- --device "my-laptop"
```

如果要上报到中心节点：

```bash
npm run collect -- \
  --device "my-laptop" \
  --push http://center-host:4173/api/ingest \
  --token "change-me"
```

中心节点会把所有设备的 daily/session 记录写入同一个 SQLite，并在 Web 页面统一展示。

## Docker

Docker 镜像适合作为中心看板和 ingest 服务：

```bash
INGEST_TOKEN="change-me" docker compose up -d
```

容器会把数据写入挂载的 `./data`。本机日志采集通常应该在宿主机执行，因为各类 Agent/CLI 的使用记录一般保存在宿主机用户目录中。

## 隐私和安全

- 本项目读取本机 AI 工具的本地日志、SQLite 或缓存文件，并生成聚合后的 token/cost 数据。
- 默认不会上传任何数据。
- `--push` 只会发送到你提供的 URL。
- `INGEST_TOKEN` 开启后，`/api/ingest` 需要 Bearer token。
- 不要提交 `data/usage.sqlite`、`.env` 或任何采集后的导出文件。

## 开源说明

本项目以 MIT License 发布。

## 前端形态

当前前端是单入口 Vite + React。源码位于：

```text
src/client
```

本地开发前端可以运行：

```bash
npm run dev
```

生产构建输出到 `dist/`，由 `src/server.mjs` 托管：

```bash
npm run build
npm run serve
```
