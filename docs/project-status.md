# 项目状态与后续工作

更新日期：2026-10-04。增量同步及页面优化见 [PR #30](https://github.com/fengguanghuai/ai-token-dashboard/pull/30)；可选日志字节续读与固定快照导出见 [PR #31](https://github.com/fengguanghuai/ai-token-dashboard/pull/31)；发布准备与合成查询基准见 [PR #32](https://github.com/fengguanghuai/ai-token-dashboard/pull/32)。代码、验证与合并状态以对应 PR 为准，不代表已部署。

本文件是当前待办与完成状态的统一入口。性能文档记录实现边界和测量证据，历史计划保留方案演变，不作为当前执行清单。这里的“完成”只针对该项验收范围，不代表整个项目不存在问题。

## 原始四项待办

| 编号 | 原始目标 | 当前状态 | 证据与未完成边界 |
| --- | --- | --- | --- |
| START-01 | 启动端口检查与友好提示 | 已完成 | [PR #24](https://github.com/fengguanghuai/ai-token-dashboard/pull/24)、[启动脚本](../src/dev.mjs)：启动子进程前探测端口，冲突时给出提示。 |
| QUERY-01 | 精确时间查询聚合、明细按需分页 | 已完成 | [PR #24](https://github.com/fengguanghuai/ai-token-dashboard/pull/24)、[查询说明](query-performance.md)：统计基于完整选定范围，事件详情按页加载。 |
| SYNC-01 | 同步读取变更记录，避免完整快照比较 | 已完成 | [PR #30](https://github.com/fengguanghuai/ai-token-dashboard/pull/30)：[变更记录](../src/sync-journal.mjs)与用量同事务；[同步](../src/sync.mjs)按目标、设备、来源保存确认进度。首次基线后只读取变化记录，支持历史修正、重试、显式范围替换和慢目标保留；三库契约测试通过。 |
| READ-01 | 日志从上次位置续读，避免重读变化的大文件 | 部分完成；Codex、Claude 有可选模式 | [PR #31](https://github.com/fengguanghuai/ai-token-dashboard/pull/31) 的 Codex 续读已扩展到 [Claude](../src/collectors/claude-code.mjs)，分别使用 `CODEX_LOG_APPEND_ONLY=1` / `CLAUDE_LOG_APPEND_ONLY=1`。默认完整读取变化文件；可选模式仅读新增字节及未完成行，不能检测历史中部改写后增长，其余来源尚未支持。 |

**计数：3 项完成、1 项部分完成。** 页面“上一周期对比”和多设备“同步比较”是不同功能，不能用 QUERY-01 或 PR #26 代替 SYNC-01 的完成证据。

## 其他已交付内容

| 内容 | 合并证据 | 范围 |
| --- | --- | --- |
| 用量可靠性、费用保留与恢复规则 | [PR #20](https://github.com/fengguanghuai/ai-token-dashboard/pull/20) | 具体语义见[费用与升级说明](usage-accuracy.md)；不将历史估算宣称为已还原账单。 |
| 开发模式采集请求的来源校验兼容 | [PR #21](https://github.com/fengguanghuai/ai-token-dashboard/pull/21) | Vite 代理保留浏览器请求来源。 |
| 采集缓存、变化日期核对和完成通知 | [PR #22](https://github.com/fengguanghuai/ai-token-dashboard/pull/22)、[PR #23](https://github.com/fengguanghuai/ai-token-dashboard/pull/23) | 见[采集性能](collection-performance.md)。这是本地采集优化，不是 SYNC-01 的同步变更序列。 |
| 诊断命令与首次使用冒烟测试 | [PR #25](https://github.com/fengguanghuai/ai-token-dashboard/pull/25) | `npm run doctor`、`npm run test:onboarding`；见[诊断说明](doctor.md)。 |
| 普通首页和复盘按日期查询 | [PR #26](https://github.com/fengguanghuai/ai-token-dashboard/pull/26) | 包含对比周期、全局筛选选项、有限缓存和请求取消；“全部”仍查询全部历史汇总。 |
| 用量 CSV 流式导出、移除首页历史口径横幅 | [PR #28](https://github.com/fengguanghuai/ai-token-dashboard/pull/28) | 服务端分批输出，下载由浏览器管理；帮助说明和历史费用保留。不是事务快照导出。 |

截至基线，以上 PR 的合并提交均在 Git 历史中。历史测试与基准结果只适用于当时版本和样本。

## 本轮高收益优化

[PR #30](https://github.com/fengguanghuai/ai-token-dashboard/pull/30) 按用户确认顺序实现；验收边界见[查询性能](query-performance.md)和[同步性能](collection-performance.md)。

| 编号 | 范围 | 代码与验证 |
| --- | --- | --- |
| TZ-01 | 页面与服务端时区一致 | `/api/config`、`display-time.js`；覆盖跨月、DST、明细、对比与导出范围。已有日汇总不自动重建。 |
| ASSET-01 | 静态资源与路由加载 | gzip、ETag、HEAD、私有缓存；首页与复盘独立加载，认证先于缓存判断。 |
| QUOTA-01 | 合并额度并发请求 | `request-cache.mjs`；共享进行中的调用，保留成功/错误两种 TTL，失败可重试。 |
| HOURLY-01 | 复用重复小时统计 | 10 秒有限缓存，以数据库来源修订号失效；外部连接写入由集成测试验证。 |
| BROWSER-01 | 可重复的浏览器回归 | `npm run test:browser`，临时 SQLite、合成数据、跨时区 Chromium；独立 CI job。 |

## 原始验收记录与后续顺序

### 1. SYNC-01：事务变更记录与确认进度

当前实现使用持久化变更记录和每个目标端独立的确认进度，替代常规同步的完整快照哈希比较。SQLite 本地契约测试及 CI 中 PostgreSQL/MySQL 的同一契约均通过。独立数据库副本测得无变化同步约 2 ms，旧方式约 409–417 ms；1 条历史修正只读取并发送 1 条变化，历史金额未重新计算。

完成条件：

- 用量写入与变更记录同事务提交；覆盖采集、导入、恢复和显式全量替换等写入入口。
- 首次同步建立基线后，无变化和少量变化的常规同步不读取整个用量快照，不重新散列全部历史，也不重写整份历史行确认清单。
- 确认进度按目标地址、设备和必要的来源范围隔离；只在远端确认后推进。部分失败、响应丢失、重启重试不丢记录，重放保持幂等。
- 补入旧记录、历史记录更新和显式范围替换都能传递；不能仅依赖最大事件时间。清理变更记录时保留慢目标的恢复路径。
- SQLite、PostgreSQL、MySQL 测试通过；与完整同步逐项核对事件、Token 和已有费用，并记录无变化/少量变化场景的读取行数与耗时。

### 2. READ-01：有明确可靠性边界的字节续读

先以 Codex 为首个支持来源；其他采集器单独记录支持范围。现有解析状态、累计用量、fork 重放和跨文件去重语义必须保留。

2026-10-04 用户确认保留默认完整校验、增加可选只追加模式。该模式已覆盖重启续读、文件身份变化、可观察截断、同大小改写、半行、UTF-8 分割、缓存损坏和模式切换。64 MiB 合成日志追加 157 字节，仅读取 157 字节；结果与完整校验一致。原始目标继续标为部分完成，因为通用日志的“历史改写检测”和“跳过旧字节”不能同时保证。具体启用方式与测试边界见[采集性能](collection-performance.md#codex-可选字节续读)。

后续扩展到 Claude JSONL，默认仍完整解析变化文件。检查点保存原始用量快照和绝对行号，续读后重新合并响应，保留迟到的流式修正、advisor 和 sidechain 去重。没有修改共享字节读取器或数据库费用逻辑；重复快照较多时缓存可能增大，详见 [Claude 续读边界](collection-performance.md#claude-可选字节续读)。

完成条件：

- 明确哪些日志可以认定为只追加，以及无法确认时的回退策略。仅靠文件大小、时间戳或头尾抽样，不能保证发现历史中部改写。
- 在确认支持的追加场景中，读取量随新增字节增长，不再为每次追加读取完整旧前缀；用实际读取字节数验证，不只测 JSON 解析耗时。
- 覆盖进程重启、文件替换/轮转、截断、半行 JSON、UTF-8 半字符、缓存损坏和版本变化；结果与完整解析一致。
- 若无法在保证所需正确性的前提下跳过旧内容校验，保持“部分完成”，记录限制；不能用重命名或缩小验收口径宣称原始目标完成。
- 测试与基准明确区分读取、解析、整次采集耗时和峰值内存。

### 3. EXPORT-02：固定快照导出（已实现）

新增固定快照导出：在数据库只读一致性快照内按页生成私有临时 CSV，提交并释放连接后再开始下载。SQLite 使用独立只读连接，PostgreSQL/MySQL 使用可重复读事务。并发替换来源时，导出各页仍对应同一版本；慢下载不持有数据库事务。验证覆盖取消、查询失败、临时文件清理与三库同一契约，远程库由 CI 验证。见 [PR #31](https://github.com/fengguanghuai/ai-token-dashboard/pull/31) 和[导出边界](query-performance.md#csv-导出边界)。

验收：并发写入时，导出仍对应同一版本；内存保持有界；取消、失败和临时资源清理可靠；慢速下载不长期占用写事务。实现方案需同时考虑三种数据库。

### 4. RELEASE-01：公开版本准备（验收流程与文档已补齐）

已有中英文 README、MIT 许可证、诊断命令和跨平台 CI，应在这些基础上补充，避免重复搭建。

本轮新增 [Unreleased 版本说明](../CHANGELOG.md)、[升级/回退和支持边界](release.md)、[贡献与反馈入口](../CONTRIBUTING.md)，以及 `npm run test:release`。它复用首次安装冒烟，再用 PR #30 前的冻结 SQLite schema 验证备份、升级、历史字段保留、同步、重启和恢复；三平台 CI 执行同一流程。它不验证任意旧库或远程生产备份，具体限制见升级文档。目标提交的 CI 通过与实际发布分别以 PR / Release 证据为准，当前仍标记 Unreleased。

本地 macOS arm64 / Node 22.22.2 验收：从提交 `9aa2221` 的干净归档安装 `npm ci`，`npm run test:release` 通过；工作区 `npm test` 为 188 通过、2 个远程库测试跳过。跨平台、远程库和浏览器结果见 [PR #32 CI](https://github.com/fengguanghuai/ai-token-dashboard/pull/32/checks)。

验收：形成版本说明、升级/回退与已知限制说明、贡献及问题反馈入口；对拟发布版本完成全新安装和升级验收；确认文档描述的采集器与平台支持范围。准备完成与实际发布分别记录，不能把 `package.json` 的版本号当成已发布证据。

### 5. QUERY-02：大范围预聚合（按测量决定）

“全部”仍会读取全部日/项目汇总，尚无服务端物化汇总缓存。只有实际查询与内存测量显示需要时才安排，不能仅因缺少缓存就认定为缺陷。

2026-10-04 已加入可重复的[合成查询基准](../scripts/query-benchmark.mjs)，完成 10 万 / 100 万事件的全历史与 30 天对比。100 万全历史约 1.09 秒、峰值 RSS 158 MiB、响应约 10 MiB；30 天约 190 ms、63 MiB。测量不含浏览器、并发及远程库。本轮完成测量，未实现预聚合；后续在实际大库高频全历史场景同时评估查询时间与响应体积，详见[查询证据](query-performance.md#大范围查询的可重复基准)。

## 更新规则

- 原始目标保留固定编号；新增任务单列，不能挤掉未完成项。
- “部分完成”必须同时写已实现范围与剩余验收条件；代码、测试、合并、运行验证分开记录。
- 后续变更沿用功能分支、可审阅的提交、PR、CI 通过后合并的流程。状态变化时更新本页，并链接实现和验证证据。
- 历史金额按既定规则保留，只补可确认的漏算，不为性能优化重算全部历史。
- 不用一个整体百分比代替不同目标的验收，也不因本页已整理就宣称任何未完成目标已修复。
