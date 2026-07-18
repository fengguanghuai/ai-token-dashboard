# Dashboard 紧凑化与图表修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec `docs/superpowers/specs/2026-07-18-dashboard-density-polish-design.md`：趋势图去圆角、环形图画出全部来源、中间行三卡等高并给缓存卡加「节省费用 + 命中率 sparkline」、热力图格子响应式拉伸并加小时分布。

**Architecture:** 纯前端 React (无 JSX 测试基建，UI 改动靠 dev server 视觉验证 + `npm test` 回归)；唯一的后端改动是 `/api/data` 的 daily 行新增 `cacheSavedUSD` 字段，由 `pricing.mjs` 新导出的 `calculateCacheSavings` 计算（此函数走 TDD）。

**Tech Stack:** React 18 + ECharts 6 + 手写 CSS；Node 22 原生 `node --test`；SQLite 数据（只读，不改 schema）。

## Global Constraints

- 不改 DB schema、不改采集器、不改表格区 / KPI 行 / 筛选器。
- 测试命令：`npm test`（node --test，跑 `test/*.test.mjs`）。
- dev 环境：`npm run dev`（vite 5173 + API 4173）。
- 工作树里有上一轮未提交的 UI 改动（KPI 6→4、donut 过滤等），先原样提交为基线（Task 1），不要混入本计划的改动。
- 所有新 UI 文案为中文，与现有风格一致；数字用 `U.compactCN` / `U.fmtUS`。

---

### Task 1: 提交现有 WIP 基线

**Files:**
- Modify: 无（仅提交现有工作树改动）

现有未提交改动（KPI 行 6→4 卡、donut <0.5% 过滤、TopModels 8→5、Gauge cache-metrics、对应 CSS）是用户当前看到的界面基线，先单独提交，避免与本计划的 diff 混在一起。

- [ ] **Step 1: 确认改动范围只有三个文件**

Run: `git status --short`
Expected: `M src/client/dashboard/App.jsx`、`M src/client/dashboard/components-charts.jsx`、`M src/client/dashboard/styles.css`（`.superpowers/` 与 docs 之外无其它）。`?? .superpowers/` 不要提交。

- [ ] **Step 2: 提交**

```bash
git add src/client/dashboard/App.jsx src/client/dashboard/components-charts.jsx src/client/dashboard/styles.css
git commit -m "feat: slim KPI row, cap top models at 5, donut tiny-slice filter, cache card meters"
```

---

### Task 2: pricing.mjs 新增 calculateCacheSavings（TDD）

**Files:**
- Modify: `src/pricing.mjs`（在 `calculateCost` 定义之后，约 195 行处新增导出函数）
- Test: `test/pricing.test.mjs`（文件已存在，追加用例）

**Interfaces:**
- Consumes: 既有 `calculateCost(model, tokens, pricingData, provider, options)`。
- Produces: `calculateCacheSavings(model, tokens, pricingData, provider = null) => number`，tokens 形如 `{ input, output, cacheRead, cacheWrite, reasoning }`（与 calculateCost 相同），返回 `max(0, 无缓存假设成本 − 实际估算成本)`，查不到定价时为 0。Task 3 的 server.mjs 依赖此签名。

- [ ] **Step 1: 写失败测试**

在 `test/pricing.test.mjs` 末尾追加（该文件已 `import { calculateCost } from '../src/pricing.mjs'`，把 import 改为同时引入 `calculateCacheSavings`）：

```js
import { calculateCost, calculateCacheSavings } from '../src/pricing.mjs';
```

