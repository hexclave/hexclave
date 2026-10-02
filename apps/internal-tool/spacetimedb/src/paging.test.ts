import { describe, expect, it } from "vitest";
import {
  PAGE_INITIAL_WINDOW_MICROS,
  PAGE_MAX_LIMIT,
  PAGE_MAX_WIDENINGS,
  clampPageLimit,
  compareNewestFirst,
  pageByCreatedAt,
  toPage,
  validatePageLimit,
  type OlderRowProbe,
  type PageCursor,
  type PageableRow,
  type SliceScanner,
} from "./paging";

type Row = PageableRow & { label: string };

function row(id: number | bigint, micros: number | bigint, label = `row-${id}`): Row {
  return { id: BigInt(id), createdAt: { microsSinceUnixEpoch: BigInt(micros) }, label };
}

/**
 * Stands in for a btree range scan over `createdAt`. Deliberately returns rows
 * in *insertion* order, not sorted: SpacetimeDB guarantees no ordering to the
 * caller, so any test that passed only because the fake handed rows back
 * newest-first would be lying about the real thing.
 */
function fakeIndex(rows: Row[]): {
  scan: SliceScanner<Row>,
  probe: OlderRowProbe,
  slices: Array<{ lo: bigint, hi: bigint, hiInclusive: boolean }>,
} {
  const slices: Array<{ lo: bigint, hi: bigint, hiInclusive: boolean }> = [];
  const scan: SliceScanner<Row> = (lo, hi, hiInclusive) => {
    slices.push({ lo, hi, hiInclusive });
    return rows.filter(r => {
      const at = r.createdAt.microsSinceUnixEpoch;
      return at >= lo && (hiInclusive ? at <= hi : at < hi);
    });
  };
  const probe: OlderRowProbe = (hi) => rows.some(r => r.createdAt.microsSinceUnixEpoch < hi);
  return { scan, probe, slices };
}

const HOUR = PAGE_INITIAL_WINDOW_MICROS;
// A "now" far enough from the epoch that the widening loop never clamps at 0.
const NOW = HOUR * 1_000_000n;

function cursorAt(micros: bigint, beforeId?: bigint): PageCursor {
  return { beforeCreatedAtMicros: micros, beforeId };
}

// Most assertions care only about which rows came back, not the resume marker.
function rowsOf(scan: SliceScanner<Row>, cursor: PageCursor, limit: number): Row[] {
  return pageByCreatedAt(scan, () => false, cursor, limit).rows;
}

// A page that reached the beginning of time, i.e. has no resume point.
function pageOf(rows: Row[]) {
  return { rows, resumeBeforeMicros: undefined };
}

function labels(rows: Row[]): string[] {
  return rows.map(r => r.label);
}

describe("compareNewestFirst", () => {
  it("orders newest first", () => {
    expect(labels([row(1, 10), row(2, 30), row(3, 20)].sort(compareNewestFirst)))
      .toEqual(["row-2", "row-3", "row-1"]);
  });

  it("breaks ties on the same timestamp by descending id, so the order is total", () => {
    expect(labels([row(1, 10), row(3, 10), row(2, 10)].sort(compareNewestFirst)))
      .toEqual(["row-3", "row-2", "row-1"]);
  });
});

describe("validatePageLimit / clampPageLimit", () => {
  it("rejects a limit that cannot produce a page", () => {
    expect(validatePageLimit(0)).not.toBeNull();
    expect(validatePageLimit(-1)).not.toBeNull();
    expect(validatePageLimit(1.5)).not.toBeNull();
  });

  it("accepts a usable limit", () => {
    expect(validatePageLimit(1)).toBeNull();
    expect(validatePageLimit(PAGE_MAX_LIMIT)).toBeNull();
  });

  it("caps an oversized limit rather than rejecting it", () => {
    expect(clampPageLimit(PAGE_MAX_LIMIT + 1_000)).toBe(PAGE_MAX_LIMIT);
    expect(clampPageLimit(10)).toBe(10);
  });
});

