# 本地采集器架构

## 目标

本项目只保留纯 JavaScript 本地采集路径。采集过程读取用户机器上的 AI 工具日志、JSONL transcript、JSON session 或 SQLite 状态库，统一归一化后写入本项目配置的 SQLite / PostgreSQL / MySQL。

项目不再 vendoring 外部采集 runner，也不再提供 Rust 构建脚本或外部二进制兼容入口。

## 采集架构

```text
npm run collect
  -> src/collect.mjs
  -> src/collectors/*.mjs
  -> collection_checkpoints: 比较日期签名，事务内核对变化日期
  -> daily_usage: 每日 source/model token 与 cost
  -> time_usage: 带真实时间与项目路径的事件明细
  -> session_usage: 保留旧 workspace/model 聚合兼容数据
  -> collection_runs: 记录采集状态
```

## 支持范围

- Claude Code：`~/.claude/projects/`
- Hermes Agent：`~/.hermes/state.db` 或 `$HERMES_HOME/state.db`
- Codex CLI：`~/.codex/sessions/`
- Gemini CLI：`~/.gemini/tmp/`
- OpenClaw：`~/.openclaw/agents/`、`~/.clawdbot/agents/`、`~/.moltbot/agents/`、`~/.moldbot/agents/`
- OpenCode：`~/.local/share/opencode/`
- Grok CLI：`~/.grok/sessions/`
- DeepSeek Harness：`~/.dsh/sessions/`
- Pi Agent：`~/.pi/agent/sessions/`；优先读取 `PI_CODING_AGENT_SESSION_DIR`，其次为 `PI_CODING_AGENT_DIR/sessions`，再使用 `collectors.pi.roots`

## 数据映射

各 collector 输出统一的中间结构：

- `contributions[]`：用于生成 `daily_usage`
- `entries[]`：用于生成旧兼容 `session_usage`
- `events[]`：用于生成 `time_usage`；项目排行只从带项目路径的事件聚合，按日期、设备、来源和模型过滤

写入后由 `src/server.mjs` 暴露 `/api/data`（日聚合 / 项目日聚合 / 采集记录）和 `/api/time`（按时间范围、游标分页加载事件，每页最多 2000 条），前端页面消费这两个 API。

解析缓存未变化时不再重写 JSON；更新缓存采用临时文件和原子替换。数据库核对以完整归一化结果的日期签名判断变化，不使用事件时间水位线，因此迟到的历史记录仍会入库。无变化时跳过用量表读取，变化时保留跨日期的项目活动和历史费用。更多说明见 [采集性能](collection-performance.md)。

## 安全边界

- 默认只读取本机文件，不上传数据。
- 多设备上报只在显式传入 `--push` 时发生。
- 默认只监听 `127.0.0.1`。外部监听必须配置 `DASHBOARD_TOKEN` 或 `INGEST_TOKEN`，页面、读写 API 都需要鉴权。
- `--full` 默认预览，只有 `--full --apply` 才备份并替换指定范围。费用与恢复规则见 [usage-accuracy.md](usage-accuracy.md)。
- `data/usage.sqlite`、`.env` 和采集导出文件不应提交到 Git。
