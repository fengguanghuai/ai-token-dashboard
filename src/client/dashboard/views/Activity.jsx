import { useMemo } from 'react';
import { CalendarBlank, Clock, Info, Pulse, TrendUp, Warning } from '@phosphor-icons/react';
import { U } from '../../shared/utils.js';
import { useChart, normalizeNumber, shortDate, MetricCard } from '../view-utils.jsx';

export default function ActivityView({ daily, hourly, dates, hourlyError }) {
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
