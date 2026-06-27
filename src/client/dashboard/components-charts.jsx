/* =============================================================
   Charts — Trend, Donut, TopModels, Heatmap, Gauge, Stat
   ============================================================= */

import { Fragment, useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts';
import { U } from '../shared/utils.js';
import { EChart } from '../shared/echart.jsx';
import { Delta } from './components-top.jsx';

// ───────────────────────────────────────────────────────────────
// Trend chart — switchable bar/line/stacked + optional comparison
// ───────────────────────────────────────────────────────────────
const TREND_MODES = [
  { id: 'stacked', label: '堆叠' },
  { id: 'line',    label: '折线' },
  { id: 'bar',     label: '柱状' }
];

function TrendChart({ rows, dates, sources, compareRows, compareDates, mode, onModeChange, totals, prevTotals, onExport, density }) {
  // build series
  const byKey = useMemo(() => {
    const m = new Map();
    for (const r of rows) m.set(`${r.usageDate}::${r.source}`, (m.get(`${r.usageDate}::${r.source}`) || 0) + r.totalTokens);
    return m;
  }, [rows]);

  const compareByDate = useMemo(() => {
    if (!compareRows) return null;
    const m = new Map();
    for (const r of compareRows) m.set(r.usageDate, (m.get(r.usageDate) || 0) + r.totalTokens);
    return m;
  }, [compareRows]);

  const totalByDate = dates.map(d =>
    sources.reduce((s, src) => s + (byKey.get(`${d}::${src}`) || 0), 0)
  );

  const compareSeries = compareByDate
    ? compareDates.map(d => compareByDate.get(d) || 0)
    : null;

  const topSourceByDate = useMemo(() => {
    const top = new Map();
    for (const d of dates) {
      for (let i = sources.length - 1; i >= 0; i -= 1) {
        const src = sources[i];
        if ((byKey.get(`${d}::${src}`) || 0) > 0) {
          top.set(d, src);
          break;
        }
      }
    }
    return top;
  }, [byKey, dates, sources]);

  // Trend rolling-avg (7-day) for line mode
  const rolling = (() => {
    const arr = [];
    const win = Math.min(7, Math.max(2, Math.floor(dates.length / 8)));
    for (let i = 0; i < totalByDate.length; i++) {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - win + 1); j <= i; j++) { sum += totalByDate[j]; count++; }
      arr.push(count ? sum / count : 0);
    }
    return arr;
  })();

  // Build the series based on mode
  const series = [];
  const palette = sources.map(s => U.getSourceColor(s));
  const stableBarState = {
    emphasis: { focus: 'none', itemStyle: { opacity: 1 } },
    blur: { itemStyle: { opacity: 1 } },
    select: { itemStyle: { opacity: 1 } }
  };
  // NOTE: do NOT put `areaStyle` in any state object. The base areaStyle uses a
  // linear-gradient color; including areaStyle in emphasis/blur/select makes ECharts
  // animate the gradient on hover, which crashes its color interpolator
  // ("Cannot read properties of undefined (reading 'length')") and freezes the chart.
  const stableLineState = (width = 2) => ({
    emphasis: { focus: 'none', lineStyle: { width, opacity: 1 }, itemStyle: { opacity: 1 } },
    blur: { lineStyle: { opacity: 1 }, itemStyle: { opacity: 1 } },
    select: { lineStyle: { opacity: 1 }, itemStyle: { opacity: 1 } }
  });

  if (mode === 'stacked' || mode === 'bar') {
    sources.forEach((src, i) => {
      series.push({
        name: src,
        type: 'bar',
        stack: mode === 'stacked' ? 'total' : undefined,
        barMaxWidth: 24,
        itemStyle: { color: palette[i] },
        ...stableBarState,
        data: dates.map(d => {
          const value = byKey.get(`${d}::${src}`) || 0;
          if (mode === 'bar') return { value, itemStyle: { borderRadius: [3, 3, 0, 0] } };
          return {
            value,
            itemStyle: {
              borderRadius: value > 0 && topSourceByDate.get(d) === src ? [4, 4, 0, 0] : 0
            }
          };
        })
      });
    });
  } else if (mode === 'line') {
    sources.forEach((src, i) => {
      series.push({
        name: src,
        type: 'line',
        smooth: 0.3,
        symbol: 'circle',
        symbolSize: 4,
        showSymbol: false,
        lineStyle: { width: 2, color: palette[i] },
        itemStyle: { color: palette[i] },
        areaStyle: {
          opacity: 0.08,
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: palette[i] },
              { offset: 1, color: 'transparent' }
            ]
          }
        },
        // Emphasis is disabled here: hovering an area-filled line would make ECharts
        // animate its gradient areaStyle, crashing the color interpolator and freezing
        // the whole chart. Tooltip + axisPointer still work without emphasis.
        emphasis: { disabled: true },
        data: dates.map(d => byKey.get(`${d}::${src}`) || 0)
      });
    });
  }

  // Compare overlay (dashed total of previous period)
  if (compareSeries) {
    series.push({
      name: '上一周期',
      type: 'line',
      smooth: 0.3,
      symbol: 'none',
      lineStyle: { width: 1.6, color: 'oklch(0.55 0.005 80)', type: 'dashed' },
      itemStyle: { color: 'oklch(0.55 0.005 80)' },
      ...stableLineState(1.6),
      data: dates.map((_, i) => compareSeries[i] || 0),
      z: 5
    });
  }

  // 7-day rolling baseline (subtle)
  if (mode !== 'line' && dates.length > 10) {
    series.push({
      name: '7 日均线',
      type: 'line',
      smooth: 0.5,
      symbol: 'none',
      lineStyle: { width: 1.6, color: 'oklch(0.45 0.04 265)', type: [4, 4] },
      itemStyle: { color: 'oklch(0.45 0.04 265)' },
      ...stableLineState(1.6),
      data: rolling,
      z: 4
    });
  }

  const option = {
    backgroundColor: 'transparent',
    animation: true,
    animationDuration: 400,
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'line',
        lineStyle: { color: 'oklch(0.62 0.04 265 / 0.45)', width: 1, type: [3, 3] }
      },
      backgroundColor: '#ffffff',
      borderColor: 'oklch(0.92 0.004 80)',
      borderWidth: 1,
      padding: [10, 12],
      textStyle: { color: 'oklch(0.18 0.005 80)', fontSize: 12 },
      extraCssText: 'box-shadow: 0 8px 24px rgba(15,23,42,0.10); border-radius: 10px;',
      formatter(params) {
        const date = params[0]?.axisValue || '';
        let total = 0;
        for (const p of params) if (sources.includes(p.seriesName)) total += p.value || 0;
        let html = `<div style="font-weight:600;margin-bottom:6px;color:oklch(0.40 0.005 80);font-size:11.5px;letter-spacing:.04em">${date}</div>`;
        html += `<div style="font-size:16px;font-weight:600;margin-bottom:8px">${U.compactCN(total)} <span style="font-size:11px;color:oklch(0.55 0.005 80);font-weight:500"> tokens</span></div>`;
        for (const p of params) {
          html += `<div style="display:flex;align-items:center;gap:8px;margin-top:3px;font-size:12px">
            <span style="width:8px;height:8px;border-radius:2px;background:${p.color};display:inline-block"></span>
            <span style="color:oklch(0.45 0.005 80);flex:1">${p.seriesName}</span>
            <span style="font-weight:600;margin-left:18px;font-variant-numeric:tabular-nums">${U.compactCN(p.value || 0)}</span>
          </div>`;
        }
        return html;
      }
    },
    legend: { show: false },
    grid: { left: 8, right: 12, top: 16, bottom: density === 'compact' ? 26 : 40, containLabel: true },
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: mode !== 'line',
      axisLine: { lineStyle: { color: 'oklch(0.92 0.004 80)' } },
      axisTick: { show: false },
      axisLabel: {
        color: 'oklch(0.55 0.005 80)',
        fontSize: 10.5,
        hideOverlap: true,
        formatter: v => v.slice(5)
      }
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        color: 'oklch(0.62 0.004 80)',
        fontSize: 10.5,
        formatter: v => U.compact(v)
      },
      splitLine: { lineStyle: { color: 'oklch(0.95 0.004 80)' } },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    dataZoom: dates.length > 20 ? [
      { type: 'inside', start: 0, end: 100, zoomLock: false },
      {
        type: 'slider',
        height: 18,
        bottom: 4,
        borderColor: 'transparent',
        backgroundColor: 'oklch(0.97 0.004 80)',
        fillerColor: 'oklch(0.92 0.02 265 / 0.5)',
        handleStyle: { color: '#fff', borderColor: 'oklch(0.55 0.16 265)' },
        moveHandleSize: 4,
        textStyle: { color: 'oklch(0.55 0.005 80)', fontSize: 10 }
      }
    ] : [],
    series
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">每日 Token 使用趋势</h2>
          <p className="panel-sub">
            {totals?.totalTokens != null && (
              <>当前周期 <b style={{color:'var(--text)', fontWeight:600}}>{U.compactCN(totals.totalTokens)}</b> tokens · {dates.length} 天</>
            )}
          </p>
        </div>
        <div className="panel-actions">
          <div className="panel-tabs">
            {TREND_MODES.map(m => (
              <button key={m.id} className={`tab ${mode === m.id ? 'active' : ''}`} onClick={() => onModeChange(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <button className="btn btn-icon" onClick={onExport} title="导出 CSV">
            <svg className="icon" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
      <EChart option={option} height={320}/>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Donut chart — source share
// ───────────────────────────────────────────────────────────────
function SourceDonut({ rows, sources, total, onFocusSource, focused }) {
  const data = sources.map(src => {
    let v = 0;
    for (const r of rows) if (r.source === src) v += r.totalTokens;
    return { name: src, value: v, color: U.getSourceColor(src) };
  }).sort((a, b) => b.value - a.value);

  const sum = data.reduce((s, d) => s + d.value, 0);

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      appendToBody: true,
      confine: true,
      transitionDuration: 0,
      backgroundColor: '#fff',
      borderColor: 'oklch(0.92 0.004 80)',
      borderWidth: 1,
      textStyle: { color: 'oklch(0.18 0.005 80)', fontSize: 12 },
      extraCssText: 'pointer-events:none;box-shadow:0 8px 24px rgb(0 0 0 / 0.08);border-radius:8px;',
      formatter: p => `<div style="font-weight:600;margin-bottom:4px">${p.name}</div>
        <div style="font-size:14px;font-weight:600">${U.compactCN(p.value)} tokens</div>
        <div style="font-size:11px;color:oklch(0.55 0.005 80)">${(p.percent || 0).toFixed(1)}%</div>`
    },
    series: [{
      type: 'pie',
      animationDurationUpdate: 220,
      animationEasingUpdate: 'cubicOut',
      stateAnimation: {
        duration: 140,
        easing: 'cubicOut'
      },
      radius: ['48%', '78%'],
      center: ['50%', '50%'],
      minAngle: 2,
      avoidLabelOverlap: true,
      label: { show: false },
      labelLine: { show: false },
      itemStyle: {
        borderRadius: 8,
        borderColor: '#fff',
        borderWidth: 2,
        shadowBlur: 12,
        shadowOffsetY: 3,
        shadowColor: 'rgba(15, 23, 42, 0.16)'
      },
      emphasis: {
        scale: true,
        scaleSize: 3,
        itemStyle: {
          shadowBlur: 12,
          shadowOffsetY: 3,
          shadowColor: 'rgba(15, 23, 42, 0.16)'
        }
      },
      blur: {
        itemStyle: { opacity: 1 }
      },
      data: data.map(d => ({
        name: d.name,
        value: d.value,
        itemStyle: { color: d.color, opacity: focused && focused !== d.name ? 0.25 : 1 },
        emphasis: {
          itemStyle: {
            color: d.color,
            opacity: 1,
            borderColor: '#fff',
            borderWidth: 2,
            shadowBlur: 12,
            shadowOffsetY: 3,
            shadowColor: 'rgba(15, 23, 42, 0.16)'
          }
        }
      }))
    }]
  };

  return (
    <div className="panel source-donut-panel">
      <div className="panel-header source-donut-header">
        <div>
          <h2 className="panel-title">来源占比</h2>
        </div>
        <p className="panel-sub source-donut-note">点击图例聚焦 · 顶部 1 项贡献 {data[0] && sum ? ((data[0].value / sum) * 100).toFixed(0) : 0}%</p>
      </div>
      <div className="donut-stack">
        <div className="donut-stage">
          <EChart option={option} height={236}/>
          <div style={{
            position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
            pointerEvents: 'none', textAlign: 'center'
          }}>
            <div>
              <div style={{fontSize: 10.5, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase'}}>合计</div>
              <div style={{fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 2}}>
                {U.compactCN(sum)}
              </div>
            </div>
          </div>
        </div>
        <div className="legend">
          {data.map(d => (
            <div key={d.name}
              className={`legend-item ${focused && focused !== d.name ? 'dim' : ''}`}
              onClick={() => onFocusSource(focused === d.name ? null : d.name)}>
              <span className="legend-swatch" style={{background: d.color}}/>
              <span className="legend-name" title={d.name}>{d.name}</span>
              <span className="legend-val">{U.compactCN(d.value)}</span>
              <span className="legend-pct">{sum ? ((d.value / sum) * 100).toFixed(1) : 0}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Top Models bar chart (HTML)
// ───────────────────────────────────────────────────────────────
function TopModels({ rows, onDrillModel }) {
  const byModel = new Map();
  for (const r of rows) {
    if (!r.model) continue;
    const k = r.model;
    if (!byModel.has(k)) byModel.set(k, { model: k, source: r.source, total: 0, cost: 0, count: 0 });
    const m = byModel.get(k);
    m.total += r.totalTokens;
    m.cost  += r.costUSD;
    m.count += 1;
  }
  const list = Array.from(byModel.values()).sort((a, b) => b.total - a.total).slice(0, 8);
  const max = list[0]?.total || 1;

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">Top 模型</h2>
          <p className="panel-sub">按总 Token 排序 · {list.length} 个</p>
        </div>
        <span style={{fontSize: 11, color: 'var(--muted)'}}>Tokens · 费用</span>
      </div>
      <div className="bars">
        {list.length === 0 && <div className="empty">当前筛选下无数据</div>}
        {list.map(m => (
          <div key={m.model} className="bar-row" onClick={() => onDrillModel?.(m)}>
            <div className="bar-label">
              <div className="model">{m.model}</div>
              <div className="meta">
                <span className="tag">
                  <span className="tag-dot" style={{background: U.getSourceColor(m.source)}}/>
                  {m.source}
                </span>
                <span>{m.count} 条记录</span>
              </div>
              <div className="bar-track">
                <div className="bar-fill"
                  style={{
                    width: `${(m.total / max) * 100}%`,
                    background: U.getSourceColor(m.source)
                  }}/>
              </div>
            </div>
            <div className="bar-value">
              {U.compactCN(m.total)}
              <small>{m.cost > 0 ? U.fmtUS.format(m.cost) : '—'}</small>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Heatmap (day × hour, synthetic from hourly pattern)
// ───────────────────────────────────────────────────────────────
function Heatmap({ rows, dates, hourlyPattern }) {
  // For each date compute total, distribute across hours
  const byDate = new Map();
  for (const r of rows) byDate.set(r.usageDate, (byDate.get(r.usageDate) || 0) + r.totalTokens);

  // Build a matrix: [date][hour]
  const matrix = dates.map(d => {
    const total = byDate.get(d) || 0;
    return hourlyPattern.map(h => Math.round(total * h));
  });

  const flat = matrix.flat();
  const max = Math.max(...flat, 1);

  const heatColor = (v) => {
    const t = Math.pow(v / max, 0.6);
    if (t < 0.02) return 'oklch(0.97 0.003 80)';
    const lightness = 0.94 - t * 0.50;
    const chroma = 0.02 + t * 0.16;
    return `oklch(${lightness} ${chroma} 265)`;
  };

  // Limit dates to fit nicely (28 days max for readability)
  const showDates = dates.slice(-28);
  const showMatrix = matrix.slice(-28);

  const HOURS_LABELS = ['0', '', '', '', '4', '', '', '', '8', '', '', '', '12', '', '', '', '16', '', '', '', '20', '', '', ''];

  const rowCount = showDates.length;
  const cellH = 18;
  const gap = 2;

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">使用热力图</h2>
          <p className="panel-sub">最近 {showDates.length} 天 × 24 小时分布 · 个人活跃时段</p>
        </div>
        <span className="heat-scale">
          少
          <span className="heat-scale-bar">
            {Array.from({length: 8}, (_, i) => (
              <span key={i} style={{background: heatColor((i / 7) * max)}}/>
            ))}
          </span>
          多
        </span>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: `52px repeat(24, 1fr)`,
        gridTemplateRows: `18px repeat(${rowCount}, ${cellH}px)`,
        columnGap: gap, rowGap: gap,
        alignItems: 'center'
      }}>
        <div/>
        {HOURS_LABELS.map((h, i) => (
          <div key={`h-${i}`} className="heat-col-label" style={{gridRow: 1, gridColumn: i + 2}}>{h}</div>
        ))}

        {showDates.map((d, di) => (
          <Fragment key={d}>
            <div className="heat-row-label" style={{gridRow: di + 2, gridColumn: 1}}>
              {di % 3 === 0 || di === showDates.length - 1 ? d.slice(5) : ''}
            </div>
            {showMatrix[di].map((v, hi) => (
              <div key={`${di}-${hi}`} className="heat-cell"
                style={{
                  gridRow: di + 2, gridColumn: hi + 2,
                  background: heatColor(v),
                  height: cellH
                }}
                title={`${showDates[di]} ${String(hi).padStart(2,'0')}:00 · ${U.compactCN(v)} tokens`}/>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Gauge / arc — cache hit rate
// ───────────────────────────────────────────────────────────────
function Gauge({ rate, cacheRead, cacheCreation, total, prevRate }) {
  const r = Math.max(0, Math.min(100, rate));
  const C = Math.PI * 70;
  const dash = (r / 100) * C;

  return (
    <div className="panel">
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
        <div className="gauge-meta">
          <span>读取 <b>{U.compactCN(cacheRead)}</b></span>
          <span>创建 <b>{U.compactCN(cacheCreation)}</b></span>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Growth stats panel — WoW / DoD
// ───────────────────────────────────────────────────────────────
function GrowthPanel({ totalsByDay }) {
  const days = Array.from(totalsByDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const values = days.map(d => d[1]);
  const n = values.length;

  const today    = values[n - 1] || 0;
  const yest     = values[n - 2] || 0;
  const dod = U.deltaPct(today, yest);

  // last 7 vs prev 7
  const last7 = values.slice(-7).reduce((s, v) => s + v, 0);
  const prev7 = values.slice(-14, -7).reduce((s, v) => s + v, 0);
  const wow = U.deltaPct(last7, prev7);

  // last 30 vs prev 30
  const last30 = values.slice(-30).reduce((s, v) => s + v, 0);
  const prev30 = values.slice(-60, -30).reduce((s, v) => s + v, 0);
  const mom = U.deltaPct(last30, prev30);

  // best day
  let bestIdx = 0;
  values.forEach((v, i) => { if (v > values[bestIdx]) bestIdx = i; });
  const bestDate = days[bestIdx]?.[0];
  const bestVal  = values[bestIdx];

  // average daily
  const avg = n ? Math.round(values.reduce((s, v) => s + v, 0) / n) : 0;

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">环比与趋势</h2>
          <p className="panel-sub">基于当前筛选周期</p>
        </div>
      </div>
      <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
        <GrowthStat label="日环比 DoD" value={dod} sub={`今日 ${U.compactCN(today)}`}/>
        <GrowthStat label="周环比 WoW" value={wow} sub={`7 日 ${U.compactCN(last7)}`}/>
        <GrowthStat label="月环比 MoM" value={mom} sub={`30 日 ${U.compactCN(last30)}`}/>
        <GrowthStat label="日均"       value={null} sub={U.compactCN(avg)} subUnit="tokens / day"/>
      </div>
      <div style={{marginTop: 14, padding: '10px 12px', background: 'var(--surface-2)',
        borderRadius: 8, fontSize: 12, color: 'var(--text-2)',
        display: 'flex', alignItems: 'center', gap: 8}}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{color: 'var(--c-amber)'}}>
          <path d="M7 1.5l1.6 3.3 3.6.5-2.6 2.5.6 3.6L7 9.7l-3.2 1.7.6-3.6L1.8 5.3l3.6-.5L7 1.5z" fill="currentColor" opacity="0.85"/>
        </svg>
        <span>峰值 <b style={{fontWeight:600}}>{bestDate}</b> · {U.compactCN(bestVal)} tokens</span>
      </div>
    </div>
  );
}

function GrowthStat({ label, value, sub, subUnit }) {
  return (
    <div style={{
      padding: '10px 12px',
      background: 'var(--surface-2)',
      border: '1px solid var(--border-2)',
      borderRadius: 9,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      whiteSpace: 'nowrap'
    }}>
      <div style={{minWidth: 0, overflow: 'hidden'}}>
        <div style={{fontSize: 10.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap'}}>{label}</div>
        <div style={{fontSize: 11, color: 'var(--muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
          {value != null ? sub : (subUnit || '')}
        </div>
      </div>
      <div style={{
        fontSize: value != null ? 18 : 17, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
        color: value == null ? 'var(--text)' : (value > 0 ? 'var(--good)' : value < 0 ? 'var(--bad)' : 'var(--text)'),
        whiteSpace: 'nowrap', flexShrink: 0
      }}>
        {value != null ? (value > 0 ? '+' : '') + value.toFixed(1) + '%' : sub}
      </div>
    </div>
  );
}

export { TrendChart, SourceDonut, TopModels, Heatmap, Gauge, GrowthPanel };
