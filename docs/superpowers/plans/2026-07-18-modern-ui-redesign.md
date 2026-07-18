# Token Studio 现代化 UI 重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `codex/modern-dashboard` 分支上，把看板重构为「左侧边栏 + 工具卡片主角概览 + 亮/暗双主题」的现代数据产品视觉，复盘页同步换肤。

**Architecture:** 保留现有 React + ECharts 数据流（App.jsx 的 fetch/state 不动），把 1090 行 App.jsx 按视图拆文件；样式全部重写为 CSS 变量 token 体系，`data-theme` 挂在 `<html>` 上切换亮暗；ECharts 配色运行时从 CSS 变量读取。后端零改动。

**Tech Stack:** React 18、ECharts 6、Vite 7、@phosphor-icons/react、node --test。

**设计规格:** `docs/superpowers/specs/2026-07-18-modern-ui-redesign-design.md`（本计划的唯一视觉依据）

## Global Constraints

- 后端 API、SQLite schema、采集逻辑零改动；只动 `src/client/**`、`index.html`。
- 现有 22 个测试（`npm test`）任何任务完成后都必须全绿；每个任务结束跑 `npm run build` 必须成功。
- 亮色为默认主题；暗色通过 `:root[data-theme='dark']` 覆盖变量实现；选择存 localStorage key `ts-theme`。
- 工具颜色一律用现有 `U.getSourceColor(name)`（`src/client/shared/utils.js:41`），不得新建第二套工具配色。
- 中文文案保持现有措辞，不重写文案。
- 数字一律 `font-variant-numeric: tabular-nums`。
- 复盘页 `/review` 永远亮色（含打印）。

### 设计 Token（所有任务共用，值以此为准）

| 变量 | 亮色 | 暗色 |
| --- | --- | --- |
| `--bg` | `#f7f7f8` | `#101014` |
| `--surface` | `#ffffff` | `#1b1b21` |
| `--surface-2` | `#fbfbfc` | `#17171c` |
| `--border` | `#e7e7ea` | `#26262c` |
| `--border-strong` | `#d9d9de` | `#32323a` |
| `--text` | `#18181b` | `#ededf0` |
| `--muted` | `#83838c` | `#8f8f9a` |
| `--accent` | `#5865f2` | `#6673ff` |
| `--accent-soft` | `#eef0fe` | `#23233c` |
| `--good` | `#16a34a` | `#4ade80` |
| `--bad` | `#dc2626` | `#f87171` |
| `--chart-grid` | `#ececf0` | `#26262c` |
| `--tooltip-bg` | `#1d1d20` | `#26262e` |
| `--radius` | `9px` | 同 |
| `--shadow` | `0 1px 2px rgba(24,24,27,.04)` | `none` |

字体栈：`'Inter', -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif`；等宽 `'JetBrains Mono', ui-monospace, monospace`（index.html 已加载这两个字体）。

---

### Task 1: 共享纯逻辑 — `sourceBreakdown` 与 `resolveTheme`（TDD）

**Files:**
- Modify: `src/client/shared/utils.js`（在 `projectLabel` 附近新增函数并加入 `U` 导出）
- Create: `src/client/dashboard/theme.js`
- Create: `test/client-ui.test.mjs`

**Interfaces:**
- Produces: `U.sourceBreakdown(rows) -> [{ source, totalTokens, costUSD, share, topModel }]`（按 totalTokens 降序；share 为 0-100；topModel 可为 null）
- Produces: `theme.js` 导出 `resolveTheme(stored) -> 'light'|'dark'`、`initTheme() -> theme`、`setTheme(theme)`、`chartVars() -> { text, muted, border, surface, accent, grid, tooltipBg }`

- [ ] **Step 1: 写失败测试**

```js
// test/client-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { U } from '../src/client/shared/utils.js';
import { resolveTheme } from '../src/client/dashboard/theme.js';

const rows = [
  { source: 'Claude Code', model: 'claude-opus-4-8', totalTokens: 700, costUSD: 5 },
  { source: 'Claude Code', model: 'claude-fable-5', totalTokens: 100, costUSD: 2 },
  { source: 'Codex CLI', model: 'gpt-5.6-sol', totalTokens: 200, costUSD: 1 }
];

test('sourceBreakdown aggregates per source with share and top model', () => {
  const out = U.sourceBreakdown(rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'Claude Code');
  assert.equal(out[0].totalTokens, 800);
  assert.equal(out[0].costUSD, 7);
  assert.equal(out[0].topModel, 'claude-opus-4-8');
  assert.equal(Math.round(out[0].share), 80);
  assert.equal(out[1].source, 'Codex CLI');
});

test('sourceBreakdown handles empty input and missing fields', () => {
  assert.deepEqual(U.sourceBreakdown([]), []);
  const out = U.sourceBreakdown([{ source: null, model: null, totalTokens: 'x', costUSD: null }]);
  assert.equal(out[0].source, '未标记');
  assert.equal(out[0].totalTokens, 0);
  assert.equal(out[0].topModel, null);
});

test('resolveTheme defaults to light and only accepts dark', () => {
  assert.equal(resolveTheme(null), 'light');
  assert.equal(resolveTheme('banana'), 'light');
  assert.equal(resolveTheme('dark'), 'dark');
  assert.equal(resolveTheme('light'), 'light');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/client-ui.test.mjs`
