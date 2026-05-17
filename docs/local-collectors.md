# 本地采集器架构

## 目标

本项目只保留纯 JavaScript 本地采集路径。采集过程读取用户机器上的 AI 工具日志、JSONL transcript、JSON session 或 SQLite 状态库，统一归一化后写入本项目自己的 SQLite。

项目不再 vendoring 外部采集 runner，也不再提供 Rust 构建脚本或外部二进制兼容入口。

## 采集架构

```text
npm run collect
  -> src/collect.mjs
  -> src/collectors/*.mjs
  -> daily_usage: 每日 source/model token 与 cost
  -> session_usage: workspace/model 或 session/project 维度排行
  -> collection_runs: 记录采集状态
```

## 支持范围

- Claude Code：`~/.claude/projects/`
- Hermes Agent：`~/.hermes/state.db` 或 `$HERMES_HOME/state.db`
- Codex CLI：`~/.codex/sessions/`
- Gemini CLI：`~/.gemini/tmp/`
- OpenClaw：`~/.openclaw/agents/`、`~/.clawdbot/agents/`、`~/.moltbot/agents/`、`~/.moldbot/agents/`

## 数据映射

各 collector 输出统一的中间结构：

- `contributions[]`：用于生成 `daily_usage`
- `entries[]`：用于生成 `session_usage`

写入后由 `src/server.mjs` 暴露 `/api/data` 和 `/api/summary`，前端页面只消费这两个 API。

## 安全边界

- 默认只读取本机文件，不上传数据。
- 多设备上报只在显式传入 `--push` 时发生。
- `/api/ingest` 可以通过 `INGEST_TOKEN` 开启 Bearer token 校验。
- `data/usage.sqlite`、`.env` 和采集导出文件不应提交到 Git。
