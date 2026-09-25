import { fromStored } from './db-batch.mjs';
import { calculateCacheSavings } from './pricing.mjs';
import { validDate } from './ingest-validation.mjs';
import { projectPath } from './project-identity.mjs';

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
  const projects = await db.all(`SELECT device, source, usage_date, model, project_path,
      MAX(event_time) AS last_activity, ${tokens.map(key => `SUM(${key}) AS ${key}`).join(', ')}, SUM(cost_usd) AS cost_usd
    FROM time_usage WHERE 1=1${where.sql}
    GROUP BY device, source, usage_date, model, project_path ORDER BY usage_date DESC`, where.values);
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

export async function queryTime(db, params, pricingData) {
  const rawStart = params.get('start'), rawEnd = params.get('end');
  const end = rawEnd || new Date().toISOString();
  const start = rawStart || new Date(Date.parse(end) - 30 * 86400_000).toISOString();
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) > Date.parse(end)) throw new Error('Invalid time range');
  const range = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  const limit = Number(params.get('limit') || 1000);
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new Error('limit must be between 1 and 2000');
  const values = [range.start, range.end];
  let cursorWhere = '';
  if (params.has('cursor')) {
    let cursor;
    try { cursor = JSON.parse(Buffer.from(params.get('cursor'), 'base64url').toString()); } catch { throw new Error('Invalid cursor'); }
    if (cursor.start !== range.start || cursor.end !== range.end || !Array.isArray(cursor.last)
        || cursor.last.length !== 4 || cursor.last.some(v => typeof v !== 'string' || v.length > 4096)) throw new Error('Invalid cursor');
    cursorWhere = ' AND (event_time, device, source, event_key) > (?, ?, ?, ?)';
    values.push(...cursor.last);
  }
  const raw = await db.all(`SELECT * FROM time_usage WHERE event_time >= ? AND event_time <= ?${cursorWhere}
    ORDER BY event_time, device, source, event_key LIMIT ?`, [...values, limit + 1]);
  const more = raw.length > limit;
  const page = raw.slice(0, limit);
  const last = page.at(-1);
  return {
    range,
    time: page.map(stored => {
      const row = fromStored('time', stored);
      return { ...row, projectPath: projectPath(row.projectPath), id: JSON.stringify([row.device, row.source, row.eventKey]), cacheSavedUSD: savings(row, pricingData) };
    }),
    nextCursor: more ? Buffer.from(JSON.stringify({ ...range, last: [last.event_time, last.device, last.source, last.event_key] })).toString('base64url') : null
  };
}
