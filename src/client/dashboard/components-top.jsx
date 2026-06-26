/* =============================================================
   Filter bar, KPI cards, sparklines — top of dashboard
   ============================================================= */

import { useState, useEffect, useRef } from 'react';
import { U } from '../shared/utils.js';
import claudeIcon from './icons/claude.svg';
import gptIcon from './icons/gpt.svg';

const QUOTA_TOOL_ICON = { Claude: claudeIcon, Codex: gptIcon };

// ───────────────────────────────────────────────────────────────
// Subscription-window quota bars (live, from /api/quota)
// ───────────────────────────────────────────────────────────────
const QUOTA_WINDOW_LABEL = {
  five_hour: '5 小时',
  seven_day: '7 天',
  seven_day_opus: '7 天 · Opus',
  seven_day_sonnet: '7 天 · Sonnet'
};

function quotaResetText(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '即将重置';
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d${h}h 后重置`;
  if (h > 0) return `${h}h${m}m 后重置`;
  return `${m}m 后重置`;
}

const QUOTA_WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

function QuotaWindowRow({ window }) {
  const pct = Math.round((window.utilization || 0) * 100);
  const tone = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok';
  return (
    <div className="quota-row">
      <div className="quota-row-head">
        <span className="quota-win">{QUOTA_WINDOW_LABEL[window.name] || window.name}</span>
        <span className="quota-reset">{quotaResetText(window.resetsAt)}</span>
        <span className="quota-pct">{pct}%</span>
      </div>
      <div className="quota-track">
        <div className={`quota-fill quota-${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

function QuotaItem({ tool, windows }) {
  const ordered = [...windows].sort(
    (a, b) => QUOTA_WINDOW_ORDER.indexOf(a.name) - QUOTA_WINDOW_ORDER.indexOf(b.name)
  ).slice(0, 2);
  return (
    <div className="quota-item">
      <div className="quota-tool">
        {QUOTA_TOOL_ICON[tool] && <img className="quota-logo" src={QUOTA_TOOL_ICON[tool]} alt="" />}
        {tool}
      </div>
      {ordered.map(w => <QuotaWindowRow key={w.name} window={w} />)}
    </div>
  );
}

function QuotaBars({ quota }) {
  if (!quota || quota.disabled) return null;
  const items = [];
  for (const [key, label] of [['claude', 'Claude'], ['codex', 'Codex']]) {
    const q = quota[key];
    if (!q || !q.ok || !q.windows || !q.windows.length) continue;
    items.push(<QuotaItem key={key} tool={label} windows={q.windows} />);
  }
  if (!items.length) return null;
  return <div className="quota-bars">{items}</div>;
}

// ───────────────────────────────────────────────────────────────
// Topbar
// ───────────────────────────────────────────────────────────────
function Topbar({ lastSync, onRefresh, refreshing, onCollect, collecting, collectStatus }) {
  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="brand">
          <div className="brand-mark">TS</div>
          <div>
            <h1>Token Studio</h1>
            <p className="brand-sub">个人 AI Token 消耗看板</p>
          </div>
        </div>
        <div className="page-switch">
          <span className="page-chip active">看板</span>
          <a href="/review" className="page-chip">复盘</a>
        </div>
      </div>
      <div className="topbar-right">
        {collectStatus && (
          <div className={`collect-pill collect-${collectStatus.type}`} title={collectStatus.message}>
            <span className="collect-dot"></span>
            <span>{collectStatus.type === 'running' ? '采集中' : collectStatus.type === 'ok' ? '采集完成' : '采集失败'}</span>
          </div>
        )}
        <div className="sync-pill">
          <span className="sync-dot"></span>
          <span>最后同步 <strong style={{color:'var(--text)', fontWeight:600}}>{lastSync}</strong></span>
        </div>
        <button className="btn" onClick={() => alert('Settings · TODO')}>
          <svg className="icon" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4"/>
            <path d="M8 1v2M8 13v2M15 8h-2M3 8H1M13.07 2.93l-1.41 1.41M4.34 11.66l-1.41 1.41M13.07 13.07l-1.41-1.41M4.34 4.34L2.93 2.93" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
        </button>
        <button className={`btn btn-primary ${collecting ? 'loading' : ''}`} onClick={onCollect} disabled={collecting || refreshing}>
          <svg className={`icon ${collecting ? 'spin' : ''}`} viewBox="0 0 16 16" fill="none" style={{opacity:1}}>
            <path d="M4 6.5h8M4 9.5h8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/>
            <path d="M3.5 4.5c0-.83 2.01-1.5 4.5-1.5s4.5.67 4.5 1.5v7c0 .83-2.01 1.5-4.5 1.5s-4.5-.67-4.5-1.5v-7Z" stroke="currentColor" strokeWidth="1.35"/>
            <circle cx="8" cy="8" r="1.25" fill="currentColor"/>
          </svg>
          {collecting ? '采集中' : '采集'}
        </button>
        <button className={`btn btn-primary ${refreshing ? 'loading' : ''}`} onClick={onRefresh}>
          <svg className={`icon ${refreshing ? 'spin' : ''}`} viewBox="0 0 16 16" fill="none" style={{opacity:1}}>
            <path d="M3 3v3h3M13 13v-3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M13 7A5 5 0 0 0 4 5M3 9a5 5 0 0 0 9 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          {refreshing ? '同步中' : '刷新'}
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Filter bar
// ───────────────────────────────────────────────────────────────
function FilterBar({ f, setF, allSources, allDevices, allModels, availableRange, onExport, quota }) {
  const RANGES = [
    { id: 'today', label: '今天', days: 1  },
    { id: '7d',  label: '7 天',  days: 7  },
    { id: '14d', label: '14 天', days: 14 },
    { id: '30d', label: '30 天', days: 30 },
    { id: '90d', label: '90 天', days: 90 },
    { id: 'all', label: '全部' }
  ];

  const setRange = (r) => {
    if (r.id === 'all') {
      setF({
        ...f,
        rangeId: r.id,
        startDate: availableRange.startDate,
        endDate: availableRange.endDate,
        precise: false,
        startDateTime: availableRange.startDateTime || U.startOfDayLocal(availableRange.startDate),
        endDateTime: availableRange.endDateTime || U.endOfDayLocal(availableRange.endDate)
      });
      return;
    }
    const startDate = U.daysAgo(r.days - 1);
    const endDate = U.daysAgo(0);
    setF({
      ...f,
      rangeId: r.id,
      startDate,
      endDate,
      precise: false,
      startDateTime: U.startOfDayLocal(startDate),
      endDateTime: U.endOfDayLocal(endDate)
    });
  };

  const setPreciseRange = (startDate, endDate) => {
    setF({
      ...f,
      precise: true,
      rangeId: 'custom',
      startDate,
      endDate,
      startDateTime: U.startOfDayLocal(startDate),
      endDateTime: U.endOfDayLocal(endDate)
    });
  };

  const toggleSet = (key, value) => {
    const next = new Set(f[key]);
    if (next.has(value)) next.delete(value); else next.add(value);
    setF({ ...f, [key]: next });
  };

  const clearAll = () => {
    setF({ ...f, sources: new Set(), devices: new Set(), models: new Set() });
  };

  const filtersActive = f.sources.size + f.devices.size + f.models.size;

  return (
    <div className="filterbar">
      <div className="filterbar-main">
      <div className="filter-row filter-row-primary">
        <div className="filter-group">
          <span className="filter-label">时间</span>
          <div className="chip-row">
            {RANGES.map(r => (
              <button key={r.id}
                className={`chip ${f.rangeId === r.id ? 'active' : ''}`}
                onClick={() => setRange(r)}>{r.label}</button>
            ))}
          </div>
          <DateRangeField
            start={f.startDate}
            end={f.endDate}
            precise={f.precise}
            onChange={setPreciseRange} />
        </div>
      </div>

      <div className="filter-row">
        <div className="filter-group filter-group-sources">
          <span className="filter-label">来源</span>
          {allSources.map(s => (
            <button key={s}
              className={`pill ${f.sources.has(s) ? 'active' : ''}`}
              style={f.sources.has(s) ? {color: U.PALETTE[s] || ''} : {}}
              onClick={() => toggleSet('sources', s)}>
              <span className="pill-dot" style={{background: U.PALETTE[s] || ''}}/>
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="filter-row filter-row-secondary">
        <div className="filter-group">
          <span className="filter-label">设备</span>
          <MultiSelect
            options={allDevices}
            selected={f.devices}
            onChange={v => setF({...f, devices: v})}
            placeholder="全部设备"/>
          <span className="filter-label" style={{marginLeft: 4}}>模型</span>
          <MultiSelect
            options={allModels}
            selected={f.models}
            onChange={v => setF({...f, models: v})}
            placeholder="全部模型"/>
        </div>

        <div className="filter-spacer"/>

        {filtersActive > 0 && (
          <button className="btn" onClick={clearAll}>
            <svg className="icon" viewBox="0 0 16 16" fill="none">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
            清除筛选 · {filtersActive}
          </button>
        )}
        <button className={`toggle ${f.compare ? 'on' : ''}`} onClick={() => setF({...f, compare: !f.compare})}>
          <span className="toggle-slot"/>
          对比上一周期
        </button>
        <button className="btn" onClick={onExport}>
          <svg className="icon" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          导出
        </button>
      </div>
      </div>
      <QuotaBars quota={quota} />
    </div>
  );
}

function parseDateStr(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

// Single-box range picker: first click sets the start, second click the end.
function DateRangeField({ start, end, precise, onChange }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);   // first-clicked day mid-selection
  const [hover, setHover] = useState(null);
  const ref = useRef(null);
  const [viewMonth, setViewMonth] = useState(() => {
    const d = parseDateStr(start) || new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  useEffect(() => {
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setAnchor(null); setHover(null); }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const moveMonth = (delta) => setViewMonth(prev => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));

  // Highlighted range: the in-progress anchor→hover preview, else the committed start→end.
  let lo, hi;
  if (anchor) {
    const other = hover || anchor;
    [lo, hi] = anchor <= other ? [anchor, other] : [other, anchor];
  } else {
    [lo, hi] = [start, end];
  }

  const pickDay = (value) => {
    if (!anchor) {
      setAnchor(value);
      setHover(value);
    } else {
      const [a, b] = anchor <= value ? [anchor, value] : [value, anchor];
      onChange(a, b);
      setAnchor(null);
      setHover(null);
      setOpen(false);
    }
  };

  const days = monthCells(viewMonth);
  const monthLabel = `${viewMonth.getFullYear()}年${String(viewMonth.getMonth() + 1).padStart(2, '0')}月`;

  return (
    <div className="dt-field" ref={ref}>
      <button className={`dt-range-trigger ${precise ? 'active' : ''}`} type="button" onClick={() => setOpen(o => !o)}>
        <svg className="time-icon" viewBox="0 0 16 16" fill="none">
          <path d="M4 2.5v2M12 2.5v2M3 6.5h10M4 4h8c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H4c-.83 0-1.5-.67-1.5-1.5v-6C2.5 4.67 3.17 4 4 4Z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
        <span>{start || '开始'}</span>
        <span className="time-sep">~</span>
        <span>{end || '结束'}</span>
      </button>

      {open && (
        <div className="dt-popover">
          <div className="dt-head">
            <button className="dt-nav" type="button" onClick={() => moveMonth(-1)}>‹</button>
            <div className="dt-title">{monthLabel}</div>
            <button className="dt-nav" type="button" onClick={() => moveMonth(1)}>›</button>
          </div>
          <div className="dt-week">
            {['一', '二', '三', '四', '五', '六', '日'].map(d => <span key={d}>{d}</span>)}
          </div>
          <div className="dt-grid">
            {days.map(day => {
              const inRange = lo && hi && day.value >= lo && day.value <= hi;
              const isEnd = day.value === lo || day.value === hi;
              return (
                <button
                  key={day.key}
                  type="button"
                  className={`dt-day ${day.inMonth ? '' : 'muted'} ${inRange ? 'in-range' : ''} ${isEnd && (lo || hi) ? 'active' : ''}`}
                  onMouseEnter={() => { if (anchor) setHover(day.value); }}
                  onClick={() => pickDay(day.value)}>
                  {day.date.getDate()}
                </button>
              );
            })}
          </div>
          <div className="dt-range-hint">{anchor ? '再点一下选择结束日期' : '点击选择开始日期'}</div>
        </div>
      )}
    </div>
  );
}

function monthCells(monthDate) {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const start = new Date(first);
  const offset = (first.getDay() + 6) % 7;
  start.setDate(first.getDate() - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const value = U.localDateStr(date);
    return {
      date,
      value,
      key: value,
      inMonth: date.getMonth() === monthDate.getMonth()
    };
  });
}

// ───────────────────────────────────────────────────────────────
// MultiSelect — dropdown with checkboxes
// ───────────────────────────────────────────────────────────────
function MultiSelect({ options, selected, onChange, placeholder }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const label = selected.size === 0
    ? placeholder
    : selected.size === 1
      ? Array.from(selected)[0]
      : `${selected.size} 项已选`;

  const toggle = (v) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v); else next.add(v);
    onChange(next);
  };

  return (
    <div ref={ref} style={{position:'relative', display:'inline-block'}}>
      <button className={`pill ${selected.size ? 'active' : ''}`} onClick={() => setOpen(o => !o)}
        style={{paddingLeft: 10, fontWeight: selected.size ? 600 : 400}}>
        {label}
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" style={{marginLeft:2, opacity:0.5}}>
          <path d="M1 3l3.5 3L8 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div style={{
          position:'absolute', top:'calc(100% + 6px)', left:0, zIndex:30,
          minWidth: 220, background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 8,
          boxShadow: '0 10px 30px -10px rgb(0 0 0 / 0.15)',
          padding: 4, maxHeight: 280, overflowY: 'auto'
        }}>
          {selected.size > 0 && (
            <button className="chip" style={{width:'100%', justifyContent:'flex-start', color: 'var(--c-indigo)', fontSize: 11.5}}
              onClick={() => onChange(new Set())}>清除选择</button>
          )}
          {options.map(o => (
            <button key={o} className="chip"
              onClick={() => toggle(o)}
              style={{width:'100%', justifyContent:'flex-start', gap:8, fontWeight:400}}>
              <span style={{
                width: 14, height: 14, borderRadius: 3,
                border: '1.5px solid ' + (selected.has(o) ? 'var(--c-indigo)' : 'var(--border)'),
                background: selected.has(o) ? 'var(--c-indigo)' : 'transparent',
                display: 'grid', placeItems: 'center', flexShrink: 0
              }}>
                {selected.has(o) && (
                  <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                    <path d="M1.5 4.5L4 7l3.5-5" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </span>
              <span style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontSize: 12}}>{o}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Sparkline SVG
// ───────────────────────────────────────────────────────────────
function Spark({ values, color, height = 30, fill = true }) {
  if (!values || values.length === 0) return null;
  const w = 100, h = height;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1 || 1)) * w;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return [x, y];
  });
  const d = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const dArea = d + ` L${w},${h} L0,${h} Z`;

  return (
    <svg className="kpi-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {fill && <path d={dArea} fill={color} opacity="0.12"/>}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
    </svg>
  );
}

// ───────────────────────────────────────────────────────────────
// Delta pill
// ───────────────────────────────────────────────────────────────
function Delta({ value, suffix = '%', invert = false }) {
  if (value == null || !isFinite(value)) {
    return <span className="delta flat">—</span>;
  }
  const positive = value > 0.05;
  const negative = value < -0.05;
  const flat = !positive && !negative;
  const cls = flat ? 'flat' : (positive ? (invert ? 'down' : 'up') : (invert ? 'up' : 'down'));
  const arrow = flat ? '·' : (positive ? '↑' : '↓');
  return (
    <span className={`delta ${cls}`}>
      {arrow} {Math.abs(value).toFixed(1)}{suffix}
    </span>
  );
}

// ───────────────────────────────────────────────────────────────
// KPI card
// ───────────────────────────────────────────────────────────────
function KPI({ label, value, sub, delta, dotColor, sparkValues, sparkColor }) {
  return (
    <div className="kpi">
      <div className="kpi-label">
        <span style={{display:'inline-flex', alignItems:'center', gap:6}}>
          {dotColor && <span className="dot" style={{color: dotColor}}/>}
          {label}
        </span>
      </div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">
        {delta != null && <Delta value={delta}/>}
        <span>{sub}</span>
      </div>
      {sparkValues && <Spark values={sparkValues} color={sparkColor || 'var(--c-indigo)'}/>}
    </div>
  );
}

export { Topbar, FilterBar, KPI, Delta };
