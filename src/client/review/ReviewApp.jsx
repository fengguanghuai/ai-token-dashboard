/* =============================================================
   /review — main app (real data via /api/data)
   ============================================================= */

import { useEffect, useMemo, useState } from 'react';
import { U } from '../shared/utils.js';
import { fetchDailyRange, dailyRangeForFilters } from '../shared/usage-data.js';
import { useRangeQuery } from '../shared/use-range-query.js';
import { RU } from './utils.js';
import { ThemeToggle } from '../shared/ThemeToggle.jsx';
import tokenStudioFlow from '../assets/token-studio-flow.png';
import { HeroSection, ProjectSection, CalendarSection } from './sections-1.jsx';
import { ToolsSection, EfficiencySection, InsightsSection } from './sections-2.jsx';
import './styles.css';

export function ReviewApp() {
  const [periodId, setPeriodId] = useState('month');
  const [dateRange, setDateRange] = useState(null);
  const today = useMemo(() => new Date(), []);
  const period = useMemo(() => RU.getPeriod(periodId, today, dateRange || []), [periodId, today, dateRange]);
  const query = useMemo(() => dailyRangeForFilters({
    startDate: period.prev?.start || period.start, endDate: period.end, compare: false
  }), [period]);
  const state = useRangeQuery(fetchDailyRange, query);
  const data = state.data;
  const error = !data && state.error;
  const loading = !data && !error;
  useEffect(() => {
    if (data?.dateRange) setDateRange(previous => previous?.start === data.dateRange.start && previous?.end === data.dateRange.end ? previous : data.dateRange);
  }, [data?.dateRange]);

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', flexDirection: 'column', gap: 16
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          border: '3px solid var(--rule)', borderTopColor: 'var(--indigo)',
          animation: 'spin 0.8s linear infinite'
        }}/>
        <div style={{color: 'var(--ink-soft)', fontSize: 14}}>加载数据中…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', flexDirection: 'column', gap: 12
      }}>
        <div style={{fontSize: 32}}>⚠️</div>
        <div style={{color: 'var(--ink)', fontWeight: 600}}>数据加载失败</div>
        <div style={{color: 'var(--ink-soft)', fontSize: 13}}>{error}</div>
        <button onClick={state.retry} style={{
          marginTop: 8, padding: '8px 18px', borderRadius: 8,
          border: '1px solid var(--rule)', background: 'var(--paper-2)',
          cursor: 'pointer', fontSize: 13
        }}>重新加载</button>
      </div>
    );
  }

  return <ReviewDashboard rawData={data} period={period} periodId={periodId} setPeriodId={setPeriodId} queryState={state}/>;
}

