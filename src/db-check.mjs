import './load-env.mjs';
import { openDb } from './db.mjs';

const db = await openDb();
try {
  console.log(`[db:check] driver=${db.driver}`);
  for (const table of ['collection_runs', 'daily_usage', 'session_usage', 'time_usage']) {
    if (table === 'collection_runs') {
      const row = await db.get(`SELECT COUNT(*) AS count FROM ${table}`);
      console.log(`${table}=${Number(row.count)}`);
      continue;
    }
    const row = await db.get(`
      SELECT COUNT(*) AS count,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM ${table}
    `);
    console.log(
      `${table}=${Number(row.count)} total_tokens=${Number(row.total_tokens)} cost_usd=${Number(row.cost_usd)}`
    );
  }
} finally {
  await db.close();
}
