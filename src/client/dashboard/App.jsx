import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import {
  ArrowsClockwise,
  BookOpenText,
  CalendarBlank,
  CaretDown,
  ChartLineUp,
  CheckCircle,
  ChatsCircle,
  Clock,
  Coins,
  CurrencyDollar,
  Database,
  DownloadSimple,
  Funnel,
  Gauge,
  Info,
  MagnifyingGlass,
  Pulse,
  TrendUp,
  Warning,
  X
} from '@phosphor-icons/react';
import { U } from '../shared/utils.js';
import { sourceIcon, sourceIconScale } from './source-icons.js';
import claudeLogo from './icons/claude.svg';
import gptLogo from './icons/gpt.svg';
import './styles.css';

const NAV_ITEMS = [
  { id: 'overview', label: '概览' },
  { id: 'activity', label: '活跃度' },
  { id: 'usage', label: '用量拆解' },
  { id: 'sessions', label: '会话' },
  { id: 'quota', label: '额度' }
];

const RANGE_OPTIONS = [
  { id: '7d', label: '过去 7 天', days: 7 },
  { id: '14d', label: '过去 14 天', days: 14 },
  { id: '30d', label: '过去 30 天', days: 30 },
  { id: '90d', label: '过去 90 天', days: 90 },
  { id: 'all', label: '全部', days: null }
];

const QUOTA_WINDOW_LABELS = {
  five_hour: '5 小时窗口',
  seven_day: '7 天窗口',
  seven_day_opus: '7 天 · Opus',
  seven_day_sonnet: '7 天 · Sonnet'
};

function fetchJson(url, options) {
  return fetch(url, options).then(async response => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 202) {
      throw new Error(body.error || body.message || `HTTP ${response.status}`);
    }
    return body;
  });
}

function useChart(option, deps = []) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return undefined;
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    chart.setOption(option, true);
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function aggregate(rows) {
  return rows.reduce((total, row) => ({
    totalTokens: total.totalTokens + normalizeNumber(row.totalTokens),
    inputTokens: total.inputTokens + normalizeNumber(row.inputTokens),
    outputTokens: total.outputTokens + normalizeNumber(row.outputTokens),
    cacheReadTokens: total.cacheReadTokens + normalizeNumber(row.cacheReadTokens),
    cacheCreationTokens: total.cacheCreationTokens + normalizeNumber(row.cacheCreationTokens),
    reasoningTokens: total.reasoningTokens + normalizeNumber(row.reasoningOutputTokens),
    costUSD: total.costUSD + normalizeNumber(row.costUSD)
  }), {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    costUSD: 0
  });
}

function groupRows(rows, getter) {
  const map = new Map();
  for (const row of rows) {
    const rawKey = getter(row);
    const key = rawKey || '未标记';
    if (!map.has(key)) {
      map.set(key, { name: key, rows: [], ...aggregate([]) });
    }
    const item = map.get(key);
    item.rows.push(row);
    item.totalTokens += normalizeNumber(row.totalTokens);
    item.inputTokens += normalizeNumber(row.inputTokens);
    item.outputTokens += normalizeNumber(row.outputTokens);
    item.cacheReadTokens += normalizeNumber(row.cacheReadTokens);
    item.cacheCreationTokens += normalizeNumber(row.cacheCreationTokens);
    item.reasoningTokens += normalizeNumber(row.reasoningOutputTokens);
    item.costUSD += normalizeNumber(row.costUSD);
  }
  return Array.from(map.values());
}

function rangeLabel(startDate, endDate, rangeId) {
  if (rangeId === 'all') return startDate === endDate ? startDate : `${startDate} ~ ${endDate}`;
  return `${startDate} ~ ${endDate}`;
}

function shortDate(value) {
  return value ? value.slice(5) : '—';
}

function formatDelta(current, previous) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

function deltaMeta(current, previous, inverse = false) {
  const value = formatDelta(current, previous);
  if (value == null || !Number.isFinite(value)) return { text: '暂无上周期', tone: 'neutral' };
  const favorable = inverse ? value <= 0 : value >= 0;
  return {
    text: `${value >= 0 ? '↑' : '↓'} ${Math.abs(value).toFixed(1)}%`,
    tone: favorable ? 'good' : 'bad'
  };
}

function formatReset(iso) {
  if (!iso) return '重置时间未知';
  const milliseconds = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '即将重置';
  const minutes = Math.floor(milliseconds / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) return `${days} 天 ${hours} 小时后重置`;
  if (hours) return `${hours} 小时 ${rest} 分后重置`;
  return `${rest} 分钟后重置`;
}

function summarizeCollectOutput(stdout) {
  if (!stdout) return '采集完成';
  return stdout.split('\n').filter(Boolean).slice(-3).join(' · ');
}

