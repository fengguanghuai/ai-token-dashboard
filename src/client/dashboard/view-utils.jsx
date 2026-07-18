/* Shared hooks, formatters, and small components used by every dashboard view. */
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { U } from '../shared/utils.js';
import { sourceIcon, sourceIconScale } from './source-icons.js';
import claudeLogo from './icons/claude.svg';
import gptLogo from './icons/gpt.svg';

export function useChart(option, deps = []) {
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

export function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function aggregate(rows) {
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

export function groupRows(rows, getter) {
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

export function rangeLabel(startDate, endDate, rangeId) {
  if (rangeId === 'all') return startDate === endDate ? startDate : `${startDate} ~ ${endDate}`;
  return `${startDate} ~ ${endDate}`;
}

export function shortDate(value) {
  return value ? value.slice(5) : '—';
}

function formatDelta(current, previous) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

export function deltaMeta(current, previous, inverse = false) {
  const value = formatDelta(current, previous);
  if (value == null || !Number.isFinite(value)) return { text: '暂无上周期', tone: 'neutral' };
  const favorable = inverse ? value <= 0 : value >= 0;
  return {
    text: `${value >= 0 ? '↑' : '↓'} ${Math.abs(value).toFixed(1)}%`,
    tone: favorable ? 'good' : 'bad'
  };
}

export function formatReset(iso) {
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

export function quotaProvidersFrom(quota) {
  if (!quota || quota.disabled) return [];
  return [
    { id: 'claude', name: 'Claude', logo: claudeLogo, data: quota.claude },
    { id: 'codex', name: 'Codex', logo: gptLogo, data: quota.codex }
  ].filter(provider => provider.data && ((provider.data.ok && provider.data.windows?.length) || provider.data.status !== 'no_credentials'));
}

export function exportDaily(rows, announce) {
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

export function SourceIdentity({ source }) {
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

export function MetricCard({ icon: Icon, label, value, unit, delta, hint, inverse = false }) {
  const meta = deltaMeta(delta.current, delta.previous, inverse);
  return (
    <article className="metric-card">
      <div className="metric-card-head"><span>{label}</span><Icon size={18} /></div>
      <div className="metric-value"><strong>{value}</strong>{unit && <span>{unit}</span>}</div>
      <div className="metric-foot"><span className={meta.tone}>{meta.text}</span><span>{hint}</span></div>
    </article>
  );
}

export function TokenComposition({ totals }) {
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
