import { dateWhere, eventFilters, queryTime } from './usage-query.mjs';
import { fromStored } from './db-batch.mjs';

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

// Wait for downstream capacity; stop paging when the browser cancels. Avoid
// holding a database transaction/connection open while a slow client downloads.
async function writeChunk(res, chunk) {
  if (res.destroyed) return false;
  if (res.write(chunk)) return true;
  return new Promise((resolve, reject) => {
    const cleanup = () => { res.off('drain', drain); res.off('close', close); res.off('error', error); };
    const drain = () => { cleanup(); resolve(true); };
    const close = () => { cleanup(); resolve(false); };
    const error = err => { cleanup(); reject(err); };
    res.once('drain', drain); res.once('close', close); res.once('error', error);
    if (res.destroyed) close();
  });
}

export async function streamUsageCsv(db, params, res, pricingData) {
  const pages = usageCsvPages(db, params, pricingData);
  try {
    let page = await pages.next(); // Query/validate before committing response.
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="tokens-${params.get('mode') === 'time' ? 'time' : 'daily'}.csv"`,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    while (!page.done && !res.destroyed) {
      if (!await writeChunk(res, page.value)) return;
      if (res.destroyed) return;
      page = await pages.next();
    }
    if (!res.destroyed) res.end();
  } finally { await pages.return(); }
}
