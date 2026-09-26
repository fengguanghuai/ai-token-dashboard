import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Reuse parser state only after verifying every consumed byte. Sampling the
// head/tail cannot detect an edit in the middle followed by an append.
// This saves JSON parsing, not disk reads. The checkpoint contains raw usage,
// never prices. An unterminated final line is visible but never checkpointed.
export async function parseAppendOnly(file, previous, parse) {
  const bytes = await readFile(file);
  const valid = previous && Number.isSafeInteger(previous.offset)
    && previous.offset >= 0 && previous.offset <= bytes.length
    && Array.isArray(previous.events) && Number.isSafeInteger(previous.committedCount)
    && previous.committedCount >= 0 && previous.committedCount <= previous.events.length && previous.state
    && (previous.offset === 0 || bytes[previous.offset - 1] === 10)
    && hash(bytes.subarray(0, previous.offset)) === previous.hash;
  const offset = valid ? previous.offset : 0;
  const end = bytes.lastIndexOf(10) + 1;
  const next = parse(bytes.subarray(offset, end).toString('utf8'), valid ? structuredClone(previous.state) : undefined);
  const committed = [...(valid ? previous.events.slice(0, previous.committedCount) : []), ...next.events];
  const tail = parse(bytes.subarray(end).toString('utf8'), structuredClone(next.state));
  return { offset: end, hash: hash(bytes.subarray(0, end)), state: next.state,
    committedCount: committed.length, events: [...committed, ...tail.events] };
}
