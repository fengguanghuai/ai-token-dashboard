# 版本准备、升级与回退

当前变更记录在 [Unreleased](../CHANGELOG.md)。发布准备、PR 合并、GitHub Release 和正在运行的服务是四个独立状态；`package.json` 中的 `0.1.0` 不表示已经发布。本文不执行打标签、发布或服务重启。

## 发布前验收

在目标提交的全新目录中执行 `npm ci`，随后运行：

```sh
npm test
npm run test:release
npx playwright install chromium
npm run test:browser
```

`test:release` 先构建并执行首次安装冒烟：诊断缺失数据库、初始化、重复采集合成 Pi 日志、构建页面/资源与用量接口。随后使用提交 `193277e1d5a8f71c90c192e926e12db42032c729` 的冻结 SQLite schema（PR #30 之前），验证一致性备份、两次初始化升级、历史所有用量字段保留、新采集、首次 HTTP 同步、进程重启后无变化同步、恢复旧备份及再次升级。记录零费用、历史估算和未知费用来源都必须保留。测试只访问临时目录和合成数据。

这证明对应旧 schema 的升级与数据备份恢复，不代表执行了旧版本应用的端到端回退，也不覆盖任意更早或被手工修改的数据库。历史列升级另有单元测试。跨库的事务、同步和 CSV 一致性由 PostgreSQL/MySQL 集成测试覆盖；本轮不声称验证了远程生产备份或恢复。

发布时记录目标 commit、CI 链接、版本号/Tag、已知限制及制品来源。六项 CI 检查（3 个平台、浏览器、依赖审计、数据库集成）均通过后，才将候选描述为通过验证；实际发布后再记录 Release 链接。部署后另查 HTTP、采集与同步，不用 CI 替代运行验收。

## 升级已有实例

1. 记录当前 commit、Node 版本、实际数据库类型/路径和部署配置。先在数据库副本上演练；保留 `.env`、采集路径配置及旧构建产物在私有位置。
2. 暂停该数据库的所有采集进程、定时任务、同步接收端和其他写入者。所有共享数据库的写入程序必须一起升级；旧程序写入不会生成新同步变更记录，可能导致漏同步。
3. 备份完整数据库。SQLite 不要只复制正在使用的 `.sqlite` 主文件，WAL 中可能仍有已提交数据。下面的 Node 命令以只读源连接执行一致性 `VACUUM INTO`；源路径必须是实际 SQLite 数据库，目标必须是私有目录下尚不存在的文件，磁盘空间至少容纳一份数据库：

   ```sh
   node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1],{readOnly:true}); try {db.prepare('VACUUM INTO ?').run(process.argv[2]);} finally {db.close();}" "/absolute/path/usage.sqlite" "/private/backup/usage-before-upgrade.sqlite"
   ```

   校验备份能打开且 `PRAGMA integrity_check` 返回 `ok`，并核对三张用量表的行数、Token 和金额；测试脚本执行了同一备份命令及逐字段核对。PostgreSQL/MySQL 使用对应数据库的完整一致性备份或托管快照，并在独立库验证恢复；不能用 CSV 导出替代数据库备份。
4. 在新代码目录安装锁定依赖并构建：`npm ci`、`npm run build`。带入原配置，确认没有指向错误数据库，然后运行 `npm run doctor`、`npm run db:init`、`npm run db:check`。`db:init` 会修改 schema；`doctor` 只做诊断。初始化不重估历史金额，可能补锁价元数据及整理运行记录。
5. 启动新版本，检查页面、日期范围、历史 Token/金额和 CSV；确认没有端口冲突后再恢复定时采集和同步。已有日汇总不会因 `DISPLAY_TZ` 改变而重建，采集端和中心应使用一致时区。
6. 第一次同步会发送历史基线；后续按修订发送变化。保留原设备名和来源，观察失败后的重试及中心结果。单独 `--resync` 不删除中心数据；`--full --apply` 是备份后替换范围的独立操作，不是升级必需步骤。

Codex 的 `CODEX_LOG_APPEND_ONLY` 默认关闭；仅当日志旧内容保证不改写时才显式设为 `1`。模式切换会重建解析缓存。它不能检测“中部改写后文件又增长”的情况，详见[采集边界](collection-performance.md)。

## 回退

先停止全部相关写入者，另存升级后的完整数据库及日志，以便保留升级后新增用量。把升级前备份恢复到**新的空路径或独立数据库**，不要覆盖带有旧 WAL/SHM 的活动 SQLite 路径。恢复旧 commit、依赖和构建产物，配置为已恢复的数据库；核对完整性、行数、Token、金额后再启动旧程序。

恢复备份只恢复到备份时刻，之后新增数据需要另行核对合并。共享数据库及同步两端需协调回退，在核对完成前保持上传暂停，避免用较旧快照覆盖较新历史。没有经过验证的备份时，不能把直接启动旧代码视为可靠回退，也不要临时删除同步表规避问题。`db:restore` 恢复的是 JSON 用量范围，不是数据库 schema 或同步进度的版本回退。

## 支持与已知限制

| 维度 | 已有验证与边界 |
| --- | --- |
| 系统与运行时 | Node ≥22.15；macOS、Linux、Windows CI 执行构建、合成采集和升级验收。真实 Chromium 交互在 Linux CI 验证。不能据此宣称每个平台上的全部厂商客户端日志均经过真实环境验收。 |
| 数据库 | SQLite 为默认；CI 验证 PostgreSQL 16、MySQL 8.4。MySQL 展示时区统计需要正确加载时区表。其他版本和托管网络配置需单独检查。 |
| 采集器 | 九类来源见[采集器说明](local-collectors.md)。日志格式兼容性取决于实际客户端版本，未配置来源不产生日志。Gemini 当前只返回日/会话汇总，不提供精确事件视图；项目统计需要事件中有真实路径。 |
| 压缩日志 | DSH 的 zstd 需要 Node 提供相关 API；不支持时跳过压缩文件并提示。 |
| 费用 | 已记录金额优先，缺失时估算；未知模型为零不表示免费，估算不能作为厂商账单。 |
| 导出 | 固定快照先落临时磁盘再下载，需要相应磁盘空间；强制终止可能留下私有临时文件。 |
| 大范围查询 | “全部”返回全部日/项目汇总，事件详情仍分页；响应大小随汇总维度增长。合成测量见[查询性能](query-performance.md)。 |
| 联网与权限 | 普通采集默认只读本地日志并写本地配置数据库；显式同步/价格刷新联网。订阅额度默认启用，会查询上游且可能刷新本机 OAuth 凭据；可设 `SUBSCRIPTION_QUOTA_ENABLED=false`。非本机监听必须配置令牌。 |

贡献和问题反馈见 [CONTRIBUTING](../CONTRIBUTING.md)。
