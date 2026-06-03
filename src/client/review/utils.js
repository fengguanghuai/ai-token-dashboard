/* =============================================================
   Review-page specific analysis utilities
   ============================================================= */

import { U } from '../shared/utils.js';

// Local YYYY-MM-DD (avoids toISOString's UTC drift)
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m: m - 1, d };
}

const PERIOD_LABELS = {
  week: '本周',
  month: '本月',
  prev:  '上月',
  '90d': '近 90 天',
  all: '全部'
};

function getPeriod(id, today = new Date(), rows = []) {
  const t = new Date(today); t.setHours(0,0,0,0);
  if (id === 'week') {
    const start = new Date(t); start.setDate(t.getDate() - 6);
    return {
      id,
      label: '本周',
      start: localDateStr(start),
      end:   localDateStr(t),
      pretty: `${localDateStr(start).slice(5)} – ${localDateStr(t).slice(5)}`,
      prev: (function () {
        const ps = new Date(start); ps.setDate(ps.getDate() - 7);
        const pe = new Date(start); pe.setDate(pe.getDate() - 1);
        return { start: localDateStr(ps), end: localDateStr(pe) };
      })()
    };
  }
  if (id === 'month') {
    const start = new Date(t.getFullYear(), t.getMonth(), 1);
    return {
      id,
      label: '本月',
      start: localDateStr(start),
      end:   localDateStr(t),
      pretty: `${t.getFullYear()} 年 ${t.getMonth() + 1} 月`,
      prev: (function () {
        const ps = new Date(t.getFullYear(), t.getMonth() - 1, 1);
        const pe = new Date(t.getFullYear(), t.getMonth(), 0);
        return { start: localDateStr(ps), end: localDateStr(pe) };
      })()
    };
  }
  if (id === 'prev') {
    const ps = new Date(t.getFullYear(), t.getMonth() - 1, 1);
    const pe = new Date(t.getFullYear(), t.getMonth(), 0);
    return {
      id,
      label: '上月',
      start: localDateStr(ps),
      end:   localDateStr(pe),
      pretty: `${ps.getFullYear()} 年 ${ps.getMonth() + 1} 月`,
      prev: (function () {
        const pps = new Date(ps.getFullYear(), ps.getMonth() - 1, 1);
        const ppe = new Date(ps.getFullYear(), ps.getMonth(), 0);
        return { start: localDateStr(pps), end: localDateStr(ppe) };
      })()
    };
  }
  if (id === '90d') {
    const start = new Date(t); start.setDate(t.getDate() - 89);
    return {
      id,
      label: '近 90 天',
      start: localDateStr(start),
      end:   localDateStr(t),
      pretty: `近 90 天`,
      prev: null
    };
  }
  if (id === 'all') {
    const dates = rows.map(r => r.usageDate).filter(Boolean).sort();
    const start = dates[0] || localDateStr(t);
    const end = dates[dates.length - 1] || localDateStr(t);
    return {
      id,
      label: '全部',
      start,
      end,
      pretty: `${start} – ${end}`,
      prev: null
    };
  }
}

function inRange(d, p) { return d >= p.start && d <= p.end; }

function filterByPeriod(rows, period) {
  return rows.filter(r => inRange(r.usageDate, period));
}

function sumField(rows, f) {
  let s = 0; for (const r of rows) s += r[f] || 0; return s;
}

// Aggregate by a key
function aggregateBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!k) continue;
    if (!m.has(k)) m.set(k, {
      key: k, totalTokens: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, reasoningOutputTokens: 0,
      costUSD: 0, days: new Set(), sources: new Set(), models: new Set()
    });
    const a = m.get(k);
    a.totalTokens += r.totalTokens;
    a.inputTokens += r.inputTokens;
    a.outputTokens += r.outputTokens;
    a.cacheReadTokens += r.cacheReadTokens;
    a.cacheCreationTokens += r.cacheCreationTokens;
    a.reasoningOutputTokens += r.reasoningOutputTokens;
    a.costUSD += r.costUSD;
    a.days.add(r.usageDate);
    a.sources.add(r.source);
    a.models.add(r.model);
  }
  return Array.from(m.values()).map(v => ({
    ...v,
    dayCount: v.days.size,
    cacheHitRate: v.totalTokens ? (v.cacheReadTokens / v.totalTokens) * 100 : 0
  }));
}

