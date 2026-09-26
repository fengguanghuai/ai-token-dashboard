import { fromStored } from './db-batch.mjs';
import { calculateCost, calculateCacheSavings } from './pricing.mjs';
import { validDate } from './ingest-validation.mjs';
import { projectPath } from './project-identity.mjs';
import { dateExpression, hourExpression } from './db.mjs';

const tokens = ['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'reasoning_output_tokens', 'total_tokens'];
const bucket = row => JSON.stringify([row.device, row.source, row.usageDate, row.model]);

export function savings(row, pricingData) {
  return calculateCacheSavings(row.model, {
    input: row.inputTokens, output: row.outputTokens, cacheRead: row.cacheReadTokens, cacheWrite: row.cacheCreationTokens,
    reasoning: /^Codex CLI(?: \(JS\))?$/.test(row.source) ? 0 : row.reasoningOutputTokens
  }, pricingData, null, { tiered: false });
}

export function dateWhere(params) {
  const start = params.get('startDate'), end = params.get('endDate');
  if (start && !validDate(start) || end && !validDate(end) || start && end && start > end) throw new Error('Invalid date range');
  return {
    sql: `${start ? ' AND usage_date >= ?' : ''}${end ? ' AND usage_date <= ?' : ''}`,
    values: [...(start ? [start] : []), ...(end ? [end] : [])]
  };
}

export async function queryDaily(db, params, pricingData) {
  const where = dateWhere(params);
  const daily = (await db.all(`SELECT * FROM daily_usage WHERE 1=1${where.sql} ORDER BY usage_date DESC`, where.values))
    .map(row => fromStored('daily', row));
  // Project attribution comes exclusively from events that actually carry a
  // project. Legacy workspace totals cannot identify a day's project.
  const dimensions = ['device', 'source', 'usage_date', 'model', 'project_path'];
  const projects = await db.all(`SELECT ${dimensions.map(column => `${exact(db, column)} AS ${column}`).join(', ')},
      MAX(event_time) AS last_activity, ${tokens.map(key => `SUM(${key}) AS ${key}`).join(', ')}, SUM(cost_usd) AS cost_usd
    FROM time_usage WHERE 1=1${where.sql}
    GROUP BY ${dimensions.map(column => exact(db, column)).join(', ')} ORDER BY usage_date DESC`, where.values);
  const projectDaily = projects.map(row => ({
    ...fromStored('daily', row), projectPath: projectPath(row.project_path), lastActivity: row.last_activity,
    id: JSON.stringify([row.device, row.source, row.usage_date, row.model, row.project_path]),
    costBasis: 'event_details'
  }));
  const eventTotals = new Map();
  for (const row of projectDaily) {
    const key = bucket(row), current = eventTotals.get(key) || { totalTokens: 0, costUSD: 0 };
    current.totalTokens += row.totalTokens; current.costUSD += row.costUSD; eventTotals.set(key, current);
  }
  return {
    daily: daily.map(row => {
      const detail = eventTotals.get(bucket(row));
      return {
        ...row, id: bucket(row), projectPath: null, cacheSavedUSD: savings(row, pricingData),
        eventTokens: detail?.totalTokens ?? null, eventCostUSD: detail?.costUSD ?? null,
        reconciliation: !detail ? 'missing_details' : detail.totalTokens !== row.totalTokens ? 'token_difference'
          : Math.abs(detail.costUSD - row.costUSD) > 0.000001 ? 'cost_difference' : 'matched'
      };
    }),
    projectDaily
  };
}

// Global bounds/options remain available even when a selected period is empty.
// These are small metadata sets, not the historical usage rows themselves.
export async function queryUsageMetadata(db) {
  const dates = await db.get('SELECT MIN(usage_date) AS start_date, MAX(usage_date) AS end_date FROM daily_usage');
  const events = await db.get('SELECT MIN(event_time) AS start_time, MAX(event_time) AS end_time FROM time_usage');
  const dimensions = await db.all(`SELECT DISTINCT ${['device', 'source', 'model'].map(key => `${exact(db, key)} AS ${key}`).join(', ')} FROM daily_usage`);
  return {
    dateRange: { start: dates.start_date, end: dates.end_date },
    eventRange: { start: events.start_time, end: events.end_time },
    dimensions: Object.fromEntries(['device', 'source', 'model'].map(key => [`${key}s`, [...new Set(dimensions.map(row => row[key]).filter(Boolean))].sort()]))
  };
}

export async function queryHourly(db, params) {
  const { values } = dateWhere(params); // Validate before constructing bounds.
  const start = params.get('startDate'), end = params.get('endDate');
  const localDate = dateExpression(db.driver), localHour = hourExpression(db.driver);
  // The indexed UTC envelope is deliberately wider than any timezone offset.
  // The local-date predicate is authoritative, including DST and stored rows
  // whose usage_date was collected under a different display timezone.
  const utc = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400_000).toISOString();
  const where = `${start ? ` AND event_time >= ? AND ${localDate} >= ?` : ''}${end ? ` AND event_time < ? AND ${localDate} <= ?` : ''}`;
  const bounds = [...(start ? [utc(start, -1), values[0]] : []), ...(end ? [utc(end, 2), values.at(-1)] : [])];
  const dimensions = ['device', 'source', 'model'];
  const rows = await db.all(`SELECT ${dimensions.map(key => `${exact(db, key)} AS ${key}`).join(', ')},
    ${localDate} AS local_date, ${localHour} AS local_hour, COUNT(*) AS event_count,
    SUM(total_tokens) AS total_tokens, SUM(cost_usd) AS cost_usd FROM time_usage
    WHERE 1=1${where} GROUP BY ${dimensions.map(key => exact(db, key)).join(', ')}, ${localDate}, ${localHour}
    ORDER BY local_date DESC, local_hour DESC`, bounds);
  return { hourly: rows.map(row => ({ device: row.device, source: row.source, model: row.model,
    usageDate: row.local_date, hour: Number(row.local_hour), eventCount: Number(row.event_count),
    totalTokens: Number(row.total_tokens), costUSD: Number(row.cost_usd) })) };
}

