export function parsePiledriverGcTimestamp(value: string) {
  const isEpochMillis = /^\d+$/.test(value);
  if (!isEpochMillis) throw new Error("GC cutoff must be non-negative epoch milliseconds");
  const millis = Number(value);
  if (!Number.isSafeInteger(millis) || millis < 0 || Number.isNaN(new Date(millis).getTime())) {
    throw new Error("GC cutoff must be non-negative epoch milliseconds representable by JavaScript Date");
  }
  return millis;
}

export function parsePiledriverGcMaxObjects(value: string | undefined) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("GC maxObjects must be a positive safe integer");
  return parsed;
}