// Top model used per project / source — pick model with biggest contribution
function topModelFor(rows, filterFn) {
  const m = new Map();
  for (const r of rows) {
    if (!filterFn(r)) continue;
    m.set(r.model, (m.get(r.model) || 0) + r.totalTokens);
  }
  let topName = '—', topVal = -1;
  for (const [k, v] of m) if (v > topVal) { topName = k; topVal = v; }
  return topName;
}

function dailyTotals(rows, period) {
  // build sorted array of {date, total, cost, byTool}
  const ps = parseDateStr(period.start);
  const pe = parseDateStr(period.end);
  const start = new Date(ps.y, ps.m, ps.d);
  const end = new Date(pe.y, pe.m, pe.d);
  const days = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = localDateStr(d);
    days.push({ date: ds, total: 0, cost: 0, byTool: {} });
  }
  const idx = new Map(days.map((d, i) => [d.date, i]));
  for (const r of rows) {
    const i = idx.get(r.usageDate);
    if (i == null) continue;
    days[i].total += r.totalTokens;
    days[i].cost  += r.costUSD;
    days[i].byTool[r.source] = (days[i].byTool[r.source] || 0) + r.totalTokens;
  }
  return days;
}

// Auto-generate narrative for the project section
function narrativeForProjects(projAgg, totalTokens, daily) {
  if (!projAgg.length) return null;
  const top = projAgg[0];
  const share = ((top.totalTokens / (totalTokens || 1)) * 100);
  const topModel = topModelFor(daily, r => r.projectPath === top.key);
  const cacheRate = top.cacheHitRate.toFixed(0);
  return { top, share, topModel, cacheRate };
}

// Find peaks (top N days)
function findPeaks(days, n = 3) {
  return [...days].filter(d => d.total > 0).sort((a, b) => b.total - a.total).slice(0, n);
}

