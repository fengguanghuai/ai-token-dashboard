import { useMemo, useState } from 'react';
import { DownloadSimple, MagnifyingGlass } from '@phosphor-icons/react';
import { U } from '../../shared/utils.js';
import { groupRows, exportDaily, SourceIdentity, TokenComposition } from '../view-utils.jsx';

export default function UsageView({ daily, totals, sessionAggregates, announce }) {
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
