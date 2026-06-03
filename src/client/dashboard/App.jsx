/* =============================================================
   Main App — real data from /api/data
   ============================================================= */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { U } from '../shared/utils.js';
import { Topbar, FilterBar, KPI } from './components-top.jsx';
import { TrendChart, SourceDonut, TopModels, Gauge, GrowthPanel, Heatmap } from './components-charts.jsx';
import { TablePanel, DrillDrawer } from './components-tables.jsx';
import './styles.css';

function summarizeCollectOutput(stdout) {
  return stdout
    ? stdout.split('\n').filter(Boolean).slice(-5).join(' · ')
    : '采集完成';
}

export function App() {
  const [M, setM] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [collectStatus, setCollectStatus] = useState(null);

  // ───── Load data from API ─────
  const loadData = useCallback(() => {
    setRefreshing(true);
    fetch('/api/data')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        // Assign colors to sources dynamically
        const sourceNames = [...new Set(data.daily.map(r => r.source))];
        const SOURCES = sourceNames.map((name, i) => ({
          name,
          color: U.getSourceColor(name)
        }));

        // Standard hourly pattern (normalized)
        const rawHourly = [
          0.005, 0.003, 0.002, 0.001, 0.001, 0.003,
          0.008, 0.025, 0.045, 0.075, 0.092, 0.082,
          0.055, 0.078, 0.092, 0.088, 0.080, 0.060,
          0.045, 0.038, 0.045, 0.040, 0.025, 0.012
        ];
        const hsum = rawHourly.reduce((a, b) => a + b, 0);
        const HOURLY = rawHourly.map(v => v / hsum);

        setM({
          ...data,
          SOURCES,
          HOURLY,
          today: U.daysAgo(0)
        });
        setLoadError(null);
      })
      .catch(err => setLoadError(err.message))
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const syncCollectStatus = useCallback((options = {}) => {
    return fetch('/api/collect/status')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (data.status === 'running') {
          setCollecting(true);
          setCollectStatus({ type: 'running', message: data.message || '正在采集本机用量…' });
        } else if (data.status === 'ok') {
          setCollecting(false);
          setCollectStatus({ type: 'ok', message: summarizeCollectOutput(data.stdout) });
          if (options.refreshOnDone) loadData();
        } else if (data.status === 'error') {
          setCollecting(false);
          setCollectStatus({ type: 'error', message: data.stderr || data.message || '采集失败' });
        } else {
          setCollecting(false);
        }
        return data;
      });
  }, [loadData]);

  const waitForCollectDone = useCallback(async () => {
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const data = await syncCollectStatus({ refreshOnDone: true });
      if (data.status !== 'running') return data;
    }
  }, [syncCollectStatus]);

  useEffect(() => {
    let cancelled = false;
    syncCollectStatus()
      .then(data => {
        if (!cancelled && data.status === 'running') waitForCollectDone();
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [syncCollectStatus, waitForCollectDone]);

  const runCollect = useCallback(() => {
    setCollecting(true);
    setCollectStatus({ type: 'running', message: '正在采集本机用量…' });
    fetch('/api/collect', { method: 'POST' })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok && r.status !== 202) {
          throw new Error(data.error || data.stderr || `HTTP ${r.status}`);
        }
        setCollectStatus({ type: 'running', message: data.message || '正在采集本机用量…' });
        return waitForCollectDone();
      })
      .catch(err => {
        setCollecting(false);
        setCollectStatus({ type: 'error', message: err.message || '采集失败' });
      });
  }, [waitForCollectDone]);

  // ───── Loading / error screens ─────
  if (loadError) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '100vh', gap: 16,
        color: 'var(--text-2)', fontFamily: 'var(--font)'
      }}>
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="20" r="18" stroke="oklch(0.65 0.16 25)" strokeWidth="2"/>
          <path d="M20 12v10M20 28v2" stroke="oklch(0.65 0.16 25)" strokeWidth="2.5" strokeLinecap="round"/>
        </svg>
        <p style={{fontSize: 15, margin: 0}}>加载失败：{loadError}</p>
        <button className="btn btn-primary" onClick={loadData}>重试</button>
      </div>
    );
  }

  if (!M) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '100vh', gap: 14,
        color: 'var(--text-2)', fontFamily: 'var(--font)'
      }}>
        <svg className="spin" width="32" height="32" viewBox="0 0 32 32" fill="none">
          <circle cx="16" cy="16" r="13" stroke="var(--c-indigo)" strokeWidth="2.5"
            strokeDasharray="60" strokeDashoffset="20" strokeLinecap="round"/>
        </svg>
        <p style={{fontSize: 14, margin: 0}}>正在加载数据…</p>
      </div>
    );
  }

  return (
    <Dashboard
      M={M}
      refreshing={refreshing}
      collecting={collecting}
      collectStatus={collectStatus}
      onRefresh={loadData}
      onCollect={runCollect} />
  );
}

/* =============================================================
   Dashboard (extracted so App stays clean)
   ============================================================= */
