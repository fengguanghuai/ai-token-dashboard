import { U } from '../shared/utils.js';

export function UsageNotes({ rows, pricing }) {
  const models = [...new Set(rows.filter(r => r.totalTokens > 0).map(r => r.model))];
  const unmatched = models.filter(model => pricing?.models?.[model] === false);
  const unchecked = models.filter(model => typeof pricing?.models?.[model] !== 'boolean');
  const timestamp = pricing?.primarySnapshotAt;
  const date = timestamp ? new Date(timestamp) : null;
  return <details className="panel usage-notes">
    <summary>统计口径与价格说明
      <span className="muted">{unmatched.length ? ` · ${unmatched.length} 个模型当前未匹配价格` : unchecked.length ? ' · 部分价格状态待确认' : ' · 查看计算方式'}</span>
    </summary>
    <div className="usage-notes-grid">
      <section><h3>Token 怎么算</h3>
        <p>总 Token 汇总采集记录中的总量；不同工具可能包含缓存或未细分用量，不能简单把所有展示项再次相加。</p>
        <p>Output 是输出用量。部分工具的推理 Token 已包含在输出中，不重复累加。</p>
      </section>
      <section><h3>缓存怎么算</h3>
        <p>Cache = 缓存读取 + 缓存创建；命中率 = 缓存读取 ÷ 总 Token。缓存节省费用是估算，不是实际退款。</p>
      </section>
      <section><h3>费用不是账单</h3>
        <p>显示已有记录的费用汇总，可能来自工具记录或价格估算，不等同于订阅支出或实际账单。本页不会按新价格重算历史记录。</p>
        <p>主价格目录快照：{date && Number.isFinite(date.getTime()) ? U.formatTs(date.toISOString()) : '更新时间未知'}。不代表所有模型价格的生效时间或历史记录的计价版本。</p>
        <p>未匹配价格且没有已记录费用的用量无法估价，总费用可能不完整；零费用不一定代表免费。</p>
        {unmatched.length > 0 && <p>当前未匹配价格：{unmatched.join('、')}。已有费用仍保留。</p>}
        {unchecked.length > 0 && <p>价格状态待确认：{unchecked.join('、')}。</p>}
      </section>
    </div>
  </details>;
}
