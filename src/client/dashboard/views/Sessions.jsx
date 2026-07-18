import { useMemo, useState } from 'react';
import { ArrowsClockwise, ChatsCircle, Info, MagnifyingGlass } from '@phosphor-icons/react';
import { U } from '../../shared/utils.js';
import { aggregate, normalizeNumber, SourceIdentity } from '../view-utils.jsx';

export default function SessionsView({ timeRows, fallbackSessions, selectedSources, startDate, endDate }) {
  const [search, setSearch] = useState('');
  const sessions = useMemo(() => {
    if (timeRows === null) return null;
    const eligible = timeRows.filter(row => row.sessionId && row.usageDate >= startDate && row.usageDate <= endDate && (selectedSources.size === 0 || selectedSources.has(row.source)));
    const map = new Map();
    for (const row of eligible) {
      const key = `${row.source}::${row.sessionId}`;
      if (!map.has(key)) map.set(key, { source: row.source, sessionId: row.sessionId, projectPath: row.projectPath || '未标记项目', model: row.model || '未标记模型', eventCount: 0, lastActivity: row.eventTime, ...aggregate([]) });
      const item = map.get(key);
      item.eventCount += 1;
      if (String(row.eventTime) > String(item.lastActivity)) item.lastActivity = row.eventTime;
      item.totalTokens += normalizeNumber(row.totalTokens);
      item.inputTokens += normalizeNumber(row.inputTokens);
      item.outputTokens += normalizeNumber(row.outputTokens);
      item.cacheReadTokens += normalizeNumber(row.cacheReadTokens);
      item.cacheCreationTokens += normalizeNumber(row.cacheCreationTokens);
      item.reasoningTokens += normalizeNumber(row.reasoningOutputTokens);
      item.costUSD += normalizeNumber(row.costUSD);
    }
    return Array.from(map.values()).filter(row => [row.source, row.sessionId, row.projectPath, row.model].some(value => String(value).toLowerCase().includes(search.toLowerCase()))).sort((a, b) => b.totalTokens - a.totalTokens);
  }, [timeRows, startDate, endDate, selectedSources, search]);
  const aggregateCount = fallbackSessions.filter(row => selectedSources.size === 0 || selectedSources.has(row.source)).length;
  return (
    <div className="page-stack">
      <section className="panel sessions-panel">
        <div className="section-heading usage-heading">
          <div><h2>会话</h2><p>仅展示事件记录中可确认 session_id 的真实会话</p></div>
          <label className="search-box"><MagnifyingGlass size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索来源、项目、模型或会话 ID…" /></label>
        </div>
        {sessions === null ? (
          <div className="chart-empty"><ArrowsClockwise className="spin" size={22} />正在读取事件级会话…</div>
        ) : sessions.length === 0 ? (
          <div className="empty-state"><ChatsCircle size={34} /><strong>当前周期没有可确认的真实会话</strong><span>数据库仍保留 {aggregateCount} 条工作区/模型聚合记录，但这里不会把聚合记录伪装成会话。</span></div>
        ) : (
          <div className="data-table-wrap">
            <table className="modern-table">
              <thead><tr><th>来源</th><th>项目 / 会话</th><th>模型</th><th>事件</th><th className="num">Total</th><th className="num">费用</th><th>最后活动</th></tr></thead>
              <tbody>{sessions.map(row => <tr key={`${row.source}-${row.sessionId}`}><td><SourceIdentity source={row.source} /></td><td><strong className="truncate" title={row.projectPath}>{row.projectPath}</strong><small className="mono truncate" title={row.sessionId}>{row.sessionId}</small></td><td><span className="mono truncate" title={row.model}>{row.model}</span></td><td>{row.eventCount}</td><td className="num strong">{U.compactCN(row.totalTokens)}</td><td className="num">{U.fmtUS.format(row.costUSD)}</td><td>{U.formatTs(row.lastActivity)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
      <div className="coverage-note"><Info size={16} /><span>Claude、Codex、OpenCode 等提供事件明细的来源可以形成真实会话；只提供日汇总的来源仍可在“用量拆解”查看，但不会出现在此表。</span></div>
    </div>
  );
}
