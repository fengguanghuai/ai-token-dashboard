const tokenFields = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'reasoningOutputTokens', 'totalTokens'];

function text(value, name, { optional = false, max = 4096 } = {}) {
  if (optional && value == null) return;
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(`Invalid ${name}`);
  }
}

export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${name}`);
}

export function validateIngest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected an object');
  const mode = payload.mode ?? 'incremental';
  if (!['incremental', 'full'].includes(mode)) throw new Error('Invalid mode');
  const result = { mode };
  for (const kind of ['daily', 'time', 'sessions', 'runs', 'scopes']) {
    const rows = payload[kind] ?? [];
    if (!Array.isArray(rows) || rows.length > 100_000) throw new Error(`Invalid ${kind} array`);
    result[kind] = rows.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Invalid ${kind} row`);
      text(row.device, 'device', { max: 255 });
      text(row.source, 'source', { max: 255 });
      if (kind === 'scopes') return { device: row.device, source: row.source };
      if (kind === 'runs') {
        if (!['ok', 'empty', 'error', 'warn', 'skip'].includes(row.status)) throw new Error('Invalid run status');
        if (row.collectedAt != null) timestamp(row.collectedAt, 'collectedAt');
        for (const key of ['message', 'command']) if (row[key] != null && typeof row[key] !== 'string') throw new Error(`Invalid ${key}`);
        return { ...row };
      }
      for (const key of tokenFields) {
        if (row[key] != null && (!Number.isSafeInteger(row[key]) || row[key] < 0)) throw new Error(`Invalid ${key}`);
      }
      if (row.costUSD != null && (typeof row.costUSD !== 'number' || !Number.isFinite(row.costUSD) || row.costUSD < 0)) throw new Error('Invalid costUSD');
      if (row.costBasis != null && !['legacy_unknown', 'estimated', 'recorded', 'mixed', 'unknown'].includes(row.costBasis)) throw new Error('Invalid costBasis');
      text(row.pricingVersion, 'pricingVersion', { optional: true, max: 64 });
      text(row.model, 'model', { optional: true, max: 255 });
      text(row.projectPath, 'projectPath', { optional: true });
      if (kind !== 'sessions' && !validDate(row.usageDate)) throw new Error('Invalid usageDate');
      if (kind === 'time') {
        text(row.eventKey, 'eventKey');
        text(row.sessionId, 'sessionId', { optional: true });
        timestamp(row.eventTime, 'eventTime');
      }
      if (kind === 'sessions') {
        text(row.sessionId, 'sessionId');
        if (row.lastActivity != null) timestamp(row.lastActivity, 'lastActivity');
      }
      return { ...row, ...(kind === 'time' ? { eventTime: new Date(row.eventTime).toISOString() } : {}) };
    });
  }
  // Full replacement must name its scope, including sources whose replacement
  // is empty. A missing mode never turns an ordinary upload into a deletion.
  if (mode === 'full') {
    if (!result.scopes.length) throw new Error('Full replacement requires explicit scopes');
    const scopes = new Set(result.scopes.map(row => JSON.stringify([row.device, row.source])));
    for (const row of [...result.daily, ...result.time, ...result.sessions]) {
      if (!scopes.has(JSON.stringify([row.device, row.source]))) throw new Error('Row outside replacement scope');
    }
  }
  return result;
}