export function App() {
  const [data, setData] = useState(null);
  const [hourly, setHourly] = useState([]);
  const [quota, setQuota] = useState(null);
  const [timeRows, setTimeRows] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [hourlyError, setHourlyError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [collectStatus, setCollectStatus] = useState(null);

  const loadCore = useCallback(async () => {
    setRefreshing(true);
    setHourlyError('');
    fetchJson('/api/quota').then(setQuota).catch(() => {});
    try {
      const [nextData, nextHourly] = await Promise.all([
        fetchJson('/api/data'),
        fetchJson('/api/hourly').catch(error => {
          setHourlyError(error.message || '小时级数据加载失败');
          return { hourly: [] };
        })
      ]);
      setData({
        daily: nextData.daily || [],
        sessions: nextData.sessions || [],
        runs: nextData.runs || []
      });
      setHourly(nextHourly.hourly || []);
      setLoadError('');
      if (timeRows !== null) {
        fetchJson('/api/time')
          .then(precise => setTimeRows(precise.time || []))
          .catch(() => {});
      }
    } catch (error) {
      setLoadError(error.message || '数据加载失败');
    } finally {
      setRefreshing(false);
    }
  }, [timeRows]);

  const loadTimeRows = useCallback(() => {
    if (timeRows !== null) return;
    fetchJson('/api/time')
      .then(result => setTimeRows(result.time || []))
      .catch(() => setTimeRows([]));
  }, [timeRows]);

  const syncCollection = useCallback(async (refreshOnDone = false) => {
    const status = await fetchJson('/api/collect/status');
    if (status.status === 'running') {
      setCollecting(true);
      setCollectStatus({ type: 'running', message: status.message || '正在采集本机用量' });
      return status;
    }
    setCollecting(false);
    if (status.status === 'ok') {
      setCollectStatus({ type: 'ok', message: summarizeCollectOutput(status.stdout) });
      if (refreshOnDone) await loadCore();
    } else if (status.status === 'error') {
      setCollectStatus({ type: 'error', message: status.stderr || status.message || '采集失败' });
    }
    return status;
  }, [loadCore]);

  const waitForCollection = useCallback(async () => {
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 1400));
      const status = await syncCollection(true);
      if (status.status !== 'running') return;
    }
  }, [syncCollection]);

  const runCollect = useCallback(async () => {
    setCollecting(true);
    setCollectStatus({ type: 'running', message: '正在采集本机用量' });
    try {
      await fetchJson('/api/collect', { method: 'POST' });
      await waitForCollection();
    } catch (error) {
      setCollecting(false);
      setCollectStatus({ type: 'error', message: error.message || '采集失败' });
    }
  }, [waitForCollection]);

  useEffect(() => { loadCore(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let active = true;
    syncCollection(false).then(status => {
      if (active && status.status === 'running') waitForCollection();
    }).catch(() => {});
    return () => { active = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loadError) {
    return (
      <div className="full-state">
        <Warning size={34} />
        <strong>看板数据暂时无法读取</strong>
        <span>{loadError}</span>
        <button className="primary" onClick={loadCore}>重新加载</button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="full-state">
        <ArrowsClockwise className="spin" size={30} />
        <strong>正在整理用量数据</strong>
      </div>
    );
  }

  return (
    <Dashboard
      data={data}
      hourly={hourly}
      hourlyError={hourlyError}
      quota={quota}
      timeRows={timeRows}
      onNeedTime={loadTimeRows}
      refreshing={refreshing}
      collecting={collecting}
      collectStatus={collectStatus}
      onRefresh={loadCore}
      onCollect={runCollect}
    />
  );
}

function Dashboard({
  data,
  hourly,
  hourlyError,
  quota,
  timeRows,
  onNeedTime,
  refreshing,
  collecting,
  collectStatus,
  onRefresh,
  onCollect
}) {
  const [activeView, setActiveView] = useState('overview');
  const [rangeId, setRangeId] = useState('30d');
  const [selectedSources, setSelectedSources] = useState(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);

  const allDates = useMemo(() => Array.from(new Set(data.daily.map(row => row.usageDate).filter(Boolean))).sort(), [data.daily]);
  const firstDate = allDates[0] || U.daysAgo(0);
  const lastDate = allDates[allDates.length - 1] || U.daysAgo(0);
  const range = RANGE_OPTIONS.find(option => option.id === rangeId) || RANGE_OPTIONS[2];
  const startDate = range.days ? U.addDays(lastDate, -(range.days - 1)) : firstDate;
  const endDate = lastDate;
  const sources = useMemo(() => Array.from(new Set(data.daily.map(row => row.source).filter(Boolean))).sort(), [data.daily]);

  const filteredDaily = useMemo(() => data.daily.filter(row =>
    row.usageDate >= startDate && row.usageDate <= endDate &&
    (selectedSources.size === 0 || selectedSources.has(row.source))
  ), [data.daily, startDate, endDate, selectedSources]);

  const filteredHourly = useMemo(() => hourly.filter(row =>
    row.usageDate >= startDate && row.usageDate <= endDate &&
    (selectedSources.size === 0 || selectedSources.has(row.source))
  ), [hourly, startDate, endDate, selectedSources]);

  const sourceFilteredDaily = useMemo(() => data.daily.filter(row =>
    selectedSources.size === 0 || selectedSources.has(row.source)
  ), [data.daily, selectedSources]);

  const filteredSessionAggregates = useMemo(() => data.sessions.filter(row =>
    (rangeId === 'all' || !row.lastActivity || (row.lastActivity >= startDate && row.lastActivity <= endDate)) &&
    (selectedSources.size === 0 || selectedSources.has(row.source))
  ), [data.sessions, rangeId, startDate, endDate, selectedSources]);

  const selectedRangeDates = useMemo(() => U.rangeDates(startDate, endDate), [startDate, endDate]);
  const previousDaily = useMemo(() => {
    if (rangeId === 'all') return [];
    const previousEnd = U.addDays(startDate, -1);
    const previousStart = U.addDays(previousEnd, -(selectedRangeDates.length - 1));
    return data.daily.filter(row =>
      row.usageDate >= previousStart && row.usageDate <= previousEnd &&
      (selectedSources.size === 0 || selectedSources.has(row.source))
    );
  }, [data.daily, rangeId, startDate, selectedRangeDates.length, selectedSources]);

  const totals = useMemo(() => aggregate(filteredDaily), [filteredDaily]);
  const previousTotals = useMemo(() => aggregate(previousDaily), [previousDaily]);
  const activeDays = useMemo(() => new Set(filteredDaily.filter(row => normalizeNumber(row.totalTokens) > 0).map(row => row.usageDate)).size, [filteredDaily]);
  const previousActiveDays = useMemo(() => new Set(previousDaily.filter(row => normalizeNumber(row.totalTokens) > 0).map(row => row.usageDate)).size, [previousDaily]);
  const lastSync = data.runs[0]?.collectedAt ? U.formatTs(data.runs[0].collectedAt) : '—';

  useEffect(() => {
    if (activeView === 'sessions') onNeedTime();
  }, [activeView, onNeedTime]);

  const announce = useCallback(message => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2400);
  }, []);

  const changeView = id => {
    setActiveView(id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const common = {
    daily: filteredDaily,
    allDaily: sourceFilteredDaily,
    hourly: filteredHourly,
    totals,
    previousTotals,
    activeDays,
    previousActiveDays,
    dates: selectedRangeDates,
    rangeId,
    quota,
    runs: data.runs,
    sessionAggregates: filteredSessionAggregates,
    sources,
    selectedSources,
    announce
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => changeView('overview')} aria-label="返回概览">
          <span className="brand-mark">TS</span>
          <span><strong>Token Studio</strong><small>个人 AI Token 消耗看板</small></span>
        </button>

        <nav className="main-nav" aria-label="主导航">
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              className={activeView === item.id ? 'active' : ''}
              onClick={() => changeView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="top-actions">
          <div className="sync-status" title={collectStatus?.message || ''}>
            <span className={collectStatus?.type === 'error' ? 'error' : ''} />
            最后同步 <strong>{lastSync}</strong>
          </div>
          <a className="outline-button review-link" href="/review"><BookOpenText size={17} />复盘</a>
          <button className="primary" disabled={collecting || refreshing} onClick={onCollect}>
            <Database size={17} />{collecting ? '采集中' : '采集'}
          </button>
          <button className="outline-button" disabled={refreshing || collecting} onClick={onRefresh}>
            <ArrowsClockwise size={17} className={refreshing ? 'spin' : ''} />刷新
          </button>
        </div>
      </header>

      <div className="command-row">
        <div className="range-wrap">
          <CalendarBlank size={18} />
          <select value={rangeId} onChange={event => setRangeId(event.target.value)} aria-label="时间范围">
            {RANGE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <CaretDown size={14} aria-hidden="true" />
        </div>
        <div className="date-chip">{rangeLabel(startDate, endDate, rangeId)}</div>
        <div className="filter-anchor">
          <button className="outline-button" onClick={() => setFiltersOpen(open => !open)} aria-expanded={filtersOpen}>
            <Funnel size={17} />筛选
            {selectedSources.size > 0 && <span className="count">{selectedSources.size}</span>}
          </button>
          {filtersOpen && (
            <FilterPopover
              sources={sources}
              selected={selectedSources}
              onChange={setSelectedSources}
              onClose={() => setFiltersOpen(false)}
              onApply={() => {
                setFiltersOpen(false);
                announce(selectedSources.size ? `已筛选 ${selectedSources.size} 个来源` : '已显示全部来源');
              }}
            />
          )}
        </div>
        <span className="result-count">{filteredDaily.length.toLocaleString('zh-CN')} 条日聚合记录</span>
      </div>

      {activeView === 'overview' && <Overview {...common} />}
      {activeView === 'activity' && <ActivityView {...common} hourlyError={hourlyError} />}
      {activeView === 'usage' && <UsageView {...common} />}
      {activeView === 'sessions' && (
        <SessionsView
          {...common}
          timeRows={timeRows}
          fallbackSessions={data.sessions}
          startDate={startDate}
          endDate={endDate}
        />
      )}
      {activeView === 'quota' && <QuotaView {...common} />}

      {toast && <div className="toast" role="status"><CheckCircle size={18} weight="fill" />{toast}</div>}
    </div>
  );
}

function FilterPopover({ sources, selected, onChange, onClose, onApply }) {
  const toggle = source => {
    const next = new Set(selected);
    if (next.has(source)) next.delete(source);
    else next.add(source);
    onChange(next);
  };
  return (
    <div className="filter-popover" role="dialog" aria-label="来源筛选">
      <div className="popover-head">
        <strong>来源筛选</strong>
        <button onClick={onClose} aria-label="关闭"><X size={16} /></button>
      </div>
      <p>不选择时显示全部已采集来源。</p>
      <div className="filter-options">
        {sources.map(source => (
          <label key={source}>
            <input type="checkbox" checked={selected.has(source)} onChange={() => toggle(source)} />
            <SourceIdentity source={source} />
          </label>
        ))}
      </div>
      <div className="popover-actions">
        <button className="text-button" onClick={() => onChange(new Set())}>清空</button>
        <button className="primary" onClick={onApply}>应用筛选</button>
      </div>
    </div>
  );
}

function SourceIdentity({ source }) {
  const icon = sourceIcon(source);
  return (
    <span className="source-identity">
      {icon
        ? <img src={icon} alt="" style={{ transform: `scale(${sourceIconScale(source)})` }} />
        : <span className="source-dot" style={{ background: U.getSourceColor(source) }} />}
      <span>{source}</span>
    </span>
  );
}

function MetricCard({ icon: Icon, label, value, unit, delta, hint, inverse = false }) {
  const meta = deltaMeta(delta.current, delta.previous, inverse);
  return (
    <article className="metric-card">
      <div className="metric-card-head"><span>{label}</span><Icon size={18} /></div>
      <div className="metric-value"><strong>{value}</strong>{unit && <span>{unit}</span>}</div>
      <div className="metric-foot"><span className={meta.tone}>{meta.text}</span><span>{hint}</span></div>
    </article>
  );
}

function Overview({ daily, allDaily, hourly, totals, previousTotals, activeDays, previousActiveDays, dates, rangeId, quota, runs, sessionAggregates, announce }) {
  const dailyAverage = activeDays ? totals.costUSD / activeDays : 0;
  return (
    <div className="dashboard-grid">
      <main className="analysis-canvas">
        <section className="metric-grid" aria-label="核心指标">
          <MetricCard icon={Coins} label="总 Token" value={U.compactCN(totals.totalTokens)} delta={{ current: totals.totalTokens, previous: previousTotals.totalTokens }} hint={rangeId === 'all' ? '全部历史' : '较上周期'} />
          <MetricCard icon={CurrencyDollar} label="估算费用" value={U.fmtUS.format(totals.costUSD)} delta={{ current: totals.costUSD, previous: previousTotals.costUSD }} hint={rangeId === 'all' ? '累计估算' : '较上周期'} inverse />
          <MetricCard icon={CalendarBlank} label="活跃天数" value={activeDays.toLocaleString('zh-CN')} unit="天" delta={{ current: activeDays, previous: previousActiveDays }} hint={`共 ${dates.length} 天`} />
          <MetricCard icon={TrendUp} label="日均费用" value={U.fmtUS.format(dailyAverage)} delta={{ current: dailyAverage, previous: previousActiveDays ? previousTotals.costUSD / previousActiveDays : 0 }} hint="按活跃日" inverse />
        </section>

        <section className="panel trend-panel">
          <div className="section-heading">
            <div><h2>{rangeId === 'all' ? '全部时间使用趋势' : `${dates.length} 天使用趋势`}</h2><p>Token 构成（柱）与估算费用（折线）</p></div>
            <button className="icon-button" aria-label="导出当前趋势" onClick={() => exportDaily(daily, announce)}><DownloadSimple size={17} /></button>
          </div>
          <TrendChart rows={daily} dates={dates} />
        </section>

        <section className="panel breakdown-panel">
          <div className="split-detail">
            <TokenComposition totals={totals} />
            <CostDrivers daily={daily} projectRows={sessionAggregates} />
          </div>
        </section>
      </main>
      <StatusRail daily={allDaily} periodDaily={daily} hourly={hourly} quota={quota} runs={runs} totals={totals} />
    </div>
  );
}

function exportDaily(rows, announce) {
  U.downloadCSV(`token-studio-${U.daysAgo(0)}.csv`, rows, [
    { title: 'date', field: 'usageDate' },
    { title: 'source', field: 'source' },
    { title: 'model', field: 'model' },
    { title: 'input', field: 'inputTokens' },
    { title: 'output', field: 'outputTokens' },
    { title: 'cache_read', field: 'cacheReadTokens' },
    { title: 'cache_creation', field: 'cacheCreationTokens' },
    { title: 'reasoning', field: 'reasoningOutputTokens' },
    { title: 'total', field: 'totalTokens' },
    { title: 'cost_usd', field: 'costUSD' }
  ]);
  announce('已导出当前筛选数据');
}

function TrendChart({ rows, dates }) {
  const option = useMemo(() => {
    const map = new Map(dates.map(date => [date, aggregate([])]));
    for (const row of rows) {
      if (!map.has(row.usageDate)) map.set(row.usageDate, aggregate([]));
      const item = map.get(row.usageDate);
      item.inputTokens += normalizeNumber(row.inputTokens);
      item.outputTokens += normalizeNumber(row.outputTokens);
      item.cacheReadTokens += normalizeNumber(row.cacheReadTokens) + normalizeNumber(row.cacheCreationTokens);
      item.reasoningTokens += normalizeNumber(row.reasoningOutputTokens);
      item.costUSD += normalizeNumber(row.costUSD);
    }
    const orderedDates = Array.from(map.keys()).sort();
    const values = orderedDates.map(date => map.get(date));
    const maxToken = Math.max(1, ...values.map(item => item.inputTokens + item.outputTokens + item.cacheReadTokens + item.reasoningTokens));
    const unit = maxToken >= 1e9 ? 1e9 : maxToken >= 1e6 ? 1e6 : maxToken >= 1e3 ? 1e3 : 1;
    const unitLabel = unit === 1e9 ? 'B' : unit === 1e6 ? 'M' : unit === 1e3 ? 'K' : '';
    return {
      animationDuration: 450,
      color: ['#4168d8', '#7a66d8', '#aaa0e8', '#d6d0f1', '#1f55c8'],
      grid: { left: 52, right: 58, top: 54, bottom: 64 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#1d1d20',
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 12 },
        valueFormatter: value => typeof value === 'number' ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : value
      },
      legend: { top: 4, left: 4, itemWidth: 9, itemHeight: 9, itemGap: 18, textStyle: { color: '#6f6c68', fontSize: 11 } },
      xAxis: {
        type: 'category',
        data: orderedDates.map(shortDate),
        axisLine: { lineStyle: { color: '#dedbd5' } },
        axisTick: { show: false },
        axisLabel: { color: '#77736e', fontSize: 10, interval: orderedDates.length > 60 ? Math.ceil(orderedDates.length / 10) : 'auto' }
      },
      yAxis: [
        {
          type: 'value',
          name: `Tokens (${unitLabel || '个'})`,
          nameTextStyle: { color: '#88837d', fontSize: 10, padding: [0, 0, 8, -20] },
          splitLine: { lineStyle: { color: '#eeebe5' } },
          axisLabel: { color: '#8b8781', fontSize: 10 }
        },
        {
          type: 'value',
          name: 'USD',
          nameTextStyle: { color: '#88837d', fontSize: 10 },
          splitLine: { show: false },
          axisLabel: { color: '#8b8781', fontSize: 10, formatter: '${value}' }
        }
      ],
      dataZoom: [{
        type: 'slider',
        height: 18,
        bottom: 10,
        borderColor: '#e7e3dc',
        backgroundColor: '#f4f1ec',
        fillerColor: 'rgba(65,104,216,.12)',
        dataBackground: { lineStyle: { color: '#bfc9ea' }, areaStyle: { color: '#dfe5f5' } },
        selectedDataBackground: { lineStyle: { color: '#5275d4' }, areaStyle: { color: '#cbd6f2' } },
        handleStyle: { color: '#fff', borderColor: '#7892dc' },
        showDetail: false,
        start: orderedDates.length > 45 ? Math.max(0, 100 - (45 / orderedDates.length) * 100) : 0,
        end: 100
      }],
      series: [
        { name: '输入', type: 'bar', stack: 'tokens', data: values.map(item => item.inputTokens / unit), barMaxWidth: 18 },
        { name: '输出', type: 'bar', stack: 'tokens', data: values.map(item => item.outputTokens / unit) },
        { name: '缓存', type: 'bar', stack: 'tokens', data: values.map(item => item.cacheReadTokens / unit) },
        { name: '推理', type: 'bar', stack: 'tokens', data: values.map(item => item.reasoningTokens / unit) },
        { name: '费用', type: 'line', yAxisIndex: 1, data: values.map(item => item.costUSD), smooth: 0.28, symbol: 'none', lineStyle: { width: 2, color: '#1f55c8' } }
      ]
    };
  }, [rows, dates]);
  const ref = useChart(option, [option]);
  return <div className="chart trend-chart" ref={ref} role="img" aria-label="Token 与费用趋势图" />;
}

function TokenComposition({ totals }) {
  const total = totals.totalTokens || 1;
  const items = [
    { label: '输入 Input', value: totals.inputTokens, tone: 'blue' },
    { label: '输出 Output', value: totals.outputTokens, tone: 'violet' },
    { label: '缓存 Cache', value: totals.cacheReadTokens + totals.cacheCreationTokens, tone: 'lavender' },
    { label: '推理 Reasoning', value: totals.reasoningTokens, tone: 'pale' }
  ];
  return (
    <section className="composition">
      <div className="section-heading compact"><div><h3>Token 构成</h3><p>总计 {U.compactCN(totals.totalTokens)} Token</p></div></div>
      <div className="composition-list">
        {items.map(item => {
          const percent = item.value / total * 100;
          return (
            <div className="composition-row" key={item.label}>
              <span className={`dot ${item.tone}`} />
              <span>{item.label}</span>
              <div className="composition-track"><span className={item.tone} style={{ width: `${Math.min(100, percent)}%` }} /></div>
              <strong>{U.compactCN(item.value)}</strong>
              <small>{percent.toFixed(1)}%</small>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CostDrivers({ daily, projectRows = [] }) {
  const [dimension, setDimension] = useState('source');
  const dimensions = {
    source: { label: '来源', getter: row => row.source },
    model: { label: '模型', getter: row => row.model },
    project: { label: '项目', getter: row => row.projectPath }
  };
  const rows = useMemo(() => {
    const sourceRows = dimension === 'project' ? projectRows : daily;
    return groupRows(sourceRows, dimensions[dimension].getter).sort((a, b) => b.costUSD - a.costUSD).slice(0, 5);
  }, [daily, projectRows, dimension]);
  const totalCost = rows.reduce((sum, row) => sum + row.costUSD, 0) || 1;
  return (
    <section className="drivers">
      <div className="section-heading compact">
        <div><h3>费用驱动</h3><p>Top 5 · 当前周期</p></div>
        <div className="segmented">
          {Object.entries(dimensions).map(([id, item]) => <button key={id} className={dimension === id ? 'active' : ''} onClick={() => setDimension(id)}>{item.label}</button>)}
        </div>
      </div>
      <div className="driver-list">
        {rows.length === 0 && <div className="small-empty">当前筛选下暂无费用数据</div>}
        {rows.map((row, index) => {
          const percent = row.costUSD / totalCost * 100;
          return (
            <div className="driver-row" key={row.name}>
              <span className="driver-rank">{index + 1}</span>
              <strong title={row.name}>{row.name}</strong>
              <span className="driver-cost">{U.fmtUS.format(row.costUSD)}</span>
              <div className="share-track"><span style={{ width: `${percent}%` }} /></div>
              <span className="driver-share">{percent.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StatusRail({ daily, periodDaily, hourly, quota, runs, totals }) {
  const today = U.daysAgo(0);
  const todayRows = daily.filter(row => row.usageDate === today);
  const todayTotals = aggregate(todayRows);
  const todayHourly = hourly.filter(row => row.usageDate === today);
  const peakHour = todayHourly.length ? todayHourly.reduce((best, row) => normalizeNumber(row.totalTokens) > normalizeNumber(best.totalTokens) ? row : best, todayHourly[0]).hour : null;
  const activeSources = new Set(todayRows.map(row => row.source)).size;
  const latestBySource = new Map();
  for (const run of runs) if (!latestBySource.has(run.source)) latestBySource.set(run.source, run);
  const failing = Array.from(latestBySource.values()).filter(run => run.status === 'error');
  const monthPrefix = today.slice(0, 7);
  const monthRows = daily.filter(row => row.usageDate.startsWith(monthPrefix));
  const monthTotals = aggregate(monthRows);
  const elapsedDays = Math.max(1, new Date().getDate());
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const projected = monthTotals.costUSD / elapsedDays * daysInMonth;
  const sevenDates = U.rangeDates(U.addDays(today, -6), today);
  const sevenMap = new Map(sevenDates.map(date => [date, 0]));
  for (const row of daily) if (sevenMap.has(row.usageDate)) sevenMap.set(row.usageDate, sevenMap.get(row.usageDate) + normalizeNumber(row.totalTokens));
  const sevenMax = Math.max(1, ...sevenMap.values());
  const quotaProviders = quotaProvidersFrom(quota).filter(provider => provider.data.ok && provider.data.windows?.length);
  const highCostDay = groupRows(periodDaily, row => row.usageDate).sort((a, b) => b.costUSD - a.costUSD)[0];
  return (
    <aside className="panel status-rail">
      <div className="rail-title"><h2>运行摘要</h2><span>今天</span></div>
      <section className="today-block">
        <div className="today-grid">
          <div><span>今日 Token</span><strong>{U.compactCN(todayTotals.totalTokens)}</strong><small>{todayRows.length ? '已计入今日数据' : '今日暂无记录'}</small></div>
          <div><span>今日费用</span><strong>{U.fmtUS.format(todayTotals.costUSD)}</strong><small>实时估算</small></div>
          <div><span>活跃来源</span><strong>{activeSources}</strong><small>共 {new Set(daily.map(row => row.source)).size} 个来源</small></div>
          <div><span>峰值小时</span><strong>{peakHour == null ? '—' : `${String(peakHour).padStart(2, '0')}:00`}</strong><small>{peakHour == null ? '暂无小时记录' : '按小时用量'}</small></div>
        </div>
      </section>
      <section className="forecast-block">
        <div className="rail-section-head"><strong>本月费用预测</strong><span>按当前日均</span></div>
        <div className="forecast-value"><strong>{U.fmtUS.format(projected)}</strong><span>当前 {U.fmtUS.format(monthTotals.costUSD)}</span></div>
        <progress value={Math.min(elapsedDays, daysInMonth)} max={daysInMonth} aria-label="本月时间进度" />
        <div className="forecast-meta"><span>日均 {U.fmtUS.format(monthTotals.costUSD / elapsedDays)}</span><span>{elapsedDays}/{daysInMonth} 天</span></div>
      </section>
      <section className="activity-block">
        <div className="rail-section-head"><strong>7 天用量</strong><span>{U.compactCN(Array.from(sevenMap.values()).reduce((sum, value) => sum + value, 0))}</span></div>
        <div className="mini-bars">
          {Array.from(sevenMap.entries()).map(([date, value]) => <div key={date}><span style={{ height: `${Math.max(4, value / sevenMax * 58)}px` }} /><small>{shortDate(date)}</small></div>)}
        </div>
      </section>
      {quotaProviders.length > 0 && (
        <section className="quota-summary-block">
          <div className="rail-section-head"><strong>已连接额度</strong><span>{quotaProviders.length} 个工具</span></div>
          {quotaProviders.map(provider => <CompactQuota key={provider.id} provider={provider} />)}
        </section>
      )}
      <section className="attention-block">
        <div className="rail-section-head"><strong>需要关注</strong><span>{failing.length ? `${failing.length} 项异常` : '运行正常'}</span></div>
        {failing.slice(0, 2).map(run => (
          <div className="attention-row" key={`${run.source}-${run.collectedAt}`}><Warning size={18} className="danger" /><span><strong>{run.source} 采集异常</strong><small>{run.message || run.status}</small></span></div>
        ))}
        {highCostDay && <div className="attention-row"><ChartLineUp size={18} className="blue-icon" /><span><strong>周期费用峰值</strong><small>{highCostDay.name} · {U.fmtUS.format(highCostDay.costUSD)}</small></span></div>}
        {!failing.length && !highCostDay && <div className="small-empty">当前周期暂无需要关注的项目</div>}
      </section>
      <div className="data-health-row"><Pulse size={16} /><span><strong>{failing.length ? '部分来源需检查' : '数据采集正常'}</strong><small>累计 {U.compactCN(totals.totalTokens)} Token</small></span><Info size={15} /></div>
    </aside>
  );
}

function quotaProvidersFrom(quota) {
  if (!quota || quota.disabled) return [];
  return [
    { id: 'claude', name: 'Claude', logo: claudeLogo, data: quota.claude },
    { id: 'codex', name: 'Codex', logo: gptLogo, data: quota.codex }
  ].filter(provider => provider.data && ((provider.data.ok && provider.data.windows?.length) || provider.data.status !== 'no_credentials'));
}

function CompactQuota({ provider }) {
  const window = provider.data.windows?.[0];
  const used = window ? Math.round(normalizeNumber(window.utilization) * 100) : null;
  return (
    <div className="compact-quota-row">
      <div className="compact-quota-title"><img src={provider.logo} alt="" /><span><strong>{provider.name}</strong><small>{window ? formatReset(window.resetsAt) : '暂时无法读取额度'}</small></span></div>
      <div className="compact-quota-value"><strong>{used == null ? '—' : `${100 - used}%`}</strong><span>剩余</span></div>
      <progress value={used || 0} max="100" aria-label={`${provider.name} 已使用 ${used || 0}%`} />
    </div>
  );
}

function ActivityView({ daily, hourly, dates, hourlyError }) {
  const activeDates = useMemo(() => new Set(daily.filter(row => normalizeNumber(row.totalTokens) > 0).map(row => row.usageDate)), [daily]);
  const { current, longest } = useMemo(() => calculateStreaks(dates, activeDates), [dates, activeDates]);
  const peakHour = useMemo(() => {
    const grouped = new Map(Array.from({ length: 24 }, (_, hour) => [hour, 0]));
    for (const row of hourly) grouped.set(Number(row.hour), grouped.get(Number(row.hour)) + normalizeNumber(row.totalTokens));
    return Array.from(grouped.entries()).sort((a, b) => b[1] - a[1])[0] || [null, 0];
  }, [hourly]);
  const weekday = useMemo(() => {
    const result = Array.from({ length: 7 }, (_, index) => ({ index, value: 0 }));
    for (const row of daily) result[new Date(`${row.usageDate}T00:00:00`).getDay()].value += normalizeNumber(row.totalTokens);
    return result;
  }, [daily]);
  const recentHeatDates = dates.slice(-28);
  return (
    <div className="page-stack">
      <section className="metric-grid activity-metrics">
        <MetricCard icon={CalendarBlank} label="活跃天数" value={activeDates.size} unit="天" delta={{ current: activeDates.size, previous: 0 }} hint={`共 ${dates.length} 天`} />
        <MetricCard icon={Pulse} label="当前连续" value={current} unit="天" delta={{ current, previous: 0 }} hint="截至周期末" />
        <MetricCard icon={TrendUp} label="最长连续" value={longest} unit="天" delta={{ current: longest, previous: 0 }} hint="当前周期" />
        <MetricCard icon={Clock} label="高峰小时" value={peakHour[0] == null ? '—' : `${String(peakHour[0]).padStart(2, '0')}:00`} delta={{ current: 0, previous: 0 }} hint={peakHour[1] ? U.compactCN(peakHour[1]) : '暂无小时记录'} />
      </section>
      <section className="panel activity-heat-panel">
        <div className="section-heading"><div><h2>使用热力图</h2><p>最近 {recentHeatDates.length} 天 × 24 小时 · 悬浮查看真实用量</p></div><div className="heat-legend"><span>少</span><i className="l0" /><i className="l1" /><i className="l2" /><i className="l3" /><i className="l4" /><span>多</span></div></div>
        {hourlyError ? <div className="chart-empty"><Warning size={22} />{hourlyError}</div> : <HeatmapChart rows={hourly} dates={recentHeatDates} />}
      </section>
      <div className="two-column">
        <section className="panel compact-panel"><div className="section-heading"><div><h2>星期分布</h2><p>各星期 Token 占比</p></div></div><WeekdayChart rows={weekday} /></section>
        <section className="panel compact-panel"><div className="section-heading"><div><h2>小时节奏</h2><p>所选周期的 24 小时使用轮廓</p></div></div><HourlyChart rows={hourly} /></section>
      </div>
      <div className="coverage-note"><Info size={16} /><span>小时图仅统计已提供事件级记录的来源；日级活跃天数仍使用完整的日聚合数据。</span></div>
    </div>
  );
}

function calculateStreaks(dates, activeDates) {
  let longest = 0;
  let running = 0;
  for (const date of dates) {
    if (activeDates.has(date)) {
      running += 1;
      longest = Math.max(longest, running);
    } else running = 0;
  }
  let current = 0;
  for (let index = dates.length - 1; index >= 0; index -= 1) {
    if (!activeDates.has(dates[index])) break;
    current += 1;
  }
  return { current, longest };
}

function HeatmapChart({ rows, dates }) {
  const option = useMemo(() => {
    const map = new Map();
    for (const row of rows) {
      const key = `${row.usageDate}-${row.hour}`;
      map.set(key, (map.get(key) || 0) + normalizeNumber(row.totalTokens));
    }
    const data = [];
    dates.forEach((date, y) => {
      for (let hour = 0; hour < 24; hour += 1) data.push([hour, y, map.get(`${date}-${hour}`) || 0]);
    });
    const max = Math.max(1, ...data.map(point => point[2]));
    return {
      animationDuration: 320,
      grid: { left: 58, right: 18, top: 30, bottom: 18 },
      tooltip: { formatter: ({ data: point }) => `${dates[point[1]]} ${String(point[0]).padStart(2, '0')}:00<br/><b>${U.compactCN(point[2])} tokens</b>`, backgroundColor: '#1d1d20', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 } },
      xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, hour) => hour), position: 'top', axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#77736e', interval: 3, fontSize: 10 } },
      yAxis: { type: 'category', data: dates.map(shortDate), inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#77736e', fontSize: 10, interval: dates.length > 18 ? 2 : 1 } },
      visualMap: { show: false, min: 0, max, inRange: { color: ['#f0eee9', '#dfe6f8', '#b3c2ee', '#6e8dde', '#345cc5'] } },
      series: [{ type: 'heatmap', data, itemStyle: { borderColor: '#fcfbf8', borderWidth: 2, borderRadius: 3 }, emphasis: { itemStyle: { borderColor: '#1d1d20', borderWidth: 1 } } }]
    };
  }, [rows, dates]);
  const ref = useChart(option, [option]);
  return <div className="activity-heat-chart" ref={ref} role="img" aria-label="按日期和小时展示的使用热力图" />;
}

function WeekdayChart({ rows }) {
  const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const option = useMemo(() => ({
    grid: { left: 48, right: 18, top: 18, bottom: 32 },
    tooltip: { trigger: 'axis', backgroundColor: '#1d1d20', borderWidth: 0, textStyle: { color: '#fff' }, valueFormatter: value => `${U.compactCN(value)} tokens` },
    xAxis: { type: 'category', data: labels, axisLine: { lineStyle: { color: '#dedbd5' } }, axisTick: { show: false }, axisLabel: { color: '#77736e', fontSize: 10 } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#eeebe5' } }, axisLabel: { color: '#8b8781', fontSize: 10, formatter: value => U.compact(value) } },
    series: [{ type: 'bar', data: rows.map(row => row.value), barMaxWidth: 30, itemStyle: { color: '#4168d8', borderRadius: [5, 5, 2, 2] } }]
  }), [rows]);
  const ref = useChart(option, [option]);
  return <div className="small-chart" ref={ref} />;
}

function HourlyChart({ rows }) {
  const values = useMemo(() => {
    const hours = Array.from({ length: 24 }, () => 0);
    for (const row of rows) hours[Number(row.hour)] += normalizeNumber(row.totalTokens);
    return hours;
  }, [rows]);
  const option = useMemo(() => ({
    grid: { left: 48, right: 18, top: 18, bottom: 32 },
    tooltip: { trigger: 'axis', backgroundColor: '#1d1d20', borderWidth: 0, textStyle: { color: '#fff' }, valueFormatter: value => `${U.compactCN(value)} tokens` },
    xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, hour) => hour), axisLine: { lineStyle: { color: '#dedbd5' } }, axisTick: { show: false }, axisLabel: { color: '#77736e', fontSize: 10, interval: 3 } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#eeebe5' } }, axisLabel: { color: '#8b8781', fontSize: 10, formatter: value => U.compact(value) } },
    series: [{ type: 'line', data: values, smooth: 0.3, symbol: 'none', lineStyle: { color: '#4168d8', width: 2 }, areaStyle: { color: 'rgba(65,104,216,.12)' } }]
  }), [values]);
  const ref = useChart(option, [option]);
  return <div className="small-chart" ref={ref} />;
}

function UsageView({ daily, totals, sessionAggregates, announce }) {
  const [dimension, setDimension] = useState('source');
  const [measure, setMeasure] = useState('tokens');
  const [search, setSearch] = useState('');
  const dimensions = {
    source: { label: '来源', getter: row => row.source },
    model: { label: '模型', getter: row => row.model },
    project: { label: '项目', getter: row => row.projectPath }
  };
  const rows = useMemo(() => groupRows(dimension === 'project' ? sessionAggregates : daily, dimensions[dimension].getter)
    .filter(row => row.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => measure === 'cost' ? b.costUSD - a.costUSD : b.totalTokens - a.totalTokens), [daily, sessionAggregates, dimension, measure, search]);
  const max = Math.max(1, ...rows.map(row => measure === 'cost' ? row.costUSD : row.totalTokens));
  return (
    <div className="page-stack">
      <section className="panel usage-hero">
        <div className="section-heading usage-heading">
          <div><h2>用量拆解</h2><p>按来源、模型和项目查看 Token 与费用贡献</p></div>
          <button className="outline-button" onClick={() => exportDaily(daily, announce)}><DownloadSimple size={17} />导出 CSV</button>
        </div>
        <div className="usage-controls">
          <div className="segmented large">{Object.entries(dimensions).map(([id, item]) => <button key={id} className={dimension === id ? 'active' : ''} onClick={() => setDimension(id)}>{item.label}</button>)}</div>
          <div className="segmented">{[['tokens', 'Token'], ['cost', '费用']].map(([id, label]) => <button key={id} className={measure === id ? 'active' : ''} onClick={() => setMeasure(id)}>{label}</button>)}</div>
          <label className="search-box"><MagnifyingGlass size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={`搜索${dimensions[dimension].label}…`} /></label>
        </div>
        <div className="rank-list">
          {rows.length === 0 && <div className="chart-empty">当前筛选下暂无匹配数据</div>}
          {rows.map((row, index) => {
            const value = measure === 'cost' ? row.costUSD : row.totalTokens;
            const percentage = value / max * 100;
            return (
              <div className="rank-row" key={row.name}>
                <span className="rank-number">{index + 1}</span>
                <div className="rank-name">{dimension === 'source' ? <SourceIdentity source={row.name} /> : <strong title={row.name}>{row.name}</strong>}<small>{row.rows.length} 条记录</small></div>
                <div className="rank-bar"><span style={{ width: `${percentage}%`, background: dimension === 'source' ? U.getSourceColor(row.name) : '#4168d8' }} /></div>
                <strong className="rank-value">{measure === 'cost' ? U.fmtUS.format(row.costUSD) : U.compactCN(row.totalTokens)}</strong>
                <span className="rank-cost">{measure === 'cost' ? U.compactCN(row.totalTokens) : U.fmtUS.format(row.costUSD)}</span>
              </div>
            );
          })}
        </div>
      </section>
      <div className="two-column usage-bottom">
        <section className="panel compact-panel"><TokenComposition totals={totals} /></section>
        <section className="panel compact-panel"><UsageSummary rows={rows} total={totals} /></section>
      </div>
    </div>
  );
}

function UsageSummary({ rows, total }) {
  const top = rows[0];
  const coverage = top && total.totalTokens ? top.totalTokens / total.totalTokens * 100 : 0;
  const cache = total.totalTokens ? total.cacheReadTokens / total.totalTokens * 100 : 0;
  return (
    <div className="summary-card-content">
      <div className="section-heading compact"><div><h3>结构摘要</h3><p>当前筛选周期</p></div></div>
      <div className="summary-stat-grid">
        <div><span>维度数量</span><strong>{rows.length}</strong><small>有用量记录</small></div>
        <div><span>头部集中度</span><strong>{coverage.toFixed(1)}%</strong><small>{top?.name || '暂无'}</small></div>
        <div><span>缓存读取占比</span><strong>{cache.toFixed(1)}%</strong><small>占总 Token</small></div>
        <div><span>估算费用</span><strong>{U.fmtUS.format(total.costUSD)}</strong><small>当前周期</small></div>
      </div>
    </div>
  );
}

function SessionsView({ timeRows, fallbackSessions, selectedSources, startDate, endDate }) {
  const [search, setSearch] = useState('');
  const sessions = useMemo(() => {
    if (timeRows === null) return null;
    const eligible = timeRows.filter(row => row.sessionId && row.usageDate >= startDate && row.usageDate <= endDate && (selectedSources.size === 0 || selectedSources.has(row.source)));
    const map = new Map();
    for (const row of eligible) {
      const key = `${row.source}::${row.sessionId}`;
      if (!map.has(key)) map.set(key, { source: row.source, sessionId: row.sessionId, projectPath: row.projectPath || '未标记项目', model: row.model || '未标记模型', eventCount: 0, lastActivity: row.eventTime, ...aggregate([]) });
      const item = map.get(key);
      item.eventCount += 1;
      if (String(row.eventTime) > String(item.lastActivity)) item.lastActivity = row.eventTime;
      item.totalTokens += normalizeNumber(row.totalTokens);
      item.inputTokens += normalizeNumber(row.inputTokens);
      item.outputTokens += normalizeNumber(row.outputTokens);
      item.cacheReadTokens += normalizeNumber(row.cacheReadTokens);
      item.cacheCreationTokens += normalizeNumber(row.cacheCreationTokens);
      item.reasoningTokens += normalizeNumber(row.reasoningOutputTokens);
      item.costUSD += normalizeNumber(row.costUSD);
    }
    return Array.from(map.values()).filter(row => [row.source, row.sessionId, row.projectPath, row.model].some(value => String(value).toLowerCase().includes(search.toLowerCase()))).sort((a, b) => b.totalTokens - a.totalTokens);
  }, [timeRows, startDate, endDate, selectedSources, search]);
  const aggregateCount = fallbackSessions.filter(row => selectedSources.size === 0 || selectedSources.has(row.source)).length;
  return (
    <div className="page-stack">
      <section className="panel sessions-panel">
        <div className="section-heading usage-heading">
          <div><h2>会话</h2><p>仅展示事件记录中可确认 session_id 的真实会话</p></div>
          <label className="search-box"><MagnifyingGlass size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索来源、项目、模型或会话 ID…" /></label>
        </div>
        {sessions === null ? (
          <div className="chart-empty"><ArrowsClockwise className="spin" size={22} />正在读取事件级会话…</div>
        ) : sessions.length === 0 ? (
          <div className="empty-state"><ChatsCircle size={34} /><strong>当前周期没有可确认的真实会话</strong><span>数据库仍保留 {aggregateCount} 条工作区/模型聚合记录，但这里不会把聚合记录伪装成会话。</span></div>
        ) : (
          <div className="data-table-wrap">
            <table className="modern-table">
              <thead><tr><th>来源</th><th>项目 / 会话</th><th>模型</th><th>事件</th><th className="num">Total</th><th className="num">费用</th><th>最后活动</th></tr></thead>
              <tbody>{sessions.map(row => <tr key={`${row.source}-${row.sessionId}`}><td><SourceIdentity source={row.source} /></td><td><strong className="truncate" title={row.projectPath}>{row.projectPath}</strong><small className="mono truncate" title={row.sessionId}>{row.sessionId}</small></td><td><span className="mono truncate" title={row.model}>{row.model}</span></td><td>{row.eventCount}</td><td className="num strong">{U.compactCN(row.totalTokens)}</td><td className="num">{U.fmtUS.format(row.costUSD)}</td><td>{U.formatTs(row.lastActivity)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
      <div className="coverage-note"><Info size={16} /><span>Claude、Codex、OpenCode 等提供事件明细的来源可以形成真实会话；只提供日汇总的来源仍可在“用量拆解”查看，但不会出现在此表。</span></div>
    </div>
  );
}

function QuotaView({ quota, runs }) {
  const providers = quotaProvidersFrom(quota);
  const latestBySource = new Map();
  for (const run of runs) if (!latestBySource.has(run.source)) latestBySource.set(run.source, run);
  return (
    <div className="page-stack">
      <section className="panel quota-page-panel">
        <div className="section-heading"><div><h2>额度</h2><p>来自本机登录凭证的当前窗口快照，不写入 SQLite 历史</p></div></div>
        {providers.length === 0 ? (
          <div className="empty-state"><Gauge size={36} /><strong>暂时没有可读取的额度</strong><span>连接 Claude 或 Codex 后，这里会自动展示当前窗口、使用率与重置时间。</span></div>
        ) : (
          <div className="quota-provider-grid">{providers.map(provider => <QuotaProviderCard key={provider.id} provider={provider} />)}</div>
        )}
      </section>
      <section className="panel collection-panel">
        <div className="section-heading"><div><h2>采集状态</h2><p>每个工具最近一次采集结果</p></div></div>
        <div className="collection-grid">
          {Array.from(latestBySource.values()).map(run => (
            <div className="collection-card" key={run.source}>
              <SourceIdentity source={run.source} />
              <span className={`status-pill ${collectionStatusMeta(run).tone}`}>{collectionStatusMeta(run).label}</span>
              <strong>{U.formatTs(run.collectedAt)}</strong>
              <small title={run.message}>{run.message || '采集完成'}</small>
            </div>
          ))}
        </div>
      </section>
      <div className="coverage-note"><Info size={16} /><span>如果后续需要额度消耗速度和历史曲线，再新增独立快照表即可；当前版本没有迁移或改写旧 SQLite。</span></div>
    </div>
  );
}

function collectionStatusMeta(run) {
  if (run.status === 'ok') {
    const age = Date.now() - new Date(String(run.collectedAt).replace(' ', 'T')).getTime();
    if (Number.isFinite(age) && age > 7 * 86400000) return { tone: 'neutral', label: '历史' };
    return { tone: 'ok', label: '正常' };
  }
  if (run.status === 'empty') return { tone: 'neutral', label: '无数据' };
  return { tone: 'error', label: '异常' };
}

function QuotaProviderCard({ provider }) {
  const windows = provider.data.windows || [];
  return (
    <article className="quota-provider-card">
      <div className="provider-head"><div><img src={provider.logo} alt="" /><span><strong>{provider.name}</strong><small>{provider.data.account?.plan || '当前账户'}</small></span></div>{provider.data.ok ? <span className="status-pill ok">已连接</span> : <span className="status-pill error">读取失败</span>}</div>
      {windows.length ? windows.map(window => {
        const used = Math.round(normalizeNumber(window.utilization) * 100);
        return <div className="quota-window" key={window.name}><div><strong>{QUOTA_WINDOW_LABELS[window.name] || window.name}</strong><span>{used}% 已使用</span></div><progress value={used} max="100" /><small>{formatReset(window.resetsAt)}</small></div>;
      }) : <div className="small-empty">{provider.data.status === 'expired' ? '登录已过期，请重新登录对应工具' : '暂时无法读取额度窗口'}</div>}
    </article>
  );
}
