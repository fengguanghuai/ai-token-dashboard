// Component-local cache: no persistence or sharing across authenticated pages.
// Cancelled/failed requests never populate it or replace the active range.
export function createRangeQuery(loader, onChange, { ttl = 30_000, maxEntries = 4, maxRows = 5000, now = Date.now } = {}) {
  const cache = new Map();
  let active = null;
  const cancel = () => { active?.controller.abort(); active = null; };
  const clear = () => { cancel(); cache.clear(); };
  async function load(query, { force = false } = {}) {
    cancel();
    const key = JSON.stringify(query);
    const hit = cache.get(key);
    if (!force && hit && now() - hit.at < ttl) {
      cache.delete(key); cache.set(key, hit);
      onChange({ key, data: hit.data, loading: false, error: null });
      return;
    }
    cache.delete(key);
    const request = { controller: new AbortController() };
    active = request;
    onChange({ key, data: null, loading: true, error: null });
    try {
      const data = await loader(query, { signal: request.controller.signal });
      if (active !== request || request.controller.signal.aborted) return;
      const rows = Object.values(data).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
      if (rows <= maxRows) {
        cache.set(key, { at: now(), data });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      }
      onChange({ key, data, loading: false, error: null });
    } catch (error) {
      if (active !== request || request.controller.signal.aborted) return;
      onChange({ key, data: null, loading: false, error: error.message });
    } finally { if (active === request) active = null; }
  }
  return { load, cancel, clear };
}
