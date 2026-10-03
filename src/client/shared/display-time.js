let zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let formatter;

export function setDisplayTimeZone(value) {
  if (typeof value !== 'string' || !value) throw new Error('展示时区无效');
  formatter = new Intl.DateTimeFormat('en-CA', { timeZone: value, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  zone = value;
}

export function displayTimeZone() { return zone; }

export function displayDateTime(value) {
  if (!formatter) setDisplayTimeZone(zone);
  const p = Object.fromEntries(formatter.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

// datetime-local has no offset. Resolve it in the server's display zone, not
// the browser's zone. Reject missing DST hours; repeated hours use the earlier
// instant, consistently for filtering, comparison and event exports.
export function displayTimeMs(value) {
  const text = String(value).replace(' ', 'T');
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return Date.parse(text);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(text)) return NaN;
  const wall = text.length === 16 ? `${text}:00` : text;
  const guess = Date.parse(`${wall}Z`);
  if (!Number.isFinite(guess) || new Date(guess).toISOString().slice(0, 19) !== wall.slice(0, 19)) return NaN;
  const offsets = [-2, 0, 2].map(days => {
    const probe = guess + days * 86400_000;
    return Date.parse(displayDateTime(probe) + 'Z') - Math.floor(probe / 1000) * 1000;
  });
  const candidates = [...new Set(offsets)].map(offset => guess - offset)
    .filter(instant => displayDateTime(instant) === wall.slice(0, 19));
  return candidates.length ? Math.min(...candidates) : NaN;
}
