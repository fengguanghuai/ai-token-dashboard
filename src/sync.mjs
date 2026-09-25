import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { rowKey } from './usage-store.mjs';
import { TABLES } from './db-batch.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

/** The manifest describes acknowledged content, independently of local event
 * timestamps. Old/offline/late events are included until the hub confirms them. */
export async function syncSnapshot({ url, token, device, snapshot, stateDir, full = false, scopes = [], fetcher = fetch }) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Use an HTTP(S) ingest URL and --token');
  const path = join(stateDir, `${hash(JSON.stringify([target.href, device]))}.json`);
  let previous = {};
  try { previous = JSON.parse(await readFile(path, 'utf8')).rows || {}; } catch { /* first sync */ }
  const acknowledged = {};
  const pending = {};
  for (const kind of Object.keys(TABLES)) {
    pending[kind] = snapshot[kind].filter(row => !full || scopes.some(scope => row.device === scope.device && row.source === scope.source)).filter(row => {
      const key = hash(`${kind}:${rowKey(kind, row)}`);
      const value = hash(JSON.stringify(TABLES[kind].fields.filter(([, name]) => name !== 'pricingLockedAt').map(([, name, fallback]) => row[name] ?? fallback)));
      acknowledged[key] = value;
      return full || previous[key] !== value;
    });
  }
  let requests = 0;
  const send = async payload => {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 48 * 1024 * 1024) throw new Error('Replacement exceeds 48 MiB; rebuild one source at a time with --source');
    const response = await fetcher(target.href, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body, signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`Upload failed: HTTP ${response.status}`);
    const result = await response.json();
    if (result.ok !== true) throw new Error('Hub did not acknowledge upload');
    requests++;
  };
  if (full) {
    // Each source replacement is atomic, including explicitly empty scopes.
    for (const scope of scopes) {
      const payload = { mode: 'full', scopes: [scope] };
      for (const kind of Object.keys(TABLES)) payload[kind] = pending[kind].filter(row => row.device === scope.device && row.source === scope.source);
      await send(payload);
    }
  } else {
    const count = Math.max(...Object.values(pending).map(rows => rows.length));
    for (let i = 0; i < count; i += 1000) {
      await send({ mode: 'incremental', ...Object.fromEntries(Object.entries(pending).map(([kind, rows]) => [kind, rows.slice(i, i + 1000)])) });
    }
  }
  // Never advance on a partial failure. Retrying already accepted chunks is safe.
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString(), rows: acknowledged }), { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return { requests, rows: Object.fromEntries(Object.entries(pending).map(([kind, rows]) => [kind, rows.length])) };
}
