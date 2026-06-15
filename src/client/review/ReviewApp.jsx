/* =============================================================
   /review — main app (real data via /api/data)
   ============================================================= */

import { useEffect, useMemo, useState } from 'react';
import { U } from '../shared/utils.js';
import { RU } from './utils.js';
import { HeroSection, ProjectSection, CalendarSection } from './sections-1.jsx';
import { ToolsSection, EfficiencySection, InsightsSection } from './sections-2.jsx';
import './styles.css';

export function ReviewApp() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/data')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

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
        <button onClick={() => window.location.reload()} style={{
          marginTop: 8, padding: '8px 18px', borderRadius: 8,
          border: '1px solid var(--rule)', background: 'var(--paper-2)',
          cursor: 'pointer', fontSize: 13
        }}>重新加载</button>
      </div>
    );
  }

  return <ReviewDashboard rawData={data}/>;
}

function ReviewDashboard({ rawData }) {
  const TODAY = new Date();
  TODAY.setHours(0, 0, 0, 0);

  const [periodId, setPeriodId] = useState('month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const period = useMemo(() => RU.getPeriod(periodId, TODAY, rawData.daily, customStart, customEnd), [periodId, rawData.daily, customStart, customEnd]);
  const prevPeriod = useMemo(() => period.prev
    ? { start: period.prev.start, end: period.prev.end }
    : null, [period]);

  const daily = useMemo(() => RU.filterByPeriod(rawData.daily, period), [rawData, period]);
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
    const projects = RU.aggregateBy(daily, 'projectPath').filter(p => p.key);
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
  }, [daily, period, totals]);

  // Insights
  const insights = useMemo(() =>
    RU.buildInsights(daily, period, prevDaily)
  , [daily, period, prevDaily]);

  // Period nav
  const ORDER = ['today', 'week', 'month', 'prev', '90d', 'all', 'custom'];
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
            <span className="brand-dot"/>
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
          {periodId === 'custom' && (
            <div className="custom-dates">
              <input type="date" className="custom-date-input"
                value={customStart}
                max={customEnd || undefined}
                onChange={e => {
                  setCustomStart(e.target.value);
                  if (periodId !== 'custom') setPeriodId('custom');
                }} />
              <span className="custom-date-sep">至</span>
              <input type="date" className="custom-date-input"
                value={customEnd}
                min={customStart || undefined}
                onChange={e => {
                  setCustomEnd(e.target.value);
                  if (periodId !== 'custom') setPeriodId('custom');
                }} />
            </div>
          )}
          <div className="nav-actions">
            <button className="nav-btn" onClick={() => window.print()}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <rect x="2.5" y="4.5" width="8" height="6" rx="1" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M4 4.5V2h5v2.5M4 8.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              打印
            </button>
          </div>
        </div>
      </nav>

      <div className="page">
        <HeroSection period={period} totals={totals} prevTotals={prevTotals} stats={heroStats}/>
      </div>

      <div className="page">
        <ProjectSection daily={daily} totalTokens={totals.total}/>
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
    </>
  );
}