function timeRange(params, startKey = 'start', endKey = 'end') {
  const end = params.get(endKey) || new Date().toISOString();
  if (!Number.isFinite(Date.parse(end))) throw new Error('Invalid time range');
  const start = params.get(startKey) || new Date(Date.parse(end) - 30 * 86400_000).toISOString();
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) > Date.parse(end)) throw new Error('Invalid time range');
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

// MySQL's default collation folds case; event and project identities do not.
const exact = (db, column) => db.driver === 'mysql' ? `${column} COLLATE utf8mb4_bin` : column;
function eventFilters(db, params) {
  const filters = {}, values = [], clauses = [];
  for (const [key, column] of [['source', 'source'], ['device', 'device'], ['model', 'model'], ['project', 'project_path']]) {
    const selected = [...new Set(params.getAll(key))].sort();
    if (selected.length > 100 || selected.some(value => value.length > 4096)) throw new Error('Invalid event filters');
    if (!selected.length) continue;
    filters[key] = selected;
    clauses.push(`${exact(db, column)} IN (${selected.map(() => '?').join(',')})`);
    values.push(...selected);
  }
  return { key: JSON.stringify(filters), values, sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '' };
}

export async function queryTime(db, params, pricingData) {
  const range = timeRange(params), filters = eventFilters(db, params);
  const limit = Number(params.get('limit') || 1000);
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new Error('limit must be between 1 and 2000');
  const values = [range.start, range.end, ...filters.values];
  const order = ['event_time', 'device', 'source', 'event_key'].map(column => exact(db, column)).join(', ');
  let cursorWhere = '';
  if (params.has('cursor')) {
    let cursor;
    try { cursor = JSON.parse(Buffer.from(params.get('cursor'), 'base64url').toString()); } catch { throw new Error('Invalid cursor'); }
    if (!cursor || cursor.start !== range.start || cursor.end !== range.end || (cursor.filters || '{}') !== filters.key || !Array.isArray(cursor.last)
        || cursor.last.length !== 4 || cursor.last.some(v => typeof v !== 'string' || v.length > 4096)) throw new Error('Invalid cursor');
    cursorWhere = ` AND (${order}) > (?, ?, ?, ?)`;
    values.push(...cursor.last);
  }
  const raw = await db.all(`SELECT * FROM time_usage WHERE event_time >= ? AND event_time <= ?${filters.sql}${cursorWhere}
    ORDER BY ${order} LIMIT ?`, [...values, limit + 1]);
  const more = raw.length > limit;
  const page = raw.slice(0, limit);
  const last = page.at(-1);
  return {
    range,
    time: page.map(stored => {
      const row = fromStored('time', stored);
      return { ...row, projectPath: projectPath(row.projectPath), id: JSON.stringify([row.device, row.source, row.eventKey]), cacheSavedUSD: savings(row, pricingData) };
    }),
    nextCursor: more ? Buffer.from(JSON.stringify({ ...range, filters: filters.key, last: [last.event_time, last.device, last.source, last.event_key] })).toString('base64url') : null
  };
}

