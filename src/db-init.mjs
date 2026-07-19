import './load-env.mjs';
import { openDb } from './db.mjs';

const db = await openDb();
try {
  const tables = ['collection_runs', 'daily_usage', 'session_usage', 'time_usage'];
  for (const table of tables) await db.get(`SELECT COUNT(*) AS count FROM ${table}`);
  console.log(`[db:init] driver=${db.driver} schema ready`);
} finally {
  await db.close();
}