function Dashboard({ M, refreshing, collecting, collectStatus, onRefresh, onCollect }) {
  // ───── Filter state ─────
  const [filters, setFilters] = useState(() => ({
    rangeId: '30d',
    startDate: U.daysAgo(29),
    endDate: U.daysAgo(0),
    sources: new Set(),
    devices: new Set(),
    models: new Set(),
    compare: true
  }));

  const [trendMode, setTrendMode] = useState('stacked');
  const [drill, setDrill] = useState(null);
  const [focusedSource, setFocusedSource] = useState(null);

  // Build option lists
  const allSources = useMemo(() => Array.from(new Set(M.daily.map(r => r.source))), [M.daily]);
  const allDevices = useMemo(() => Array.from(new Set(M.daily.map(r => r.device))), [M.daily]);
  const allModels  = useMemo(() => Array.from(new Set(M.daily.map(r => r.model))).filter(Boolean), [M.daily]);
  const availableRange = useMemo(() => {
    const dates = M.daily.map(r => r.usageDate).filter(Boolean).sort();
    return {
      startDate: dates[0] || U.daysAgo(0),
      endDate: dates[dates.length - 1] || U.daysAgo(0)
    };
  }, [M.daily]);

  // ───── Filtered data ─────
  const filtered = useMemo(() => {
    const effective = { ...filters };
    if (focusedSource) effective.sources = new Set([focusedSource]);
    return U.filterDaily(M.daily, effective);
  }, [filters, focusedSource, M.daily]);

  const totals = useMemo(() => U.aggregateTotals(filtered), [filtered]);

  const dates = useMemo(() => U.rangeDates(filters.startDate, filters.endDate), [filters.startDate, filters.endDate]);
  const presentSources = useMemo(() => {
    const set = filters.sources.size ? filters.sources : new Set(allSources);
    return Array.from(set);
  }, [filters.sources, allSources]);

  // ───── Comparison period ─────
  const compareData = useMemo(() => {
    if (!filters.compare) return { rows: null, dates: null, totals: null };
    const days = dates.length;
    const endStr = U.addDays(filters.startDate, -1);
    const startStr = U.addDays(endStr, -(days - 1));
    const rows  = U.filterDaily(M.daily, { ...filters, startDate: startStr, endDate: endStr });
    const cDates = U.rangeDates(startStr, endStr);
    return { rows, dates: cDates, totals: U.aggregateTotals(rows) };
  }, [filters, dates.length, M.daily]);

  // ───── Sparklines ─────
  const dailyTotalsByDay = useMemo(() => {
    const m = new Map();
    for (const r of filtered) m.set(r.usageDate, (m.get(r.usageDate) || 0) + r.totalTokens);
    return m;
  }, [filtered]);

  const sparkValues = useMemo(() => dates.map(d => dailyTotalsByDay.get(d) || 0), [dates, dailyTotalsByDay]);

  const sparkBy = useMemo(() => (key) => {
    const m = new Map();
    for (const r of filtered) m.set(r.usageDate, (m.get(r.usageDate) || 0) + (r[key] || 0));
    return dates.map(d => m.get(d) || 0);
  }, [filtered, dates]);

  // ───── Sessions filtered ─────
  const filteredSessions = useMemo(() => {
    return M.sessions.filter(s =>
      (filters.sources.size === 0 || filters.sources.has(s.source)) &&
      (filters.devices.size === 0 || filters.devices.has(s.device))
    ).sort((a, b) => b.totalTokens - a.totalTokens);
  }, [filters.sources, filters.devices, M.sessions]);

  const filteredRuns = useMemo(() => {
    return M.runs.filter(r =>
      (filters.sources.size === 0 || filters.sources.has(r.source)) &&
      (filters.devices.size === 0 || filters.devices.has(r.device))
    );
  }, [filters.sources, filters.devices, M.runs]);

  // ───── Export ─────
  const onExportAll = () => {
    U.downloadCSV(`tokens-daily-${filters.startDate}-${filters.endDate}.csv`, filtered, [
      { title: 'date',             field: 'usageDate' },
      { title: 'source',           field: 'source' },
      { title: 'device',           field: 'device' },
      { title: 'model',            field: 'model' },
      { title: 'input',            field: 'inputTokens' },
      { title: 'output',           field: 'outputTokens' },
      { title: 'cache_read',       field: 'cacheReadTokens' },
      { title: 'cache_creation',   field: 'cacheCreationTokens' },
      { title: 'reasoning',        field: 'reasoningOutputTokens' },
      { title: 'total',            field: 'totalTokens' },
      { title: 'cost_usd',         field: 'costUSD' }
    ]);
  };

  const onExportTrend = () => {
    const rows = dates.map(d => {
      const r = { date: d };
      for (const s of presentSources) {
        let v = 0;
        for (const x of filtered) if (x.usageDate === d && x.source === s) v += x.totalTokens;
        r[s] = v;
      }
      return r;
    });
    U.downloadCSV(`trend-${filters.startDate}-${filters.endDate}.csv`,
      rows,
      [{ title: 'date', field: 'date' }, ...presentSources.map(s => ({ title: s, field: s }))]
    );
  };

  const lastSync = M.runs[0] ? U.formatTs(M.runs[0].collectedAt.replace(' ', 'T')) : '—';

  return (
    <div className="app">
      <Topbar
        lastSync={lastSync}
        onRefresh={onRefresh}
        refreshing={refreshing}
        onCollect={onCollect}
        collecting={collecting}
        collectStatus={collectStatus} />

      <FilterBar
        f={filters}
        setF={setFilters}
        allSources={allSources}
        allDevices={allDevices}
        allModels={allModels}
        availableRange={availableRange}
        onExport={onExportAll} />

      {focusedSource && (
        <div style={{
          margin: '0 0 12px',
          padding: '10px 14px',
          background: 'oklch(0.97 0.02 265)',
          border: '1px solid oklch(0.85 0.04 265)',
          borderRadius: 10,
          display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 12.5
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 7l3 3 5-6" stroke="var(--c-indigo)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span>聚焦中：<b style={{ color: 'var(--c-indigo)' }}>{focusedSource}</b> · 所有图表已联动</span>
          <button className="btn" style={{ marginLeft: 'auto', height: 24, fontSize: 11.5 }}
            onClick={() => setFocusedSource(null)}>取消聚焦</button>
        </div>
      )}

      {/* KPI row */}
      <div className="kpi-row">
        <KPI label="总 Token" value={U.compactCN(totals.totalTokens)}
          sub="vs 上周期"
          delta={U.deltaPct(totals.totalTokens, compareData.totals?.totalTokens)}
          sparkValues={sparkValues} sparkColor="oklch(0.55 0.16 265)" />
        <KPI label="Input" value={U.compactCN(totals.inputTokens)}
          sub="输入"
          delta={U.deltaPct(totals.inputTokens, compareData.totals?.inputTokens)}
          sparkValues={sparkBy('inputTokens')} sparkColor="oklch(0.62 0.13 240)" />
        <KPI label="Output" value={U.compactCN(totals.outputTokens)}
          sub="生成"
          delta={U.deltaPct(totals.outputTokens, compareData.totals?.outputTokens)}
          sparkValues={sparkBy('outputTokens')} sparkColor="oklch(0.60 0.15 295)" />
        <KPI label="Cache" value={U.compactCN(totals.cacheTokens)}
          sub={`命中 ${totals.cacheHitRate.toFixed(0)}%`}
          delta={U.deltaPct(totals.cacheTokens, compareData.totals?.cacheTokens)}
          sparkValues={sparkBy('cacheReadTokens')} sparkColor="oklch(0.65 0.11 200)" />
        <KPI label="Reasoning" value={U.compactCN(totals.reasoningTokens)}
          sub="推理"
          delta={U.deltaPct(totals.reasoningTokens, compareData.totals?.reasoningTokens)}
          sparkValues={sparkBy('reasoningOutputTokens')} sparkColor="oklch(0.65 0.12 150)" />
        <KPI label="估算费用" value={U.fmtUS.format(totals.costUSD)}
          sub="累计"
          delta={U.deltaPct(totals.costUSD, compareData.totals?.costUSD)}
          sparkValues={sparkBy('costUSD')} sparkColor="oklch(0.72 0.14 75)" />
      </div>

      {/* Charts grid */}
      <div className="grid">
        <div className="col-8">
          <TrendChart
            rows={filtered}
            dates={dates}
            sources={presentSources}
            compareRows={compareData.rows}
            compareDates={compareData.dates}
            mode={trendMode}
            onModeChange={setTrendMode}
            totals={totals}
            onExport={onExportTrend} />
        </div>
        <div className="col-4">
          <SourceDonut
            rows={filtered}
            sources={Array.from(new Set(filtered.map(r => r.source)))}
            total={totals.totalTokens}
            focused={focusedSource}
            onFocusSource={setFocusedSource} />
        </div>

        <div className="col-6">
          <TopModels rows={filtered} onDrillModel={r => setDrill({ kind: 'model', row: r })} />
        </div>
        <div className="col-3" style={{ gridColumn: 'span 3' }}>
          <Gauge
            rate={totals.cacheHitRate}
            cacheRead={totals.cacheReadTokens}
            cacheCreation={totals.cacheCreationTokens}
            total={totals.totalTokens}
            prevRate={compareData.totals?.cacheHitRate} />
        </div>
        <div className="col-3" style={{ gridColumn: 'span 3' }}>
          <GrowthPanel totalsByDay={dailyTotalsByDay} />
        </div>

        <div className="col-12">
          <Heatmap rows={filtered} dates={dates} hourlyPattern={M.HOURLY} />
        </div>

        <div className="col-12">
          <TablePanel
            daily={filtered}
            sessions={filteredSessions}
            runs={filteredRuns}
            sources={presentSources}
            totalTokens={totals.totalTokens}
            onDrill={setDrill} />
        </div>
      </div>

      <DrillDrawer drill={drill} daily={M.daily} onClose={() => setDrill(null)} />
    </div>
  );
}
