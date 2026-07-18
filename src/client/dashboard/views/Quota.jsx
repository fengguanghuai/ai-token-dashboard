import { Gauge, Info } from '@phosphor-icons/react';
import { U } from '../../shared/utils.js';
import { normalizeNumber, formatReset, quotaProvidersFrom, SourceIdentity } from '../view-utils.jsx';

const QUOTA_WINDOW_LABELS = {
  five_hour: '5 小时窗口',
  seven_day: '7 天窗口',
  seven_day_opus: '7 天 · Opus',
  seven_day_sonnet: '7 天 · Sonnet'
};

export default function QuotaView({ quota, runs }) {
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
