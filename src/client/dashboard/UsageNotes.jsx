import { U } from '../shared/utils.js';
import { useRef } from 'react';
import { Info, Question, X } from '@phosphor-icons/react';

export function InfoButton({ label, children }) {
  const ref = useRef(null);
  return <span className="metric-info">
    <button className="info-button" aria-label={label + '说明'} onClick={() => ref.current.showModal()}><Info size={17}/></button>
    <dialog ref={ref} className="metric-dialog" aria-label={label + '说明'} onClick={e => { if (e.target === ref.current) ref.current.close(); }}>
      <div className="help-heading"><h2>{label}</h2><button className="info-button" aria-label="关闭说明" onClick={() => ref.current.close()}><X size={20}/></button></div>
      <p>{children}</p>
    </dialog>
  </span>;
}

export function UsageNotes({ rows, pricing }) {
  const ref = useRef(null);
  const models = [...new Set(rows.filter(r => r.totalTokens > 0).map(r => r.model))];
  const unmatched = models.filter(model => pricing?.models?.[model] === false);
  const unchecked = models.filter(model => typeof pricing?.models?.[model] !== 'boolean');
  const timestamp = pricing?.primarySnapshotAt;
  const date = timestamp ? new Date(timestamp) : null;
  return <>
    <button className="btn help-trigger" onClick={() => ref.current.showModal()}><Question size={19}/>帮助</button>
    <dialog ref={ref} className="help-dialog" aria-labelledby="usage-help-title" onClick={e => { if (e.target === ref.current) ref.current.close(); }}>
    <div className="help-heading"><div><h2 id="usage-help-title">帮助与数据说明</h2><p className="muted">了解数字背后的计算方式</p></div><button className="info-button" aria-label="关闭帮助" onClick={() => ref.current.close()}><X size={22}/></button></div>
    <div className="usage-notes-grid">
      <section><h3>Token 怎么算</h3>
        <p>总 Token 汇总采集记录中的总量；不同工具可能包含缓存或未细分用量，不能简单把所有展示项再次相加。</p>
        <p>输出是模型生成的用量。部分工具的推理 Token 已包含在输出中，不重复累加。</p>
      </section>
      <section><h3>缓存怎么算</h3>
        <p>缓存 = 缓存读取 + 缓存创建；命中率 = 缓存读取 ÷ 总 Token。缓存节省费用是估算，不是实际退款。</p>
      </section>
      <section><h3>数据完整性</h3>
        <p>项目归属和最后活动来自事件明细，不按最大项目推算。缺少明细的历史用量不会分配给某个项目。</p>
        <p>当前范围有 {rows.filter(r => ['legacy_unknown', 'unknown'].includes(r.costBasis)).length} 组费用未保存完整计价依据；{rows.filter(r => r.reconciliation === 'missing_details').length} 组汇总缺少明细，{rows.filter(r => ['token_difference', 'cost_difference'].includes(r.reconciliation)).length} 组汇总与明细存在差异。不同费用口径保留原值，不自动重算。</p>
      </section>
      <section><h3>导出 CSV</h3>
        <p>用量明细按当前筛选下载，不包含上一周期对比数据。请在浏览器下载列表查看进度、失败原因或取消下载。</p>
        <p>需要核对固定结果时，请等采集和同步完成后再导出；下载期间的数据更新可能影响结果。</p>
      </section>
      <section><h3>费用不是账单</h3>
        <p>显示已有记录的费用汇总，可能来自工具记录或价格估算；旧记录未保存计价依据时标为未知口径，不等同于订阅支出或实际账单。本页不会按新价格重算历史记录。新增漏算用量单独补入，既有费用保留。</p>
        <p>主价格目录快照：{date && Number.isFinite(date.getTime()) ? U.formatTs(date.toISOString()) : '更新时间未知'}。不代表所有模型价格的生效时间或历史记录的计价版本。</p>
        <p>未匹配价格且没有已记录费用的用量无法估价，总费用可能不完整；零费用不一定代表免费。</p>
        {unmatched.length > 0 && <p>当前未匹配价格：{unmatched.join('、')}。已有费用仍保留。</p>}
        {unchecked.length > 0 && <p>价格状态待确认：{unchecked.join('、')}。</p>}
      </section>
    </div>
    </dialog>
  </>;
}
