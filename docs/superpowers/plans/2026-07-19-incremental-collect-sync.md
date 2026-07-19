# 增量采集同步实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把采集写库从"全量删表重插 + 逐行 upsert"改为"水位线增量 + 批量 upsert",单次采集对远程 Postgres 的往返从 1.2 万次降到 30 次以内。

**Architecture:** 新增两个模块——`src/incremental.mjs`(纯函数:稳定 eventKey 去重、水位线过滤)和 `src/db-batch.mjs`(水位线查询 + 三张表的多行批量 upsert,兼容 sqlite/postgres/mysql 三驱动)。`src/collect.mjs` 与 `src/server.mjs` 的 `/api/ingest` 换用这两个模块;`--full` 标志保留删表重建路径。

**Tech Stack:** Node 22 原生 `node:test` / `node:sqlite`,pg,mysql2。无新依赖。

## Global Constraints

- 价格锁定语义不变:`daily_usage` 中 `usage_date < 今天` 的行 `cost_usd` 永不被覆盖(spec §相关既有约定)。
- `time_usage` 老事件在非 `--full` 路径下永不重写(增量即锁价)。
- 三驱动(sqlite/postgres/mysql)同一套代码路径,SQL 方言差异只允许出现在 `db.mjs`/`db-batch.mjs`。
- 批量每批 400 行(SQLite 变量上限保守值)。
- 水位线重叠窗口 48 小时。
- 现有导出函数 `upsertDaily`/`upsertTimeUsage`/`upsertSession` 保留不删(旧测试仍用)。

---

### Task 1: 纯函数模块 `src/incremental.mjs`

**Files:**
- Create: `src/incremental.mjs`
- Test: `test/incremental.test.mjs`

**Interfaces:**
- Produces:
  - `dedupeEventKeys(rows) -> rows`(rows: `{eventKey, ...}[]`,重复 key 追加 `#1`/`#2`,首个不变;必须对**过滤前的全量行**调用)
  - `watermarkCutoff(watermark, overlapMs?) -> string|null`(ISO 水位线 − 48h;null/非法输入返回 null)
  - `filterTimeRows(rows, cutoff) -> rows`(保留 `eventTime > cutoff`;cutoff 为 null 返回全部)
  - `filterDailyRows(rows, cutoff) -> rows`(保留 `usageDate >= cutoff.slice(0,10)`;cutoff 为 null 返回全部)

- [ ] **Step 1: 写失败测试** `test/incremental.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeEventKeys, filterDailyRows, filterTimeRows, watermarkCutoff
} from '../src/incremental.mjs';

test('dedupeEventKeys keeps unique keys and suffixes duplicates deterministically', () => {
  const rows = [{ eventKey: 'a' }, { eventKey: 'b' }, { eventKey: 'a' }, { eventKey: 'a' }];
  const out = dedupeEventKeys(rows);
  assert.deepEqual(out.map(r => r.eventKey), ['a', 'b', 'a#1', 'a#2']);
  // 同输入再跑一遍结果相同(幂等的前提)
  assert.deepEqual(dedupeEventKeys(rows).map(r => r.eventKey), ['a', 'b', 'a#1', 'a#2']);
  // 原数组对象未被修改
  assert.equal(rows[2].eventKey, 'a');
});

test('watermarkCutoff subtracts the overlap window', () => {
  assert.equal(watermarkCutoff('2026-07-19T12:00:00.000Z'), '2026-07-17T12:00:00.000Z');
  assert.equal(watermarkCutoff(null), null);
  assert.equal(watermarkCutoff('not-a-date'), null);
});

test('filterTimeRows keeps rows strictly newer than cutoff', () => {
  const rows = [
    { eventTime: '2026-07-17T11:59:59.000Z' },
    { eventTime: '2026-07-17T12:00:00.000Z' },
    { eventTime: '2026-07-17T12:00:01.000Z' }
  ];
  const out = filterTimeRows(rows, '2026-07-17T12:00:00.000Z');
  assert.deepEqual(out.map(r => r.eventTime), ['2026-07-17T12:00:01.000Z']);
  assert.equal(filterTimeRows(rows, null).length, 3);
});

test('filterDailyRows keeps dates on or after the cutoff date', () => {
  const rows = [{ usageDate: '2026-07-16' }, { usageDate: '2026-07-17' }, { usageDate: '2026-07-18' }];
  const out = filterDailyRows(rows, '2026-07-17T12:00:00.000Z');
  assert.deepEqual(out.map(r => r.usageDate), ['2026-07-17', '2026-07-18']);
  assert.equal(filterDailyRows(rows, null).length, 3);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/incremental.test.mjs`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现** `src/incremental.mjs`:

