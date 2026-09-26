/* =============================================================
   Main App — real data from /api/data
   ============================================================= */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { U } from '../shared/utils.js';
import { fetchTimeRange, projectTotals, timeRangeForFilters } from '../shared/usage-data.js';
import { Topbar, FilterBar, KPI } from './components-top.jsx';
import { TrendChart, SourceDonut, TopModels, Gauge, GrowthPanel, Heatmap } from './components-charts.jsx';
import { TablePanel, DrillDrawer } from './components-tables.jsx';
import './styles.css';

const EMPTY_TIME = [];   // stable reference so memoized selectors don't churn

function summarizeCollectOutput(stdout) {
  return stdout
    ? stdout.split('\n').filter(Boolean).slice(-5).join(' · ')
    : '采集完成';
}

export function App() {
  const [M, setM] = useState(null);
  const [timeState, setTimeState] = useState({ rows: [], key: null, loading: false, error: null });
  const timeRequest = useRef(null);
  const timeLoadedKey = useRef(null);
  const [timeRevision, setTimeRevision] = useState(0);
  const [hourlyRows, setHourlyRows] = useState(null);
  const [hourlyError, setHourlyError] = useState(null);
  const [quota, setQuota] = useState(null);         // live subscription-window quota
  const [loadError, setLoadError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [collectStatus, setCollectStatus] = useState(null);
  const collectionRequest = useRef(null);


  const ensureTime = useCallback((range, { force = false } = {}) => {
    const key = JSON.stringify(range);
    if (!force && (timeLoadedKey.current === key || timeRequest.current?.key === key)) return;
    timeRequest.current?.controller.abort();
    const controller = new AbortController();
    timeRequest.current = { key, controller };
    setTimeState({ rows: [], key, loading: true, error: null });
    fetchTimeRange(range, { signal: controller.signal })
      .then(rows => {
        if (controller.signal.aborted) return;
        timeLoadedKey.current = key;
        setTimeState({ rows, key, loading: false, error: null });
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        timeLoadedKey.current = null;
        setTimeState({ rows: [], key, loading: false, error: error.message });
      })
      .finally(() => { if (timeRequest.current?.controller === controller) timeRequest.current = null; });
  }, []);
  useEffect(() => () => timeRequest.current?.controller.abort(), []);

  // The heatmap uses compact server-side hourly aggregates rather than the
  // full per-event payload used by the precise table view.
  const loadHourly = useCallback(() => {
    setHourlyError(null);
    return fetch('/api/hourly')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => setHourlyRows(data.hourly || []))
      .catch(err => {
        setHourlyRows([]);
        setHourlyError(err.message || '小时数据加载失败');
      });
  }, []);

  // ───── Load data from API ─────
  // ───── Live subscription-window quota (5h / 7d) ─────
  // Refreshed on first load and whenever the user hits the refresh button —
  // no background polling.
  const loadQuota = useCallback(() => {
    fetch('/api/quota')
      .then(r => r.json())
      .then(d => setQuota(d))
      .catch(() => {});
  }, []);

  const loadData = useCallback(() => {
    setRefreshing(true);
    loadQuota();
    loadHourly();
    fetch('/api/data')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        // Assign colors to sources dynamically
        const sourceNames = [...new Set((data.daily || []).map(r => r.source))];
        const SOURCES = sourceNames.map((name, i) => ({
          name,
          color: U.getSourceColor(name)
        }));

        setM({
          ...data,
          daily: data.daily || [],
          SOURCES,
          today: U.daysAgo(0)
        });
        setLoadError(null);
        // If the precise view already pulled time data, refresh it too.
        timeLoadedKey.current = null;
        setTimeRevision(revision => revision + 1);
      })
      .catch(err => setLoadError(err.message))
      .finally(() => setRefreshing(false));
  }, [loadHourly, loadQuota]);

  useEffect(() => { loadData(); }, [loadData]);

  const syncCollectStatus = useCallback((options = {}) => {
    return fetch(`/api/collect/status${options.wait ? '?wait=1' : ''}`, { signal: options.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (options.signal?.aborted) return data;
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

  const waitForCollectDone = useCallback(async (signal) => {
    for (;;) {
      const started = Date.now();
      const data = await syncCollectStatus({ refreshOnDone: true, wait: true, signal });
      if (data.status !== 'running') return data;
      // A still-running old server may ignore ?wait=1 during a frontend update.
      // Keep that compatibility path from issuing a tight polling loop.
      if (Date.now() - started < 500) await new Promise(resolve => setTimeout(resolve, 500));
      signal?.throwIfAborted();
    }
  }, [syncCollectStatus]);

  useEffect(() => {
    const controller = new AbortController();
    collectionRequest.current = controller;
    syncCollectStatus({ signal: controller.signal })
      .then(data => {
        if (!controller.signal.aborted && data.status === 'running') return waitForCollectDone(controller.signal);
      })
      .catch(() => {});
    return () => { controller.abort(); collectionRequest.current?.abort(); };
  }, [syncCollectStatus, waitForCollectDone]);

  const runCollect = useCallback(() => {
    collectionRequest.current?.abort();
    const controller = new AbortController();
    collectionRequest.current = controller;
    setCollecting(true);
    setCollectStatus({ type: 'running', message: '正在采集本机用量…' });
    fetch('/api/collect', { method: 'POST', signal: controller.signal })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok && r.status !== 202) {
          throw new Error(data.error || data.stderr || `HTTP ${r.status}`);
        }
        setCollectStatus({ type: 'running', message: data.message || '正在采集本机用量…' });
        return waitForCollectDone(controller.signal);
      })
      .catch(err => {
        if (controller.signal.aborted) return;
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
      M={{
        ...M,
        time: timeState.rows,
        timeState, timeRevision,
        hourly: hourlyRows || EMPTY_TIME,
        hourlyLoading: hourlyRows === null,
        hourlyError
      }}
      refreshing={refreshing}
      collecting={collecting}
      collectStatus={collectStatus}
      quota={quota}
      onRefresh={loadData}
      onCollect={runCollect}
      onNeedTime={ensureTime} />
  );
}

/* =============================================================
   Dashboard (extracted so App stays clean)
   ============================================================= */
function Dashboard({ M, refreshing, collecting, collectStatus, quota, onRefresh, onCollect, onNeedTime }) {
  // ───── Filter state ─────
  const [filters, setFilters] = useState(() => ({
    rangeId: '30d',
    startDate: U.daysAgo(29),
    endDate: U.daysAgo(0),
    precise: false,
    startDateTime: U.startOfDayLocal(U.daysAgo(29)),
    endDateTime: U.endOfDayLocal(U.daysAgo(0)),
    sources: new Set(),
    devices: new Set(),
    models: new Set(),
    compare: true
  }));

  const [trendMode, setTrendMode] = useState('stacked');
  const [drill, setDrill] = useState(null);
  const [focusedSource, setFocusedSource] = useState(null);

  const preciseRange = useMemo(() => {
    if (!filters.precise) return null;
    try { return timeRangeForFilters(filters); } catch { return null; }
  }, [filters.precise, filters.startDateTime, filters.endDateTime, filters.compare]);
  const preciseKey = preciseRange ? JSON.stringify(preciseRange) : null;
  const preciseReady = filters.precise && preciseKey && M.timeState.key === preciseKey && !M.timeState.loading && !M.timeState.error;
  useEffect(() => {
    if (preciseRange) onNeedTime?.(preciseRange, { force: true });
  }, [preciseKey, M.timeRevision, onNeedTime]);

  // Build option lists
  const filterBaseRows = M.daily;
  const sourceOptions = useMemo(() => U.sourceOptions(filters.precise ? M.time : filterBaseRows, filters,
    filters.precise), [filterBaseRows, filters, M.time]);
  const allSources = useMemo(() => sourceOptions.map(o => o.source), [sourceOptions]);
  const allDevices = useMemo(() => Array.from(new Set(filterBaseRows.map(r => r.device))), [filterBaseRows]);
  const allModels  = useMemo(() => Array.from(new Set(filterBaseRows.map(r => r.model))).filter(Boolean), [filterBaseRows]);
  const availableRange = useMemo(() => {
    const dates = M.daily.map(r => r.usageDate).filter(Boolean).sort();
    const times = [M.eventRange?.start, M.eventRange?.end].filter(Boolean).sort();
    return {
      startDate: dates[0] || U.daysAgo(0),
      endDate: dates[dates.length - 1] || U.daysAgo(0),
      startDateTime: times[0] ? U.toDateTimeLocalValue(new Date(times[0])) : U.startOfDayLocal(dates[0] || U.daysAgo(0)),
      endDateTime: times[times.length - 1] ? U.toDateTimeLocalValue(new Date(times[times.length - 1])) : U.endOfDayLocal(dates[dates.length - 1] || U.daysAgo(0))
    };
  }, [M.daily, M.eventRange]);

  // ───── Filtered data ─────
  const sourceContextRows = useMemo(() => filters.precise
    ? U.filterTime(preciseReady ? M.time : EMPTY_TIME, filters) : U.filterDaily(M.daily, filters), [filters, M.time, M.daily, preciseReady]);
  const filtered = useMemo(() => {
    const effective = { ...filters };
    if (focusedSource) effective.sources = new Set([focusedSource]);
    return filters.precise
      ? U.filterTime(preciseReady ? M.time : EMPTY_TIME, effective)
      : U.filterDaily(M.daily, effective);
  }, [filters, focusedSource, M.daily, M.time, preciseReady]);

  const filteredHourly = useMemo(() => {
    const effective = { ...filters };
    if (focusedSource) effective.sources = new Set([focusedSource]);
    return U.filterDaily(M.hourly, effective);
  }, [filters, focusedSource, M.hourly]);

  const totals = useMemo(() => U.aggregateTotals(filtered), [filtered]);

  const dates = useMemo(() => U.rangeDates(filters.startDate, filters.endDate), [filters.startDate, filters.endDate]);
  const presentSources = useMemo(() => {
    const set = filters.sources.size ? filters.sources : new Set(allSources);
    return Array.from(set);
  }, [filters.sources, allSources]);

  // ───── Comparison period ─────
  const compareData = useMemo(() => {
    if (!filters.compare) return { rows: null, dates: null, totals: null };
    const scoped = { ...filters, ...(focusedSource ? { sources: new Set([focusedSource]) } : {}) };
    if (filters.precise) {
      const startMs = new Date(filters.startDateTime).getTime();
      const endMs = new Date(filters.endDateTime).getTime();
      if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
        return { rows: null, dates: null, totals: null };
      }
      const span = endMs - startMs;
      const prevEnd = new Date(startMs - 60_000);
      const prevStart = new Date(prevEnd.getTime() - span);
      const startDateTime = U.toDateTimeLocalValue(prevStart);
      const endDateTime = U.toDateTimeLocalValue(prevEnd);
      const rows = U.filterTime(preciseReady ? M.time : EMPTY_TIME, { ...scoped, startDateTime, endDateTime });
      return {
        rows,
        dates: U.rangeDates(startDateTime.slice(0, 10), endDateTime.slice(0, 10)),
        totals: U.aggregateTotals(rows)
      };
    }
    const days = dates.length;
    const endStr = U.addDays(filters.startDate, -1);
    const startStr = U.addDays(endStr, -(days - 1));
    const rows  = U.filterDaily(M.daily, { ...scoped, startDate: startStr, endDate: endStr });
    const cDates = U.rangeDates(startStr, endStr);
    return { rows, dates: cDates, totals: U.aggregateTotals(rows) };
  }, [filters, focusedSource, dates.length, M.daily, M.time, preciseReady]);

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

  // Daily cache hit-rate series for the gauge card sparkline
  const hitRateSeries = useMemo(() => {
    const read = new Map(), tot = new Map();
    for (const r of filtered) {
      read.set(r.usageDate, (read.get(r.usageDate) || 0) + (r.cacheReadTokens || 0));
      tot.set(r.usageDate, (tot.get(r.usageDate) || 0) + r.totalTokens);
    }
    // Only days with usage — a zero-usage day is not a 0% hit rate.
    return dates
      .filter(d => (tot.get(d) || 0) > 0)
      .map(d => ((read.get(d) || 0) / tot.get(d)) * 100);
  }, [filtered, dates]);

  const filteredProjectRows = useMemo(() => {
    const effective = { ...filters, ...(focusedSource ? { sources: new Set([focusedSource]) } : {}) };
    return filters.precise ? U.filterTime(preciseReady ? M.time : EMPTY_TIME, effective)
      : U.filterDaily(M.projectDaily || EMPTY_TIME, effective);
  }, [filters, focusedSource, M.projectDaily, M.time, preciseReady]);
  const filteredSessions = useMemo(() => projectTotals(filteredProjectRows), [filteredProjectRows]);

  const filteredRuns = useMemo(() => {
    return M.runs.filter(r =>
      (filters.sources.size === 0 || filters.sources.has(r.source)) &&
      (filters.devices.size === 0 || filters.devices.has(r.device))
    );
  }, [filters.sources, filters.devices, M.runs]);

  // ───── Export ─────
  const onExportAll = () => {
    const rangeName = filters.precise
      ? `${filters.startDateTime}-${filters.endDateTime}`.replace(/[:T]/g, '-')
      : `${filters.startDate}-${filters.endDate}`;
    U.downloadCSV(`tokens-${filters.precise ? 'time' : 'daily'}-${rangeName}.csv`, filtered, [
      { title: filters.precise ? 'time' : 'date', field: filters.precise ? 'eventTime' : 'usageDate' },
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
        rows={filtered} pricing={M.pricing}
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
        sourceOptions={sourceOptions}
        allDevices={allDevices}
        allModels={allModels}
        availableRange={availableRange}
        onExport={onExportAll}
        onExportTrend={onExportTrend}
        exportDisabled={filters.precise && !preciseReady}
        quota={quota} />

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

      {filters.precise && !preciseReady ? (
        <div className="panel" role={M.timeState.error ? 'alert' : 'status'} style={{ padding: 24 }}>
          {!preciseRange ? '请选择有效的时间范围' : M.timeState.error ? `精确明细加载失败：${M.timeState.error}` : '正在加载所选时间范围的明细…'}
          {preciseRange && M.timeState.error && <button className="btn" onClick={() => onNeedTime(preciseRange, { force: true })}>重试明细</button>}
        </div>
      ) : <>
      {filters.precise && <p className="muted" role="note">精确时间模式仅统计已采集的事件明细；没有事件记录的来源和历史区间不包含在内。</p>}
      {!filters.precise && filtered.some(r => r.reconciliation && r.reconciliation !== 'matched') &&
        <p className="muted" role="note">部分历史汇总缺少明细或费用口径不同，已有金额已保留。项目费用按可用事件明细统计；详见帮助。</p>}
      {/* KPI row */}
      <div className="kpi-row">
        <KPI label="总 Token" value={U.compactCN(totals.totalTokens)}
          numericValue={totals.totalTokens}
          sub="vs 上周期"
          delta={U.deltaPct(totals.totalTokens, compareData.totals?.totalTokens)}
          sparkValues={sparkValues} sparkColor="oklch(0.55 0.16 265)" />
        <KPI label="输出" value={U.compactCN(totals.outputTokens)}
          numericValue={totals.outputTokens}
          sub="生成"
          delta={U.deltaPct(totals.outputTokens, compareData.totals?.outputTokens)}
          sparkValues={sparkBy('outputTokens')} sparkColor="oklch(0.60 0.15 295)" />
        <KPI label="缓存" value={U.compactCN(totals.cacheTokens)}
          numericValue={totals.cacheTokens}
          sub={totals.totalTokens > 0 ? `命中 ${totals.cacheHitRate.toFixed(0)}%` : '暂无用量'}
          delta={U.deltaPct(totals.cacheTokens, compareData.totals?.cacheTokens)}
          sparkValues={sparkBy('cacheReadTokens')} sparkColor="oklch(0.65 0.11 200)" />
        <KPI label="估算费用" value={U.fmtUS.format(totals.costUSD)}
          notice={filtered.some(r => r.totalTokens > 0 && M.pricing?.models?.[r.model] === false) ? '部分模型未匹配价格 · 估价可能不完整' : null}
          numericValue={totals.costUSD} format={U.fmtUS.format}
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
            />
        </div>
        <div className="col-4">
          <SourceDonut
            rows={sourceContextRows}
            sources={Array.from(new Set(sourceContextRows.map(r => r.source)))}
            total={totals.totalTokens}
            focused={focusedSource}
            onFocusSource={setFocusedSource} />
        </div>

        <div className="col-6">
          <TopModels rows={filtered} onDrillModel={r => setDrill({ kind: 'model', row: r, allSources: true })} />
        </div>
        <div className="col-3">
          <Gauge
            rate={totals.cacheHitRate}
            cacheRead={totals.cacheReadTokens}
            cacheCreation={totals.cacheCreationTokens}
            total={totals.totalTokens}
            prevRate={compareData.totals?.cacheHitRate}
            savedUSD={totals.cacheSavedUSD}
            hitRateSeries={hitRateSeries} />
        </div>
        <div className="col-3">
          <GrowthPanel totalsByDay={dailyTotalsByDay} />
        </div>

        <div className="col-12">
          <Heatmap
            rows={filteredHourly}
            dates={dates}
            loading={M.hourlyLoading}
            error={M.hourlyError} />
        </div>

        <div className="col-12">
          <TablePanel
            pricing={M.pricing}
            daily={filtered}
            sessions={filteredSessions}
            runs={filteredRuns}
            sources={presentSources}
            totalTokens={totals.totalTokens}
            onDrill={setDrill} />
        </div>
      </div>

      <AnimatePresence>
        {drill && <DrillDrawer key="usage-detail" drill={drill} daily={drill.kind === 'session' ? filteredProjectRows : filtered} rangeLabel={filters.precise ? `${filters.startDateTime} ~ ${filters.endDateTime}` : `${filters.startDate} ~ ${filters.endDate}`} onClose={() => setDrill(null)} />}
      </AnimatePresence>
      </>}
    </div>
  );
}
