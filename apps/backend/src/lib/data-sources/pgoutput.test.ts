import { describe, expect, it } from "vitest";
import { decodePgoutputMessage, formatLsn, parseLsn, type PgoutputRelation } from "./pgoutput";

/** Builders that produce the exact byte layout Postgres emits, so the tests exercise real parsing. */
function cstring(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
}
function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}
function int16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return buffer;
}
function uint64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(value);
  return buffer;
}
function relationMessage(relationId: number, columns: { name: string, isKey: boolean }[]): Buffer {
  return Buffer.concat([
    Buffer.from("R"),
    int32(relationId),
    cstring("public"),
    cstring("users"),
    Buffer.from("d"),
    int16(columns.length),
    ...columns.flatMap(column => [Buffer.from([column.isKey ? 1 : 0]), cstring(column.name), int32(23), int32(-1)]),
  ]);
}
/** `values`: string = a text value, null = SQL NULL, undefined = unchanged TOAST. */
function tupleData(values: (string | null | undefined)[]): Buffer {
  return Buffer.concat([
    int16(values.length),
    ...values.map(value => {
      if (value === null) return Buffer.from("n");
      if (value === undefined) return Buffer.from("u");
      const bytes = Buffer.from(value, "utf8");
      return Buffer.concat([Buffer.from("t"), int32(bytes.length), bytes]);
    }),
  ]);
}

function newRelations(): Map<number, PgoutputRelation> {
  return new Map<number, PgoutputRelation>();
}

