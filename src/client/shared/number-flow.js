// Animate the already-formatted display value, never change calculation precision.
export function numberFlowParts(formatted) {
  const match = String(formatted).match(/^([^\d+\-]*)([-+]?\d[\d,]*(?:\.\d+)?)(.*)$/);
  if (!match) return null;
  const value = Number(match[2].replaceAll(',', ''));
  if (!Number.isFinite(value)) return null;
  const digits = match[2].split('.')[1]?.length || 0;
  return { value, prefix: match[1], suffix: match[3], format: {
    useGrouping: match[2].includes(','), minimumFractionDigits: digits, maximumFractionDigits: digits,
  } };
}