Expected: FAIL（`sourceBreakdown is not a function` / 模块不存在）

- [ ] **Step 3: 最小实现**

在 `src/client/shared/utils.js` 的 `projectLabel` 函数后新增，并把 `sourceBreakdown` 加进文件末尾的 `U` 导出对象：

```js
// Per-source aggregation for the overview tool cards
function sourceBreakdown(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.source || '未标记';
    if (!map.has(key)) map.set(key, { source: key, totalTokens: 0, costUSD: 0, models: new Map() });
    const item = map.get(key);
    const total = Number(r.totalTokens) || 0;
    item.totalTokens += total;
    item.costUSD += Number(r.costUSD) || 0;
    if (r.model) item.models.set(r.model, (item.models.get(r.model) || 0) + total);
  }
  const grand = Array.from(map.values()).reduce((sum, item) => sum + item.totalTokens, 0);
  return Array.from(map.values())
    .map(item => ({
      source: item.source,
      totalTokens: item.totalTokens,
      costUSD: item.costUSD,
      share: grand ? (item.totalTokens / grand) * 100 : 0,
      topModel: Array.from(item.models.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}
```

新建 `src/client/dashboard/theme.js`（`resolveTheme` 顶层无 DOM 依赖，node 可直接 import）：

```js
const STORAGE_KEY = 'ts-theme';

export function resolveTheme(stored) {
  return stored === 'dark' ? 'dark' : 'light';
}

export function initTheme() {
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* private mode */ }
  const theme = resolveTheme(stored);
  document.documentElement.dataset.theme = theme;
  return theme;
}

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* private mode */ }
}

export function chartVars() {
  const styles = getComputedStyle(document.documentElement);
  const v = name => styles.getPropertyValue(name).trim();
  return {
    text: v('--text'),
    muted: v('--muted'),
    border: v('--border'),
    surface: v('--surface'),
    accent: v('--accent'),
    grid: v('--chart-grid'),
    tooltipBg: v('--tooltip-bg')
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: 全部通过（22 旧 + 3 新）

- [ ] **Step 5: Commit**

```bash
git add src/client/shared/utils.js src/client/dashboard/theme.js test/client-ui.test.mjs
git commit -m "feat(ui): add sourceBreakdown aggregation and theme module"
```

---

### Task 2: 视图文件机械拆分（不改行为）

**Files:**
- Create: `src/client/dashboard/view-utils.jsx`
- Create: `src/client/dashboard/views/Overview.jsx`
- Create: `src/client/dashboard/views/Activity.jsx`
- Create: `src/client/dashboard/views/Usage.jsx`
- Create: `src/client/dashboard/views/Sessions.jsx`
- Create: `src/client/dashboard/views/Quota.jsx`
- Modify: `src/client/dashboard/App.jsx`（1090 行 → 约 480 行）

**Interfaces:**
- Produces: `view-utils.jsx` 导出 `useChart, normalizeNumber, aggregate, groupRows, shortDate, deltaMeta, formatReset, rangeLabel, quotaProvidersFrom, exportDaily, SourceIdentity, MetricCard, TokenComposition`
- Produces: 每个 views/*.jsx 默认导出同名视图组件，props 与现有调用完全一致（`App.jsx:463-475` 的 `common` 展开）
- Consumes: Task 1 无依赖（本任务纯移动代码）

- [ ] **Step 1: 创建 view-utils.jsx**

从 `App.jsx` **原样移动**以下代码到 `src/client/dashboard/view-utils.jsx` 并加 `export`：`useChart`(64-79)、`normalizeNumber`(81-84)、`aggregate`(86-104)、`groupRows`(106-125)、`rangeLabel`(127-130)、`shortDate`(132-134)、`formatDelta`+`deltaMeta`(136-149)、`formatReset`(151-162)、`SourceIdentity`(512-522)、`MetricCard`(524-533)、`exportDaily`(567-581)、`TokenComposition`(662-689)、`quotaProvidersFrom`(794-800)。文件头 import：

```jsx
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { U } from '../shared/utils.js';
import { sourceIcon, sourceIconScale } from './source-icons.js';
import claudeLogo from './icons/claude.svg';
import gptLogo from './icons/gpt.svg';
```

- [ ] **Step 2: 创建五个视图文件**

原样移动（保留全部实现，仅补 import，全部从 `../view-utils.jsx`、`../../shared/utils.js`、`@phosphor-icons/react` 引入所需符号）：

- `views/Overview.jsx`：`Overview`(535-565)、`TrendChart`(583-660)、`CostDrivers`(691-728)、`StatusRail`(730-792)、`CompactQuota`(802-812)
- `views/Activity.jsx`：`ActivityView`(814-847)、`calculateStreaks`(849-864)、`HeatmapChart`(866-890)、`WeekdayChart`(892-903)、`HourlyChart`(905-920)
- `views/Usage.jsx`：`UsageView`(922-970)、`UsageSummary`(972-987)
- `views/Sessions.jsx`：`SessionsView`(989-1035)
- `views/Quota.jsx`：`QuotaView`(1037-1067)、`collectionStatusMeta`(1069-1077)、`QuotaProviderCard`(1079-1090)

- [ ] **Step 3: 收缩 App.jsx**

删除已移出的函数，顶部新增：

```jsx
import Overview from './views/Overview.jsx';
import ActivityView from './views/Activity.jsx';
import UsageView from './views/Usage.jsx';
import SessionsView from './views/Sessions.jsx';
import QuotaView from './views/Quota.jsx';
import { rangeLabel, aggregate, normalizeNumber } from './view-utils.jsx';
```

（`Dashboard` 内仍用 `aggregate`/`normalizeNumber` 计算 totals，`FilterPopover` 用 `SourceIdentity` — 也从 view-utils 引入。）

- [ ] **Step 4: 验证行为未变**

Run: `npm test && npm run build`
Expected: 测试全绿，构建成功，无 unused import 报错

- [ ] **Step 5: Commit**

```bash
git add src/client/dashboard/
git commit -m "refactor(ui): split App.jsx into per-view modules"
```

---

### Task 3: 设计 token 体系 + 应用壳（侧栏导航 + 主题切换）

**Files:**
- Modify: `src/client/dashboard/styles.css`（整体重写）
- Modify: `src/client/dashboard/App.jsx`（`Dashboard` 组件布局部分，`App.jsx:398-479`）
- Modify: `index.html`（favicon 底色换 `#5865f2`，可选）