// Generate insights
function buildInsights(daily, period, prevDaily) {
  const insights = [];
  const totals = {
    total: sumField(daily, 'totalTokens'),
    cost:  sumField(daily, 'costUSD'),
    cache: sumField(daily, 'cacheReadTokens'),
    avgDaily: 0
  };
  const days = dailyTotals(daily, period);
  const nonZero = days.filter(d => d.total > 0);
  const avg = nonZero.length ? totals.total / nonZero.length : 0;
  totals.avgDaily = avg;

  // 1. Spike day
  const peak = nonZero.sort((a, b) => b.total - a.total)[0];
  if (peak && avg > 0 && peak.total > avg * 2.2) {
    const ratio = (peak.total / avg).toFixed(1);
    const topTool = Object.entries(peak.byTool).sort((a, b) => b[1] - a[1])[0];
    insights.push({
      kind: 'red',
      emoji: '⚡',
      headline: `${peak.date.slice(5)} 单日消耗是平均的 ${ratio} 倍`,
      detail: [
        { k: '当日总量', v: U.compactCN(peak.total) },
        { k: '日均',     v: U.compactCN(avg) },
        { k: '主因',     v: topTool ? topTool[0] : '—' }
      ],
      narrative: `当天 ${topTool ? topTool[0] : '主要工具'} 贡献了 ${topTool ? ((topTool[1] / peak.total) * 100).toFixed(0) : 0}% 的用量，可能与大规模重构或新任务启动相关。`
    });
  }

  // 2. Tool cost efficiency
  const byTool = aggregateBy(daily, 'source').sort((a, b) => b.costUSD - a.costUSD);
  if (byTool.length >= 2 && byTool[0].costUSD > 0 && byTool[1].costUSD > 0) {
    const a = byTool[0], b = byTool[1];
    const aCostPerM = a.totalTokens ? (a.costUSD / a.totalTokens) * 1e6 : 0;
    const bCostPerM = b.totalTokens ? (b.costUSD / b.totalTokens) * 1e6 : 0;
    if (aCostPerM > bCostPerM * 1.6) {
      const ratio = (aCostPerM / bCostPerM).toFixed(1);
      insights.push({
        kind: 'yellow',
        emoji: '💰',
        headline: `${a.key} 单位 token 费用是 ${b.key} 的 ${ratio} 倍`,
        detail: [
          { k: `${a.key} $/百万 tk`, v: U.fmtUS.format(aCostPerM) },
          { k: `${b.key} $/百万 tk`, v: U.fmtUS.format(bCostPerM) },
          { k: '费用差距', v: U.fmtUS.format(a.costUSD - b.costUSD) }
        ],
        narrative: `如果将 ${a.key} 中的部分工作迁移到 ${b.key}，理论上能省下约 ${U.fmtUS.format((a.costUSD - a.totalTokens / 1e6 * bCostPerM))}。但要权衡场景适配。`
      });
    }
  }

  // 3. Cache hit improvement
  if (prevDaily && prevDaily.length) {
    const prevCache = sumField(prevDaily, 'cacheReadTokens');
    const prevTotal = sumField(prevDaily, 'totalTokens');
    const prevRate = prevTotal ? (prevCache / prevTotal) * 100 : 0;
    const currRate = totals.total ? (totals.cache / totals.total) * 100 : 0;
    const diff = currRate - prevRate;
    if (Math.abs(diff) > 2) {
      insights.push({
        kind: diff > 0 ? 'green' : 'yellow',
        emoji: diff > 0 ? '🌱' : '⚠️',
        headline: `Cache 命中率${diff > 0 ? '提升' : '下降'} ${Math.abs(diff).toFixed(1)} 个百分点`,
        detail: [
          { k: '本期', v: `${currRate.toFixed(1)}%` },
          { k: '上期', v: `${prevRate.toFixed(1)}%` },
          { k: '节省 tk',  v: U.compactCN(totals.cache - prevCache) }
        ],
        narrative: diff > 0
          ? `更高的命中率意味着你在同一上下文里反复迭代，工作连续性更好。继续保持。`
          : `命中率下降可能是因为切换项目或重启上下文更频繁，看看能否合并任务批次。`
      });
    }
  }

  // 4. Highest-growth project
  if (prevDaily && prevDaily.length) {
    const currByProj = aggregateBy(daily, 'projectPath');
    const prevByProj = aggregateBy(prevDaily, 'projectPath');
    const prevMap = new Map(prevByProj.map(p => [p.key, p.totalTokens]));
    const ranked = currByProj
      .map(p => {
        const prev = prevMap.get(p.key) || 0;
        const delta = prev ? ((p.totalTokens - prev) / prev) * 100 : null;
        return { ...p, prevTokens: prev, delta };
      })
      .filter(p => p.delta != null && p.delta > 50 && p.totalTokens > 100000)
      .sort((a, b) => b.delta - a.delta);

    if (ranked.length) {
      const top = ranked[0];
      insights.push({
        kind: 'blue',
        emoji: '🚀',
        headline: `${top.key} 用量上升 ${top.delta.toFixed(0)}%，是你最近的主战场`,
        detail: [
          { k: '本期', v: U.compactCN(top.totalTokens) },
          { k: '上期', v: U.compactCN(top.prevTokens) },
          { k: '增幅', v: `+${top.delta.toFixed(0)}%` }
        ],
        narrative: `该项目本期消耗集中在 ${top.dayCount} 个活跃天，平均每天 ${U.compactCN(Math.round(top.totalTokens / Math.max(1, top.dayCount)))} tokens。`
      });
    }
  }

  return insights.slice(0, 4);
}

// Heat color scale (warm)
function heatColor(t) {
  if (t < 0.02) return 'oklch(0.94 0.005 80)';
  const lightness = 0.90 - t * 0.50;
  const chroma = 0.02 + t * 0.18;
  return `oklch(${lightness} ${chroma} 265)`;
}

// build month grid (return array of weeks with day cells)
function buildMonthGrid(year, month, dayMap) {
  // month is 0-indexed
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startCol = firstDay.getDay(); // 0=Sun
  const totalDays = lastDay.getDate();
  const cells = [];
  for (let i = 0; i < startCol; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) {
    const ds = localDateStr(new Date(year, month, d));
    cells.push({ date: ds, day: d, ...(dayMap.get(ds) || { total: 0, cost: 0, byTool: {} }) });
  }
  // pad to multiple of 7
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

// list months that intersect a period (parse via local-date helper, not Date constructor)
function monthsInPeriod(period) {
  const a = parseDateStr(period.start);
  const b = parseDateStr(period.end);
  const months = [];
  let y = a.y, m = a.m;
  while (y < b.y || (y === b.y && m <= b.m)) {
    months.push({ year: y, month: m });
    m++; if (m > 11) { m = 0; y++; }
  }
  return months;
}

export const RU = {
  PERIOD_LABELS, getPeriod, filterByPeriod, sumField,
  aggregateBy, topModelFor, dailyTotals, narrativeForProjects, findPeaks,
  buildInsights, heatColor, buildMonthGrid, monthsInPeriod,
  localDateStr, parseDateStr
};