```js
const CACHE_PRICING_FIXTURE = {
  'test-cache-model': {
    mode: 'chat',
    litellm_provider: 'anthropic',
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6
  }
};

test('calculateCacheSavings = uncached cost minus actual cost', () => {
  const tokens = { input: 1000, output: 500, cacheRead: 100_000, cacheWrite: 2000 };
  // uncached: (1000+100000+2000)*1e-6 + 500*2e-6      = 0.104
  // actual:   1000*1e-6 + 500*2e-6 + 100000*1e-7 + 2000*1.25e-6 = 0.0145
  const saved = calculateCacheSavings('test-cache-model', tokens, CACHE_PRICING_FIXTURE);
  assert.ok(Math.abs(saved - 0.0895) < 1e-9, `got ${saved}`);
});

test('calculateCacheSavings is 0 with no cache tokens or unknown model', () => {
  assert.equal(calculateCacheSavings('test-cache-model', { input: 1000, output: 500 }, CACHE_PRICING_FIXTURE), 0);
  assert.equal(calculateCacheSavings('no-such-model-zzz-123', { input: 1, cacheRead: 1000 }, {}), 0);
});
```

注意：若 fixture 的裸模型名查不到（`lookupPricing` 的候选生成不接受该形状），把 fixture 键换成 `anthropic/test-cache-model` 再试；两个用例的期望值不变。

- [ ] **Step 2: 运行确认失败**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL，`calculateCacheSavings is not a function` / SyntaxError（未导出）。

- [ ] **Step 3: 实现**

`src/pricing.mjs`，紧跟 `calculateCost` 函数之后：

```js
/**
 * Estimated dollars saved by prompt caching: what the same request volume
 * would have cost with every cached token billed at the full input rate,
 * minus the actual estimated cost. 0 when pricing is unknown.
 */
export function calculateCacheSavings(model, tokens, pricingData, provider = null) {
  const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0 } = tokens;
  if (!cacheRead && !cacheWrite) return 0;
  const uncached = calculateCost(
    model,
    { input: input + cacheRead + cacheWrite, output, reasoning },
    pricingData,
    provider
  );
  const actual = calculateCost(model, tokens, pricingData, provider);
  return Math.max(0, uncached - actual);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test 2>&1 | tail -20`
Expected: 全部 PASS（含既有用例）。

- [ ] **Step 5: 提交**

```bash
git add src/pricing.mjs test/pricing.test.mjs
git commit -m "feat: add calculateCacheSavings to pricing module"
```

---

### Task 3: /api/data daily 行附加 cacheSavedUSD

**Files:**
- Modify: `src/server.mjs`（头部 import、启动时加载 pricing、`/api/data` 的 daily 映射约 111-116 行）

**Interfaces:**
- Consumes: Task 2 的 `calculateCacheSavings(model, tokens, pricingData)`；既有 `loadPricing(cachePath)`。
- Produces: `/api/data` 响应中每个 daily 行多一个数值字段 `cacheSavedUSD`（≥0）。Task 4 的 aggregateTotals、Task 7 的 Gauge 依赖它。

- [ ] **Step 1: 实现**

`src/server.mjs` 头部（`import { queryQuota }` 之后）：

```js
import { calculateCacheSavings, loadPricing } from './pricing.mjs';
```

`const db = openDb(...)` 附近（模块顶层，文件已是 ESM 可用顶层 await）：

```js
// Pricing data for serve-time cache-savings estimation. Same bundled cache
// file the collector uses; savings silently degrade to 0 if it is missing.
const pricingData = await loadPricing(resolve(process.cwd(), 'data', 'pricing-litellm.json'));
```

`/api/data` 中 daily 映射改为：

```js
      daily: rawDaily.map(d => ({
        ...d,
        projectPath: projMap.get(`${d.device}::${d.source}`)?.project || null,
        cacheSavedUSD: calculateCacheSavings(d.model, {
          input: d.inputTokens,
          output: d.outputTokens,
          cacheRead: d.cacheReadTokens,
          cacheWrite: d.cacheCreationTokens,
          reasoning: d.reasoningOutputTokens
        }, pricingData)
      })),
```

- [ ] **Step 2: 启动服务验证字段**

```bash
PORT=4599 node src/server.mjs & sleep 2
curl -s localhost:4599/api/data | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const rows=JSON.parse(s).daily;const w=rows.filter(r=>r.cacheSavedUSD>0);console.log('rows',rows.length,'with savings',w.length,'sample',w[0]?.model,w[0]?.cacheSavedUSD);})"
kill %1
```