// With tiering disabled, cache savings is linear before the per-event zero
// clamp. Apply that clamp in SQL before SUM (write-heavy events can be negative).
function savingsExpression(db, models, pricingData) {
  if (!models.length) return { sql: '0', values: [] };
  const values = [];
  const cases = models.map(({ model }) => {
    const rate = key => calculateCost(model, { input: 1 }, pricingData, null, { tiered: false })
      - calculateCost(model, { [key]: 1 }, pricingData, null, { tiered: false });
    const read = rate('cacheRead'), write = rate('cacheWrite');
    if (!Number.isFinite(read) || !Number.isFinite(write)) throw new Error('Invalid cache pricing');
    const expression = `(cache_read_tokens * ${read} + cache_creation_tokens * ${write})`;
    values.push(model);
    return `WHEN ? THEN CASE WHEN ${expression} > 0 THEN ${expression} ELSE 0 END`;
  });
  return { sql: `CASE ${exact(db, 'model')} ${cases.join(' ')} ELSE 0 END`, values };
}

export async function queryTimeSummary(db, params, pricingData) {
  const range = timeRange(params);
  let previousRange = null;
  if (params.has('compareStart') || params.has('compareEnd')) {
    if (!params.get('compareStart') || !params.get('compareEnd')) throw new Error('Invalid comparison range');
    previousRange = timeRange(params, 'compareStart', 'compareEnd');
    if (previousRange.end >= range.start) throw new Error('Comparison must precede current range');
  }
  const where = previousRange
    ? '(event_time >= ? AND event_time <= ? OR event_time >= ? AND event_time <= ?)'
    : 'event_time >= ? AND event_time <= ?';
  const bounds = [range.start, range.end, ...(previousRange ? [previousRange.start, previousRange.end] : [])];
  const models = await db.all(`SELECT DISTINCT ${exact(db, 'model')} AS model FROM time_usage WHERE ${where}`, bounds);
  const cache = savingsExpression(db, models, pricingData);
  const dimensions = ['device', 'source', 'usage_date', 'model', 'project_path', 'cost_basis', 'pricing_version'];
  const columns = dimensions.map(column => `${exact(db, column)} AS ${column}`).join(', ');
  const groups = dimensions.map(column => exact(db, column)).join(', ');
  const period = "CASE WHEN event_time >= ? AND event_time <= ? THEN 'current' ELSE 'previous' END";
  const projects = await db.all(`SELECT ${period} AS period, ${columns}, MAX(event_time) AS last_activity,
      COUNT(*) AS event_count, ${tokens.map(key => `SUM(${key}) AS ${key}`).join(', ')}, SUM(cost_usd) AS cost_usd,
      SUM(${cache.sql}) AS cache_saved
    FROM time_usage WHERE ${where} GROUP BY period, ${groups} ORDER BY usage_date`,
    [range.start, range.end, ...cache.values, ...bounds]);
  const hour = hourExpression(db.driver), date = dateExpression(db.driver);
  const hourly = await db.all(`SELECT ${period} AS period,
      ${['device', 'source', 'model'].map(column => `${exact(db, column)} AS ${column}`).join(', ')},
      ${date} AS local_date, ${hour} AS local_hour, COUNT(*) AS event_count, SUM(total_tokens) AS total_tokens, SUM(cost_usd) AS cost_usd
    FROM time_usage WHERE ${where} GROUP BY period, ${['device', 'source', 'model'].map(column => exact(db, column)).join(', ')}, local_date, local_hour`,
    [range.start, range.end, ...bounds]);
  const empty = () => ({ daily: [], projectDaily: [], hourly: [], eventCount: 0 });
  const result = { range, previousRange, current: empty(), previous: previousRange ? empty() : null };
  const daily = { current: new Map(), previous: new Map() };
  for (const stored of projects) {
    const row = { ...fromStored('daily', stored), projectPath: projectPath(stored.project_path), lastActivity: stored.last_activity,
      eventCount: Number(stored.event_count), cacheSavedUSD: Number(stored.cache_saved) };
    const target = result[stored.period];
    target.projectDaily.push(row);
    target.eventCount += row.eventCount;
    const key = bucket(row), existing = daily[stored.period].get(key);
    if (!existing) daily[stored.period].set(key, { ...row, id: key, projectPath: null });
    else {
      for (const field of ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'reasoningOutputTokens', 'totalTokens', 'costUSD', 'cacheSavedUSD', 'eventCount']) existing[field] += row[field];
      if (existing.costBasis !== row.costBasis) existing.costBasis = 'mixed';
      if (existing.pricingVersion !== row.pricingVersion) existing.pricingVersion = null;
    }
  }
  for (const period of ['current', 'previous']) if (result[period]) result[period].daily = [...daily[period].values()];
  for (const row of hourly) result[row.period].hourly.push({ device: row.device, source: row.source, model: row.model,
    usageDate: row.local_date, hour: Number(row.local_hour), eventCount: Number(row.event_count), totalTokens: Number(row.total_tokens), costUSD: Number(row.cost_usd) });
  return result;
}
