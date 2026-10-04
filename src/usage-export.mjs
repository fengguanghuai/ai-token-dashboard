import { dateWhere, eventFilters, queryTime } from './usage-query.mjs';
import { fromStored } from './db-batch.mjs';
import { withReadSnapshot } from './db.mjs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const fields = ['source', 'device', 'model', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'reasoningOutputTokens', 'totalTokens', 'costUSD'];
const titles = ['source', 'device', 'model', 'input', 'output', 'cache_read', 'cache_creation', 'reasoning', 'total', 'cost_usd'];

export function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Names come from local logs. Keep spreadsheet applications from evaluating
  // them as formulas; numeric usage and costs remain numeric.
  if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function* usageCsvPages(db, input, pricingData) {
  const params = new URLSearchParams(input);
  const mode = params.get('mode') || 'daily';
  if (!['daily', 'time'].includes(mode) || params.has('cursor') || params.has('limit') || (mode === 'daily' && params.has('project'))) {
    throw Object.assign(new Error('Invalid export parameters'), { status: 400 });
  }
  let where, filters;
  try {
    where = dateWhere(params); filters = eventFilters(db, params);
    if (mode === 'time') {
      // Validate explicit bounds before sending CSV headers; do not allow a
      // moving default end time between pages.
      const start = Date.parse(params.get('start')), end = Date.parse(params.get('end'));
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('Invalid time range');
    }
  } catch (error) { error.status = 400; throw error; }
  const columns = [mode === 'time' ? 'eventTime' : 'usageDate', ...fields];
  let header = [mode === 'time' ? 'time' : 'date', ...titles].join(',') + '\r\n';
  let cursor = null;
  const exact = column => db.driver === 'mysql' ? `${column} COLLATE utf8mb4_bin` : column;
  const keys = ['usage_date', 'device', 'source', 'model'];
  const order = keys.map(exact).join(', ');
  do {
    let rows, more;
    if (mode === 'time') {
      params.set('limit', '1000');
      if (cursor) params.set('cursor', cursor);
      const page = await queryTime(db, params, pricingData);
      rows = page.time; cursor = page.nextCursor; more = Boolean(cursor);
    } else {
      const raw = await db.all(`SELECT * FROM daily_usage WHERE 1=1${where.sql}${filters.sql}${cursor ? ` AND (${order}) > (?, ?, ?, ?)` : ''} ORDER BY ${order} LIMIT ?`,
        [...where.values, ...filters.values, ...(cursor || []), 1001]);
      more = raw.length > 1000;
      const page = raw.slice(0, 1000);
      cursor = page.length ? keys.map(key => page.at(-1)[key]) : null;
      rows = page.map(row => fromStored('daily', row));
    }
    yield header + rows.map(row => columns.map(key => csvCell(row[key])).join(',') + '\r\n').join('');
    header = '';
    if (!more) break;
  } while (true);
}

// Materialize one consistent snapshot with bounded page memory, then release
// the database before the first download byte. Slow downloads only hold a file.
export async function streamUsageCsv(db, params, res, pricingData, { temporaryRoot = tmpdir() } = {}) {
  if (res.destroyed) return;
  const directory = await mkdtemp(join(temporaryRoot, 'ai-token-export-'));
  const path = join(directory, 'usage.csv');
  let file;
  try {
    file = await open(path, 'wx', 0o600);
    await withReadSnapshot(db, async snapshot => {
      for await (const page of usageCsvPages(snapshot, params, pricingData)) {
        if (res.destroyed) return;
        await file.writeFile(page);
        if (res.destroyed) return;
      }
    });
    if (res.destroyed) return;
    const { size } = await file.stat();
    await file.close(); file = null;
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="tokens-${params.get('mode') === 'time' ? 'time' : 'daily'}.csv"`,
      'content-length': size,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    await pipeline(createReadStream(path), res);
  } catch (error) {
    if (!res.destroyed) throw error;
  } finally {
    try { await file?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