describe("pageByCreatedAt", () => {
  it("returns the newest rows first, even though the index yields them unordered", () => {
    const rows = [row(1, NOW - 30n), row(2, NOW - 10n), row(3, NOW - 20n)];
    const { scan } = fakeIndex(rows);

    expect(labels(rowsOf(scan, cursorAt(NOW), 10))).toEqual(["row-2", "row-3", "row-1"]);
  });

  it("returns no more than the limit", () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(i + 1, NOW - BigInt(i + 1)));
    const { scan } = fakeIndex(rows);

    expect(rowsOf(scan, cursorAt(NOW), 10)).toHaveLength(10);
  });

  it("includes a row sitting exactly on the cursor timestamp when no id cursor is given", () => {
    const { scan } = fakeIndex([row(1, NOW)]);

    expect(labels(rowsOf(scan, cursorAt(NOW), 10))).toEqual(["row-1"]);
  });

  it("excludes the cursor row itself and anything newer at the same instant", () => {
    // All three share a timestamp — the exact case `createdAt` alone cannot
    // separate, and where a naive `< cursor` would drop row-1 entirely.
    const { scan } = fakeIndex([row(1, NOW), row(2, NOW), row(3, NOW)]);

    expect(labels(rowsOf(scan, cursorAt(NOW, 3n), 10))).toEqual(["row-2", "row-1"]);
  });

  it("widens past the initial window to fill a page from older rows", () => {
    // Nothing in the first hour; the only row is ~4 hours back, so the loop
    // must double the window several times to reach it.
    const { scan, slices } = fakeIndex([row(1, NOW - HOUR * 4n)]);

    expect(labels(rowsOf(scan, cursorAt(NOW), 10))).toEqual(["row-1"]);
    expect(slices.length).toBeGreaterThan(1);
  });

  it("stops widening at the lookback bound instead of scanning forever", () => {
    const { scan, slices } = fakeIndex([]);

    expect(rowsOf(scan, cursorAt(NOW), 10)).toEqual([]);
    expect(slices).toHaveLength(PAGE_MAX_WIDENINGS + 1);
  });

  it("stops early once a slice has filled the page, since later slices are older", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, NOW - BigInt(i + 1)));
    const { scan, slices } = fakeIndex(rows);

    rowsOf(scan, cursorAt(NOW), 5);

    expect(slices).toHaveLength(1);
  });

  it("visits a row on a slice boundary exactly once", () => {
    // NOW - HOUR is the boundary between the first slice and the second.
    const { scan } = fakeIndex([row(1, NOW - HOUR)]);

    const page = rowsOf(scan, cursorAt(NOW), 10);

    expect(labels(page)).toEqual(["row-1"]);
  });

  it("keeps the newest rows when a single dense slice exceeds the trim threshold", () => {
    // 4x the limit is where the in-flight trim kicks in; go well past it so the
    // trim runs repeatedly mid-slice and must never discard a newer row.
    const dense = Array.from({ length: 500 }, (_, i) => row(i + 1, NOW - BigInt(i + 1)));
    const { scan } = fakeIndex(dense);

    const page = rowsOf(scan, cursorAt(NOW), 10);

    // The 10 newest are the 10 smallest offsets, i.e. ids 1..10.
    expect(labels(page)).toEqual(["row-1", "row-2", "row-3", "row-4", "row-5", "row-6", "row-7", "row-8", "row-9", "row-10"]);
  });

  it("holds only `limit` rows even when the slice is far larger", () => {
    const dense = Array.from({ length: 1_000 }, (_, i) => row(i + 1, NOW - BigInt(i + 1)));
    const { scan } = fakeIndex(dense);

    expect(rowsOf(scan, cursorAt(NOW), 5)).toHaveLength(5);
  });
});

