const formatters = new Map();

export function resolveDisplayTz() {
  const tz = (process.env.DISPLAY_TZ || '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    if (!/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(tz)) throw new Error('Invalid timezone');
    new Intl.DateTimeFormat('en', { timeZone: tz }).format();
    return tz;
  } catch { return 'UTC'; }
}

export function zonedParts(value, tz = resolveDisplayTz()) {
  const date = new Date(typeof value === 'string' && /^\d{4}-\d{2}-\d{2} /.test(value) ? value.replace(' ', 'T') + 'Z' : value);
  if (!Number.isFinite(date.getTime())) return null;
  if (!formatters.has(tz)) formatters.set(tz, new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }));
  const parts = Object.fromEntries(formatters.get(tz).formatToParts(date).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
