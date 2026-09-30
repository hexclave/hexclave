import { describe, expect, it } from "vitest";
import {
  getCdcAvailability,
  getDefaultCursorColumn,
  getModeAvailability,
  getRecommendedMode,
  isTemporalCursorType,
  type DataSourceCapabilities,
  type DataSourceTableInfo,
} from "./modes";

const capable: DataSourceCapabilities = {
  version: "16.4", walLevel: "logical", hasReplication: true,
  inRecovery: false, slotsUsed: 0, slotsMax: 10, probedAtMillis: 0,
};

function table(overrides: Partial<DataSourceTableInfo> = {}): DataSourceTableInfo {
  return {
    schemaName: "public",
    tableName: "users",
    approxRows: 5_000_000,
    primaryKeyColumns: ["id"],
    // As format_type() renders it — the shape the probe actually produces.
    cursorCandidates: [{ column: "updated_at", dataType: "timestamp with time zone", indexed: true }],
    replicaIdentity: "d",
    isLogged: true,
    isPartitioned: false,
    ...overrides,
  };
}

describe("CDC availability", () => {
  it("is available when the server and table both permit it", () => {
    expect(getCdcAvailability(capable, table())).toEqual({ available: true, reason: null });
  });

  it("reports the blocking condition, in the order a customer can act on", () => {
    expect(getCdcAvailability({ ...capable, walLevel: "replica" }).reason).toBe("needs wal_level=logical");
    expect(getCdcAvailability({ ...capable, hasReplication: false }).reason).toBe("needs REPLICATION grant");
    expect(getCdcAvailability({ ...capable, inRecovery: true }).reason).toBe("not on a read replica");
    expect(getCdcAvailability({ ...capable, slotsUsed: 10 }).reason).toBe("no replication slots free");
  });

  it("blocks a table whose replica identity would break the customer's writes", () => {
    // Adding a REPLICA IDENTITY NOTHING table to a publication makes their own
    // UPDATEs start failing, so this must never be offered.
    expect(getCdcAvailability(capable, table({ replicaIdentity: "n" })).reason).toBe("needs a replica identity");
  });

  it("blocks unlogged and partitioned tables", () => {
    expect(getCdcAvailability(capable, table({ isLogged: false })).reason).toBe("table is unlogged");
    // Changes publish under the leaf partition, not the parent we subscribe to.
    expect(getCdcAvailability(capable, table({ isPartitioned: true })).reason).toBe("table is partitioned");
  });

  it("blocks a keyless table even on a fully capable server", () => {
    // Without a key there is nothing to match an UPDATE or DELETE against.
    expect(getCdcAvailability(capable, table({ primaryKeyColumns: [] })).reason).toBe("needs a primary key");
  });

  it("does not report a keyless table's problem as a server-level one", () => {
    expect(getCdcAvailability(capable)).toEqual({ available: true, reason: null });
  });

  it("does not treat an unknown replication slot budget as full", () => {
    expect(getCdcAvailability({ ...capable, slotsMax: null }, table())).toEqual({ available: true, reason: null });
  });
});

describe("mode availability", () => {
  it("refuses cursor mode when no column qualifies", () => {
    const availability = getModeAvailability(table({ cursorCandidates: [] }), capable);
    expect(availability.cursor).toEqual({ available: false, reason: "no usable column" });
  });

  it("offers only the two modes we support", () => {
    expect(Object.keys(getModeAvailability(table(), capable)).sort()).toEqual(["cdc", "cursor"]);
  });
});

describe("recommendation", () => {
  it("prefers CDC wherever it is possible, whatever the table's size", () => {
    expect(getRecommendedMode(table({ approxRows: 40 }), capable)).toBe("cdc");
  });

  it("prefers CDC for large mutable tables", () => {
    expect(getRecommendedMode(table(), capable)).toBe("cdc");
  });

  it("falls back to a cursor when CDC is unavailable", () => {
    expect(getRecommendedMode(table(), { ...capable, walLevel: "replica" })).toBe("cursor");
  });

  it("returns null when nothing applies, rather than a mode that would fail", () => {
    // No key for CDC to match on, and no column that could serve as a cursor.
    const impossible = table({ cursorCandidates: [], primaryKeyColumns: [] });
    expect(getRecommendedMode(impossible, { ...capable, walLevel: "replica" })).toBeNull();
  });
});

describe("default cursor column", () => {
  it("prefers an indexed candidate over a conventionally named unindexed one", () => {
    // An unindexed cursor makes every sync a sequential scan, which costs more
    // than picking a less obvious column name.
    const chosen = getDefaultCursorColumn(table({
      cursorCandidates: [
        { column: "updated_at", dataType: "timestamptz", indexed: false },
        { column: "row_version", dataType: "bigint", indexed: true },
      ],
    }));
    expect(chosen).toBe("row_version");
  });

  it("prefers the conventional name among equally indexed candidates", () => {
    const chosen = getDefaultCursorColumn(table({
      cursorCandidates: [
        { column: "created_at", dataType: "timestamptz", indexed: true },
        { column: "updated_at", dataType: "timestamptz", indexed: true },
      ],
    }));
    expect(chosen).toBe("updated_at");
  });

  it("is null when there is nothing to pick", () => {
    expect(getDefaultCursorColumn(table({ cursorCandidates: [] }))).toBeNull();
  });
});

describe("temporal cursor columns", () => {
  it("recognises the timestamp types format_type() emits, typmods and all", () => {
    for (const type of [
      "timestamp with time zone",
      "timestamp(3) without time zone",
      "timestamp(6) with time zone",
      "date",
    ]) {
      expect(isTemporalCursorType(type), type).toBe(true);
    }
  });

  it("treats keys and counters as non-temporal, since they only move on insert", () => {
    // These are legal cursors — an append-only log is exactly what they suit —
    // but an edit to an existing row never bumps them, so the picker warns.
    for (const type of ["bigint", "integer", "smallint"]) {
      expect(isTemporalCursorType(type), type).toBe(false);
    }
  });
});
