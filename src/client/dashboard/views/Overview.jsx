import { useMemo, useState } from 'react';
import {
  CalendarBlank,
  ChartLineUp,
  Coins,
  CurrencyDollar,
  DownloadSimple,
  Info,
  Pulse,
  TrendUp,
  Warning
} from '@phosphor-icons/react';
import { U } from '../../shared/utils.js';
import {
  useChart,
  normalizeNumber,
  aggregate,
  groupRows,
  shortDate,
  formatReset,
  quotaProvidersFrom,
  exportDaily,
  MetricCard,
  TokenComposition
} from '../view-utils.jsx';

export default function Overview({ daily, allDaily, hourly, totals, previousTotals, activeDays, previousActiveDays, dates, rangeId, quota, runs, sessionAggregates, announce }) {
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
