/**
 * Incremental parse cache.
 *
 * Collectors re-scan every session file on each run. Most files never change
 * between runs (only the active session gets appended), yet they were fully
 * re-read and re-parsed every time. This caches each file's *parsed records*
 * keyed by a cheap fingerprint (mtime + size); unchanged files are served from
 * cache instead of being re-parsed.
 *
 * Important invariants:
 *   - Only raw parsed records are cached — never costs. Cost is recomputed
 *     downstream from the cached tokens, so pricing updates still take effect.
 *   - Records must be JSON-serializable (plain numbers/strings/null/objects).
 *   - Bump the `version` passed by a collector whenever its parser logic
 *     changes, so stale entries are discarded.
 *
 * Set PARSE_CACHE=0 to disable entirely (falls back to always parsing).
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const CACHE_ROOT = process.env.AI_TOKEN_DASHBOARD_CACHE_DIR
  || resolve(process.cwd(), 'data', 'parse-cache');

const DISABLED = ['0', 'false', 'no', 'off']
  .includes(String(process.env.PARSE_CACHE ?? '').trim().toLowerCase());

// namespace -> { version, prev: Map<path,{fp,records}>, next: Map<...>, path }
const stores = new Map();

function cachePathFor(namespace) {
  return resolve(CACHE_ROOT, `${namespace}.json`);
}

async function getStore(namespace, version) {
  let store = stores.get(namespace);
  if (store && store.version === version) return store;

  store = { version, prev: new Map(), next: new Map(), path: cachePathFor(namespace) };
  try {
    const raw = JSON.parse(await readFile(store.path, 'utf8'));
    if (raw && raw.version === version && raw.files) {
      for (const [key, value] of Object.entries(raw.files)) {
        if (value && typeof value.fp === 'string') store.prev.set(key, value);
      }
    }
  } catch {
    // no usable cache — start cold
  }
  stores.set(namespace, store);
  return store;
}

async function fingerprint(filePath) {
  try {
    const st = await stat(filePath);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return null;
  }
}

/**
 * Return parsed records for `filePath`, reusing the cache when the file's
 * fingerprint is unchanged. `parseFile(filePath)` is only invoked on a miss.
 */
export async function cachedParse(namespace, version, filePath, parseFile) {
  if (DISABLED) return parseFile(filePath);

  const store = await getStore(namespace, version);
  const fp = await fingerprint(filePath);

  if (fp) {
    const hit = store.prev.get(filePath);
    if (hit && hit.fp === fp) {
      store.next.set(filePath, hit);
      return hit.records;
    }
  }

  const records = await parseFile(filePath);
  // Only cache stat-able files; unstattable ones are parsed fresh every time.
  if (fp) store.next.set(filePath, { fp, records });
  return records;
}

/**
 * Persist the entries touched this run (dropping files no longer present) and
 * reset the in-memory state so a second pass in the same process stays correct.
 */
export async function flushCache(namespace) {
  if (DISABLED) return;
  const store = stores.get(namespace);
  if (!store) return;

  const files = {};
  for (const [key, value] of store.next) files[key] = value;

  try {
    await mkdir(dirname(store.path), { recursive: true });
    await writeFile(store.path, JSON.stringify({ version: store.version, files }));
  } catch {
    // best-effort: a failed cache write must never break collection
  }

  store.prev = store.next;
  store.next = new Map();
}
