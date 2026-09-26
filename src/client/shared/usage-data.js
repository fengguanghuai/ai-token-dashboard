import { U } from './utils.js';

export function dailyRangeForFilters(filters) {
  const { startDate, endDate } = filters;
  for (const date of [startDate, endDate]) {
    const stamp = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== date) throw new Error('请选择有效的日期范围');
  }
  if (startDate > endDate) throw new Error('请选择有效的日期范围');
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400_000) + 1;
  return { startDate: filters.compare ? U.addDays(startDate, -days) : startDate, endDate };
}

export function hourlyRangeForFilters(filters) {
  dailyRangeForFilters({ ...filters, compare: false });
  return { startDate: [filters.startDate, U.addDays(filters.endDate, -27)].sort().at(-1), endDate: filters.endDate };
}

export async function fetchDailyRange(range, { signal, fetcher = fetch } = {}) {
  const response = await fetcher(`/api/data?${queryParams(range)}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!['daily', 'projectDaily', 'runs'].every(key => Array.isArray(data[key])) || !data.dateRange
      || !['devices', 'sources', 'models'].every(key => Array.isArray(data.dimensions?.[key]))) throw new Error('日期统计数据格式错误，请确认服务端已升级');
  return data;
}

export async function fetchHourlyRange(range, { signal, fetcher = fetch } = {}) {
  const response = await fetcher(`/api/hourly?${queryParams(range)}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.hourly)) throw new Error('小时统计数据格式错误');
  return data;
}

export function timeRangeForFilters(filters) {
  const start = new Date(filters.startDateTime).getTime();
  const end = new Date(filters.endDateTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('请选择有效的时间范围');
  return { start: new Date(filters.compare ? start - (end - start) - 60_000 : start).toISOString(), end: new Date(end).toISOString() };
}

export async function fetchTimeRange(range, { signal, fetcher = fetch } = {}) {
  const rows = [], seen = new Set();
  let cursor = null;
  do {
    const data = await fetchTimePage(range, { signal, fetcher, cursor, limit: 2000 });
    rows.push(...data.time);
    cursor = data.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('明细分页重复，请重试');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return rows;
}

export function projectTotals(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!row.projectPath) continue;
    const key = JSON.stringify([row.device, row.source, row.projectPath, row.model]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped].map(([key, records]) => {
    const totals = U.aggregateTotals(records);
    return {
      ...records[0], ...totals, reasoningOutputTokens: totals.reasoningTokens, sessionId: key,
      lastActivity: records.reduce((value, r) => (r.eventTime || r.lastActivity || '') > value ? r.eventTime || r.lastActivity : value, '') || null
    };
  }).sort((a, b) => b.totalTokens - a.totalTokens);
}

export function summaryRangeForFilters(filters) {
  const range = timeRangeForFilters({ ...filters, compare: false });
  if (!filters.compare) return range;
  const end = Date.parse(range.start) - 60_000;
  return { ...range, compareStart: new Date(end - (Date.parse(range.end) - Date.parse(range.start))).toISOString(), compareEnd: new Date(end).toISOString() };
}

export function eventQueryForFilters(filters, focusedSource, drill) {
  const query = { ...timeRangeForFilters({ ...filters, compare: false }), source: [...filters.sources], device: [...filters.devices], model: [...filters.models] };
  if (focusedSource) query.source = [focusedSource];
  if (drill?.kind === 'source') { query.source = [drill.row.source]; query.device = [drill.row.device]; }
  if (drill?.kind === 'model') { query.model = [drill.row.model]; if (!drill.allSources) query.source = [drill.row.source]; }
  if (drill?.kind === 'session') {
    query.source = [drill.row.source]; query.device = [drill.row.device]; query.model = [drill.row.model]; query.project = [drill.row.projectPath];
  }
  return query;
}

function queryParams(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) if (item != null) params.append(key, String(item));
  }
  return params;
}

export async function fetchTimePage(query, { signal, fetcher = fetch, cursor = null, limit = 50 } = {}) {
  const params = queryParams({ ...query, limit, ...(cursor ? { cursor } : {}) });
  const response = await fetcher(`/api/time?${params}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.time) || !(data.nextCursor === null || typeof data.nextCursor === 'string')) throw new Error('明细数据格式错误');
  return data;
}

export async function fetchTimeSummary(range, { signal, fetcher = fetch } = {}) {
  const response = await fetcher(`/api/time/summary?${queryParams(range)}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  for (const part of [data.current, ...(range.compareStart ? [data.previous] : [])]) {
    if (!part || !['daily', 'projectDaily', 'hourly'].every(key => Array.isArray(part[key]))) throw new Error('统计数据格式错误');
  }
  return data;
}

export function filterDimensions(rows, filters) {
  return rows.filter(row => (!filters.sources.size || filters.sources.has(row.source))
    && (!filters.devices.size || filters.devices.has(row.device)) && (!filters.models.size || filters.models.has(row.model)));
}

export function summarySourceOptions(rows, filters) {
  const active = new Set(filterDimensions(rows, { ...filters, sources: new Set() }).filter(row => row.totalTokens > 0).map(row => row.source));
  return U.sortSources([...new Set([...active, ...filters.sources])]).map(source => ({ source, hasUsage: active.has(source) }));
}