Expected: `with savings` 数量 > 0，sample 的 cacheSavedUSD 为正数（claude 系模型应有值）。

- [ ] **Step 3: 回归 + 提交**

Run: `npm test 2>&1 | tail -5` → PASS。

```bash
git add src/server.mjs
git commit -m "feat: serve per-row cacheSavedUSD in /api/data"
```

---

### Task 4: aggregateTotals 汇总 cacheSavedUSD（TDD）

**Files:**
- Modify: `src/client/shared/utils.js`（`aggregateTotals`，约 192-214 行）
- Test: Create `test/client-utils.test.mjs`

**Interfaces:**
- Consumes: daily 行的 `cacheSavedUSD`（Task 3；行上可能缺省 → 按 0）。
- Produces: `U.aggregateTotals(rows)` 返回对象新增 `cacheSavedUSD` 数值字段。Task 7 通过 `totals.cacheSavedUSD` 消费。

- [ ] **Step 1: 写失败测试**

Create `test/client-utils.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { U } from '../src/client/shared/utils.js';

test('aggregateTotals sums cacheSavedUSD, defaulting missing values to 0', () => {
  const rows = [
    { totalTokens: 100, inputTokens: 10, outputTokens: 20, cacheReadTokens: 60,
      cacheCreationTokens: 10, reasoningOutputTokens: 0, costUSD: 1, cacheSavedUSD: 2.5 },
    { totalTokens: 50, inputTokens: 50, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, reasoningOutputTokens: 0, costUSD: 0.5 } // no cacheSavedUSD
  ];
  const t = U.aggregateTotals(rows);
  assert.equal(t.cacheSavedUSD, 2.5);
  assert.equal(t.totalTokens, 150);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/client-utils.test.mjs 2>&1 | tail -10`
Expected: FAIL，`t.cacheSavedUSD` 为 undefined。（若 import 阶段因浏览器专用 API 报错，说明 utils.js 顶层引用了 document/window——按实际报错处理，函数体内引用不影响 import。）

- [ ] **Step 3: 实现**

`aggregateTotals` 中：