function ReviewDashboard({ rawData, period, periodId, setPeriodId, queryState }) {
  const prevPeriod = useMemo(() => period.prev
    ? { start: period.prev.start, end: period.prev.end }
    : null, [period]);

  const daily = useMemo(() => RU.filterByPeriod(rawData.daily, period), [rawData, period]);
  const projectDaily = useMemo(() => RU.filterByPeriod(rawData.projectDaily || [], period).filter(row => row.projectPath), [rawData, period]);
  const prevDaily = useMemo(() =>
    prevPeriod ? RU.filterByPeriod(rawData.daily, prevPeriod) : []
  , [rawData, prevPeriod]);

  // Aggregate totals
  const totals = useMemo(() => {
    const total = RU.sumField(daily, 'totalTokens');
    const input = RU.sumField(daily, 'inputTokens');
    const output = RU.sumField(daily, 'outputTokens');
    const cacheRead = RU.sumField(daily, 'cacheReadTokens');
    const cacheCreation = RU.sumField(daily, 'cacheCreationTokens');
    const reasoning = RU.sumField(daily, 'reasoningOutputTokens');
    const cost = RU.sumField(daily, 'costUSD');
    return {
      total, input, output, cacheRead, cacheCreation, reasoning, cost,
      cacheHitRate: total ? (cacheRead / total) * 100 : 0
    };
  }, [daily]);

  const prevTotals = useMemo(() => prevDaily.length ? ({
    total: RU.sumField(prevDaily, 'totalTokens'),
    cost:  RU.sumField(prevDaily, 'costUSD')
  }) : null, [prevDaily]);

  // Hero stat strip
  const heroStats = useMemo(() => {
    const days = RU.dailyTotals(daily, period);
    const active = days.filter(d => d.total > 0);
    const peak = active.length ? [...active].sort((a, b) => b.total - a.total)[0] : null;
    const tools = RU.aggregateBy(daily, 'source').sort((a, b) => b.totalTokens - a.totalTokens);
    const projects = RU.aggregateBy(projectDaily, 'projectPath').filter(p => p.key);
    const topTool = tools[0];
    return {
      activeDays: active.length,
      projectCount: projects.length,
      sourceCount: tools.length,
      peakDay: peak,
      topTool: topTool ? {
        key: topTool.key,
        short: topTool.key.replace(/ CLI| Code/, ''),
        totalTokens: topTool.totalTokens,
        share: (topTool.totalTokens / (totals.total || 1)) * 100
      } : null,
      avgDailyCost: active.length ? totals.cost / active.length : 0
    };
  }, [daily, projectDaily, period, totals]);

  // Insights
  const insights = useMemo(() =>
    RU.buildInsights(daily, period, prevDaily)
  , [daily, period, prevDaily]);

  // Period nav
  const ORDER = ['week', 'month', 'prev', '90d', 'all'];
  const idx = ORDER.indexOf(periodId);
  const prevId = idx > 0 ? ORDER[idx - 1] : null;
  const nextId = idx < ORDER.length - 1 ? ORDER[idx + 1] : null;

  const exportCSV = () => {
    U.downloadCSV(`token-review-${period.start}-${period.end}.csv`, daily, [
      { title: 'date', field: 'usageDate' },
      { title: 'source', field: 'source' },
      { title: 'device', field: 'device' },
      { title: 'model', field: 'model' },
      { title: 'project', field: 'projectPath' },
      { title: 'input', field: 'inputTokens' },
      { title: 'output', field: 'outputTokens' },
      { title: 'cache_read', field: 'cacheReadTokens' },
      { title: 'cache_creation', field: 'cacheCreationTokens' },
      { title: 'reasoning', field: 'reasoningOutputTokens' },
      { title: 'total', field: 'totalTokens' },
      { title: 'cost_usd', field: 'costUSD' }
    ]);
  };

  return (
    <>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <nav className="review-nav">
        <div className="review-nav-inner">
          <div className="brand-line">
            <img className="review-brand-mark" src={tokenStudioFlow} alt="Token Studio" />
            <span className="brand-name">Token Studio</span>
            <div className="page-switch">
              <a href="/" className="page-chip">看板</a>
              <span className="page-chip active">复盘</span>
            </div>
          </div>
          <div className="period-switch">
            {ORDER.map(id => (
              <button key={id}
                className={`period-chip ${periodId === id ? 'active' : ''}`}
                onClick={() => setPeriodId(id)}>
                {RU.PERIOD_LABELS[id]}
              </button>
            ))}
          </div>
          <div className="nav-actions">
            <ThemeToggle className="nav-btn" />
            <button className="nav-btn" disabled={!queryState.ready} onClick={() => window.print()}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <rect x="2.5" y="4.5" width="8" height="6" rx="1" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M4 4.5V2h5v2.5M4 8.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              打印
            </button>
          </div>
        </div>
      </nav>

      {!queryState.ready ? <div className="page" role={queryState.error ? 'alert' : 'status'}>
        {queryState.error ? `复盘加载失败：${queryState.error}` : '正在加载所选周期的复盘…'}
        {queryState.error && <button className="nav-btn" onClick={queryState.retry}>重试</button>}
      </div> : <>
      <div className="page">
        {daily.some(r => r.reconciliation && r.reconciliation !== 'matched') && <p className="section-sub" role="note">部分历史汇总与事件明细尚未核对一致。已有费用已保留，不能按当前价格快照解释为当时账单。</p>}
        <HeroSection period={period} totals={totals} prevTotals={prevTotals} stats={heroStats}/>
      </div>

      <div className="page">
        <p className="section-sub">项目归属来自事件明细。{U.compactCN(Math.max(0, totals.total - RU.sumField(projectDaily, 'totalTokens')))} Token 暂无可核对的项目归属；项目费用可能与保留的历史汇总金额不同。</p>
        <ProjectSection daily={projectDaily} totalTokens={totals.total}/>
      </div>

      <div className="page-wide">
        <div style={{maxWidth: 780, margin: '0 auto', padding: '0'}}>
          <CalendarSection daily={daily} period={period}/>
        </div>
      </div>

      <div className="page-wide">
        <div style={{maxWidth: 780, margin: '0 auto'}}>
          <ToolsSection daily={daily} totalTokens={totals.total}/>
        </div>
      </div>

      <div className="page">
        <EfficiencySection daily={daily} period={period}/>
      </div>

      <div className="page">
        <InsightsSection insights={insights}/>
      </div>

      <footer className="review-footer">
        <div className="review-footer-inner">
          <div className="period-jump">
            <button disabled={!prevId} onClick={() => prevId && setPeriodId(prevId)}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M8 2l-4 4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {prevId ? RU.PERIOD_LABELS[prevId] : '更早'}
            </button>
            <div className="period-current">{period.pretty}</div>
            <button disabled={!nextId} onClick={() => nextId && setPeriodId(nextId)}>
              {nextId ? RU.PERIOD_LABELS[nextId] : '更晚'}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
          <button className="export-btn" onClick={exportCSV}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 1v8M4 6l3 3 3-3M2 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            导出 CSV
          </button>
        </div>
      </footer>
      </>}
    </>
  );
}
