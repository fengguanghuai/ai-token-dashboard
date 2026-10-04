import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const shapeValid = value => value && Number.isSafeInteger(value.offset) && value.offset >= 0
  && Array.isArray(value.events) && Number.isSafeInteger(value.committedCount)
  && value.committedCount >= 0 && value.committedCount <= value.events.length
  && value.state && typeof value.state === 'object' && !Array.isArray(value.state);
const identity = st => ({ dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs,
  size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });

// Detect accidental checkpoint corruption, including valid JSON with changed
// parser state. This is not an authenticity check against malicious edits.
export function validAppendCheckpoint(value) {
  if (!shapeValid(value) || value.mode !== 'append-only' || !value.file
      || !Number.isSafeInteger(value.file.size) || value.file.size < value.offset) return false;
  const { checksum, ...payload } = value;
  return typeof checksum === 'string' && checksum === hash(JSON.stringify(payload));
}

function parseBytes(bytes, previous, parse, base = 0) {
  const end = bytes.lastIndexOf(10) + 1;
  const next = parse(bytes.subarray(0, end).toString('utf8'), previous ? structuredClone(previous.state) : undefined);
  const committed = [...(previous ? previous.events.slice(0, previous.committedCount) : []), ...next.events];
  // An unterminated final line is visible but never checkpointed. Re-reading it
  // also preserves partial JSON and partial UTF-8 across subsequent appends.
  const tail = parse(bytes.subarray(end).toString('utf8'), structuredClone(next.state));
  return { offset: base + end, state: next.state, committedCount: committed.length,
    events: [...committed, ...tail.events] };
}

// Default: verify every consumed byte. Opt-in append-only mode trusts that old
// bytes never change; identity/size checks cannot detect a middle edit followed
// by growth. Switching modes requires a fresh cache version in the collector.
export async function parseAppendOnly(file, previous, parse, { appendOnly = false, onRead } = {}) {
  const handle = await open(file, 'r');
  try {
    const before = identity(await handle.stat());
    const reusable = appendOnly && validAppendCheckpoint(previous)
      && before.ino !== 0 && ['dev', 'ino', 'birthtimeMs'].every(key => before[key] === previous.file[key])
      && before.size >= previous.file.size
      && (before.size > previous.file.size || ['mtimeMs', 'ctimeMs'].every(key => before[key] === previous.file[key]));
    let result;
    if (reusable) {
      const bytes = Buffer.alloc(before.size - previous.offset);
      let count = 0;
      while (count < bytes.length) {
        const { bytesRead } = await handle.read(bytes, count, bytes.length - count, previous.offset + count);
        onRead?.(bytesRead);
        if (!bytesRead) break;
        count += bytesRead;
      }
      const after = identity(await handle.stat());
      if (count === bytes.length && after.size >= before.size
          && (after.size > before.size || ['mtimeMs', 'ctimeMs'].every(key => after[key] === before[key]))) {
        result = parseBytes(bytes, previous, parse, previous.offset);
      } else {
        // An observed truncate/rewrite is outside the append-only contract.
        // Do not issue a checkpoint assembled from two versions of the file.
        throw new Error('Log changed while reading; retry collection');
      }
    } else {
      const bytes = await handle.readFile();
      onRead?.(bytes.length);
      const valid = previous?.mode !== 'append-only' && shapeValid(previous) && previous.offset <= bytes.length
        && (previous.offset === 0 || bytes[previous.offset - 1] === 10)
        && hash(bytes.subarray(0, previous.offset)) === previous.hash;
      const base = valid ? previous.offset : 0;
      result = parseBytes(bytes.subarray(base), valid ? previous : null, parse, base);
      result.hash = hash(bytes.subarray(0, result.offset));
      if (appendOnly) {
        const after = identity(await handle.stat());
        if (bytes.length !== before.size || JSON.stringify(after) !== JSON.stringify(before)) {
          throw new Error('Log changed while establishing its append checkpoint; retry collection');
        }
      }
    }
    if (appendOnly) {
      result.mode = 'append-only'; result.file = before;
      result.checksum = hash(JSON.stringify(result));
    }
    return result;
  } finally { await handle.close(); }
}