**Interfaces:**
- Consumes: Task 1 `initTheme/setTheme`
- Produces: CSS 类 `app-shell / sidebar / nav-item / content-area / topbar / command-row / panel / metric-card / segmented / status-pill / modern-table` 供后续任务使用；`Dashboard` 内部新增 state `theme`，并把 `theme` 加入传给各视图的 `common` props（图表联动重绘用）

- [ ] **Step 1: 重写 styles.css 基础层**

文件开头替换为 token 体系（值见 Global Constraints 表），并保留/改写既有组件选择器。基础层完整代码：

```css
:root {
  --bg: #f7f7f8; --surface: #ffffff; --surface-2: #fbfbfc;
  --border: #e7e7ea; --border-strong: #d9d9de;
  --text: #18181b; --muted: #83838c;
  --accent: #5865f2; --accent-soft: #eef0fe;
  --good: #16a34a; --bad: #dc2626;
  --chart-grid: #ececf0; --tooltip-bg: #1d1d20;
  --radius: 9px; --shadow: 0 1px 2px rgba(24,24,27,.04);
  --font: 'Inter', -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, monospace;
}
:root[data-theme='dark'] {
  --bg: #101014; --surface: #1b1b21; --surface-2: #17171c;
  --border: #26262c; --border-strong: #32323a;
  --text: #ededf0; --muted: #8f8f9a;
  --accent: #6673ff; --accent-soft: #23233c;
  --good: #4ade80; --bad: #f87171;
  --chart-grid: #26262c; --tooltip-bg: #26262e;
  --shadow: none;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; -webkit-font-smoothing: antialiased; }
strong, .num { font-variant-numeric: tabular-nums; }
button { font-family: inherit; cursor: pointer; }

.app-shell { display: flex; min-height: 100vh; }
.sidebar { position: sticky; top: 0; height: 100vh; width: 216px; flex-shrink: 0; display: flex; flex-direction: column; gap: 2px; padding: 14px 10px; background: var(--surface-2); border-right: 1px solid var(--border); }
.sidebar .brand { display: flex; align-items: center; gap: 9px; padding: 4px 8px 16px; background: none; border: 0; color: var(--text); text-align: left; }
.sidebar .brand-mark { width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; background: linear-gradient(135deg, var(--accent), #8b5cf6); color: #fff; font-weight: 700; font-size: 12px; }
.sidebar .brand strong { display: block; font-size: 14px; }
.sidebar .brand small { color: var(--muted); font-size: 11px; }
.nav-item { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border: 0; border-radius: 7px; background: none; color: var(--muted); font-size: 13px; }
.nav-item:hover { background: var(--surface); color: var(--text); }
.nav-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.nav-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.sidebar-spacer { flex: 1; }
.content-area { flex: 1; min-width: 0; max-width: 1440px; padding: 0 22px 32px; margin: 0 auto; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0 10px; }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 16px 18px; }
```

