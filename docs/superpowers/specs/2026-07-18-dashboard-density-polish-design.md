# Dashboard 紧凑化与图表修正 — 设计

日期：2026-07-18
背景：用户反馈四个问题——趋势图圆角处理不好、来源占比环形图只画出 2 个扇区、
缓存卡/环比卡下方大片留白、热力图格子偏小且左右悬浮空白多。

## 1. 趋势图去圆角

`components-charts.jsx` TrendChart：

- 柱状 / 堆叠模式下所有柱子 `borderRadius` 归零（直接不再设置 itemStyle.borderRadius）。
- 删除只为"堆叠顶端段加圆角"服务的 `topSourceByDate` useMemo 及其引用。
- 折线模式不变。

## 2. 环形图恢复显示全部来源

`components-charts.jsx` SourceDonut：

- 去掉扇区 `itemStyle.borderRadius: 8`（方角扇区）。
- 删除 `<0.5%` 的 pieData 过滤（该过滤是圆角扇区在接缝处挤成圆点的规避手段，
  圆角移除后不再需要）。全部来源入环，`minAngle: 2` 保底可见。
- 图例逻辑不变。

## 3. 中间行（Top 模型 6 + 缓存 3 + 环比 3）：充实数据 + 等高

### 等高（styles.css）

- 该行（及其它行）卡片高度拉满：`.grid > [class^="col-"] > .panel { height: 100% }`
  （或等效选择器），panel 内容 flex column 分布，白卡填满行高。

### 缓存卡（Gauge）新增数据

- **缓存节省费用**：突出显示 `≈ $X`，副文案"若无缓存需多付"。
  数据来源见下方服务端改动；按当前筛选聚合（`totals.cacheSavedUSD`）。
- **每日命中率 sparkline**：按当前筛选按日计算 `cacheRead/total`，
  复用 `components-top.jsx` 的 `Spark` 组件（导出它），置于卡片底部。
- 现有"读取 vs 创建"压缩为一行紧凑数字（保留数值，去掉进度条）；
  "缓存占总 Token" 进度条移除，数值并入紧凑行或省略。

### 环比卡（GrowthPanel）

- 数据不变（DoD/WoW/MoM/日均/峰值），stat 列表 flex 均匀拉开填满高度。

### 服务端：cacheSavedUSD

`server.mjs` `/api/data`：

- 启动时 `loadPricing()`；daily 每行附加
  `cacheSavedUSD = max(0, calculateCost(model, {input: input+cacheRead+cacheWrite, output, reasoning})
  − calculateCost(model, {input, output, cacheRead, cacheWrite, reasoning}))`。
- 查不到定价时为 0。放在服务端按行算，保证与前端全部筛选维度联动。
- `utils.js` `aggregateTotals` 增加 `cacheSavedUSD` 求和。
- `App.jsx` 将 `totals.cacheSavedUSD` 与每日命中率序列传入 Gauge。

## 4. 热力图：响应式格子 + 小时分布

`components-charts.jsx` Heatmap + styles.css：

- 格子列宽改为 `minmax(13px, 1fr)` 并设格子 `max-width`（约 22px），
  `width: 100%`、高度固定 13px；网格 `width: 100%`（撑满左栏），不再 max-content 居中悬浮。
- 网格下方新增与 24 列对齐的**小时分布**迷你柱状图：
  对当前显示的 28 天按小时求和 tokens，24 根小柱（div 实现，同网格列轨道），
  hover 显示 tooltip（小时 + tokens）。
- 右侧活跃摘要新增一条"高峰时段 HH:00"（取小时分布峰值），与现有"高峰 周六"呼应。

## 改动范围

- `src/client/dashboard/components-charts.jsx`（四个组件）
- `src/client/dashboard/components-top.jsx`（导出 Spark）
- `src/client/dashboard/styles.css`（等高、热力图响应式、新元素样式）
- `src/client/shared/utils.js`（aggregateTotals）
- `src/server.mjs`（daily 行 cacheSavedUSD）
- `src/client/dashboard/App.jsx`（传参）

## 不做的事

- 不改表格区、KPI 行、筛选器。
- 不改数据采集与存储 schema。
- 环比卡不新增指标。

## 验证

- `npm run dev` 起本地服务，实际浏览器查看四处改动。
- 环形图应画出 4 个来源（Hermes Agent 0.11%、OpenCode 0.01% 可见小扇区）。
- 缓存节省费用应为正数且随筛选变化。
- 中间行三卡等高；热力图网格撑满左栏。
