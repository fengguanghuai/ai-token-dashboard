import React, { useState } from 'react';
import { MotionConfig, motion, AnimatePresence } from 'motion/react';
import NumberFlow from '@number-flow/react';
import { AreaChart as TremorArea, DonutChart as TremorDonut } from '@tremor/react';
import { Area, AreaChart, CartesianGrid, XAxis, PieChart, Pie, Cell } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from './components/ui/chart';
import { LineChart as BklitLineChart } from './components/charts/line-chart';
import { Line as BklitLine } from './components/charts/line';
import { Grid } from './components/charts/grid';
import { XAxis as BklitXAxis } from './components/charts/x-axis';
import { ChartTooltip as BklitTooltip } from './components/charts/tooltip/chart-tooltip';
import { RingChart } from './components/charts/ring-chart';
import { Ring } from './components/charts/ring';
import { RingCenter } from './components/charts/ring-center';
import { ArrowUpRight, Check, Sparkles, RotateCcw, ArrowLeft, Heart, Play, Layers } from 'lucide-react';
import './style.css';

const colors = ['#805ad5', '#22a6a1', '#eca65b'];
const sourceNames = ['Codex', 'Claude', 'Pi'];
const seed = [28, 42, 36, 61, 44, 78, 56, 43, 68, 82, 60, 74, 53, 92];
const datasets = [seed, seed.map((n, i) => Math.round(n * (i % 3 === 0 ? .7 : 1.22)))];
const config = { tokens: { label: '用量（百万 Token）', color: colors[0] }, previous: { label:'对比周期',color:colors[1] } };
const docs = { Bklit:'https://bklit.com/docs/components/line-chart', shadcn:'https://ui.shadcn.com/charts', Tremor:'https://npm.tremor.so/docs/visualizations/area-chart', NumberFlow:'https://number-flow.barvian.me/', Motion:'https://motion.dev/docs/react', Tambo:'https://docs.tambo.co/', CopilotKit:'https://docs.copilotkit.ai/concepts/generative-ui-overview' };
function Official({name}) { return <a href={docs[name]} target="_blank" rel="noreferrer">官方示例 <ArrowUpRight size={13}/></a>; }
function SampleCharts({kind,data,mix}) {
 const shares=sourceNames.map((name,i)=>({name,value:mix[i],fill:colors[i]}));
 if(kind==='Bklit') return <>
   <div className="chart-frame bklit-chart"><BklitLineChart data={data}><Grid horizontal/><BklitLine dataKey="tokens" stroke={colors[0]}/><BklitXAxis/><BklitTooltip/></BklitLineChart></div>
   <p className="sample-label">多环进度 · 各来源独立预算使用率，不是份额图</p>
   <div className="ring-frame"><RingChart data={shares.map(d=>({label:d.name,value:d.value,maxValue:100,color:d.fill}))} size={220}>{shares.map((d,i)=><Ring key={d.name} index={i}/>)}<RingCenter defaultLabel="演示进度合计"/></RingChart></div>
 </>;
 if(kind==='Tremor') return <>
   <TremorArea className="chart-frame" data={data} index="day" categories={['tokens']} colors={['violet']} valueFormatter={n=>`${n}M`} showLegend={false} showAnimation yAxisWidth={48}/>
   <p className="sample-label">来源占比 · 悬停查看明细</p>
   <TremorDonut className="ring-frame" data={shares} category="value" index="name" colors={['violet','cyan','amber']} valueFormatter={n=>`${n}%`} showAnimation/>
 </>;
 return <>
   <ChartContainer config={config} className="chart-frame"><AreaChart accessibilityLayer data={data} margin={{left:8,right:8,top:12}}><CartesianGrid vertical={false}/><XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8}/><ChartTooltip content={<ChartTooltipContent/>}/><Area type="monotone" dataKey="tokens" stroke={colors[0]} fill={colors[0]} fillOpacity={.12} strokeWidth={2}/></AreaChart></ChartContainer>
   <p className="sample-label">来源占比 · 悬停查看明细</p>
   <ChartContainer config={config} className="ring-frame"><PieChart><ChartTooltip content={<ChartTooltipContent nameKey="name" hideLabel/>}/><Pie data={shares} dataKey="value" nameKey="name" innerRadius={62} outerRadius={88} paddingAngle={3} strokeWidth={0}>{shares.map(d=><Cell key={d.name} fill={d.fill}/>)}</Pie></PieChart></ChartContainer>
 </>;
}
function FlowDemo({kind}) {
 const [step,setStep]=useState(0);
 const [choice,setChoice]=useState('模型费用对比');
 return <div className="flow-demo">
   <div className="flow-top"><span className="tag">流程模拟 · 未接入 SDK / 模型</span><Official name={kind}/></div>
   <h3>{kind==='Tambo'?'问一句，返回一张分析卡':'说一句，调整当前看板'}</h3>
   <p>{kind==='Tambo'?'体验 AI 选择图表的交互形式。这里由固定按钮触发，不是模型推理。':'体验操作预览与确认。这里仅修改演示区，不影响真实筛选。'}</p>
   <div className="prompt-options">{(kind==='Tambo'?['模型费用对比','来源占比分析']:['查看最近 7 天','只看 Codex']).map(s=><button key={s} onClick={()=>{setChoice(s);setStep(1);}}><Sparkles size={14}/>{s}</button>)}</div>
   <div className="flow-result" aria-live="polite">
   {step===0?<div className="flow-empty"><Layers size={24}/><span>点击上方问题，体验展示流程</span></div>:kind==='Tambo'?<motion.div key={choice} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}}><span className="tag">固定样例结果</span><h4>{choice}</h4>{(choice === "模型费用对比" ? ["模型 A", "模型 B", "模型 C"] : sourceNames).map((n,i)=><div className="mini-bar" key={n}><span>{n}</span><progress max="100" value={[65,25,10][i]}/><strong>{[65,25,10][i]}%</strong></div>)}<small>演示摘要：{choice === "模型费用对比" ? "模型 A 的费用" : "Codex 的用量"}占 65%。真实接入后需由后台查询并计算。</small></motion.div>:<><span className="tag">{step===2?'已应用到演示区':'待确认的操作'}</span><h4>{choice}</h4><p>时间：{choice==='查看最近 7 天'?'最近 7 天':'当前周期'} · 来源：{choice==='只看 Codex'?'Codex':'全部来源'}</p><button className="primary" onClick={()=>setStep(step===2?0:2)}>{step===2?'撤销演示操作':'确认应用（演示）'}</button></>}
   </div>
 </div>;
}
export default function App(){
 const [period,setPeriod]=useState(7),[sample,setSample]=useState(0),[tab,setTab]=useState('charts'),[favorites,setFavorites]=useState([]),[number,setNumber]=useState(12847),[expanded,setExpanded]=useState(false);
 const data=datasets[sample].slice(-period).map((tokens,i)=>({date:new Date(2026,8,i+1),day:`09-${String(i+1).padStart(2,'0')}`,tokens}));
 const mix=sample===0?[65,25,10]:[48,38,14];
 const toggle=n=>setFavorites(a=>a.includes(n)?a.filter(v=>v!==n):[...a,n]);
 return <MotionConfig reducedMotion="user"><main className="lab">
 <header className="lab-header"><a className="back" href="http://127.0.0.1:5173/"><ArrowLeft size={16}/>返回看板</a><span>Token Studio <span className="muted">/ 组件实验室</span></span><span className="tag">独立展示 · 不读取真实数据</span></header>
 <section className="intro"><div><p className="eyebrow">COMPONENT PLAYGROUND</p><h1>先体验，再选择。</h1><p>同一组演示数据，看看不同组件的手感。主看板和环形图保持原样。</p></div><div className="intro-count"><strong>07</strong><span>组件与交互方向</span></div></section>
 <nav className="lab-toolbar" aria-label="展示分类"><div className="segmented">{[['charts','图表对比'],['motion','数字与动效'],['ai','AI 交互']].map(([id,label])=><button key={id} aria-pressed={tab===id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{label}</button>)}</div><span className="muted">{tab==='charts'?'试试切换数据，再悬停图表':tab==='motion'?'点击按钮，感受变化过程':'仅展示交互概念，不代表框架实际运行'}</span></nav>
 {tab==='charts'&&<><div className="data-toolbar"><span>演示用量 · 百万 Token</span><div className="actions">{[7,14].map(n=><button key={n} aria-pressed={period===n} className={period===n?'selected':''} onClick={()=>setPeriod(n)}>{n} 天</button>)}<button onClick={()=>setSample(v=>1-v)}><RotateCcw size={14}/>切换样例 {sample+1}</button></div></div><div className="chart-grid">{['Bklit','shadcn','Tremor'].map((kind,i)=><article className="sample-card" key={kind}><div className="card-heading"><span className="card-index">0{i+1}</span><button className={`favorite ${favorites.includes(kind)?'picked':''}`} aria-pressed={favorites.includes(kind)} aria-label={`收藏 ${kind}`} onClick={()=>toggle(kind)}><Heart size={16} fill={favorites.includes(kind)?'currentColor':'none'}/></button></div><h2>{kind}{kind==='shadcn'?'/ui':kind==='Bklit'?' UI':''}</h2><p className="description">{['细腻曲线与多环进度，适合试验交互','简洁图形与统一提示框，适合分析面板','现成分析图表，适合快速搭建看板'][i]}</p><div className="meta"><span className="tag">{kind==='Tremor'?'官方 npm 版 3.18.7':'官方组件源码'}</span><Official name={kind}/></div><SampleCharts kind={kind} data={data} mix={mix}/><div className="source-legend">{sourceNames.map((n,j)=><span key={n}><i style={{background:colors[j]}}/>{n} <b>{mix[j]}{kind==='Bklit'?' / 100':'%'}</b></span>)}</div><footer>{['注意：多环是预算进度，不替代来源占比环形图。','Recharts 3 + 官方 ChartContainer / Tooltip。','此处是稳定 npm 版本，不是新版复制式组件。'][i]}</footer></article>)}</div></>}
 {tab==='motion'&&<div className="two-grid"><article className="sample-card"><div className="meta"><span className="tag">真实组件 · 0.6.2</span><Official name="NumberFlow"/></div><h2>NumberFlow</h2><p>数字逐位滚动，适合 Token 总量和费用卡片。</p><div className="number-stage"><span>演示 Token 用量</span><NumberFlow value={number} locales="en-US"/><small>只是展示数字，不写入统计</small></div><div className="actions"><button onClick={()=>setNumber(n=>n+1379)}>增加用量</button><button onClick={()=>setNumber(984)}>变成三位数</button><button onClick={()=>setNumber(12847)}>重置</button></div><button className="choose" onClick={()=>toggle('NumberFlow')}>{favorites.includes('NumberFlow')?'已选中':'喜欢这个数字效果'}</button></article><article className="sample-card"><div className="meta"><span className="tag">真实组件 · 项目已有</span><Official name="Motion"/></div><h2>Motion</h2><p>展开收起与列表重排，适合明细、筛选和抽屉。</p><div className="motion-stage"><motion.div layout className="motion-tile"><span><Check size={16}/>演示采集摘要</span><strong>3 个来源 · 128 条记录</strong><AnimatePresence>{expanded&&<motion.div initial={{height:0,opacity:0}} animate={{height:'auto',opacity:1}} exit={{height:0,opacity:0}} className="motion-details">{sourceNames.map((n,i)=><p key={n}>{n}<span>{[86,32,10][i]} 条</span></p>)}</motion.div>}</AnimatePresence></motion.div></div><button onClick={()=>setExpanded(v=>!v)}><Play size={14}/>{expanded?'收起摘要':'展开摘要'}</button><button className="choose" onClick={()=>toggle('Motion')}>{favorites.includes('Motion')?'已选中':'喜欢这个展开效果'}</button></article></div>}
 {tab==='ai'&&<><div className="notice">此区对比的是两种交互方向，不是两个 SDK 的性能或能力实测。无模型调用、无后台连接。</div><div className="two-grid">{['Tambo','CopilotKit'].map(kind=><article className="sample-card" key={kind}><h2>{kind} 交互方向</h2><FlowDemo kind={kind}/><button className="choose" onClick={()=>toggle(kind)}>{favorites.includes(kind)?'已选中':'喜欢这个交互方向'}</button></article>)}</div></>}
 <section className="selection"><div><strong>你的候选清单</strong><p>{favorites.length?favorites.join(' · '):'点击卡片上的爱心或选择按钮，临时标记喜欢的方案。'}</p></div>{favorites.length>0&&<button onClick={()=>setFavorites([])}>清空选择</button>}<small>仅当前页面保留，不自动提交或安装到主看板。</small></section>
 <footer className="lab-footer">所有数据均为内存样例 · 主项目不增加依赖 · 关闭展示页不影响统计</footer>
 </main></MotionConfig>;
}