其余既有选择器（`command-row / metric-card / segmented / search-box / modern-table / status-pill / toast / filter-popover / empty-state / chart-empty / coverage-note` 等）逐个改为只引用上述变量——凡出现旧暖色字面量（`#faf7ef、#f4f1ec、#dedbd5、#77736e、#6f6c68、#1d1d20` 等）一律替换为对应 token；结构规则（布局/间距/圆角）沿用 9px 圆角与 8px 间距网格。

- [ ] **Step 2: 改造 Dashboard 壳**

`Dashboard` 返回的 JSX 骨架替换为（`FilterPopover`、`command-row` 内容保持既有实现，只挪位置；`NAV_ICONS` 用 phosphor 图标映射）：

```jsx
import { SquaresFour, Fire, ChartBar, ChatsCircle, Gauge, BookOpenText, Sun, Moon } from '@phosphor-icons/react';
import { initTheme, setTheme } from './theme.js';

const NAV_ICONS = { overview: SquaresFour, activity: Fire, usage: ChartBar, sessions: ChatsCircle, quota: Gauge };

// Dashboard 内新增：
const [theme, setThemeState] = useState(() => initTheme());
const toggleTheme = () => {
  const next = theme === 'dark' ? 'light' : 'dark';
  setTheme(next);
  setThemeState(next);
};
// common 中加入 theme

return (
  <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => changeView('overview')}>
        <span className="brand-mark">TS</span>
        <span><strong>Token Studio</strong><small>AI Token 看板</small></span>
      </button>
      {NAV_ITEMS.map(item => {
        const Icon = NAV_ICONS[item.id];
        return (
          <button key={item.id} className={`nav-item ${activeView === item.id ? 'active' : ''}`} onClick={() => changeView(item.id)}>
            <Icon size={17} />{item.label}
          </button>
        );
      })}
      <div className="sidebar-spacer" />
      <a className="nav-item" href="/review"><BookOpenText size={17} />复盘</a>
      <button className="nav-item" onClick={toggleTheme}>
        {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}{theme === 'dark' ? '亮色模式' : '暗色模式'}
      </button>
    </aside>
    <div className="content-area">
      <header className="topbar">{/* 原 top-actions：sync-status + 采集 + 刷新按钮，原样保留 */}</header>
      <div className="command-row">{/* 原 range select + date-chip + filter-anchor + result-count，原样保留 */}</div>
      {/* 视图渲染 5 行原样保留 */}
      {toast && <div className="toast" role="status"><CheckCircle size={18} weight="fill" />{toast}</div>}
    </div>
  </div>
);
```

- [ ] **Step 3: 时间筛选补齐（规格 §2）**

`App.jsx` 的 `RANGE_OPTIONS` 头部插入 `{ id: 'today', label: '今天', days: 1 }`；并在 `command-row` 的 `date-chip` 位置替换为两个原生日期输入实现自定义区间：

```jsx
// Dashboard state 新增
const [customRange, setCustomRange] = useState(null); // { start, end } | null
// startDate/endDate 计算改为：
const startDate = customRange ? customRange.start : (range.days ? U.addDays(lastDate, -(range.days - 1)) : firstDate);
const endDate = customRange ? customRange.end : lastDate;
// command-row 中：
<div className="date-inputs">
  <input type="date" value={startDate} max={endDate} onChange={e => setCustomRange({ start: e.target.value, end: endDate })} aria-label="开始日期" />
  <span>~</span>
  <input type="date" value={endDate} min={startDate} onChange={e => setCustomRange({ start: startDate, end: e.target.value })} aria-label="结束日期" />
</div>
// RANGE_OPTIONS select 的 onChange 里同时 setCustomRange(null)
```

配套样式：

