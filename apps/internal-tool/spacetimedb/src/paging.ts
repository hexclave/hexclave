
export type PageableRow = { id: bigint, createdAt: { microsSinceUnixEpoch: bigint } };


export type SliceScanner<Row extends PageableRow> = (
  loMicrosInclusive: bigint,
  hiMicros: bigint,
  hiInclusive: boolean,
) => Iterable<Row>;

export type PageCursor = { beforeCreatedAtMicros: bigint, beforeId: bigint | undefined };


export type OlderRowProbe = (hiMicros: bigint) => boolean;

export const PAGE_INITIAL_WINDOW_MICROS = 60n * 60n * 1000n * 1000n; // 1 hour
export const PAGE_MAX_WIDENINGS = 14;
export const PAGE_MAX_LIMIT = 200;

export function compareNewestFirst(a: PageableRow, b: PageableRow): number {
  const aMicros = a.createdAt.microsSinceUnixEpoch;
  const bMicros = b.createdAt.microsSinceUnixEpoch;
  if (aMicros !== bMicros) return aMicros > bMicros ? -1 : 1;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}


export function validatePageLimit(limit: number): string | null {
  if (!Number.isInteger(limit)) return 'limit must be an integer';
  if (limit <= 0) return 'limit must be greater than 0';
  return null;
}

export function clampPageLimit(limit: number): number {
  return limit > PAGE_MAX_LIMIT ? PAGE_MAX_LIMIT : limit;
}

export type Page<Row extends PageableRow> = {
  rows: Row[],
  resumeBeforeMicros: bigint | undefined,
};

export type PageOptions<Row extends PageableRow> = {
  matches?: (row: Row) => boolean,
  createdAtOrAfterMicros?: bigint,
};

export function pageByCreatedAt<Row extends PageableRow>(
  scanSlice: SliceScanner<Row>,
  anyOlderThan: OlderRowProbe,
  cursor: PageCursor,
  limit: number,
  options: PageOptions<Row> = {},
): Page<Row> {
  const cursorMicros = cursor.beforeCreatedAtMicros;
  const createdAtOrAfterMicros = options.createdAtOrAfterMicros ?? 0n;
  const collected: Row[] = [];
  let hiMicros = cursorMicros;
  let windowMicros = PAGE_INITIAL_WINDOW_MICROS;
  let resumeBeforeMicros: bigint | undefined = undefined;

  const trimToBest = () => {
    collected.sort(compareNewestFirst);
    if (collected.length > limit) collected.length = limit;
  };

  for (let widening = 0; widening <= PAGE_MAX_WIDENINGS; widening++) {
    if (hiMicros < createdAtOrAfterMicros || hiMicros <= 0n) break;
    const windowStart = hiMicros > windowMicros ? hiMicros - windowMicros : 0n;
    const loMicros = windowStart > createdAtOrAfterMicros ? windowStart : createdAtOrAfterMicros;

    for (const row of scanSlice(loMicros, hiMicros, widening === 0)) {
      if (cursor.beforeId != null && row.createdAt.microsSinceUnixEpoch === cursorMicros && row.id >= cursor.beforeId) {
        continue;
      }
      if (options.matches != null && !options.matches(row)) continue;
      collected.push(row);
      if (collected.length >= limit * 4) trimToBest();
    }

    trimToBest();
    if (collected.length >= limit) break;
    if (loMicros === createdAtOrAfterMicros) break;

    hiMicros = loMicros;
    windowMicros *= 2n;

    if (widening === PAGE_MAX_WIDENINGS && hiMicros > createdAtOrAfterMicros && anyOlderThan(hiMicros)) {
      resumeBeforeMicros = hiMicros - 1n;
    }
  }

  return { rows: collected, resumeBeforeMicros };
}


export function toPage<Row extends PageableRow>(page: Page<Row>, limit: number): {
  rows: Row[],
  nextBeforeCreatedAtMicros: bigint | undefined,
  nextBeforeId: bigint | undefined,
} {
  const rows = page.rows;
  if (rows.length >= limit) {
    const last = rows[rows.length - 1];
    return { rows, nextBeforeCreatedAtMicros: last.createdAt.microsSinceUnixEpoch, nextBeforeId: last.id };
  }
  if (page.resumeBeforeMicros != null) {
    return { rows, nextBeforeCreatedAtMicros: page.resumeBeforeMicros, nextBeforeId: undefined };
  }
  return { rows, nextBeforeCreatedAtMicros: undefined, nextBeforeId: undefined };
}
