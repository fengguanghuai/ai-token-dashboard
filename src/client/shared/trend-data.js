export function buildTrendData(rows, dates, sources, compareRows, compareDates = []) {
  const byDate = new Map();
  const keys = new Map(sources.map((source, i) => [source, `source${i}`]));
  for (const row of rows) {
    const key = keys.get(row.source);
    if (!key) continue;
    if (!byDate.has(row.usageDate)) byDate.set(row.usageDate, {});
    const values = byDate.get(row.usageDate);
    values[key] = (values[key] || 0) + row.totalTokens;
  }
  const previous = new Map();
  for (const row of compareRows || []) previous.set(row.usageDate, (previous.get(row.usageDate) || 0) + row.totalTokens);
  return dates.map((day, index) => {
    const [year, month, date] = day.split('-').map(Number);
    const point = { date: new Date(year, month - 1, date), day, total: 0 };
    sources.forEach((_, i) => {
      point[`source${i}`] = byDate.get(day)?.[`source${i}`] || 0;
      point.total += point[`source${i}`];
    });
    if (compareRows) {
      point.previous = previous.get(compareDates[index]) || 0;
      point.previousDay = compareDates[index] || '';
    }
    return point;
  });
}
