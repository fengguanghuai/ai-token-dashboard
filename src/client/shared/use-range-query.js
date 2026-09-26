import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRangeQuery } from './range-query.js';

export function useRangeQuery(loader, query, revision = 0) {
  const [state, setState] = useState({ key: null, data: null, loading: false, error: null, loadedKey: null });
  const resource = useMemo(() => createRangeQuery(loader, next => setState(previous => ({
    ...next,
    // Keep metadata/controls mounted, but callers must gate statistics on ready.
    data: next.data ?? previous.data,
    loadedKey: next.data ? next.key : previous.loadedKey
  }))), [loader]);
  const key = query ? JSON.stringify(query) : null;
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (lastRevision.current !== revision) { resource.clear(); lastRevision.current = revision; }
    if (key) resource.load(JSON.parse(key));
    else resource.cancel();
    return resource.cancel;
  }, [resource, key, revision]);
  const retry = useCallback(() => { if (key) resource.load(JSON.parse(key), { force: true }); }, [resource, key]);
  return { ...state, retry, ready: Boolean(key && state.key === key && state.loadedKey === key && !state.loading && !state.error) };
}
