/**
 * 为已有 Token 但费用为 0 的历史日账回填模型费用。
 *
 * 优先按 time_usage 中的逐事件费用汇总，避免将日汇总 Token 误按单次请求的
 * 阶梯价格计算；缺少事件明细时再使用最新定价按汇总 Token 估算。
 * 仅更新可得出正数费用的记录，不会改写免费模型或仍无定价的记录。
 *
 * @author fengguanghuai-jwk
 * @date 2026-07-15
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { defaultDbPath } from './db.mjs';
import { calculateCost, loadPricing } from './pricing.mjs';

const args = parseArgs(process.argv.slice(2));
const dbPath = resolve(args.db || process.env.DB_PATH || defaultDbPath);
const pricingPath = resolve(process.cwd(), 'data', 'pricing-litellm.json');
const pricingData = await loadPricing(pricingPath);

if (!pricingData) {
  throw new Error('未能加载定价缓存；请先执行 npm run pricing:update');
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 10000');

const rows = db.prepare(`
  SELECT device, source, usage_date, model,
    input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
    reasoning_output_tokens, total_tokens
  FROM daily_usage
  WHERE total_tokens > 0 AND cost_usd = 0
  ORDER BY usage_date, source, model
`).all();

const timeCost = db.prepare(`
  SELECT COUNT(*) AS events, COALESCE(SUM(total_tokens), 0) AS tokens,
    COALESCE(SUM(cost_usd), 0) AS cost
  FROM time_usage
  WHERE device = ? AND source = ? AND usage_date = ? AND model = ?
`);
const updateDaily = db.prepare(`
  UPDATE daily_usage
  SET cost_usd = ?, updated_at = datetime('now')
  WHERE device = ? AND source = ? AND usage_date = ? AND model = ? AND cost_usd = 0
`);

let updated = 0;
let fromEvents = 0;
const skipped = [];

db.exec('BEGIN');
try {
  for (const row of rows) {
    const eventSummary = timeCost.get(row.device, row.source, row.usage_date, row.model);
    const eventCost = Number(eventSummary.cost);
    const hasCompleteEventCosts = eventSummary.events > 0
      && Number(eventSummary.tokens) === row.total_tokens
      && eventCost > 0;
    const estimatedCost = calculateCost(row.model, {
      input: row.input_tokens,
      output: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_creation_tokens,
      reasoning: row.reasoning_output_tokens
    }, pricingData, null, { tiered: false });
    const cost = hasCompleteEventCosts ? eventCost : estimatedCost;

    if (!Number.isFinite(cost) || cost <= 0) {
      skipped.push(`${row.usage_date} ${row.source} ${row.model}`);
      continue;
    }

    updateDaily.run(cost, row.device, row.source, row.usage_date, row.model);
    updated += 1;
    if (hasCompleteEventCosts) fromEvents += 1;
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}

console.log(`[pricing] historical daily rows scanned=${rows.length}, updated=${updated}, event-summed=${fromEvents}, skipped=${skipped.length}`);
if (skipped.length) console.log(`[pricing] still without a positive price: ${skipped.join('; ')}`);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--db' && argv[index + 1]) {
      result.db = argv[index + 1];
      index += 1;
    }
  }
  return result;
}