```js
function aggregateTotals(rows) {
  let total = 0, inp = 0, out = 0, cacheRd = 0, cacheCr = 0, reason = 0, cost = 0, saved = 0;
  for (const r of rows) {
    total += r.totalTokens;
    inp   += r.inputTokens;
    out   += r.outputTokens;
    cacheRd += r.cacheReadTokens;
    cacheCr += r.cacheCreationTokens;
    reason += r.reasoningOutputTokens;
    cost  += r.costUSD;
    saved += r.cacheSavedUSD || 0;
  }
  return {
    totalTokens: total,
    inputTokens: inp,
    outputTokens: out,
    cacheReadTokens: cacheRd,
    cacheCreationTokens: cacheCr,
    cacheTokens: cacheRd + cacheCr,
    reasoningTokens: reason,
    costUSD: cost,
    cacheSavedUSD: saved,
    cacheHitRate: total ? (cacheRd / total) * 100 : 0
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test 2>&1 | tail -5`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/client/shared/utils.js test/client-utils.test.mjs
git commit -m "feat: aggregate cacheSavedUSD in totals"
```

---

### Task 5: 趋势图柱子去圆角

**Files:**
- Modify: `src/client/dashboard/components-charts.jsx`（TrendChart：删除 `topSourceByDate` useMemo 约 43-55 行；柱状 series 构建约 87-107 行）

**Interfaces:**
- Consumes/Produces: 无跨任务接口，纯内部改动。

- [ ] **Step 1: 实现**

删除整个 `topSourceByDate` useMemo（`const topSourceByDate = useMemo(...)` 到 `}, [byKey, dates, sources]);`）。

柱状/堆叠分支改为（不再有逐点 itemStyle / borderRadius）：

```js
  if (mode === 'stacked' || mode === 'bar') {
    sources.forEach((src, i) => {
      series.push({
        name: src,
        type: 'bar',
        stack: mode === 'stacked' ? 'total' : undefined,
        barMaxWidth: 24,
        itemStyle: { color: palette[i] },
        ...stableBarState,
        data: dates.map(d => byKey.get(`${d}::${src}`) || 0)
      });
    });
  } else if (mode === 'line') {
```

- [ ] **Step 2: 视觉验证**

Run: `npm run dev`（若未在跑），浏览器打开 http://localhost:5173。
Expected: 堆叠/柱状模式下柱子四角均为直角；切换三种模式无报错。

- [ ] **Step 3: 提交**

```bash
git add src/client/dashboard/components-charts.jsx
git commit -m "fix: square bar corners in trend chart"
```

---

### Task 6: 环形图方角 + 全部来源入环

**Files:**
- Modify: `src/client/dashboard/components-charts.jsx`（SourceDonut 约 277-357 行）

**Interfaces:**
- Consumes/Produces: 无跨任务接口。

- [ ] **Step 1: 实现**

三处改动：

1. 删除 pieData 过滤及其注释（`// Tiny slices (<0.5%)...` 三行注释 + `const pieData = data.filter(...)`），series 的 `data:` 直接用 `data.map(...)`。
2. series 的 `itemStyle` 去掉 `borderRadius: 8`：

```js
      itemStyle: {
        borderColor: '#fff',
        borderWidth: 2,
        shadowBlur: 12,
        shadowOffsetY: 3,
        shadowColor: 'rgba(15, 23, 42, 0.16)'
      },
```

3. `minAngle: 2` 保留不动。

- [ ] **Step 2: 视觉验证**

浏览器刷新，来源占比环形图。
Expected: 4 个来源全部有扇区（Hermes Agent / OpenCode 为细小扇区但可见、可 hover 出 tooltip）；扇区为方角；12 点钟接缝处无叠色小圆点。

- [ ] **Step 3: 提交**

```bash
git add src/client/dashboard/components-charts.jsx
git commit -m "fix: draw all sources in donut with square slice corners"
```

---

### Task 7: 中间行等高 + 缓存卡节省费用 & 命中率 sparkline + 环比卡拉伸

**Files:**
- Modify: `src/client/dashboard/components-top.jsx`（607 行导出处）
- Modify: `src/client/dashboard/components-charts.jsx`（import 行 9；Gauge 约 695-768 行；GrowthPanel 约 801-825 行）
- Modify: `src/client/dashboard/App.jsx`（Dashboard 内新增 hitRateSeries useMemo；Gauge 调用处约 465-472 行）
- Modify: `src/client/dashboard/styles.css`（Grid 段约 920-931 行后新增等高规则；Cache card 段 1188-1257 行重写）

**Interfaces:**
- Consumes: `totals.cacheSavedUSD`（Task 4）；`Spark({ values, color, height, fill })`（components-top 既有组件）。
- Produces: `Gauge` 新 props：`savedUSD`（number）、`hitRateSeries`（number[]，与 dates 对齐的百分比 0-100）。`Spark` 从 components-top.jsx 具名导出。

- [ ] **Step 1: 导出 Spark**

`components-top.jsx` 最后一行改为：

```js
export { Topbar, FilterBar, KPI, Delta, Spark };
```

`components-charts.jsx` 第 9 行改为：

```js
import { Delta, Spark } from './components-top.jsx';
```

- [ ] **Step 2: 重写 Gauge 组件**

替换整个 `Gauge` 函数：

```jsx
function Gauge({ rate, cacheRead, cacheCreation, total, prevRate, savedUSD, hitRateSeries }) {
  const r = Math.max(0, Math.min(100, rate));
  const C = Math.PI * 70;
  const dash = (r / 100) * C;

  return (
    <div className="panel cache-card">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">缓存命中率</h2>
          <p className="panel-sub">cache_read / total</p>
        </div>
        <Delta value={U.deltaPct(rate, prevRate)} />
      </div>
      <div className="gauge">
        <div className="gauge-wrap">
          <svg viewBox="0 0 180 100" width="180" height="100">
            <path d="M 10 90 A 80 80 0 0 1 170 90" stroke="oklch(0.95 0.004 80)" strokeWidth="14" fill="none" strokeLinecap="round"/>
            <path
              d="M 10 90 A 80 80 0 0 1 170 90"
              stroke="url(#hitGrad)"
              strokeWidth="14" fill="none" strokeLinecap="round"
              strokeDasharray={`${dash} ${C}`}
              style={{transition: 'stroke-dasharray 600ms cubic-bezier(0.22,1,0.36,1)'}}
            />
            <defs>
              <linearGradient id="hitGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="oklch(0.65 0.13 200)"/>
                <stop offset="100%" stopColor="oklch(0.55 0.16 265)"/>
              </linearGradient>
            </defs>
          </svg>
          <div className="gauge-text">
            <div>
              <span className="gauge-num">{r.toFixed(1)}</span>
              <span className="gauge-suffix">%</span>
            </div>
          </div>
        </div>
      </div>

      <div className="cache-line">
        <span><i className="cache-key cache-key-read"/>读取 <b>{U.compactCN(cacheRead)}</b></span>
        <span><i className="cache-key cache-key-create"/>创建 <b>{U.compactCN(cacheCreation)}</b></span>
      </div>

      <div className="cache-saved">
        <div className="cache-saved-label">缓存节省费用</div>
        <div className="cache-saved-num">≈ {U.fmtUS.format(savedUSD || 0)}</div>
        <div className="cache-saved-sub">若无缓存需多付的估算金额</div>
      </div>

      <div className="cache-trend">
        <div className="cache-trend-head">
          <span>每日命中率</span>
        </div>
        <Spark values={hitRateSeries} color="oklch(0.65 0.11 200)" height={36}/>
      </div>
    </div>
  );
}
```

（`total` prop 保留传入但不再展示"缓存占总 Token"进度条。）

- [ ] **Step 3: GrowthPanel 拉伸填满**

`GrowthPanel` 的 stat 容器 div 改为：

```jsx
      <div style={{display: 'flex', flexDirection: 'column', gap: 8, flex: 1, justifyContent: 'space-evenly'}}>
```

峰值提示块的样式不动（保持 `marginTop: 14`）；只改上面这个 stat 容器，靠 `flex: 1` + `space-evenly` 把四个 stat 均匀拉开填满卡片高度。

- [ ] **Step 4: App.jsx 传参**

Dashboard 组件内（`sparkBy` useMemo 之后）新增：

```js
  // Daily cache hit-rate series for the gauge card sparkline
  const hitRateSeries = useMemo(() => {
    const read = new Map(), tot = new Map();
    for (const r of filtered) {
      read.set(r.usageDate, (read.get(r.usageDate) || 0) + (r.cacheReadTokens || 0));
      tot.set(r.usageDate, (tot.get(r.usageDate) || 0) + r.totalTokens);
    }
    return dates.map(d => {
      const t = tot.get(d) || 0;
      return t ? ((read.get(d) || 0) / t) * 100 : 0;
    });
  }, [filtered, dates]);
```

Gauge 调用处改为：

```jsx
          <Gauge
            rate={totals.cacheHitRate}
            cacheRead={totals.cacheReadTokens}
            cacheCreation={totals.cacheCreationTokens}
            total={totals.totalTokens}
            prevRate={compareData.totals?.cacheHitRate}
            savedUSD={totals.cacheSavedUSD}
            hitRateSeries={hitRateSeries} />
```

- [ ] **Step 5: CSS — 等高 + 新卡片样式**

`styles.css` Grid 段（`.col-12 { ... }` 之后）新增：

```css
/* Equal-height rows: stretch each panel to fill its grid cell */
.grid > [class*="col-"] { display: flex; flex-direction: column; }
.grid > [class*="col-"] > .panel { flex: 1; display: flex; flex-direction: column; min-width: 0; }
```

Cache card 段：保留 `.cache-card`、`.cache-card .gauge`、`.cache-key`、`.cache-key-read`、`.cache-key-create`，删除 `.cache-metrics`、`.cache-metric-head`、`.cache-metric-label`、`.cache-metric-val`、`.cache-track`、`.cache-track-split`、`.cache-fill`、`.cache-fill-read`、`.cache-fill-total`、`.cache-metric-foot` 规则，新增：

```css
.cache-line {
  display: flex;
  justify-content: center;
  gap: 18px;
  font-size: 12px;
  color: var(--text-2);
  margin-top: 2px;
}
.cache-line b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }

.cache-saved {
  margin-top: 14px;
  padding: 12px 14px;
  background: var(--surface-2);
  border: 1px solid var(--border-2);
  border-radius: 9px;
  text-align: center;
}
.cache-saved-label {
  font-size: 10.5px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.cache-saved-num {
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--good);
  margin-top: 2px;
}
.cache-saved-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }

.cache-trend { margin-top: auto; padding-top: 14px; }
.cache-trend-head {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 4px;
}
.cache-trend .kpi-spark { display: block; width: 100%; height: 36px; }
```

注意 `.cache-card` 原有的 `display`/`flex` 定义（1189-1193 行）查看后与全局等高规则合并，避免重复或冲突（全局已给 `.panel` flex column，`.cache-card` 里只留它特有的规则）。

- [ ] **Step 6: 视觉验证**

浏览器刷新。
Expected:
- Top 模型 / 缓存 / 环比三卡底边齐平，白卡填满整行高度，无底色露出。
- 缓存卡自上而下：弧形表 → 读取/创建一行 → 「缓存节省费用 ≈ $xxx」绿色大数字（正数）→ 底部每日命中率 sparkline。
- 切换筛选（来源/时间范围）时节省费用与 sparkline 联动变化。
- 趋势图+环形图那一行也等高无异常；热力图/表格行无布局破坏。

- [ ] **Step 7: 回归 + 提交**

Run: `npm test 2>&1 | tail -5` → PASS。

```bash
git add src/client/dashboard/components-top.jsx src/client/dashboard/components-charts.jsx src/client/dashboard/App.jsx src/client/dashboard/styles.css
git commit -m "feat: equal-height chart rows, cache savings stat and hit-rate sparkline"
```

---

### Task 8: 热力图响应式格子 + 小时分布 + 高峰时段

**Files:**
- Modify: `src/client/dashboard/components-charts.jsx`（Heatmap 约 460-690 行）
- Modify: `src/client/dashboard/styles.css`（heatmap 段 1261-1341 行）

**Interfaces:**
- Consumes/Produces: 无跨任务接口。

- [ ] **Step 1: Heatmap JSX — 小时汇总与网格改造**

`showMatrix`/`max` 计算之后新增：

```js
  // Hour-of-day marginal distribution across the shown window
  const hourTotals = Array.from({length: 24}, (_, h) =>
    showMatrix.reduce((s, row) => s + row[h].tokens, 0)
  );
  const hourMax = Math.max(...hourTotals, 1);
  const peakHourIndex = hourTotals.indexOf(Math.max(...hourTotals));
```

网格容器 inline style 改为（列轨道响应式、底部加 2 行放小时分布）：

```jsx
              style={{
                gridTemplateColumns: '48px repeat(24, minmax(13px, 1fr))',
                gridTemplateRows: `16px repeat(${showDates.length}, 14px) 10px 30px`
              }}>
```

在日期行渲染结束、tooltip 渲染之前插入小时分布行（gridRow = 日期行之后隔一行）：

```jsx
              <div className="heat-row-label" style={{gridRow: showDates.length + 3, gridColumn: 1}}>时段</div>
              {hourTotals.map((v, hi) => (
                <div
                  key={`hb-${hi}`}
                  className="heat-hour-bar"
                  style={{gridRow: showDates.length + 3, gridColumn: hi + 2}}
                  title={`${String(hi).padStart(2, '0')}:00 · ${U.compactCN(v)} tokens`}>
                  <div style={{height: v ? `${Math.max(8, (v / hourMax) * 100)}%` : 0}}/>
                </div>
              ))}
```

- [ ] **Step 2: 活跃摘要新增「高峰时段」**

`heat-stat-grid` 内（峰值日期 stat 之后）追加：

```jsx
            <div className="heat-stat" style={{gridColumn: '1 / -1'}}>
              <span>高峰时段</span>
              <strong>{String(peakHourIndex).padStart(2, '0')}:00</strong>
              <small>{U.compactCN(hourTotals[peakHourIndex])} tokens</small>
            </div>
```

- [ ] **Step 3: CSS**

`styles.css` heatmap 段：

```css
.heatmap-main {
  min-width: 0;
  display: flex;
  align-items: center;
}
.heatmap-grid {
  position: relative;
  display: grid;
  width: 100%;
  gap: 3px;
  align-items: center;
}
```

（即 `.heatmap-main` 去掉 `justify-content: center`；`.heatmap-grid` 的 `width: max-content; margin: 0 auto;` 改为 `width: 100%`。）

`.heat-cell` 的尺寸规则拆开——基础类保留视觉样式，网格内改为自适应：

```css
.heat-cell {
  appearance: none;
  width: 13px;
  height: 13px;
  min-width: 13px;
  padding: 0;
  border: 1px solid color-mix(in oklab, var(--border), transparent 24%);
  border-radius: 2.5px;
  cursor: pointer;
  transition: transform 100ms ease, border-color 100ms ease, box-shadow 100ms ease;
}
.heatmap-grid .heat-cell {
  width: 100%;
  height: 100%;
}
```

新增小时分布条样式：

```css
.heat-hour-bar {
  align-self: end;
  height: 100%;
  display: flex;
  align-items: flex-end;
}
.heat-hour-bar > div {
  width: 100%;
  border-radius: 2px 2px 0 0;
  background: oklch(0.63 0.15 265 / 0.75);
  min-height: 0;
}
.heat-hour-bar:hover > div { background: oklch(0.48 0.18 265); }
```

- [ ] **Step 4: 视觉验证**

浏览器刷新，热力图区域。
Expected:
- 网格横向撑满左栏（格子为扁矩形，宽>高），左右不再悬浮空白；窄窗口时出现横向滚动而不挤破。
- 网格下方 24 根小柱与小时列对齐，hover 有 title 提示；晚间时段应明显更高。
- 右侧摘要多一条「高峰时段 HH:00 · x tokens」，横跨两列。
- 格子 hover tooltip 位置仍正确（tooltip 基于 cell rect 计算，自适应后应无偏移）。

- [ ] **Step 5: 回归 + 提交**

Run: `npm test 2>&1 | tail -5` → PASS。

```bash
git add src/client/dashboard/components-charts.jsx src/client/dashboard/styles.css
git commit -m "feat: responsive heatmap cells with hour-of-day distribution"
```

---

### Task 9: 端到端验证收尾

**Files:** 无新改动（发现问题则就地修复并单独提交）。

- [ ] **Step 1: 全量测试**

Run: `npm test 2>&1 | tail -10`
Expected: 全部 PASS。

- [ ] **Step 2: 完整视觉走查（对照 spec 的验证清单）**

`npm run dev` 下逐项确认：
1. 趋势图三种模式柱子直角、无 console 报错。
2. 环形图 4 来源全画、方角、聚焦联动正常（点击图例聚焦/取消）。
3. 中间行三卡等高；缓存节省费用为正且随筛选联动；sparkline 正常。
4. 热力图撑满、小时分布对齐、高峰时段正确。
5. 收窄浏览器窗口到 ~900px：各行退化为单列（既有响应式断点 1761-1763 行），无溢出。

- [ ] **Step 3: 确认工作树干净**

Run: `git status --short`
Expected: 除 `.superpowers/` 外无未提交改动。
