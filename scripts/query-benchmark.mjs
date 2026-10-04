// Synthetic SQLite only. Each sample uses a fresh process to exclude seeding
// allocations from query peak RSS. No application .env or personal logs loaded.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.mjs';
import { queryDaily, queryUsageMetadata } from '../src/usage-query.mjs';

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === '--worker') {
  const db = await openDb(process.argv[3], { readOnly: true });
  try {
    const params = new URLSearchParams(process.argv[4]);
    const rssBeforeMiB = process.memoryUsage().rss / 1024 ** 2;
    const start = performance.now();
    const result = { ...await queryDaily(db, params, {}), ...await queryUsageMetadata(db) };
    const queryMs = performance.now() - start;
    // Include response serialization, but not HTTP, browser rendering or a real
    // pricing snapshot. Costs are stored values; synthetic models are unknown.
    const bytes = Buffer.byteLength(JSON.stringify(result));
    const total = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0);
    assert.equal(total(result.daily, 'totalTokens'), total(result.projectDaily, 'totalTokens'));
    assert.equal(total(result.daily, 'costUSD'), total(result.projectDaily, 'costUSD'));
    console.log(JSON.stringify({ queryMs, totalMs: performance.now() - start, bytes,
      dailyRows: result.daily.length, projectRows: result.projectDaily.length,
      totalTokens: total(result.daily, 'totalTokens'), costUSD: total(result.daily, 'costUSD'),
      rssBeforeMiB, peakRssMiB: process.resourceUsage().maxRSS / 1024 }));
  } finally { await db.close(); }
} else {
  const count = Number(process.argv[2] || 100_000);
  if (!Number.isSafeInteger(count) || count < 365 || count > 2_000_000) throw new Error('Use an event count from 365 to 2000000');
  const root = mkdtempSync(join(tmpdir(), 'dashboard-query-benchmark-'));
  const path = join(root, 'synthetic.sqlite');
  try {
    const db = new DatabaseSync(path);
    try {
      db.exec(readFileSync(new URL('../db/schema.sqlite.sql', import.meta.url), 'utf8'));
      const insert = db.prepare(`INSERT INTO time_usage (device, source, event_key, event_time, usage_date, model, project_path,
        input_tokens, output_tokens, total_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, 100, 10, 110, 0.25)`);
      db.exec('BEGIN');
      for (let i = 0; i < count; i++) {
        const j = Math.floor(i / 365), day = i % 365;
        const time = new Date(Date.UTC(2025, 0, 1) + day * 86400_000 + j % 86400 * 1000).toISOString();
        insert.run(`device-${j % 2}`, j % 4 < 2 ? 'Codex CLI' : 'Claude Code', `event-${i}`, time, time.slice(0, 10),
          `synthetic-model-${Math.floor(j / 4) % 3}`, `/synthetic/project-${Math.floor(j / 12) % 4}`);
      }
      db.exec(`INSERT INTO daily_usage (device, source, usage_date, model, input_tokens, output_tokens, total_tokens, cost_usd)
        SELECT device, source, usage_date, model, SUM(input_tokens), SUM(output_tokens), SUM(total_tokens), SUM(cost_usd)
        FROM time_usage GROUP BY device, source, usage_date, model; COMMIT;`);
    } finally { db.close(); }
    const results = {};
    for (const [scenario, params] of [['all', ''], ['30days', 'startDate=2025-12-02&endDate=2025-12-31']]) {
      results[scenario] = [];
      for (let sample = 0; sample < 3; sample++) {
        const child = spawnSync(process.execPath, [self, '--worker', path, params], {
          env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), DISPLAY_TZ: 'UTC' },
          encoding: 'utf8', timeout: 120_000
        });
        assert.equal(child.status, 0, child.stderr);
        const result = JSON.parse(child.stdout);
        const selected = scenario === 'all' ? count : Math.floor(count / 365) * 30 + Math.max(0, count % 365 - 335);
        assert.equal(result.totalTokens, selected * 110);
        assert.equal(result.costUSD, selected * 0.25);
        results[scenario].push(result);
      }
    }
    console.log(JSON.stringify({ events: count, days: 365, node: process.version, platform: process.platform, arch: process.arch, results }, null, 2));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