```css
.date-inputs { display: flex; align-items: center; gap: 6px; color: var(--muted); }
.date-inputs input { background: var(--surface); border: 1px solid var(--border); border-radius: 7px; padding: 6px 9px; color: var(--text); font-family: var(--font); font-size: 12px; }
```

- [ ] **Step 4: 响应式**

styles.css 末尾追加：

```css
@media (max-width: 1100px) {
  .sidebar { width: 60px; padding: 14px 8px; }
  .sidebar .brand span:last-child, .nav-item { font-size: 0; }
  .nav-item { justify-content: center; gap: 0; padding: 10px; }
  .nav-item svg { font-size: initial; }
}
@media (max-width: 720px) {
  .app-shell { flex-direction: column; }
  .sidebar { position: static; height: auto; width: 100%; flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  .sidebar-spacer { display: none; }
}
```

- [ ] **Step 5: 验证**

Run: `npm test && npm run build && npm run dev`（手动开 http://localhost:5173 检查：侧栏导航可切换五视图、主题切换生效且刷新后记住、「今天」与自定义区间筛选生效、移动宽度无横向溢出）
Expected: 全绿 + 构建成功 + 手检通过（此时图表配色仍是旧的，属预期，Task 5 处理）

- [ ] **Step 6: Commit**

```bash
git add src/client/dashboard/ index.html
git commit -m "feat(ui): token-based design system with sidebar shell and theme toggle"
```

---### Task 4: 概览页重做（KPI 横带 + 按工具堆叠趋势 + 工具卡片）

**Files:**
- Rewrite: `src/client/dashboard/views/Overview.jsx`（删除 `StatusRail`、`CompactQuota`、`CostDrivers`、旧 `TrendChart`）
- Modify: `src/client/dashboard/App.jsx`（新增 `inspectSource` 回调）
- Modify: `src/client/dashboard/views/Usage.jsx`（接收来源初筛）
- Modify: `src/client/dashboard/styles.css`（新增 `kpi-band / quota-kpi / tool-grid / tool-card` 样式）

**Interfaces:**
- Consumes: `U.sourceBreakdown`（Task 1）、`chartVars`（Task 1）、`MetricCard / SourceIdentity / aggregate / deltaMeta / formatReset / quotaProvidersFrom / useChart / exportDaily`（Task 2）
- Produces: `Overview` props 新增 `onInspectSource(source: string)`；App 实现为 `source => { setSelectedSources(new Set([source])); changeView('usage'); announce(\`已聚焦 ${source}\`); }`

- [ ] **Step 1: 新 Overview.jsx**

