import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { U } from '../shared/utils.js';
import { sourceIcon } from './source-icons.js';

export function SourceDonut({rows,sources,onFocusSource,focused}) {
  const [hovered,setHovered] = useState(null);
  const reduceMotion = useReducedMotion();
  const data = sources.map(name => ({name,value:rows.reduce((sum,r)=>sum+(r.source===name?r.totalTokens:0),0),color:U.getSourceColor(name)})).filter(d=>d.value>0).sort((a,b)=>b.value-a.value);
  const total = data.reduce((sum,d)=>sum+d.value,0);
  const active = data.find(d=>d.name===(hovered||focused));
  const spacing = Math.min(18, 52 / Math.max(1, data.length));
  const ringWidth = Math.max(1, spacing - 3);
  const segments = data.map((d,index)=>({...d,radius:100-index*spacing,length:d.value/total*100}));
  return <div className="panel source-donut-panel source-ring-panel">
    <div className="panel-header">
      <div><h2 className="panel-title">来源占比</h2><p className="panel-sub">每个来源一圈 · 弧长表示总量占比</p></div>
      {focused&&<button className="btn" onClick={()=>onFocusSource(null)}>取消聚焦</button>}
    </div>
    {!total ? <div className="empty">当前筛选下暂无来源用量</div> : <>
      <div className="source-ring-stage">
        <svg viewBox="0 0 240 240" className="source-ring-svg" aria-label="来源用量多层同心圆图，从外到内按用量排序" role="img">
          {segments.map(d=><motion.g key={d.name}
            initial={false} animate={{opacity:active&&active.name!==d.name?0.22:1}}
            transition={{duration:reduceMotion?0:0.12}}
            onPointerEnter={()=>setHovered(d.name)} onPointerLeave={()=>setHovered(null)}
            onClick={()=>onFocusSource(focused===d.name?null:d.name)}
            style={{cursor:'pointer'}}>
            <title>{d.name}：{U.compactCN(d.value)}，{U.usageShare(d.value,total)}</title>
            <circle cx="120" cy="120" r={d.radius} fill="none" stroke={d.color} strokeWidth={ringWidth} opacity={0.13}/>
            <circle className="source-ring-arc" cx="120" cy="120" r={d.radius} pathLength="100" fill="none"
              stroke={d.color} strokeWidth={ringWidth} transform="rotate(-90 120 120)"
              strokeDasharray={`${d.length} ${100-d.length}`} pointerEvents="none"/>
          </motion.g>)}
        </svg>
        <div className="source-ring-center">
          <span>{active?.name||'当前筛选合计'}</span>
          <strong>{U.compactCN(active?.value??total)}</strong>
          <small>{active?`占总量 ${U.usageShare(active.value,total)}`:'TOKENS'}</small>
        </div>
      </div>
      <div className="source-ring-list" onPointerLeave={()=>setHovered(null)}>
        {data.map(d=><button key={d.name} type="button" className={`source-ring-row ${focused===d.name?'selected':''}`}
          aria-pressed={focused===d.name} onPointerEnter={()=>setHovered(d.name)} onFocus={()=>setHovered(d.name)} onBlur={()=>setHovered(null)}
          onClick={()=>onFocusSource(focused===d.name?null:d.name)}>
          <span className="source-ring-label">{sourceIcon(d.name)?<img className="bar-head-icon" src={sourceIcon(d.name)} alt=""/>:<i style={{background:d.color}}/>}{d.name}</span>
          <b>{U.usageShare(d.value,total)}</b>
          <span className="source-ring-track"><i style={{width:`${d.value/total*100}%`,background:d.color}}/></span>
          <span className="source-ring-value">{U.compactCN(d.value)}</span>
        </button>)}
      </div>
      <p className="source-ring-hint">由外到内用量递减 · 点击圆环或来源聚焦</p>
    </>}
  </div>;
}
