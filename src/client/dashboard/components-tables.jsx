/* =============================================================
   Tables — sortable, searchable, drill-down rows
   ============================================================= */

import { useEffect, useMemo, useState } from 'react';
import { U } from '../shared/utils.js';

// Generic data table
function DataTable({ rows, columns, initialSort, search, onSearch, onRowClick, selectedKey, getKey, height, emptyText }) {
  const [sortBy, setSortBy] = useState(initialSort || { field: null, dir: 'desc' });

  const filtered = useMemo(() => {
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter(r =>
      columns.some(c => {
        const v = typeof c.value === 'function' ? c.value(r) : r[c.field];
        return String(v ?? '').toLowerCase().includes(q);
      })
    );
  }, [rows, columns, search]);

  const sorted = useMemo(() => {
    if (!sortBy.field) return filtered;
    const arr = [...filtered];
    const col = columns.find(c => c.field === sortBy.field);
    if (!col) return arr;
    arr.sort((a, b) => {
      const va = typeof col.value === 'function' ? col.value(a) : a[col.field];
      const vb = typeof col.value === 'function' ? col.value(b) : b[col.field];
      if (typeof va === 'number' && typeof vb === 'number') return sortBy.dir === 'asc' ? va - vb : vb - va;
      const sa = String(va ?? '').toLowerCase();
      const sb = String(vb ?? '').toLowerCase();
      return sortBy.dir === 'asc' ? sa.localeCompare(sb) : sb.localeCompare(sa);
    });
    return arr;
  }, [filtered, sortBy, columns]);

  const toggleSort = (field) => {
    setSortBy(prev =>
      prev.field === field
        ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { field, dir: 'desc' }
    );
  };

  return (
    <div className="table-wrap" style={{maxHeight: height, overflow: 'auto'}}>
      <table className="dt">
        <thead>
          <tr>
            {columns.map(c => (
              <th key={c.field || c.title}
                onClick={() => c.sortable !== false && toggleSort(c.field)}
                className={sortBy.field === c.field ? 'sorted' : ''}
                style={{
                  width: c.width,
                  textAlign: c.hozAlign === 'right' ? 'right' : 'left',
                  cursor: c.sortable === false ? 'default' : 'pointer'
                }}>
                {c.title}
                {c.sortable !== false && (
                  <span className="sort-ind">
                    {sortBy.field === c.field ? (sortBy.dir === 'asc' ? '▲' : '▼') : '▾'}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr><td colSpan={columns.length} style={{textAlign:'center', padding:'30px', color:'var(--muted)'}}>{emptyText || '暂无数据'}</td></tr>
          )}
          {sorted.map((r, i) => {
            const k = getKey ? getKey(r) : i;
            return (
              <tr key={k}
                className={selectedKey === k ? 'selected' : ''}
                onClick={() => onRowClick?.(r)}>
                {columns.map(c => (
                  <td key={c.field || c.title}
                    style={{textAlign: c.hozAlign === 'right' ? 'right' : 'left'}}>
                    {c.render ? c.render(r) : (typeof c.value === 'function' ? c.value(r) : r[c.field])}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Combined tabbed table panel
// ───────────────────────────────────────────────────────────────
function TablePanel({ daily, sessions, runs, sources, totalTokens, onDrill }) {
  const [tab, setTab] = useState('sources');
  const [search, setSearch] = useState('');
  const formatRunTime = r => U.formatTs(r.collectedAt);

  // Aggregate by source
  const bySource = useMemo(() => {
    const m = new Map();
    for (const r of daily) {
      const k = `${r.source}::${r.device}`;
      if (!m.has(k)) m.set(k, { source: r.source, device: r.device, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0, models: new Set() });
      const x = m.get(k);
      x.totalTokens += r.totalTokens;
      x.inputTokens += r.inputTokens;
      x.outputTokens += r.outputTokens;
      x.cacheReadTokens += r.cacheReadTokens;
      x.costUSD += r.costUSD;
      x.models.add(r.model);
    }
    return Array.from(m.values()).map(x => ({...x, modelCount: x.models.size}));
  }, [daily]);

  const byModel = useMemo(() => {
    const m = new Map();
    for (const r of daily) {
      const k = `${r.source}::${r.model}`;
      if (!m.has(k)) m.set(k, { source: r.source, model: r.model, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0, days: new Set() });
      const x = m.get(k);
      x.totalTokens += r.totalTokens;
      x.inputTokens += r.inputTokens;
      x.outputTokens += r.outputTokens;
      x.cacheReadTokens += r.cacheReadTokens;
      x.costUSD += r.costUSD;
      x.days.add(r.usageDate);
    }
    return Array.from(m.values()).map(x => ({...x, dayCount: x.days.size}));
  }, [daily]);

  const TABS = [
    { id: 'sources', label: '来源 / 设备', count: bySource.length },
    { id: 'models',  label: '模型',        count: byModel.length },
    { id: 'sessions', label: '项目 / 会话', count: sessions.length },
    { id: 'runs',    label: '采集记录',    count: runs.length }
  ];

  // Columns per tab
  const sourceColumns = [
    { field: 'source', title: '来源', render: r => (
      <span className="tag"><span className="tag-dot" style={{background: U.getSourceColor(r.source)}}/>{r.source}</span>
    )},
    { field: 'device', title: '设备', render: r => <span className="muted" style={{fontSize:11.5}}>{r.device}</span> },
    { field: 'modelCount', title: '模型', hozAlign: 'right', render: r => r.modelCount, width: 70 },
    { field: 'totalTokens', title: 'Total', hozAlign: 'right', render: r => (
      <span className="num-strong">{U.fmt.format(r.totalTokens)}</span>
    ), width: 130 },
    { field: 'share', title: '占比', hozAlign: 'left',
      value: r => r.totalTokens / (totalTokens || 1),
      render: r => {
        const p = (r.totalTokens / (totalTokens || 1)) * 100;
        return (
          <span>
            <span className="share-bar"><span style={{width: `${Math.min(100, p)}%`, background: U.getSourceColor(r.source)}}/></span>
            <span className="share-pct">{p.toFixed(1)}%</span>
          </span>
        );
      }, width: 180
    },
    { field: 'inputTokens', title: 'Input', hozAlign: 'right', render: r => U.compact(r.inputTokens), width: 80 },
    { field: 'outputTokens', title: 'Output', hozAlign: 'right', render: r => U.compact(r.outputTokens), width: 80 },
    { field: 'cacheReadTokens', title: 'Cache', hozAlign: 'right', render: r => U.compact(r.cacheReadTokens), width: 80 },
    { field: 'costUSD', title: '费用', hozAlign: 'right', render: r => (
      r.costUSD > 0 ? <span style={{color:'var(--c-amber)'}}>{U.fmtUS.format(r.costUSD)}</span> : <span className="muted">—</span>
    ), width: 90 }
  ];

  const modelColumns = [
    { field: 'source', title: '来源', render: r => (
      <span className="tag"><span className="tag-dot" style={{background: U.getSourceColor(r.source)}}/>{r.source}</span>
    )},
    { field: 'model', title: '模型', render: r => <span className="mono">{r.model}</span> },
    { field: 'dayCount', title: '活跃天', hozAlign: 'right', render: r => r.dayCount, width: 80 },
    { field: 'inputTokens', title: 'Input', hozAlign: 'right', render: r => U.compact(r.inputTokens), width: 90 },
    { field: 'outputTokens', title: 'Output', hozAlign: 'right', render: r => U.compact(r.outputTokens), width: 90 },
    { field: 'cacheReadTokens', title: 'Cache Read', hozAlign: 'right', render: r => U.compact(r.cacheReadTokens), width: 110 },
    { field: 'totalTokens', title: 'Total', hozAlign: 'right', render: r => (
      <span className="num-strong">{U.fmt.format(r.totalTokens)}</span>
    ), width: 130 },
    { field: 'costUSD', title: '费用', hozAlign: 'right', render: r => (
      r.costUSD > 0 ? <span style={{color:'var(--c-amber)'}}>{U.fmtUS4.format(r.costUSD)}</span> : <span className="muted">—</span>
    ), width: 100 }
  ];

  const sessionColumns = [
    { field: 'source', title: '来源', render: r => (
      <span className="tag"><span className="tag-dot" style={{background: U.getSourceColor(r.source)}}/>{r.source}</span>
    ), width: 130 },
    { field: 'projectPath', title: '项目', render: r => {
      const label = r.projectPath && r.projectPath !== 'Unknown Project'
        ? r.projectPath
        : (r.sessionId ? r.sessionId.split('/').slice(-1)[0] || r.sessionId : '—');
      return <span className="mono" title={r.sessionId || ''}>{label}</span>;
    }},
    { field: 'lastActivity', title: '最后活动', render: r => (
      <span className="muted" style={{fontSize:11.5}}>{r.lastActivity}</span>
    ), width: 130 },
    { field: 'inputTokens', title: 'Input', hozAlign: 'right', render: r => U.compact(r.inputTokens), width: 90 },
    { field: 'outputTokens', title: 'Output', hozAlign: 'right', render: r => U.compact(r.outputTokens), width: 90 },
    { field: 'totalTokens', title: 'Total', hozAlign: 'right', render: r => (
      <span className="num-strong">{U.fmt.format(r.totalTokens)}</span>
    ), width: 130 },
    { field: 'costUSD', title: '费用', hozAlign: 'right', render: r => (
      r.costUSD > 0 ? <span style={{color:'var(--c-amber)'}}>{U.fmtUS4.format(r.costUSD)}</span> : <span className="muted">—</span>
    ), width: 100 }
  ];

  const runColumns = [
    { field: 'collectedAt', title: '时间', render: r => (
      <span className="mono" style={{fontSize: 11.5, color: 'var(--text-2)', whiteSpace: 'nowrap'}}>{formatRunTime(r)}</span>
    ), value: formatRunTime, width: 160 },
    { field: 'source', title: '来源', render: r => (
      <span className="tag"><span className="tag-dot" style={{background: U.getSourceColor(r.source)}}/>{r.source}</span>
    ), width: 140 },
    { field: 'device', title: '设备', render: r => <span className="muted">{r.device}</span>, width: 200 },
    { field: 'status', title: '状态', render: r => (
      <span className={`status-badge status-${r.status}`}>{r.status}</span>
    ), width: 90 },
    { field: 'message', title: '说明', render: r => (
      <span title={r.message} style={{
        color: 'var(--text-2)', fontSize: 12,
        display: 'block', overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        maxWidth: 380
      }}>{r.message}</span>
    )}
  ];

  let columns, rows, initialSort, emptyText;
  if (tab === 'sources')  { columns = sourceColumns;  rows = bySource;  initialSort = { field: 'totalTokens', dir: 'desc' }; emptyText = '当前筛选下无来源'; }
  if (tab === 'models')   { columns = modelColumns;   rows = byModel;   initialSort = { field: 'totalTokens', dir: 'desc' }; emptyText = '当前筛选下无模型'; }
  if (tab === 'sessions') { columns = sessionColumns; rows = sessions;  initialSort = { field: 'totalTokens', dir: 'desc' }; emptyText = '暂无会话数据'; }
  if (tab === 'runs')     { columns = runColumns;     rows = runs;      initialSort = { field: 'collectedAt', dir: 'desc' }; emptyText = '暂无采集记录'; }

  const exportCSV = () => {
    U.downloadCSV(`tokens-${tab}-${U.daysAgo(0)}.csv`, rows, columns);
  };

  return (
    <div className="panel">
      <div className="panel-header" style={{marginBottom: 14}}>
        <div className="panel-tabs">
          {TABS.map(t => (
            <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => { setTab(t.id); setSearch(''); }}>
              {t.label} <span style={{opacity:0.55, marginLeft:4}}>{t.count}</span>
            </button>
          ))}
        </div>
        <div className="panel-actions">
          <input className="search-input" placeholder="搜索..." value={search} onChange={e => setSearch(e.target.value)}/>
          <button className="btn" onClick={exportCSV}>
            <svg className="icon" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            CSV
          </button>
        </div>
      </div>
      <DataTable
        key={tab}
        rows={rows}
        columns={columns}
        initialSort={initialSort}
        search={search}
        height={420}
        emptyText={emptyText}
        getKey={r => r.sessionId || `${r.source}-${r.model || ''}-${r.device || ''}-${r.collectedAt || ''}`}
        onRowClick={r => onDrill?.({ kind: tab.slice(0,-1), row: r })}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Drawer — drill-down panel
// ───────────────────────────────────────────────────────────────
function DrillDrawer({ drill, daily, onClose }) {
  const open = !!drill;

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const detail = useMemo(() => {
    if (!drill) return null;
    const { kind, row } = drill;
    let title = '', sub = '', filterFn = () => true;
    if (kind === 'source') { title = row.source; sub = row.device; filterFn = r => r.source === row.source && r.device === row.device; }
    if (kind === 'model')  { title = row.model;  sub = row.source; filterFn = r => r.source === row.source && r.model === row.model; }
    if (kind === 'session'){ title = row.projectPath || row.sessionId; sub = `${row.source} · ${row.device}`;
      filterFn = r => r.source === row.source; /* session doesn't tie to daily directly — show source's daily */ }
    if (kind === 'run')    { title = `采集: ${row.source}`; sub = U.formatTs(row.collectedAt); filterFn = () => false; }

    const matching = daily.filter(filterFn);
    const totals = U.aggregateTotals(matching);
    const byDate = U.groupByDate(matching);
    const dates = Array.from(byDate.keys()).sort();
    const values = dates.map(d => {
      let sum = 0;
      const sources = byDate.get(d);
      for (const k of Object.keys(sources)) sum += sources[k];
      return sum;
    });

    return { kind, row, title, sub, totals, dates, values, count: matching.length };
  }, [drill, daily]);

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose}/>
      <div className={`drawer ${open ? 'open' : ''}`} role="dialog">
        {detail && (
          <>
            <div className="drawer-header" style={{position: 'relative'}}>
              <button className="drawer-close" onClick={onClose}>
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                  <path d="M3 3l7 7M10 3l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
              <div style={{fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4}}>
                {detail.kind === 'source' && '来源详情'}
                {detail.kind === 'model' && '模型详情'}
                {detail.kind === 'session' && '项目详情'}
                {detail.kind === 'run' && '采集详情'}
              </div>
              <h3>{detail.title}</h3>
              <div className="sub">{detail.sub}</div>
            </div>
            <div className="drawer-body">
              {detail.kind !== 'run' ? (
                <>
                  <div className="drawer-kpi-row">
                    <div className="drawer-kpi">
                      <div className="l">Total</div>
                      <div className="v">{U.compactCN(detail.totals.totalTokens)}</div>
                    </div>
                    <div className="drawer-kpi">
                      <div className="l">费用</div>
                      <div className="v" style={{color: detail.totals.costUSD > 0 ? 'var(--c-amber)' : 'var(--muted)'}}>
                        {detail.totals.costUSD > 0 ? U.fmtUS.format(detail.totals.costUSD) : '—'}
                      </div>
                    </div>
                    <div className="drawer-kpi">
                      <div className="l">活跃天数</div>
                      <div className="v">{detail.dates.length}</div>
                    </div>
                  </div>

                  <div className="detail-section">
                    <h4>趋势</h4>
                    <DrillSpark dates={detail.dates} values={detail.values}/>
                  </div>

                  <div className="detail-section">
                    <h4>分布</h4>
                    <div className="detail-row"><span className="k">Input</span><span className="v">{U.fmt.format(detail.totals.inputTokens)}</span></div>
                    <div className="detail-row"><span className="k">Output</span><span className="v">{U.fmt.format(detail.totals.outputTokens)}</span></div>
                    <div className="detail-row"><span className="k">Cache Read</span><span className="v">{U.fmt.format(detail.totals.cacheReadTokens)}</span></div>
                    <div className="detail-row"><span className="k">Cache Creation</span><span className="v">{U.fmt.format(detail.totals.cacheCreationTokens)}</span></div>
                    <div className="detail-row"><span className="k">Reasoning</span><span className="v">{U.fmt.format(detail.totals.reasoningTokens)}</span></div>
                    <div className="detail-row"><span className="k">缓存命中率</span><span className="v" style={{color:'var(--c-indigo)', fontWeight: 600}}>{detail.totals.cacheHitRate.toFixed(1)}%</span></div>
                  </div>

                  {detail.kind === 'session' && (
                    <div className="detail-section">
                      <h4>元数据</h4>
                      <div className="detail-row"><span className="k">Session ID</span><span className="v mono" style={{fontSize: 11, maxWidth: '60%', textAlign: 'right'}}>{detail.row.sessionId}</span></div>
                      <div className="detail-row"><span className="k">最后活动</span><span className="v">{detail.row.lastActivity}</span></div>
                    </div>
                  )}

                  {detail.kind === 'model' && (
                    <div className="detail-section">
                      <h4>记录</h4>
                      <div className="detail-row"><span className="k">活跃天数</span><span className="v">{detail.row.dayCount}</span></div>
                    </div>
                  )}
                </>
              ) : (
                <div className="detail-section">
                  <h4>状态</h4>
                  <div style={{padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 8, fontSize: 12.5}}>
                    <span className={`status-badge status-${detail.row.status}`}>{detail.row.status}</span>
                    <p style={{margin: '10px 0 0', lineHeight: 1.6}}>{detail.row.message}</p>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// Small sparkline for drawer
function DrillSpark({ dates, values }) {
  if (!dates.length) return <div className="empty">无数据</div>;
  const w = 480, h = 120;
  const max = Math.max(...values, 1);
  const pad = 16;
  const pts = values.map((v, i) => {
    const x = pad + (i / Math.max(1, values.length - 1)) * (w - pad * 2);
    const y = h - pad - (v / max) * (h - pad * 2);
    return [x, y];
  });
  const d = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const dArea = d + ` L${w-pad},${h-pad} L${pad},${h-pad} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{width: '100%', height: 120, display: 'block'}}>
      <defs>
        <linearGradient id="drillGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.55 0.16 265)" stopOpacity="0.25"/>
          <stop offset="100%" stopColor="oklch(0.55 0.16 265)" stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={dArea} fill="url(#drillGrad)"/>
      <path d={d} fill="none" stroke="oklch(0.55 0.16 265)" strokeWidth="2" strokeLinejoin="round"/>
      {pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r="2" fill="oklch(0.55 0.16 265)" opacity={i === pts.length - 1 ? 1 : 0}/>
      ))}
      <text x={pad} y={h - 2} fontSize="9" fill="oklch(0.62 0.005 80)" style={{fontFamily: 'var(--font-mono)'}}>{dates[0]}</text>
      <text x={w - pad} y={h - 2} textAnchor="end" fontSize="9" fill="oklch(0.62 0.005 80)" style={{fontFamily: 'var(--font-mono)'}}>{dates[dates.length - 1]}</text>
    </svg>
  );
}

export { TablePanel, DrillDrawer };