```jsx
import { useMemo, useState } from 'react';
import { Coins, CurrencyDollar, Lightning, DownloadSimple, CaretRight } from '@phosphor-icons/react';
import { U } from '../../shared/utils.js';
import { sourceIcon, sourceIconScale } from '../source-icons.js';
import { useChart, MetricCard, quotaProvidersFrom, formatReset, normalizeNumber, exportDaily } from '../view-utils.jsx';
import { chartVars } from '../theme.js';

export default function Overview({ daily, totals, previousTotals, dates, rangeId, quota, announce, theme, onInspectSource }) {
  const cacheHit = totals.totalTokens ? (totals.cacheReadTokens / totals.totalTokens) * 100 : 0;
  const previousCacheHit = previousTotals.totalTokens ? (previousTotals.cacheReadTokens / previousTotals.totalTokens) * 100 : 0;
  const quotaProviders = quotaProvidersFrom(quota).filter(p => p.data.ok && p.data.windows?.length);
  return (
    <div className="page-stack">
      <section className={`kpi-band cols-${3 + quotaProviders.length}`} aria-label="核心指标">
        <MetricCard icon={Coins} label="总 Token" value={U.compactCN(totals.totalTokens)} delta={{ current: totals.totalTokens, previous: previousTotals.totalTokens }} hint={rangeId === 'all' ? '全部历史' : '较上周期'} />
        <MetricCard icon={CurrencyDollar} label="估算费用" value={U.fmtUS.format(totals.costUSD)} delta={{ current: totals.costUSD, previous: previousTotals.costUSD }} hint={rangeId === 'all' ? '累计估算' : '较上周期'} inverse />
        <MetricCard icon={Lightning} label="缓存命中率" value={`${cacheHit.toFixed(1)}%`} delta={{ current: cacheHit, previous: previousCacheHit }} hint="cache_read / total" />
        {quotaProviders.map(provider => <QuotaKpi key={provider.id} provider={provider} />)}
      </section>

      <section className="panel trend-panel">
        <div className="section-heading">
          <div><h2>{rangeId === 'all' ? '全部时间用量' : `${dates.length} 天用量`} · 按工具</h2><p>点击图例聚焦单个工具</p></div>
          <button className="icon-button" aria-label="导出当前趋势" onClick={() => exportDaily(daily, announce)}><DownloadSimple size={17} /></button>
        </div>
        <SourceTrendChart rows={daily} dates={dates} theme={theme} />
      </section>

      <ToolCards daily={daily} onInspectSource={onInspectSource} />
    </div>
  );
}

function QuotaKpi({ provider }) {
  const window = provider.data.windows[0];
  const used = Math.round(normalizeNumber(window.utilization) * 100);
  return (
    <article className="metric-card quota-kpi">
      <div className="metric-card-head"><span>{provider.name} 额度</span><img src={provider.logo} alt="" /></div>
      <div className="metric-value"><strong>{100 - used}%</strong><span>剩余</span></div>
      <div className="quota-kpi-bar"><span style={{ width: `${used}%` }} /></div>
      <div className="metric-foot"><span>{formatReset(window.resetsAt)}</span></div>
    </article>
  );
}

function SourceTrendChart({ rows, dates, theme }) {
  const [measure, setMeasure] = useState('tokens');
  const option = useMemo(() => {
    const vars = chartVars();
    const sources = U.sourceBreakdown(rows).map(item => item.source);
    const byDate = new Map(dates.map(date => [date, new Map()]));
    for (const row of rows) {
      if (!byDate.has(row.usageDate)) continue;
      const bucket = byDate.get(row.usageDate);
      const key = row.source || '未标记';
      const value = measure === 'cost' ? normalizeNumber(row.costUSD) : normalizeNumber(row.totalTokens);
      bucket.set(key, (bucket.get(key) || 0) + value);
    }
    const maxTotal = Math.max(1, ...Array.from(byDate.values()).map(bucket => Array.from(bucket.values()).reduce((s, v) => s + v, 0)));
    const unit = measure === 'cost' ? 1 : maxTotal >= 1e9 ? 1e9 : maxTotal >= 1e6 ? 1e6 : maxTotal >= 1e3 ? 1e3 : 1;
    const unitLabel = measure === 'cost' ? 'USD' : unit === 1e9 ? 'B' : unit === 1e6 ? 'M' : unit === 1e3 ? 'K' : '';
    return {
      animationDuration: 450,
      grid: { left: 52, right: 20, top: 54, bottom: 64 },
      tooltip: { trigger: 'axis', backgroundColor: vars.tooltipBg, borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 },
        valueFormatter: value => typeof value === 'number' ? (measure === 'cost' ? U.fmtUS.format(value) : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })) : value },
      legend: { top: 4, left: 4, itemWidth: 9, itemHeight: 9, itemGap: 18, textStyle: { color: vars.muted, fontSize: 11 } },
      xAxis: { type: 'category', data: dates.map(d => d.slice(5)), axisLine: { lineStyle: { color: vars.border } }, axisTick: { show: false },
        axisLabel: { color: vars.muted, fontSize: 10, interval: dates.length > 60 ? Math.ceil(dates.length / 10) : 'auto' } },
      yAxis: { type: 'value', name: unitLabel, nameTextStyle: { color: vars.muted, fontSize: 10 },
        splitLine: { lineStyle: { color: vars.grid } }, axisLabel: { color: vars.muted, fontSize: 10 } },
      dataZoom: [{ type: 'slider', height: 18, bottom: 10, borderColor: vars.border, backgroundColor: vars.surface,
        fillerColor: 'rgba(88,101,242,.12)', handleStyle: { color: vars.surface, borderColor: vars.accent }, showDetail: false,
        start: dates.length > 45 ? Math.max(0, 100 - (45 / dates.length) * 100) : 0, end: 100 }],
      series: sources.map(source => ({
        name: source, type: 'bar', stack: 'usage', barMaxWidth: 18,
        itemStyle: { color: U.getSourceColor(source) },
        data: dates.map(date => (byDate.get(date)?.get(source) || 0) / unit)
      }))
    };
  }, [rows, dates, measure, theme]);
  const ref = useChart(option, [option]);
  return (
    <>
      <div className="segmented trend-measure">
        {[['tokens', 'Token'], ['cost', '费用']].map(([id, label]) => (
          <button key={id} className={measure === id ? 'active' : ''} onClick={() => setMeasure(id)}>{label}</button>
        ))}
      </div>
      <div className="chart trend-chart" ref={ref} role="img" aria-label="按工具堆叠的用量趋势图" />
    </>
  );
}

function ToolCards({ daily, onInspectSource }) {
  const breakdown = useMemo(() => {
    const rows = U.sourceBreakdown(daily);
    if (rows.length <= 6) return rows;
    const head = rows.slice(0, 5);
    const tail = rows.slice(5);
    head.push({
      source: `其他 ${tail.length} 个`,
      totalTokens: tail.reduce((s, r) => s + r.totalTokens, 0),
      costUSD: tail.reduce((s, r) => s + r.costUSD, 0),
      share: tail.reduce((s, r) => s + r.share, 0),
      topModel: null, aggregated: true
    });
    return head;
  }, [daily]);
  if (breakdown.length === 0) return <div className="panel chart-empty">当前筛选下暂无来源数据</div>;
  return (
    <section className="tool-grid" aria-label="按工具用量">
      {breakdown.map(item => {
        const icon = sourceIcon(item.source);
        return (
          <button key={item.source} className="tool-card" disabled={item.aggregated} onClick={() => onInspectSource(item.source)}>
            <div className="tool-card-head">
              {icon
                ? <img src={icon} alt="" style={{ transform: `scale(${sourceIconScale(item.source)})` }} />
                : <span className="source-dot" style={{ background: U.getSourceColor(item.source) }} />}
              <strong>{item.source}</strong>
              {!item.aggregated && <CaretRight size={14} className="tool-card-go" />}
            </div>
            <div className="tool-card-value num"><strong>{U.compactCN(item.totalTokens)}</strong><span>{U.fmtUS.format(item.costUSD)} · {item.share.toFixed(1)}%</span></div>
            <div className="tool-card-bar"><span style={{ width: `${Math.max(1, item.share)}%`, background: U.getSourceColor(item.source) }} /></div>
            <small>{item.topModel ? `Top 模型 ${item.topModel}` : '多个来源聚合'}</small>
          </button>
        );
      })}
    </section>
  );
}
```

