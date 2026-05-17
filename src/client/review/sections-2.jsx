/* =============================================================
   Review-page sections — Tools, Efficiency, Insights
   ============================================================= */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { U } from '../shared/utils.js';
import { RU } from './utils.js';

// ───────────────────────────────────────────────────────────────
// Tools donut + per-tool list
// ───────────────────────────────────────────────────────────────
function ToolsSection({ daily, totalTokens }) {
  const tools = useMemo(() => {
    const list = RU.aggregateBy(daily, 'source').sort((a, b) => b.totalTokens - a.totalTokens);
    return list.map(t => ({
      ...t,
      topModel: RU.topModelFor(daily, r => r.source === t.key),
      share: (t.totalTokens / (totalTokens || 1)) * 100
    }));
  }, [daily, totalTokens]);

  const donutRef = useRef(null);
  const donutChart = useRef(null);

  useEffect(() => {
    if (!donutRef.current) return;
    if (!donutChart.current) {
      donutChart.current = echarts.init(donutRef.current, null, { renderer: 'canvas' });
    }
    donutChart.current.setOption({
      backgroundColor: 'transparent',
      animation: true,
      tooltip: {
        trigger: 'item',
        backgroundColor: 'oklch(0.16 0.010 60)',
        borderColor: 'transparent',
        textStyle: { color: 'oklch(0.97 0.008 80)', fontSize: 12 },
        extraCssText: 'border-radius: 8px; box-shadow: 0 8px 24px -8px rgb(0 0 0 / 0.3);',
        formatter: p => `<div style="font-weight:600">${p.name}</div>
          <div style="font-size:13px;margin-top:4px;font-feature-settings:'tnum'">${U.compactCN(p.value)} tokens · ${(p.percent || 0).toFixed(1)}%</div>`
      },
      series: [{
        type: 'pie',
        radius: ['60%', '92%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        itemStyle: { borderColor: 'oklch(0.97 0.008 80)', borderWidth: 4 },
        data: tools.map(t => ({
          name: t.key,
          value: t.totalTokens,
          itemStyle: { color: U.getSourceColor(t.key) }
        }))
      }]
    }, true);
    const onResize = () => donutChart.current?.resize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [tools]);

  if (!tools.length) return null;
  const top = tools[0];

  return (
    <section className="story">
      <div className="section-label">04 · 工具</div>
      <h2 className="section-title">你是怎么用这些工具的</h2>
      <p className="section-sub">每个工具背后挑选了不同模型、有不同的费用结构。这是它们各自的份额与组合。</p>

      <div className="tools-split">
        <div style={{display: 'flex', justifyContent: 'center'}}>
          <div className="donut-wrap">
            <div ref={donutRef} style={{width: 280, height: 280}}/>
            <div className="donut-center">
              <div>
                <div className="l">主导工具</div>
                <div className="v">{top.share.toFixed(0)}%</div>
                <div className="s">{top.key}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="tool-list">
          {tools.map(t => (
            <div key={t.key} className="tool-card">
              <span className="tool-dot" style={{background: U.getSourceColor(t.key)}}/>
              <div className="tool-info">
                <h3 className="tool-name">{t.key}</h3>
                <div className="tool-model">
                  常用模型 · {t.topModel}
                </div>
              </div>
              <div className="tool-stats">
                <div>
                  <div className="tokens">{U.compactCN(t.totalTokens)}</div>
                  <div className="cost">{t.costUSD > 0 ? U.fmtUS.format(t.costUSD) : '免费'}</div>
                </div>
                <span className="tool-badge" title="Cache hit rate">
                  <svg viewBox="0 0 12 12" fill="none">
                    <ellipse cx="6" cy="3.5" rx="4.5" ry="1.8" stroke="currentColor" strokeWidth="1.2"/>
                    <path d="M1.5 3.5v3c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8v-3" stroke="currentColor" strokeWidth="1.2"/>
                    <path d="M1.5 6.5v3c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8v-3" stroke="currentColor" strokeWidth="1.2"/>
                  </svg>
                  {t.cacheHitRate.toFixed(0)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────
// Efficiency analysis cards
// ───────────────────────────────────────────────────────────────
function EfficiencySection({ daily, period }) {
  const totals = useMemo(() => ({
    total: RU.sumField(daily, 'totalTokens'),
    input: RU.sumField(daily, 'inputTokens'),
    output: RU.sumField(daily, 'outputTokens'),
    cacheRead: RU.sumField(daily, 'cacheReadTokens'),
    reasoning: RU.sumField(daily, 'reasoningOutputTokens')
  }), [daily]);

  const cacheRate = totals.total ? (totals.cacheRead / totals.total) * 100 : 0;
  const ioRatio   = totals.output ? totals.input / totals.output : 0;
  const reasonPct = totals.total ? (totals.reasoning / totals.total) * 100 : 0;

  // sparklines for each metric over daily
  const daysArr = useMemo(() => RU.dailyTotals(daily, period), [daily, period]);

  const cacheSeries = useMemo(() => {
    const m = new Map();
    for (const r of daily) {
      const x = m.get(r.usageDate) || { tot: 0, cr: 0 };
      x.tot += r.totalTokens; x.cr += r.cacheReadTokens;
      m.set(r.usageDate, x);
    }
    return daysArr.map(d => {
      const x = m.get(d.date);
      return x && x.tot ? (x.cr / x.tot) * 100 : 0;
    });
  }, [daily, daysArr]);

  const ioSeries = useMemo(() => {
    const m = new Map();
    for (const r of daily) {
      const x = m.get(r.usageDate) || { i: 0, o: 0 };
      x.i += r.inputTokens; x.o += r.outputTokens;
      m.set(r.usageDate, x);
    }
    return daysArr.map(d => {
      const x = m.get(d.date);
      return x && x.o ? x.i / x.o : 0;
    });
  }, [daily, daysArr]);

  const reasonSeries = useMemo(() => {
    const m = new Map();
    for (const r of daily) {
      const x = m.get(r.usageDate) || { r: 0, t: 0 };
      x.r += r.reasoningOutputTokens; x.t += r.totalTokens;
      m.set(r.usageDate, x);
    }
    return daysArr.map(d => {
      const x = m.get(d.date);
      return x && x.t ? (x.r / x.t) * 100 : 0;
    });
  }, [daily, daysArr]);

  return (
    <section className="story">
      <div className="section-label">05 · 效率</div>
      <h2 className="section-title">你的 Token 用得高效吗</h2>
      <p className="section-sub">从三个角度看 token 的"性价比"——重复利用率、信息密度、推理强度。</p>

      <div className="eff-grid">
        <EffCard
          label="Cache 命中率"
          value={cacheRate.toFixed(1)}
          unit="%"
          note={`每命中一次 cache，节省约 ${Math.max(1, Math.round(cacheRate / 8))}× 的输入费用。本期一共节省 ${U.compactCN(totals.cacheRead)} tokens 的重复计算。`}
          spark={cacheSeries}
          color="oklch(0.55 0.16 265)"/>
        <EffCard
          label="Input / Output 比"
          value={ioRatio.toFixed(1)}
          unit=":1"
          note={`平均喂给模型 ${ioRatio.toFixed(1)} 个 token，模型生成 1 个。比值越低说明指令越紧凑、生成越密集。`}
          spark={ioSeries}
          color="oklch(0.65 0.11 200)"/>
        <EffCard
          label="Reasoning 占比"
          value={reasonPct.toFixed(1)}
          unit="%"
          note={`推理 token 比例越高，说明你交给模型的任务越复杂——通常对应代码重构、调试或多步规划。`}
          spark={reasonSeries}
          color="oklch(0.65 0.12 150)"/>
      </div>
    </section>
  );
}

function EffCard({ label, value, unit, note, spark, color }) {
  return (
    <div className="eff-card">
      <div className="eff-label">{label}</div>
      <div className="eff-value">
        {value}<span className="unit">{unit}</span>
      </div>
      <p className="eff-note">{note}</p>
      {spark && spark.length > 0 && (
        <div className="eff-spark">
          <MiniSpark values={spark} color={color}/>
        </div>
      )}
    </div>
  );
}

function MiniSpark({ values, color }) {
  if (!values || values.length === 0) return null;
  const w = 200, h = 32;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return [x, y];
  });
  const d = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const dArea = d + ` L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{width: '100%', height: h, display: 'block'}}>
      <path d={dArea} fill={color} opacity="0.14"/>
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
    </svg>
  );
}

// ───────────────────────────────────────────────────────────────
// Insights — expandable cards
// ───────────────────────────────────────────────────────────────
function InsightsSection({ insights }) {
  const [openIdx, setOpenIdx] = useState(null);

  if (!insights.length) {
    return (
      <section className="story">
        <div className="section-label">06 · 复盘</div>
        <h2 className="section-title">几件值得复盘的小事</h2>
        <div className="no-data">本期没有明显的异常或趋势变化。</div>
      </section>
    );
  }

  return (
    <section className="story">
      <div className="section-label">06 · 复盘</div>
      <h2 className="section-title">几件值得复盘的小事</h2>
      <p className="section-sub">基于你本期与上一周期的对比，自动挑出最值得关注的几条。点击展开看支撑数据。</p>

      <div className="insights">
        {insights.map((ins, i) => (
          <div key={i} className={`insight ${openIdx === i ? 'open' : ''}`}
            onClick={() => setOpenIdx(openIdx === i ? null : i)}>
            <div className="insight-head">
              <div className={`insight-emoji ${ins.kind}`}>{ins.emoji}</div>
              <div className="insight-text">{ins.headline}</div>
              <svg className="insight-arrow" width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="insight-body">
              <div className="insight-detail">
                {ins.detail.map((d, di) => (
                  <div key={di}>
                    <div className="k">{d.k}</div>
                    <div className="v">{d.v}</div>
                  </div>
                ))}
              </div>
              <p className="insight-narrative">{ins.narrative}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export { ToolsSection, EfficiencySection, InsightsSection };
