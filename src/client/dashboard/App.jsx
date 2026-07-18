import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowsClockwise,
  BookOpenText,
  CalendarBlank,
  CaretDown,
  ChartBar,
  ChatsCircle,
  CheckCircle,
  Database,
  Fire,
  Funnel,
  Gauge,
  Moon,
  SquaresFour,
  Sun,
  Warning,
  X
} from '@phosphor-icons/react';
import { U } from '../shared/utils.js';
import { aggregate, normalizeNumber, SourceIdentity } from './view-utils.jsx';
import { initTheme, setTheme } from './theme.js';
import Overview from './views/Overview.jsx';
import ActivityView from './views/Activity.jsx';
import UsageView from './views/Usage.jsx';
import SessionsView from './views/Sessions.jsx';
import QuotaView from './views/Quota.jsx';
import './styles.css';

const NAV_ITEMS = [
  { id: 'overview', label: '概览', icon: SquaresFour },
  { id: 'activity', label: '活跃度', icon: Fire },
  { id: 'usage', label: '用量拆解', icon: ChartBar },
  { id: 'sessions', label: '会话', icon: ChatsCircle },
  { id: 'quota', label: '额度', icon: Gauge }
];

const RANGE_OPTIONS = [
  { id: 'today', label: '今天', days: 1 },
  { id: '7d', label: '过去 7 天', days: 7 },
  { id: '14d', label: '过去 14 天', days: 14 },
  { id: '30d', label: '过去 30 天', days: 30 },
  { id: '90d', label: '过去 90 天', days: 90 },
  { id: 'all', label: '全部', days: null }
];

function fetchJson(url, options) {
  return fetch(url, options).then(async response => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 202) {
      throw new Error(body.error || body.message || `HTTP ${response.status}`);
    }
    return body;
  });
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
  const [customRange, setCustomRange] = useState(null); // { start, end } | null
  const [selectedSources, setSelectedSources] = useState(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [theme, setThemeState] = useState(() => initTheme());
  const toastTimer = useRef(null);

  const allDates = useMemo(() => Array.from(new Set(data.daily.map(row => row.usageDate).filter(Boolean))).sort(), [data.daily]);
  const firstDate = allDates[0] || U.daysAgo(0);
  const lastDate = allDates[allDates.length - 1] || U.daysAgo(0);
  const range = RANGE_OPTIONS.find(option => option.id === rangeId) || RANGE_OPTIONS[3];
  const startDate = customRange ? customRange.start : (range.days ? U.addDays(lastDate, -(range.days - 1)) : firstDate);
  const endDate = customRange ? customRange.end : lastDate;

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setThemeState(next);
  };
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

  const inspectSource = useCallback(source => {
    setSelectedSources(new Set([source]));
    setActiveView('usage');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    announce(`已聚焦 ${source}`);
  }, [announce]);

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
    announce,
    theme
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => changeView('overview')} aria-label="返回概览">
          <span className="brand-mark">TS</span>
          <span><strong>Token Studio</strong><small>AI Token 看板</small></span>
        </button>
        <nav aria-label="主导航" style={{ display: 'contents' }}>
          {NAV_ITEMS.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`nav-item ${activeView === item.id ? 'active' : ''}`}
                onClick={() => changeView(item.id)}
                aria-current={activeView === item.id ? 'page' : undefined}
              >
                <Icon size={17} />{item.label}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-spacer" />
        <a className="nav-item" href="/review"><BookOpenText size={17} />复盘</a>
        <button className="nav-item" onClick={toggleTheme} aria-label="切换主题">
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}{theme === 'dark' ? '亮色模式' : '暗色模式'}
        </button>
      </aside>

      <div className="content-area">
        <header className="topbar">
          <div className="sync-status" title={collectStatus?.message || ''}>
            <span className={collectStatus?.type === 'error' ? 'error' : ''} />
            最后同步 <strong>{lastSync}</strong>
          </div>
          <button className="primary" disabled={collecting || refreshing} onClick={onCollect}>
            <Database size={17} />{collecting ? '采集中' : '采集'}
          </button>
          <button className="outline-button" disabled={refreshing || collecting} onClick={onRefresh}>
            <ArrowsClockwise size={17} className={refreshing ? 'spin' : ''} />刷新
          </button>
        </header>

        <div className="command-row">
        <div className="range-wrap">
          <CalendarBlank size={18} />
          <select
            value={customRange ? 'custom' : rangeId}
            onChange={event => {
              if (event.target.value === 'custom') return;
              setCustomRange(null);
              setRangeId(event.target.value);
            }}
            aria-label="时间范围"
          >
            {RANGE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            {customRange && <option value="custom">自定义区间</option>}
          </select>
          <CaretDown size={14} aria-hidden="true" />
        </div>
        <div className="date-inputs">
          <input type="date" value={startDate} max={endDate} onChange={event => event.target.value && setCustomRange({ start: event.target.value, end: endDate })} aria-label="开始日期" />
          <span>~</span>
          <input type="date" value={endDate} min={startDate} onChange={event => event.target.value && setCustomRange({ start: startDate, end: event.target.value })} aria-label="结束日期" />
        </div>
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

        {activeView === 'overview' && <Overview {...common} onInspectSource={inspectSource} />}
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