describe("toPage", () => {
  it("emits a cursor from the last row when the page came back full", () => {
    const rows = [row(9, 500), row(4, 300)];

    expect(toPage(pageOf(rows), 2)).toEqual({
      rows,
      nextBeforeCreatedAtMicros: 300n,
      nextBeforeId: 4n,
    });
  });

  it("emits no cursor for a short page, so the client stops paging", () => {
    expect(toPage(pageOf([row(9, 500)]), 2)).toEqual({
      rows: [row(9, 500)],
      nextBeforeCreatedAtMicros: undefined,
      nextBeforeId: undefined,
    });
  });

  it("emits no cursor for an empty page", () => {
    expect(toPage(pageOf([]), 2).nextBeforeCreatedAtMicros).toBeUndefined();
  });
});

describe("paging end to end", () => {
  // Walks the cursor exactly as a client would, and asserts the full sweep
  // yields every row once, newest first. This is the property that actually
  // matters: no duplicates across page boundaries, and nothing skipped.
  function sweep(rows: Row[], limit: number): string[] {
    const { scan, probe } = fakeIndex(rows);
    const seen: string[] = [];
    let cursor: PageCursor = cursorAt(NOW);

    for (let guard = 0; guard < 100; guard++) {
      const page = toPage(pageByCreatedAt(scan, probe, cursor, limit), limit);
      seen.push(...labels(page.rows));
      if (page.nextBeforeCreatedAtMicros == null) return seen;
      cursor = { beforeCreatedAtMicros: page.nextBeforeCreatedAtMicros, beforeId: page.nextBeforeId };
    }
    throw new Error("cursor failed to terminate");
  }

  it("sees every row exactly once, newest first, across many pages", () => {
    const rows = Array.from({ length: 47 }, (_, i) => row(i + 1, NOW - BigInt(i + 1) * 60n));
    const expected = labels([...rows].sort(compareNewestFirst));

    expect(sweep(rows, 10)).toEqual(expected);
  });

  it("does not duplicate or skip rows that share a timestamp across a page boundary", () => {
    // Twelve rows on just three distinct timestamps, paged 5 at a time, so a
    // page boundary is guaranteed to land inside a group of equal timestamps —
    // precisely where a `createdAt`-only cursor loops forever or loses rows.
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => row(i + 1, NOW - 10n, `a${i}`)),
      ...Array.from({ length: 4 }, (_, i) => row(i + 5, NOW - 20n, `b${i}`)),
      ...Array.from({ length: 4 }, (_, i) => row(i + 9, NOW - 30n, `c${i}`)),
    ];
    const expected = labels([...rows].sort(compareNewestFirst));

    const seen = sweep(rows, 5);

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(rows.length);
  });

  it("keeps paging past the lookback bound instead of dropping older rows", () => {
    // A row further back than the widening loop can reach in one call. Without
    // a resume cursor the first page returns only "recent", reports no next
    // cursor, and "ancient" is lost with no error anywhere — the silent
    // truncation this resume marker exists to prevent.
    const totalLookback = HOUR * ((2n ** BigInt(PAGE_MAX_WIDENINGS + 1)) - 1n);
    const far = NOW - totalLookback - HOUR * 1_000n;
    const rows = [row(1, NOW - 10n, "recent"), row(2, far, "ancient")];

    expect(sweep(rows, 10)).toEqual(["recent", "ancient"]);
  });

  it("stops offering more pages once nothing older exists", () => {
    // Regression: the resume marker used to be emitted purely because the
    // widening loop ran out of budget, so a fully-drained list kept offering
    // "load older" forever, stepping backwards through empty time.
    const rows = [row(1, NOW - 10n, "only")];
    const { scan, probe } = fakeIndex(rows);

    const first = toPage(pageByCreatedAt(scan, probe, cursorAt(NOW), 10), 10);
    expect(labels(first.rows)).toEqual(["only"]);
    expect(first.nextBeforeCreatedAtMicros).toBeUndefined();
  });

  it("terminates on an empty table", () => {
    expect(sweep([], 10)).toEqual([]);
  });

  it("spans rows spread across widening windows", () => {
    // Spread over days so most pages need several doublings to fill.
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 1, NOW - BigInt(i + 1) * HOUR * 5n));
    const expected = labels([...rows].sort(compareNewestFirst));

    expect(sweep(rows, 4)).toEqual(expected);
  });
});
