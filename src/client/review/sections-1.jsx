/* =============================================================
   Review-page sections — Hero, Projects, Calendar
   ============================================================= */

import { useMemo, useState } from 'react';
import { U } from '../shared/utils.js';
import { RU } from './utils.js';

// ───────────────────────────────────────────────────────────────
// Hero / opening
// ───────────────────────────────────────────────────────────────
function HeroSection({ period, totals, prevTotals, stats }) {
  const delta = prevTotals && prevTotals.total > 0
    ? ((totals.total - prevTotals.total) / prevTotals.total) * 100
    : null;
  const deltaUp = delta != null && delta > 0;

  return (
    <section className="hero">
      <div className="hero-eyebrow">
        <span>AI TOKEN 复盘</span>
        <span className="sep"/>
        <span>{period.pretty}</span>
      </div>

      <h1 className="hero-headline">
        {period.label}，你用了 <span className="num">{U.compactCN(totals.total)}</span> tokens
      </h1>

      <p className="hero-sub">
        折合费用 <b style={{color: 'var(--ink)', fontVariantNumeric: 'tabular-nums'}}>{U.fmtUS.format(totals.cost)}</b>
        {delta != null && (
          <>
            ，比上一周期
            <span className={`delta ${deltaUp ? 'up' : 'down'}`} style={{marginLeft: 6}}>
              {deltaUp ? '↑' : '↓'} {Math.abs(delta).toFixed(0)}%
            </span>
          </>
        )}
      </p>

      <div className="hero-meta">
        花在了
        <b>{stats.projectCount}</b> 个项目、
        <b>{stats.sourceCount}</b> 种工具、
        <b>{stats.activeDays}</b> 个活跃天上
      </div>

      <div className="stat-strip">
        <div className="stat-cell">
          <div className="l">最高单日</div>
          <div className="v">{stats.peakDay ? U.compactCN(stats.peakDay.total) : '—'}</div>
          <div className="s">{stats.peakDay ? stats.peakDay.date : '—'}</div>
        </div>
        <div className="stat-cell">
          <div className="l">最常用工具</div>
          <div className="v" style={{color: 'var(--ink)'}}>
            {stats.topTool ? stats.topTool.short : '—'}
          </div>
          <div className="s">
            <span style={{display: 'inline-flex', alignItems: 'center', gap: 5}}>
              <span style={{width:6, height:6, borderRadius:'50%', background: U.getSourceColor(stats.topTool?.key)}}/>
              {stats.topTool ? `${stats.topTool.share.toFixed(0)}% · ${U.compactCN(stats.topTool.totalTokens)}` : '—'}
            </span>
          </div>
        </div>
        <div className="stat-cell">
          <div className="l">缓存命中率</div>
          <div className="v">{totals.cacheHitRate.toFixed(0)}<span style={{fontSize: 18, color: 'var(--ink-3)'}}>%</span></div>
          <div className="s">节省约 {Math.round(totals.cacheHitRate / 5)}× 重复计算</div>
        </div>
        <div className="stat-cell">
          <div className="l">日均费用</div>
          <div className="v">{U.fmtUS.format(stats.avgDailyCost)}</div>
          <div className="s">{stats.activeDays} 天 / {U.fmtUS.format(totals.cost)}</div>
        </div>
      </div>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────
// Project bars
// ───────────────────────────────────────────────────────────────
function ProjectSection({ daily, totalTokens }) {
  const agg = useMemo(() => {
    const list = RU.aggregateBy(daily, 'projectPath').sort((a, b) => b.totalTokens - a.totalTokens);
    if (list.length <= 8) return list;
    const top = list.slice(0, 7);
    const rest = list.slice(7);
    const restTotal = rest.reduce((s, x) => s + x.totalTokens, 0);
    const restCost  = rest.reduce((s, x) => s + x.costUSD, 0);
    return [...top, {
      key: '（其他 ' + rest.length + ' 个项目）',
      totalTokens: restTotal,
      costUSD: restCost,
      dayCount: 0,
      isRest: true
    }];
  }, [daily]);

  const max = agg[0]?.totalTokens || 1;
  const maxCost = Math.max(...agg.map(a => a.costUSD), 1);

  const narrative = useMemo(() => RU.narrativeForProjects(agg, totalTokens, daily), [agg, totalTokens, daily]);

  if (!agg.length) return null;

  const colorFor = (cost) => {
    // shade: more cost = deeper indigo
    const t = Math.min(1, cost / maxCost);
    const L = 0.78 - t * 0.30;
    const C = 0.05 + t * 0.13;
    return `oklch(${L} ${C} 265)`;
  };

  return (
    <section className="story">
      <div className="section-label">02 · 项目</div>
      <h2 className="section-title">按项目看，钱主要花在这里</h2>
      <p className="section-sub">条形长度代表 token 占比，颜色深浅代表费用大小。Token 与费用并不总是同步——重读 cache 的项目消耗大但成本低。</p>

      <div className="proj-list">
        {agg.map((p, i) => {
          const pct = (p.totalTokens / (totalTokens || 1)) * 100;
          return (
            <div key={p.key} className="proj-row">
              <div className="proj-rank">{String(i + 1).padStart(2, '0')}</div>
              <div className="proj-body">
                <div className="proj-head">
                  <span className="proj-name" title={p.key}>{p.key}</span>
                  <span className="proj-meta">
                    {!p.isRest && p.dayCount + ' 活跃天 · '}
                    {pct.toFixed(1)}%
                  </span>
                </div>
                <div className="proj-bar">
                  <div className="proj-bar-fill"
                    style={{
                      width: `${(p.totalTokens / max) * 100}%`,
                      background: colorFor(p.costUSD)
                    }}/>
                </div>
              </div>
              <div className="proj-val">
                <div className="big">{U.compactCN(p.totalTokens)}</div>
                <div className="small">{p.costUSD > 0 ? U.fmtUS.format(p.costUSD) : '免费'}</div>
              </div>
            </div>
          );
        })}
      </div>

      {narrative && (
        <div className="pullquote">
          <code>{narrative.top.key}</code> 是这个周期消耗最大的项目，占总量的 <b>{narrative.share.toFixed(0)}%</b>，
          主要使用 <code>{narrative.topModel}</code> 模型，cache 命中率 <b>{narrative.cacheRate}%</b>
          {narrative.cacheRate > 60 ? '——说明你在这个项目里反复在同一上下文工作。'
            : narrative.cacheRate < 30 ? '——上下文切换频繁，每次都重新喂入大量信息。'
            : '，上下文复用程度中等。'}
        </div>
      )}
    </section>
  );
}

// ───────────────────────────────────────────────────────────────
// Calendar heatmap
// ───────────────────────────────────────────────────────────────
function CalendarSection({ daily, period }) {
  const days = useMemo(() => RU.dailyTotals(daily, period), [daily, period]);
  const dayMap = useMemo(() => new Map(days.map(d => [d.date, d])), [days]);
  const months = useMemo(() => RU.monthsInPeriod(period), [period]);
  const max = useMemo(() => Math.max(...days.map(d => d.total), 1), [days]);

  const peaks = useMemo(() => RU.findPeaks(days, 3), [days]);

  const [tip, setTip] = useState(null);
  const onEnter = (e, cell) => {
    if (!cell || cell.total === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const topTool = Object.entries(cell.byTool).sort((a, b) => b[1] - a[1])[0];
    setTip({
      x: rect.left + rect.width / 2,
      y: rect.top,
      date: cell.date,
      total: cell.total,
      tool: topTool ? topTool[0] : null,
      toolShare: topTool ? (topTool[1] / cell.total) * 100 : 0
    });
  };
  const onLeave = () => setTip(null);

  const DOW = ['日', '一', '二', '三', '四', '五', '六'];

  return (
    <section className="story">
      <div className="section-label">03 · 时间线</div>
      <h2 className="section-title">用量高峰出现在这几天</h2>
      <p className="section-sub">日历视图按天展示 token 消耗，颜色越深消耗越大。鼠标悬停可以看当天明细。</p>

      <div className="calendar">
        <div className="cal-months">
          {months.map(({ year, month }) => {
            const cells = RU.buildMonthGrid(year, month, dayMap);
            const weekCount = cells.length / 7;
            return (
              <div className="cal-month" key={`${year}-${month}`}>
                <div className="cal-month-label">{year} · {String(month + 1).padStart(2, '0')}</div>
                <div className="cal-weeks" style={{
                  gridTemplateColumns: 'repeat(7, 14px)',
                  gridTemplateRows: `12px repeat(${weekCount}, 14px)`
                }}>
                  {DOW.map((d, i) => <div key={i} className="cal-dow">{d}</div>)}
                  {cells.map((c, i) => (
                    <div key={i} className="cal-cell"
                      style={{
                        background: c ? RU.heatColor(c.total / max) : 'transparent',
                        visibility: c ? 'visible' : 'hidden'
                      }}
                      onMouseEnter={c ? (e) => onEnter(e, c) : undefined}
                      onMouseLeave={onLeave}/>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="cal-scale">
          少
          <span className="cal-scale-cells">
            {[0, 0.15, 0.3, 0.5, 0.75, 1].map((t, i) => (
              <span key={i} style={{background: RU.heatColor(t)}}/>
            ))}
          </span>
          多
        </div>
      </div>

      {tip && (
        <div className="cal-tip" style={{left: tip.x, top: tip.y}}>
          <b>{tip.date}</b>
          <span style={{margin: '0 6px'}}>·</span>
          {U.compactCN(tip.total)} tokens
          {tip.tool && (
            <span className="dim">主要 · {tip.tool} ({tip.toolShare.toFixed(0)}%)</span>
          )}
        </div>
      )}

      {peaks.length > 0 && (
        <div className="peaks">
          {peaks.map((p, i) => {
            const topTool = Object.entries(p.byTool).sort((a, b) => b[1] - a[1])[0];
            const topProject = RU.aggregateBy(daily.filter(r => r.usageDate === p.date), 'projectPath')
              .sort((a, b) => b.totalTokens - a.totalTokens)[0];
            return (
              <div className="peak-row" key={p.date}>
                <div className="peak-rank">{String(i + 1).padStart(2, '0')}</div>
                <div className="peak-date">{p.date}</div>
                <div className="peak-detail">
                  {topProject && (
                    <>主要项目 <b>{topProject.key}</b><span className="arrow">→</span></>
                  )}
                  {topTool && <>工具 <b>{topTool[0]}</b></>}
                </div>
                <div className="peak-total">{U.compactCN(p.total)}</div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export { HeroSection, ProjectSection, CalendarSection };