- [ ] **Step 2: App.jsx 接线**

`Dashboard` 内新增回调并传入 Overview（`selectedSources` setter 已存在）：

```jsx
const inspectSource = useCallback(source => {
  setSelectedSources(new Set([source]));
  setActiveView('usage');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  announce(`已聚焦 ${source}`);
}, [announce]);
// ...
{activeView === 'overview' && <Overview {...common} onInspectSource={inspectSource} />}
```

- [ ] **Step 3: 新增样式**

styles.css 追加：

```css
.page-stack { display: flex; flex-direction: column; gap: 14px; }
.kpi-band { display: grid; gap: 10px; grid-template-columns: repeat(5, 1fr); }
.kpi-band.cols-3 { grid-template-columns: repeat(3, 1fr); }
.kpi-band.cols-4 { grid-template-columns: repeat(4, 1fr); }
.quota-kpi img { width: 18px; height: 18px; }
.quota-kpi-bar { height: 4px; border-radius: 2px; background: var(--chart-grid); overflow: hidden; margin-top: 6px; }
.quota-kpi-bar span { display: block; height: 100%; border-radius: 2px; background: linear-gradient(90deg, var(--accent), #8b5cf6); }
.trend-measure { position: absolute; top: 16px; right: 56px; }
.trend-panel { position: relative; }
.tool-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.tool-card { text-align: left; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 13px 14px; display: flex; flex-direction: column; gap: 7px; color: var(--text); transition: border-color .15s; }
.tool-card:not(:disabled):hover { border-color: var(--accent); }
.tool-card:disabled { cursor: default; }
.tool-card-head { display: flex; align-items: center; gap: 8px; }
.tool-card-head img { width: 18px; height: 18px; }
.tool-card-go { margin-left: auto; color: var(--muted); }
.tool-card-value { display: flex; align-items: baseline; gap: 8px; }
.tool-card-value strong { font-size: 19px; }
.tool-card-value span { color: var(--muted); font-size: 11px; }
.tool-card-bar { height: 4px; border-radius: 2px; background: var(--chart-grid); overflow: hidden; }
.tool-card-bar span { display: block; height: 100%; border-radius: 2px; }
.tool-card small { color: var(--muted); font-size: 11px; }
@media (max-width: 1100px) { .kpi-band, .kpi-band.cols-4, .kpi-band.cols-5 { grid-template-columns: repeat(2, 1fr); } }
```

同时删除 styles.css 中不再被引用的 `status-rail / today-grid / forecast-* / mini-bars / attention-* / data-health-row / compact-quota-*` 规则块。

- [ ] **Step 4: 验证**

