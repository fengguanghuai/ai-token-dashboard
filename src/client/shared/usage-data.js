import { U } from './utils.js';

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
    const params = new URLSearchParams({ ...range, limit: '2000', ...(cursor ? { cursor } : {}) });
    const response = await fetcher(`/api/time?${params}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.time)) throw new Error('明细数据格式错误');
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
  return [...grouped].map(([key, records]) => ({
    ...records[0], ...U.aggregateTotals(records), sessionId: key,
    lastActivity: records.reduce((value, r) => (r.eventTime || r.lastActivity || '') > value ? r.eventTime || r.lastActivity : value, '') || null
  })).sort((a, b) => b.totalTokens - a.totalTokens);
}
