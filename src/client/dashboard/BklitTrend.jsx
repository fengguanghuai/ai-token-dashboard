import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useReducedMotion } from 'motion/react';
import { curveMonotoneX } from '@visx/curve';
import { LineChart } from '../vendor/bklit/components/charts/line-chart';
import { Line } from '../vendor/bklit/components/charts/line';
import { Grid } from '../vendor/bklit/components/charts/grid';
import { XAxis } from '../vendor/bklit/components/charts/x-axis';
import { ChartTooltip } from '../vendor/bklit/components/charts/tooltip/chart-tooltip';
import { useChartStable } from '../vendor/bklit/components/charts/chart-context';
import { buildTrendData } from '../shared/trend-data.js';
import { U } from '../shared/utils.js';
import '../vendor/bklit/utilities.css';

function ValueAxis() {
  const { containerRef, yScale, margin } = useChartStable();
  if (!containerRef.current) return null;
  return createPortal(<div aria-hidden="true" className="bklit-values">
    {yScale.ticks(4).map(value => <span key={value} style={{top:margin.top+yScale(value),left:0,width:margin.left-8}}>{U.compact(value)}</span>)}
  </div>, containerRef.current);
}

export default function BklitTrend({rows,dates,sources,compareRows,compareDates}) {
  const reduceMotion = useReducedMotion();
  const data = useMemo(() => buildTrendData(rows,dates,sources,compareRows,compareDates),[rows,dates,sources,compareRows,compareDates]);
  const [start,setStart] = useState(0);
  const [end,setEnd] = useState(dates.length-1);
  const visible = data.slice(start,end+1);
  const colors = sources.map(U.getSourceColor);
  return <div className="bklit-trend">
    <div className="bklit-canvas" role="img" aria-label={`每日用量折线图，${dates[start]} 至 ${dates[end]}。精确数据可通过图表明细查看或导出。`}>
      <LineChart data={visible} style={{height:'100%'}} margin={{left:48,right:18,top:20,bottom:38}} animationDuration={reduceMotion?0:550} yDomainTween={!reduceMotion}>
        <Grid horizontal numTicksRows={4}/>
        {sources.map((name,i)=><Line key={name} dataKey={`source${i}`} curve={curveMonotoneX} stroke={colors[i]} strokeWidth={2.2} fadeEdges={false} animate={!reduceMotion} showMarkers={visible.length<=2}/>)}
        {compareRows&&<Line dataKey="previous" curve={curveMonotoneX} stroke="var(--muted)" strokeWidth={1.4} dashFromIndex={0} dashArray="5,5" fadeEdges={false} animate={!reduceMotion}/>}
        <ValueAxis/>
        <XAxis numTicks={5}/>
        <ChartTooltip showDatePill={false} panelStyle={{background:'var(--surface)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:10,padding:12,maxWidth:'min(290px, 75vw)'}} content={({point})=><div className="bklit-tooltip">
          <strong>{point.day}</strong><b>{U.compactCN(point.total)} tokens</b>
          {sources.map((name,i)=><p key={name}><span style={{color:colors[i]}}>{name}</span><span>{U.compactCN(point[`source${i}`])}</span></p>)}
          {compareRows&&<p><span>上一周期 · {point.previousDay||'无对应日期'}</span><span>{U.compactCN(point.previous)}</span></p>}
        </div>}/>
      </LineChart>
    </div>
    <div className="bklit-legend">{sources.map((name,i)=><span key={name}><i style={{background:colors[i]}}/>{name}</span>)}{compareRows&&<span><i className="comparison-line"/>上一周期</span>}</div>
    {dates.length>20&&<div className="bklit-range">
      <label>起始日期 <input aria-label="趋势图起始日期" type="range" min={0} max={dates.length-2} value={start} onChange={e=>setStart(Math.min(Number(e.target.value),end-1))}/><span>{dates[start]}</span></label>
      <label>结束日期 <input aria-label="趋势图结束日期" type="range" min={1} max={dates.length-1} value={end} onChange={e=>setEnd(Math.max(Number(e.target.value),start+1))}/><span>{dates[end]}</span></label>
      <button className="btn" onClick={()=>{setStart(0);setEnd(dates.length-1);}}>重置范围</button>
    </div>}
    <details className="bklit-data"><summary>查看图表明细</summary><div className="bklit-data-scroll"><table><thead><tr><th>日期</th>{sources.map(name=><th key={name}>{name}</th>)}<th>合计</th>{compareRows&&<th>上一周期</th>}</tr></thead><tbody>{visible.map(point=><tr key={point.day}><td>{point.day}</td>{sources.map((name,i)=><td key={name}>{point[`source${i}`].toLocaleString('en-US')}</td>)}<td>{point.total.toLocaleString('en-US')}</td>{compareRows&&<td>{point.previous.toLocaleString('en-US')} ({point.previousDay||'无对应日期'})</td>}</tr>)}</tbody></table></div></details>
  </div>;
}