Run: `npm test && npm run build`，然后 `npm run dev` 手检：概览 KPI 五卡（无额度时三卡拉伸）、趋势按工具着色堆叠、Token/费用切换、点工具卡片跳到用量拆解且筛选生效、图例点击聚焦。
Expected: 全绿；`StatusRail`、`CostDrivers` 引用已全部消失（`grep -rn "StatusRail\|CostDrivers" src/` 无结果）

- [ ] **Step 5: Commit**

```bash
git add src/client/dashboard/
git commit -m "feat(overview): tool-first overview with stacked source trend and quota KPIs"
```

---

### Task 5: 其余四视图套新视觉 + 图表主题联动

**Files:**
- Modify: `src/client/dashboard/views/Activity.jsx`、`views/Usage.jsx`、`views/Sessions.jsx`、`views/Quota.jsx`、`view-utils.jsx`、`styles.css`

**Interfaces:**
- Consumes: `chartVars`（Task 1）、`theme` prop（Task 3 已加入 common）
- Produces: 无新接口；所有 ECharts option 的颜色字面量消失

- [ ] **Step 1: 图表主题联动**

四个视图内每个 `useMemo` 生成 ECharts option 的地方：开头加 `const vars = chartVars();`，把旧字面量替换——`'#1d1d20'`→`vars.tooltipBg`、`'#dedbd5'`→`vars.border`、`'#eeebe5'`→`vars.grid`、`'#77736e'/'#8b8781'/'#6f6c68'/'#88837d'`→`vars.muted`、`'#4168d8'`及 `rgba(65,104,216,…)`→`vars.accent` / `'rgba(88,101,242,.12)'`。依赖数组统一追加 `theme`（组件签名补上 `theme` prop）。`HeatmapChart` 的 visualMap 色带替换为 `[vars.grid, '#dfe6f8', '#b3c2ee', '#6e8dde', vars.accent]`，itemStyle.borderColor 用 `vars.surface`。

- [ ] **Step 2: 面板与表格样式对齐 token**

styles.css 中这些视图引用的旧规则（`rank-* / usage-* / sessions-panel / quota-* / collection-* / heat-legend / two-column / summary-*`）保留选择器名，颜色字面量全部换成 token 变量；`modern-table` 表头用 `--muted`、行分隔 `--border`、hover 行底 `--surface-2`。

- [ ] **Step 3: 验证**

Run: `npm test && npm run build`，`npm run dev` 手检：切换亮/暗主题时五个视图所有图表、表格、热力图即时换色，无残留暖色。
Expected: `grep -n "#faf7ef\|#f4f1ec\|#dedbd5\|#eeebe5\|#77736e\|#4168d8" src/client/dashboard/` 无结果

- [ ] **Step 4: Commit**

```bash
git add src/client/dashboard/
git commit -m "feat(ui): retheme activity/usage/sessions/quota views with chart theme sync"
```

---

### Task 6: 复盘页换肤（永远亮色）

**Files:**
- Modify: `src/client/review/styles.css`

**Interfaces:**
- Consumes: Global Constraints 的亮色 token 值（复盘页不引入切换逻辑，直接把亮色值写进它自己的 `:root`）
- Produces: 无

- [ ] **Step 1: 替换调色板**

`review/styles.css` 开头的旧暖色变量块替换为亮色 token（同 Task 3 亮色值，变量名沿用该文件现有命名以减少改动面；若该文件用字面量则统一收敛为顶部变量后替换）。字体栈与数字规则与看板一致：`--font` 栈、`tabular-nums`。卡片统一 9px 圆角、`#e7e7ea` 边框。打印样式块保持白底黑字。

- [ ] **Step 2: 验证**

Run: `npm run build && npm run serve`，打开 http://localhost:4173/review 手检：视觉与看板同一体系；浏览器打印预览正常。
Expected: 构建成功，复盘页无暖色残留

- [ ] **Step 3: Commit**

```bash
git add src/client/review/styles.css
git commit -m "feat(review): align review page with new light token system"
```

---

### Task 7: 终验 + 截图

- [ ] **Step 1: 全量验证**

```bash
npm test && npm run build
```
Expected: 25 个测试全绿，构建成功

- [ ] **Step 2: 生产模式手检清单**

`npm run preview` 后逐项检查：五视图切换、时间/来源筛选、采集按钮轮询、CSV 导出、亮暗切换 + 刷新记忆、390px/768px/1440px 三档宽度无横向溢出、键盘 Tab 可达侧栏与图表卡片。

- [ ] **Step 3: 截图给用户**

对 1440px 概览（亮/暗各一张）+ 其余四视图截图，供用户验收。

- [ ] **Step 4: Commit（如有修补）**

```bash
git add -A && git commit -m "fix(ui): final polish from production checklist"
```
