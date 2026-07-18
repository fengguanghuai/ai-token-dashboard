import { useMemo, useState } from 'react';
import { CaretRight, Coins, CurrencyDollar, DownloadSimple, Lightning } from '@phosphor-icons/react';
import { U } from '../../shared/utils.js';
import { sourceIcon, sourceIconScale } from '../source-icons.js';
import { useChart, normalizeNumber, formatReset, quotaProvidersFrom, exportDaily, MetricCard } from '../view-utils.jsx';
import { chartVars } from '../theme.js';

export default function Overview({ daily, totals, previousTotals, dates, rangeId, quota, announce, theme, onInspectSource }) {
  const cacheHit = totals.totalTokens ? (totals.cacheReadTokens / totals.totalTokens) * 100 : 0;
  const previousCacheHit = previousTotals.totalTokens ? (previousTotals.cacheReadTokens / previousTotals.totalTokens) * 100 : 0;
  const quotaProviders = quotaProvidersFrom(quota).filter(provider => provider.data.ok && provider.data.windows?.length);
  return (
    <div className="page-stack">
      <section className={`kpi-band cols-${3 + quotaProviders.length}`} aria-label="核心指标">
        <MetricCard icon={Coins} label="总 Token" value={U.compactCN(totals.totalTokens)} delta={{ current: totals.totalTokens, previous: previousTotals.totalTokens }} hint={rangeId === 'all' ? '全部历史' : '较上周期'} />
        <MetricCard icon={CurrencyDollar} label="估算费用" value={U.fmtUS.format(totals.costUSD)} delta={{ current: totals.costUSD, previous: previousTotals.costUSD }} hint={rangeId === 'all' ? '累计估算' : '较上周期'} inverse />
        <MetricCard icon={Lightning} label="缓存命中率" value={`${cacheHit.toFixed(1)}%`} delta={{ current: cacheHit, previous: previousCacheHit }} hint="cache_read / total" />
        {quotaProviders.map(provider => <QuotaKpi key={provider.id} provider={provider} />)}
      </section>

      <section className="panel trend-panel">
        <div className="section-heading">
          <div><h2>{rangeId === 'all' ? '全部时间用量' : `${dates.length} 天用量`} · 按工具</h2><p>点击图例聚焦单个工具</p></div>
          <button className="icon-button" aria-label="导出当前趋势" onClick={() => exportDaily(daily, announce)}><DownloadSimple size={17} /></button>
        </div>
        <SourceTrendChart rows={daily} dates={dates} theme={theme} />
      </section>

      <ToolCards daily={daily} onInspectSource={onInspectSource} />
    </div>
  );
}

function QuotaKpi({ provider }) {
  const window = provider.data.windows[0];
  const used = Math.round(normalizeNumber(window.utilization) * 100);
  return (
    <article className="metric-card quota-kpi">
      <div className="metric-card-head"><span>{provider.name} 额度</span><img src={provider.logo} alt="" /></div>
      <div className="metric-value"><strong>{100 - used}%</strong><span>剩余</span></div>
      <div className="quota-kpi-bar"><span style={{ width: `${used}%` }} /></div>
      <div className="metric-foot"><span>{formatReset(window.resetsAt)}</span></div>
    </article>
  );
}