describe("pgoutput decoding", () => {
  it("registers a relation and decodes an insert against it", () => {
    const relations = newRelations();
    decodePgoutputMessage(relationMessage(16385, [{ name: "id", isKey: true }, { name: "email", isKey: false }]), relations);
    expect(relations.get(16385)?.columns.map(c => c.name)).toEqual(["id", "email"]);

    const message = decodePgoutputMessage(
      Buffer.concat([Buffer.from("I"), int32(16385), Buffer.from("N"), tupleData(["7", "a@example.com"])]),
      relations,
    );
    expect(message).toEqual({ type: "insert", relationId: 16385, row: { id: "7", email: "a@example.com" } });
  });

  it("distinguishes a SQL NULL from an unchanged TOAST value", () => {
    // These must not collapse together: null means "erase this", undefined means
    // "the server did not send it", and writing null for the latter loses data.
    const relations = newRelations();
    decodePgoutputMessage(relationMessage(1, [{ name: "id", isKey: true }, { name: "body", isKey: false }, { name: "note", isKey: false }]), relations);
    const message = decodePgoutputMessage(
      Buffer.concat([Buffer.from("I"), int32(1), Buffer.from("N"), tupleData(["1", undefined, null])]),
      relations,
    );
    if (message.type !== "insert") throw new Error("expected an insert");
    expect(message.row.body).toBeUndefined();
    expect("body" in message.row).toBe(true);
    expect(message.row.note).toBeNull();
  });

  it("decodes an update that carries an old key tuple", () => {
    const relations = newRelations();
    decodePgoutputMessage(relationMessage(2, [{ name: "id", isKey: true }, { name: "email", isKey: false }]), relations);
    const message = decodePgoutputMessage(
      Buffer.concat([
        Buffer.from("U"), int32(2),
        Buffer.from("K"), tupleData(["7", null]),
        Buffer.from("N"), tupleData(["8", "new@example.com"]),
      ]),
      relations,
    );
    expect(message).toEqual({
      type: "update",
      relationId: 2,
      keyRow: { id: "7", email: null },
      row: { id: "8", email: "new@example.com" },
    });
  });

  it("decodes an update with no old tuple", () => {
    const relations = newRelations();
    decodePgoutputMessage(relationMessage(3, [{ name: "id", isKey: true }]), relations);
    const message = decodePgoutputMessage(
      Buffer.concat([Buffer.from("U"), int32(3), Buffer.from("N"), tupleData(["9"])]),
      relations,
    );
    if (message.type !== "update") throw new Error("expected an update");
    expect(message.keyRow).toBeNull();
    expect(message.row).toEqual({ id: "9" });
  });

  it("decodes a delete's key tuple", () => {
    const relations = newRelations();
    decodePgoutputMessage(relationMessage(4, [{ name: "id", isKey: true }, { name: "email", isKey: false }]), relations);
    const message = decodePgoutputMessage(
      Buffer.concat([Buffer.from("D"), int32(4), Buffer.from("K"), tupleData(["7", null])]),
      relations,
    );
    expect(message).toEqual({ type: "delete", relationId: 4, keyRow: { id: "7", email: null } });
  });

  it("reads begin and commit LSNs", () => {
    const relations = newRelations();
    const begin = decodePgoutputMessage(
      Buffer.concat([Buffer.from("B"), uint64(0x1a3f0000d8n), uint64(0n), int32(4242)]),
      relations,
    );
    expect(begin).toEqual({ type: "begin", finalLsn: 0x1a3f0000d8n, xid: 4242 });

    const commit = decodePgoutputMessage(
      Buffer.concat([Buffer.from("C"), Buffer.from([0]), uint64(0x1a3f0000d8n), uint64(0x1a3f000120n), uint64(0n)]),
      relations,
    );
    expect(commit).toEqual({ type: "commit", commitLsn: 0x1a3f0000d8n, endLsn: 0x1a3f000120n });
  });

  it("decodes truncate", () => {
    const relations = newRelations();
    const message = decodePgoutputMessage(
      Buffer.concat([Buffer.from("T"), int32(2), Buffer.from([0]), int32(11), int32(12)]),
      relations,
    );
    expect(message).toEqual({ type: "truncate", relationIds: [11, 12] });
  });

  it("ignores message types it has no use for rather than failing the batch", () => {
    // A new server emitting proto v2 stream messages must not break syncing.
    const message = decodePgoutputMessage(Buffer.concat([Buffer.from("Y"), int32(1)]), newRelations());
    expect(message).toEqual({ type: "unsupported", tag: "Y" });
  });

  it("refuses a change for a relation it never saw", () => {
    expect(() => decodePgoutputMessage(
      Buffer.concat([Buffer.from("I"), int32(999), Buffer.from("N"), tupleData(["1"])]),
      newRelations(),
    )).toThrow("unknown relation");
  });

  it("refuses a truncated message rather than reading past the end", () => {
    const relations = newRelations();
    decodePgoutputMessage(relationMessage(5, [{ name: "id", isKey: true }]), relations);
    expect(() => decodePgoutputMessage(
      Buffer.concat([Buffer.from("I"), int32(5), Buffer.from("N"), int16(1), Buffer.from("t"), int32(50)]),
      relations,
    )).toThrow("Truncated");
  });
});

describe("LSN formatting", () => {
  it("round-trips Postgres' two-half hex form", () => {
    expect(formatLsn(0x1a3f0000d8n)).toBe("1A/3F0000D8");
    expect(parseLsn("1A/3F0000D8")).toBe(0x1a3f0000d8n);
    expect(parseLsn(formatLsn(0n))).toBe(0n);
  });

  it("rejects a malformed LSN", () => {
    expect(() => parseLsn("not-an-lsn")).toThrow("Malformed LSN");
  });
});

describe("cursor candidate types", () => {
  it("accepts the type names format_type() actually emits, typmods and all", async () => {
    const { isCursorCandidateType } = await import("./probe");
    // Prisma renders DateTime as timestamp(3); Hibernate as timestamp(6) with tz.
    // Matching only the bare spellings left those sources with no cursor at all.
    for (const type of [
      "timestamp(3) without time zone",
      "timestamp(6) with time zone",
      "timestamp with time zone",
      "timestamp without time zone",
      "date", "bigint", "integer", "smallint",
    ]) {
      expect(isCursorCandidateType(type), type).toBe(true);
    }
    for (const type of ["text", "uuid", "jsonb", "numeric(10,2)", "boolean", "bytea"]) {
      expect(isCursorCandidateType(type), type).toBe(false);
    }
  });
});