```js
const DEFAULT_OVERLAP_MS = 48 * 60 * 60 * 1000;

/**
 * Make event keys unique within one normalized batch by suffixing repeats
 * with #1, #2, … in source order. Must run on the FULL per-source batch
 * (before any watermark filtering) so numbering is stable across runs.
 */
export function dedupeEventKeys(rows) {
  const seen = new Map();
  return rows.map((row) => {
    const count = seen.get(row.eventKey) || 0;
    seen.set(row.eventKey, count + 1);
    return count === 0 ? row : { ...row, eventKey: `${row.eventKey}#${count}` };
  });
}

/** Watermark minus the overlap window; null when there is no usable watermark. */
export function watermarkCutoff(watermark, overlapMs = DEFAULT_OVERLAP_MS) {
  if (!watermark) return null;
  const ms = Date.parse(watermark);
  if (Number.isNaN(ms)) return null;
  return new Date(ms - overlapMs).toISOString();
}

export function filterTimeRows(rows, cutoff) {
  if (!cutoff) return rows;
  return rows.filter(row => row.eventTime > cutoff);
}

export function filterDailyRows(rows, cutoff) {
  if (!cutoff) return rows;
  const cutoffDate = cutoff.slice(0, 10);
  return rows.filter(row => row.usageDate >= cutoffDate);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/incremental.test.mjs`
Expected: PASS(4 tests)

- [ ] **Step 5: 提交**

```bash
git add src/incremental.mjs test/incremental.test.mjs
git commit -m "feat: incremental sync helpers (stable keys, watermark filters)"
```

---

### Task 2: 水位线查询 + `time_usage` 批量 upsert(`src/db-batch.mjs`)

**Files:**
- Modify: `src/db.mjs`(导出三个私有辅助函数,函数体不变)
- Create: `src/db-batch.mjs`
- Test: `test/db-batch.test.mjs`

**Interfaces:**
- Consumes: `db.mjs` 的 `nowExpression(driver)`、`todayExpression(driver)`、`mysqlRowKey(...parts)`(本任务将其从私有改为导出,实现不动)。
- Produces:
  - `getTimeWatermark(db, device, source) -> Promise<string|null>`
  - `batchUpsertTimeUsage(db, rows) -> Promise<void>`(rows 结构同现有 `upsertTimeUsage` 的 row)

- [ ] **Step 1: 在 `src/db.mjs` 给三个辅助函数加 `export`**

`function nowExpression(` → `export function nowExpression(`;`function todayExpression(` → `export function todayExpression(`;`function mysqlRowKey(` → `export function mysqlRowKey(`。函数体与调用处不变。

- [ ] **Step 2: 写失败测试** `test/db-batch.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.mjs';
import { batchUpsertTimeUsage, getTimeWatermark } from '../src/db-batch.mjs';

function tmpDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'tokbatch-'));
  return { path: join(dir, 'usage.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function timeRow(i) {
  return {
    device: 'D', source: 'S', eventKey: `k${i}`,
    eventTime: `2026-07-10T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`,
    usageDate: '2026-07-10', model: 'm', projectPath: null, sessionId: null,
    inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0,
    reasoningOutputTokens: 0, totalTokens: 2, costUSD: 0.001
  };
}

test('batchUpsertTimeUsage crosses chunk boundaries and is idempotent', async () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const db = await openDb(path);
    const rows = Array.from({ length: 401 }, (_, i) => timeRow(i));
    await batchUpsertTimeUsage(db, rows);
    let { c } = await db.get('SELECT COUNT(*) AS c FROM time_usage');
    assert.equal(c, 401);
    await batchUpsertTimeUsage(db, rows); // 重跑不产生重复
    ({ c } = await db.get('SELECT COUNT(*) AS c FROM time_usage'));
    assert.equal(c, 401);
    await batchUpsertTimeUsage(db, []); // 空批不报错
    await db.close();
  } finally { cleanup(); }
});

test('getTimeWatermark returns MAX(event_time) per device+source, null when empty', async () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const db = await openDb(path);
    assert.equal(await getTimeWatermark(db, 'D', 'S'), null);
    await batchUpsertTimeUsage(db, [timeRow(1), timeRow(2)]);
    const wm = await getTimeWatermark(db, 'D', 'S');
    assert.equal(wm, '2026-07-10T00:00:02.002Z');
    assert.equal(await getTimeWatermark(db, 'D', 'other'), null);
    await db.close();
  } finally { cleanup(); }
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test test/db-batch.test.mjs`
Expected: FAIL(`src/db-batch.mjs` 不存在)

- [ ] **Step 4: 实现** `src/db-batch.mjs`:

```js
import { mysqlRowKey, nowExpression, todayExpression } from './db.mjs';

// SQLite 默认变量上限为 32766,但保守起见每批 400 行(400 × 16 参数 = 6400)。
const CHUNK_SIZE = 400;

function chunks(rows, size = CHUNK_SIZE) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export async function getTimeWatermark(db, device, source) {
  const row = await db.get(
    'SELECT MAX(event_time) AS watermark FROM time_usage WHERE device = ? AND source = ?',
    [device, source]
  );
  return row?.watermark || null;
}

const TIME_COLUMNS = `
  device, source, event_key, event_time, usage_date, model, project_path, session_id,
  input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
  reasoning_output_tokens, total_tokens, cost_usd, updated_at
`;

function timeValues(row) {
  return [
    row.device, row.source, row.eventKey, row.eventTime, row.usageDate, row.model || '',
    row.projectPath || null, row.sessionId || null, row.inputTokens || 0,
    row.outputTokens || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0,
    row.reasoningOutputTokens || 0, row.totalTokens || 0, row.costUSD || 0
  ];
}

export async function batchUpsertTimeUsage(db, rows) {
  const now = nowExpression(db.driver);
  for (const part of chunks(rows)) {
    if (db.driver === 'mysql') {
      const group = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now})`;
      await db.run(`
        INSERT INTO time_usage (row_key, ${TIME_COLUMNS})
        VALUES ${part.map(() => group).join(', ')}
        ON DUPLICATE KEY UPDATE
          event_time = VALUES(event_time), usage_date = VALUES(usage_date), model = VALUES(model),
          project_path = VALUES(project_path), session_id = VALUES(session_id),
          input_tokens = VALUES(input_tokens), output_tokens = VALUES(output_tokens),
          cache_creation_tokens = VALUES(cache_creation_tokens), cache_read_tokens = VALUES(cache_read_tokens),
          reasoning_output_tokens = VALUES(reasoning_output_tokens), total_tokens = VALUES(total_tokens),
          cost_usd = VALUES(cost_usd), updated_at = ${now}
      `, part.flatMap(row => [mysqlRowKey(row.device, row.source, row.eventKey), ...timeValues(row)]));
      continue;
    }
    const group = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now})`;
    await db.run(`
      INSERT INTO time_usage (${TIME_COLUMNS})
      VALUES ${part.map(() => group).join(', ')}
      ON CONFLICT(device, source, event_key) DO UPDATE SET
        event_time = excluded.event_time, usage_date = excluded.usage_date, model = excluded.model,
        project_path = excluded.project_path, session_id = excluded.session_id,
        input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens, cache_read_tokens = excluded.cache_read_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens, total_tokens = excluded.total_tokens,
        cost_usd = excluded.cost_usd, updated_at = ${now}
    `, part.flatMap(timeValues));
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test test/db-batch.test.mjs`
Expected: PASS(2 tests)。再跑 `node --test test/db.test.mjs` 确认 db.mjs 导出改动无回归。

- [ ] **Step 6: 提交**

```bash
git add src/db.mjs src/db-batch.mjs test/db-batch.test.mjs
git commit -m "feat: time_usage batch upsert and watermark query"
```

---

### Task 3: `daily_usage` / `session_usage` 批量 upsert

**Files:**
- Modify: `src/db-batch.mjs`
- Test: `test/db-batch.test.mjs`(追加)

**Interfaces:**
- Consumes: Task 2 的 `chunks`、`nowExpression`、`todayExpression`、`mysqlRowKey`。
- Produces:
  - `batchUpsertDaily(db, rows) -> Promise<void>`(row 结构同现有 `upsertDaily`;保留价格锁定 CASE)
  - `batchUpsertSession(db, rows) -> Promise<void>`(row 结构同现有 `upsertSession`)

- [ ] **Step 1: 追加失败测试**到 `test/db-batch.test.mjs`:

```js
import { batchUpsertDaily, batchUpsertSession } from '../src/db-batch.mjs';

function dailyRow(overrides = {}) {
  return {
    device: 'D', source: 'S', usageDate: '2026-01-01', model: 'm',
    inputTokens: 5, outputTokens: 3, cacheCreationTokens: 1, cacheReadTokens: 2,
    reasoningOutputTokens: 1, totalTokens: 12, costUSD: 1, ...overrides
  };
}

test('batchUpsertDaily keeps historical cost locked but updates tokens', async () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const db = await openDb(path);
    await batchUpsertDaily(db, [dailyRow()]); // 历史日期,首次写入
    await batchUpsertDaily(db, [dailyRow({ costUSD: 99, totalTokens: 20 })]);
    const row = await db.get('SELECT cost_usd, total_tokens, pricing_locked_at FROM daily_usage WHERE usage_date = ?', ['2026-01-01']);
    assert.equal(row.cost_usd, 1, 'historical cost must stay locked');
    assert.equal(row.total_tokens, 20, 'tokens still update');
    assert.ok(row.pricing_locked_at, 'lock timestamp set for historical dates');
    await db.close();
  } finally { cleanup(); }
});

test('batchUpsertDaily updates cost for today', async () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const db = await openDb(path);
    const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD 本地时区
    await batchUpsertDaily(db, [dailyRow({ usageDate: today, costUSD: 1 })]);
    await batchUpsertDaily(db, [dailyRow({ usageDate: today, costUSD: 2 })]);
    const row = await db.get('SELECT cost_usd, pricing_locked_at FROM daily_usage WHERE usage_date = ?', [today]);
    assert.equal(row.cost_usd, 2);
    assert.equal(row.pricing_locked_at, null);
    await db.close();
  } finally { cleanup(); }
});

test('batchUpsertSession upserts by (device, source, session_id)', async () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const db = await openDb(path);
    const row = {
      device: 'D', source: 'S', sessionId: 'sess1', lastActivity: '2026-07-19T00:00:00Z',
      projectPath: '/p', inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0,
      cacheReadTokens: 0, reasoningOutputTokens: 0, totalTokens: 2, costUSD: 0.1
    };
    await batchUpsertSession(db, [row]);
    await batchUpsertSession(db, [{ ...row, totalTokens: 5, costUSD: 0.2 }]);
    const { c } = await db.get('SELECT COUNT(*) AS c FROM session_usage');
    assert.equal(c, 1);
    const got = await db.get('SELECT total_tokens, cost_usd FROM session_usage WHERE session_id = ?', ['sess1']);
    assert.equal(got.total_tokens, 5);
    assert.equal(got.cost_usd, 0.2);
    await db.close();
  } finally { cleanup(); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/db-batch.test.mjs`
Expected: FAIL(`batchUpsertDaily` 未导出)

- [ ] **Step 3: 实现**,追加到 `src/db-batch.mjs`:

```js
const DAILY_COLUMNS = `
  device, source, usage_date, model, input_tokens, output_tokens,
  cache_creation_tokens, cache_read_tokens, reasoning_output_tokens,
  total_tokens, cost_usd, pricing_locked_at, updated_at
`;

function dailyValues(row) {
  return [
    row.device, row.source, row.usageDate, row.model || '', row.inputTokens || 0,
    row.outputTokens || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0,
    row.reasoningOutputTokens || 0, row.totalTokens || 0, row.costUSD || 0, row.usageDate
  ];
}

export async function batchUpsertDaily(db, rows) {
  const now = nowExpression(db.driver);
  const today = todayExpression(db.driver);
  for (const part of chunks(rows)) {
    if (db.driver === 'mysql') {
      const group = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, IF(? < ${today}, ${now}, NULL), ${now})`;
      await db.run(`
        INSERT INTO daily_usage (row_key, ${DAILY_COLUMNS})
        VALUES ${part.map(() => group).join(', ')}
        ON DUPLICATE KEY UPDATE
          input_tokens = VALUES(input_tokens), output_tokens = VALUES(output_tokens),
          cache_creation_tokens = VALUES(cache_creation_tokens), cache_read_tokens = VALUES(cache_read_tokens),
          reasoning_output_tokens = VALUES(reasoning_output_tokens), total_tokens = VALUES(total_tokens),
          cost_usd = IF(daily_usage.usage_date < ${today}, daily_usage.cost_usd, VALUES(cost_usd)),
          pricing_locked_at = IF(
            daily_usage.usage_date < ${today}, COALESCE(daily_usage.pricing_locked_at, ${now}), NULL
          ),
          updated_at = ${now}
      `, part.flatMap(row => [mysqlRowKey(row.device, row.source, row.usageDate, row.model || ''), ...dailyValues(row)]));
      continue;
    }
    const group = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? < ${today} THEN ${now} ELSE NULL END, ${now})`;
    await db.run(`
      INSERT INTO daily_usage (${DAILY_COLUMNS})
      VALUES ${part.map(() => group).join(', ')}
      ON CONFLICT(device, source, usage_date, model) DO UPDATE SET
        input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens, cache_read_tokens = excluded.cache_read_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens, total_tokens = excluded.total_tokens,
        cost_usd = CASE WHEN daily_usage.usage_date < ${today} THEN daily_usage.cost_usd ELSE excluded.cost_usd END,
        pricing_locked_at = CASE
          WHEN daily_usage.usage_date < ${today} THEN COALESCE(daily_usage.pricing_locked_at, ${now})
          ELSE NULL
        END,
        updated_at = ${now}
    `, part.flatMap(dailyValues));
  }
}

const SESSION_COLUMNS = `
  device, source, session_id, last_activity, project_path, input_tokens,
  output_tokens, cache_creation_tokens, cache_read_tokens,
  reasoning_output_tokens, total_tokens, cost_usd, updated_at
`;

function sessionValues(row) {
  return [
    row.device, row.source, row.sessionId, row.lastActivity || null, row.projectPath || null,
    row.inputTokens || 0, row.outputTokens || 0, row.cacheCreationTokens || 0,
    row.cacheReadTokens || 0, row.reasoningOutputTokens || 0, row.totalTokens || 0,
    row.costUSD || 0
  ];
}

export async function batchUpsertSession(db, rows) {
  const now = nowExpression(db.driver);
  for (const part of chunks(rows)) {
    if (db.driver === 'mysql') {
      const group = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now})`;
      await db.run(`
        INSERT INTO session_usage (row_key, ${SESSION_COLUMNS})
        VALUES ${part.map(() => group).join(', ')}
        ON DUPLICATE KEY UPDATE
          last_activity = VALUES(last_activity), project_path = VALUES(project_path),
          input_tokens = VALUES(input_tokens), output_tokens = VALUES(output_tokens),
          cache_creation_tokens = VALUES(cache_creation_tokens), cache_read_tokens = VALUES(cache_read_tokens),
          reasoning_output_tokens = VALUES(reasoning_output_tokens), total_tokens = VALUES(total_tokens),
          cost_usd = VALUES(cost_usd), updated_at = ${now}
      `, part.flatMap(row => [mysqlRowKey(row.device, row.source, row.sessionId), ...sessionValues(row)]));
      continue;
    }
    const group = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now})`;
    await db.run(`
      INSERT INTO session_usage (${SESSION_COLUMNS})
      VALUES ${part.map(() => group).join(', ')}
      ON CONFLICT(device, source, session_id) DO UPDATE SET
        last_activity = excluded.last_activity, project_path = excluded.project_path,
        input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens, cache_read_tokens = excluded.cache_read_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens, total_tokens = excluded.total_tokens,
        cost_usd = excluded.cost_usd, updated_at = ${now}
    `, part.flatMap(sessionValues));
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/db-batch.test.mjs`
Expected: PASS(5 tests)

- [ ] **Step 5: 提交**

```bash
git add src/db-batch.mjs test/db-batch.test.mjs
git commit -m "feat: daily/session batch upserts with pricing lock preserved"
```

---

### Task 4: 接入 `src/collect.mjs`(水位线 + `--full`)

**Files:**
- Modify: `src/collect.mjs`

**Interfaces:**
- Consumes: Task 1 全部四个函数;Task 2/3 的 `getTimeWatermark`、`batchUpsertTimeUsage`、`batchUpsertDaily`、`batchUpsertSession`;现有 `deleteTimeUsageForSource`。
- Produces: CLI 新增 `--full` 标志;`exportPayload` 新增 `mode: 'full' | 'incremental'` 字段(Task 5 的 ingest 依赖);payload 中 `daily`/`time` 只含本次实际写入的行。

- [ ] **Step 1: 改 import 与 parseArgs**

`src/collect.mjs` 顶部 import 区改为:

```js
import { deleteTimeUsageForSource, openDb, recordRun } from './db.mjs';
import { batchUpsertDaily, batchUpsertSession, batchUpsertTimeUsage, getTimeWatermark } from './db-batch.mjs';
import { dedupeEventKeys, filterDailyRows, filterTimeRows, watermarkCutoff } from './incremental.mjs';
```

`parseArgs` 的 for 循环内追加分支:

```js
    } else if (arg === '--full') {
      parsed.full = true;
```

`exportPayload` 初始化对象加一行 `mode: args.full ? 'full' : 'incremental',`(放在 `device` 之后)。

- [ ] **Step 2: 替换 collectLocal 内的写库段**

把现在的三段"normalize + runInTransaction 逐行 upsert"(约 68–85 行)整体替换为:

```js
    const dailyRows = normalizeDailyRows(graphJson, device);
    const sessionRows = normalizeSessionRows(modelsJson, device);
    // 先在全量批次上生成稳定 key,再做水位线过滤,保证 #n 序号跨次运行一致
    const timeRows = dedupeEventKeys(normalizeTimeRows(eventsJson, device));

    const watermark = args.full ? null : await getTimeWatermark(db, device, label);
    const cutoff = watermarkCutoff(watermark);
    const dailyToWrite = filterDailyRows(dailyRows, cutoff);
    const timeToWrite = filterTimeRows(timeRows, cutoff);
    const fullRebuild = args.full || !watermark;

    await runInTransaction(db, async (tx) => {
      await batchUpsertDaily(tx, dailyToWrite);
      await batchUpsertSession(tx, sessionRows);
      // 全量重建才允许删表;增量路径老事件永不触碰(价格锁定语义)
      if (fullRebuild) await deleteTimeUsageForSource(tx, device, label);
      await batchUpsertTimeUsage(tx, timeToWrite);
    });
    exportPayload.daily.push(...dailyToWrite);
    exportPayload.sessions.push(...sessionRows);
    exportPayload.time.push(...timeToWrite);
```

run 记录的 message 改为(体现增量规模):

```js
      message: `daily=${dailyToWrite.length}/${dailyRows.length}, time=${timeToWrite.length}/${timeRows.length}, workspace_model=${sessionRows.length}${fullRebuild ? ', full' : ''}`,
```

console.log 同步改成打印该 message。`status` 判定改用 `dailyRows.length || sessionRows.length`(按源数据判空,与过滤无关,维持原语义)。

- [ ] **Step 3: 稳定化 normalizeTimeRows 的兜底 key**

`normalizeTimeRows` 的 map 回调去掉 `index` 参数,`eventKey` 字段改为:

```js
      eventKey: entry.eventKey || [
        entry.client || 'unknown',
        eventTime,
        entry.sessionId || entry.workspaceKey || '',
        model,
        totalTokens
      ].join(':'),
```

(与旧公式唯一区别是去掉了末尾的 `index`;重复元组由 `dedupeEventKeys` 追加 `#n`。)

- [ ] **Step 4: 全量回归 + 手动验证**

Run: `node --test`
Expected: 全部 PASS。

手动验证(临时库,先全量后增量):

```bash
cd <repo-root>
DB=/tmp/collect-verify.sqlite
rm -f $DB
node src/collect.mjs --db $DB          # 空库 → 自动全量
node src/collect.mjs --db $DB          # 有水位线 → 增量
```

Expected:第一次输出 `time=N/N ... full`;第二次输出 `time=n/N`(n ≪ N,只有重叠窗口内的行),且两次之后:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/tmp/collect-verify.sqlite');console.log(db.prepare('SELECT COUNT(*) c, ROUND(SUM(total_tokens)) t FROM time_usage').get());"
```

与第一次采集后的计数一致(增量未引入重复)。再跑 `node src/collect.mjs --db $DB --full` 确认全量重建路径可用、行数不变。

- [ ] **Step 5: 提交**

```bash
git add src/collect.mjs
git commit -m "feat: watermark-incremental collect with --full rebuild flag"
```

---

### Task 5: `/api/ingest` 改为批量 + 按 mode 删表

**Files:**
- Modify: `src/server.mjs`(`handleIngest`,约 363–403 行;import 区)

**Interfaces:**
- Consumes: Task 2/3 的 `batchUpsertDaily`、`batchUpsertSession`、`batchUpsertTimeUsage`;Task 4 的 payload `mode` 字段。
- Produces: ingest 语义——`mode === 'full'`(或旧客户端无 mode 字段)才按 (device, source) 删表重建;`mode === 'incremental'` 只 upsert。

**背景:** 现在 ingest 对 payload 里出现的每个 (device, source) 先删光再重插。Task 4 之后增量 payload 只含窗口内的行,如果保留无条件删表,会把远端历史事件全部误删——本任务必须与 Task 4 同批部署。旧版客户端(无 mode 字段)payload 仍是全量,视为 `'full'` 保持兼容。

- [ ] **Step 1: 改 import**

`src/server.mjs` 第 7–10 行的 db.mjs import 去掉 `upsertDaily, upsertSession, upsertTimeUsage`(保留 `deleteTimeUsageForSource, pruneCollectionRuns, recordRun` 等仍在用的),追加:

```js
import { batchUpsertDaily, batchUpsertSession, batchUpsertTimeUsage } from './db-batch.mjs';
```

- [ ] **Step 2: 替换 handleIngest 的事务段**

```js
    const fullRebuild = payload.mode !== 'incremental';

    // 全量 push 携带设备完整时间窗,按 (device, source) 整体替换;
    // 增量 push 只含新事件,只做 upsert,绝不删表。
    const timePairs = new Map();
    if (fullRebuild) {
      for (const row of timeRows) {
        if (row.device && row.source) timePairs.set(`${row.device}::${row.source}`, row);
      }
    }

    await db.transaction(async (tx) => {
      await batchUpsertDaily(tx, dailyRows);
      for (const row of timePairs.values()) await deleteTimeUsageForSource(tx, row.device, row.source);
      await batchUpsertTimeUsage(tx, timeRows);
      await batchUpsertSession(tx, sessionRows);
      for (const row of runRows) await recordRun(tx, row);
    });
```

响应 JSON 追加 `mode: fullRebuild ? 'full' : 'incremental'` 字段。

- [ ] **Step 3: 回归 + 手动验证**

Run: `node --test`
Expected: 全部 PASS。

手动验证 ingest(临时库起服务):

```bash
DB=/tmp/ingest-verify.sqlite; rm -f $DB
PORT=4999 DB_PATH=$DB node src/server.mjs &   # 记下 pid
sleep 1
curl -s -X POST localhost:4999/api/ingest -H 'content-type: application/json' -d '{
  "mode":"full","daily":[],"sessions":[],"runs":[],
  "time":[{"device":"X","source":"S","eventKey":"a","eventTime":"2026-07-01T00:00:00Z","usageDate":"2026-07-01","model":"m","totalTokens":5,"inputTokens":5}]}'
curl -s -X POST localhost:4999/api/ingest -H 'content-type: application/json' -d '{
  "mode":"incremental","daily":[],"sessions":[],"runs":[],
  "time":[{"device":"X","source":"S","eventKey":"b","eventTime":"2026-07-02T00:00:00Z","usageDate":"2026-07-02","model":"m","totalTokens":7,"inputTokens":7}]}'
kill %1
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/tmp/ingest-verify.sqlite');console.log(db.prepare('SELECT COUNT(*) c FROM time_usage').get());"
```

Expected: `{ c: 2 }`——增量 push 没有删掉 full push 写入的事件 a。

- [ ] **Step 4: 提交**

```bash
git add src/server.mjs
git commit -m "feat: mode-aware batched ingest endpoint"
```

---

### Task 6: 收尾验证与文档

**Files:**
- Modify: `README.md`(采集章节追加 `--full` 说明)

**Interfaces:**
- Consumes: 全部前置任务。

- [ ] **Step 1: 全量测试**

Run: `node --test`
Expected: 全部 PASS,无跳过。

- [ ] **Step 2: 真实端到端验证(本地 sqlite)**

```bash
cp data/usage.sqlite /tmp/usage-backup.sqlite
node src/collect.mjs        # 对本地默认库跑一次增量
```

Expected:输出各源 `time=n/N` 增量数字;跑完 `node src/server.mjs` 起的仪表盘数据正常(总 token/成本与之前一致)。

- [ ] **Step 3: README 采集章节追加**(找到现有介绍 `npm run collect` 的段落,在其后追加):

```markdown
默认为增量采集:只上传比远端水位线(该设备该来源最新事件时间)新的数据,历史事件与已锁定的历史成本不会被改写。如需全量重建(如采集器逻辑变更后),使用:

    node src/collect.mjs --full

注意:`--full` 会删除该设备的远端事件并按当前价格重算历史成本。
```

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs: document incremental collect and --full rebuild"
```

## 已知边界(实现时不处理,记录在案)

- 90 天窗口滑动导致最老一天移出窗口时,如该天内有重复元组,`#n` 序号理论上可能重排;该天早已同步且被锁定,增量路径不会触及,仅 `--full` 时统一重建,无实际影响。
- `--push` 模式下水位线取自采集端本地库;若 hub 端落后于采集端本地库,增量 push 可能留缺口。当前部署(直连 Supabase,单写入方)不存在此问题;多设备 push 场景恢复手段为 `--full`。