function SourceTrendChart({ rows, dates, theme }) {
  const [measure, setMeasure] = useState('tokens');
  const option = useMemo(() => {
    const vars = chartVars();
    const sources = U.sourceBreakdown(rows).map(item => item.source);
    const byDate = new Map(dates.map(date => [date, new Map()]));
    for (const row of rows) {
      if (!byDate.has(row.usageDate)) continue;
      const bucket = byDate.get(row.usageDate);
      const key = row.source || '未标记';
      const value = measure === 'cost' ? normalizeNumber(row.costUSD) : normalizeNumber(row.totalTokens);
      bucket.set(key, (bucket.get(key) || 0) + value);
    }
    const maxTotal = Math.max(1, ...Array.from(byDate.values()).map(bucket => Array.from(bucket.values()).reduce((sum, value) => sum + value, 0)));
    const unit = measure === 'cost' ? 1 : maxTotal >= 1e9 ? 1e9 : maxTotal >= 1e6 ? 1e6 : maxTotal >= 1e3 ? 1e3 : 1;
    const unitLabel = measure === 'cost' ? 'USD' : unit === 1e9 ? 'B' : unit === 1e6 ? 'M' : unit === 1e3 ? 'K' : '';
    return {
      animationDuration: 450,
      grid: { left: 52, right: 20, top: 54, bottom: 64 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: vars.tooltipBg,
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 12 },
        valueFormatter: value => typeof value === 'number'
          ? (measure === 'cost' ? U.fmtUS.format(value) : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }))
          : value
      },
      legend: { top: 4, left: 4, itemWidth: 9, itemHeight: 9, itemGap: 18, textStyle: { color: vars.muted, fontSize: 11 } },
      xAxis: {
        type: 'category',
        data: dates.map(date => date.slice(5)),
        axisLine: { lineStyle: { color: vars.border } },
        axisTick: { show: false },
        axisLabel: { color: vars.muted, fontSize: 10, interval: dates.length > 60 ? Math.ceil(dates.length / 10) : 'auto' }
      },
      yAxis: {
        type: 'value',
        name: unitLabel,
        nameTextStyle: { color: vars.muted, fontSize: 10 },
        splitLine: { lineStyle: { color: vars.grid } },
        axisLabel: { color: vars.muted, fontSize: 10 }
      },
      dataZoom: [{
        type: 'slider',
        height: 18,
        bottom: 10,
        borderColor: vars.border,
        backgroundColor: vars.surface,
        fillerColor: 'rgba(88,101,242,.12)',
        handleStyle: { color: vars.surface, borderColor: vars.accent },
        showDetail: false,
        start: dates.length > 45 ? Math.max(0, 100 - (45 / dates.length) * 100) : 0,
        end: 100
      }],
      series: sources.map(source => ({
        name: source,
        type: 'bar',
        stack: 'usage',
        barMaxWidth: 18,
        itemStyle: { color: U.getSourceColor(source) },
        data: dates.map(date => (byDate.get(date)?.get(source) || 0) / unit)
      }))
    };
  }, [rows, dates, measure, theme]);
  const ref = useChart(option, [option]);
  return (
    <>
      <div className="segmented trend-measure">
        {[['tokens', 'Token'], ['cost', '费用']].map(([id, label]) => (
          <button key={id} className={measure === id ? 'active' : ''} onClick={() => setMeasure(id)}>{label}</button>
        ))}
      </div>
      <div className="chart trend-chart" ref={ref} role="img" aria-label="按工具堆叠的用量趋势图" />
    </>
  );
}

function ToolCards({ daily, onInspectSource }) {
  const breakdown = useMemo(() => {
    const rows = U.sourceBreakdown(daily);
    if (rows.length <= 6) return rows;
    const head = rows.slice(0, 5);
    const tail = rows.slice(5);
    head.push({
      source: `其他 ${tail.length} 个`,
      totalTokens: tail.reduce((sum, row) => sum + row.totalTokens, 0),
      costUSD: tail.reduce((sum, row) => sum + row.costUSD, 0),
      share: tail.reduce((sum, row) => sum + row.share, 0),
      topModel: null,
      aggregated: true
    });
    return head;
  }, [daily]);
  if (breakdown.length === 0) return <div className="panel chart-empty">当前筛选下暂无来源数据</div>;
  return (
    <section className="tool-grid" aria-label="按工具用量">
      {breakdown.map(item => {
        const icon = sourceIcon(item.source);
        return (
          <button key={item.source} className="tool-card" disabled={item.aggregated} onClick={() => onInspectSource(item.source)}>
            <div className="tool-card-head">
              {icon
                ? <img src={icon} alt="" style={{ transform: `scale(${sourceIconScale(item.source)})` }} />
                : <span className="source-dot" style={{ background: U.getSourceColor(item.source) }} />}
              <strong>{item.source}</strong>
              {!item.aggregated && <CaretRight size={14} className="tool-card-go" />}
            </div>
            <div className="tool-card-value num"><strong>{U.compactCN(item.totalTokens)}</strong><span>{U.fmtUS.format(item.costUSD)} · {item.share.toFixed(1)}%</span></div>
            <div className="tool-card-bar"><span style={{ width: `${Math.max(1, item.share)}%`, background: U.getSourceColor(item.source) }} /></div>
            <small>{item.topModel ? `Top 模型 ${item.topModel}` : '多个来源聚合'}</small>
          </button>
        );
      })}
    </section>
  );
}
