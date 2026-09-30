import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

/**
 * Decoder for Postgres' built-in `pgoutput` logical replication format.
 *
 * We read the WAL in batches over an ordinary SQL connection
 * (`pg_logical_slot_peek_binary_changes`) rather than holding a streaming
 * replication connection open, so this only has to understand the message
 * payloads — no protocol state machine, no keepalives. `pgoutput` is used in
 * preference to wal2json because it is built into every Postgres 10+ server,
 * including managed ones that will not install an extension for us.
 *
 * Protocol version 1, which sends every value as text.
 */

export type PgoutputColumn = {
  name: string,
  /** Part of the replica identity, so usable for matching rows on update/delete. */
  isKey: boolean,
  dataTypeId: number,
};

export type PgoutputRelation = {
  relationId: number,
  schemaName: string,
  tableName: string,
  replicaIdentity: string,
  columns: PgoutputColumn[],
};

/** `null` for a SQL NULL; `undefined` for an unchanged TOAST value, which is not the same thing. */
export type PgoutputTuple = Record<string, string | null | undefined>;

export type PgoutputMessage =
  | { type: "begin", finalLsn: bigint, xid: number }
  | { type: "commit", commitLsn: bigint, endLsn: bigint }
  | { type: "relation", relation: PgoutputRelation }
  | { type: "insert", relationId: number, row: PgoutputTuple }
  | { type: "update", relationId: number, row: PgoutputTuple, keyRow: PgoutputTuple | null }
  | { type: "delete", relationId: number, keyRow: PgoutputTuple }
  | { type: "truncate", relationIds: number[] }
  | { type: "unsupported", tag: string };

class Reader {
  private offset = 0;
  constructor(private readonly buffer: Buffer) {}

  hasMore(): boolean {
    return this.offset < this.buffer.length;
  }
  uint8(): number {
    this.require(1);
    return this.buffer.readUInt8(this.offset++);
  }
  int16(): number {
    this.require(2);
    const value = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }
  int32(): number {
    this.require(4);
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  uint64(): bigint {
    this.require(8);
    const value = this.buffer.readBigUInt64BE(this.offset);
    this.offset += 8;
    return value;
  }
  /** Null-terminated string. */
  string(): string {
    const end = this.buffer.indexOf(0, this.offset);
    if (end === -1) throw new HexclaveAssertionError("Unterminated string in pgoutput message");
    const value = this.buffer.toString("utf8", this.offset, end);
    this.offset = end + 1;
    return value;
  }
  bytes(length: number): Buffer {
    this.require(length);
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  skip(length: number): void {
    this.require(length);
    this.offset += length;
  }
  private require(length: number): void {
    if (this.offset + length > this.buffer.length) {
      throw new HexclaveAssertionError("Truncated pgoutput message");
    }
  }
}

function readTuple(reader: Reader, relation: PgoutputRelation): PgoutputTuple {
  const columnCount = reader.int16();
  const tuple: PgoutputTuple = {};
  for (let i = 0; i < columnCount; i++) {
    const kind = String.fromCharCode(reader.uint8());
    // A column beyond the relation's known shape means our cached relation is
    // stale; the value still has to be consumed to keep the reader aligned.
    // Indexing past the end is possible when our cached relation is stale, so the
    // column may genuinely be absent even though the type says otherwise.
    const column = relation.columns[i] as PgoutputColumn | undefined;
    if (kind === "n") {
      if (column) tuple[column.name] = null;
    } else if (kind === "u") {
      // Unchanged TOAST: the server did not send it, and writing null here would
      // erase a value the customer never touched.
      if (column) tuple[column.name] = undefined;
    } else if (kind === "t" || kind === "b") {
      const length = reader.int32();
      const value = reader.bytes(length).toString("utf8");
      if (column) tuple[column.name] = value;
    } else {
      throw new HexclaveAssertionError(`Unknown pgoutput tuple column kind: ${JSON.stringify(kind)}`);
    }
  }
  return tuple;
}

/**
 * Decodes one message. `relations` is both an input and an output: Relation
 * messages register the shape that later Insert/Update/Delete messages refer to
 * by id, so the same map must be carried across every message in a batch.
 */
export function decodePgoutputMessage(
  buffer: Buffer,
  relations: Map<number, PgoutputRelation>,
): PgoutputMessage {
  const reader = new Reader(buffer);
  const tag = String.fromCharCode(reader.uint8());

  switch (tag) {
    case "B": {
      const finalLsn = reader.uint64();
      reader.skip(8); // commit timestamp
      const xid = reader.int32();
      return { type: "begin", finalLsn, xid };
    }
    case "C": {
      reader.skip(1); // flags
      const commitLsn = reader.uint64();
      const endLsn = reader.uint64();
      reader.skip(8); // commit timestamp
      return { type: "commit", commitLsn, endLsn };
    }
    case "R": {
      const relationId = reader.int32();
      const schemaName = reader.string();
      const tableName = reader.string();
      const replicaIdentity = String.fromCharCode(reader.uint8());
      const columnCount = reader.int16();
      const columns: PgoutputColumn[] = [];
      for (let i = 0; i < columnCount; i++) {
        const flags = reader.uint8();
        const name = reader.string();
        const dataTypeId = reader.int32();
        reader.skip(4); // type modifier
        columns.push({ name, isKey: (flags & 1) === 1, dataTypeId });
      }
      const relation = { relationId, schemaName, tableName, replicaIdentity, columns };
      relations.set(relationId, relation);
      return { type: "relation", relation };
    }
    case "I": {
      const relationId = reader.int32();
      const relation = requireRelation(relations, relationId);
      reader.uint8(); // always 'N'
      return { type: "insert", relationId, row: readTuple(reader, relation) };
    }
    case "U": {
      const relationId = reader.int32();
      const relation = requireRelation(relations, relationId);
      let keyRow: PgoutputTuple | null = null;
      let marker = String.fromCharCode(reader.uint8());
      // 'K' = key only, 'O' = full old tuple (REPLICA IDENTITY FULL). Either is
      // optional; when absent the new tuple carries the key already.
      if (marker === "K" || marker === "O") {
        keyRow = readTuple(reader, relation);
        marker = String.fromCharCode(reader.uint8());
      }
      if (marker !== "N") {
        throw new HexclaveAssertionError(`Expected a new tuple in a pgoutput update, got ${JSON.stringify(marker)}`);
      }
      return { type: "update", relationId, row: readTuple(reader, relation), keyRow };
    }
    case "D": {
      const relationId = reader.int32();
      const relation = requireRelation(relations, relationId);
      const marker = String.fromCharCode(reader.uint8());
      if (marker !== "K" && marker !== "O") {
        throw new HexclaveAssertionError(`Expected a key tuple in a pgoutput delete, got ${JSON.stringify(marker)}`);
      }
      return { type: "delete", relationId, keyRow: readTuple(reader, relation) };
    }
    case "T": {
      const count = reader.int32();
      reader.skip(1); // flags (cascade / restart identity)
      const relationIds: number[] = [];
      for (let i = 0; i < count; i++) relationIds.push(reader.int32());
      return { type: "truncate", relationIds };
    }
    default: {
      // Type ('Y'), Origin ('O'), and the streaming messages of proto v2+ carry
      // nothing we act on. Skipping them keeps a new server version from
      // breaking the sync.
      return { type: "unsupported", tag };
    }
  }
}

function requireRelation(relations: Map<number, PgoutputRelation>, relationId: number): PgoutputRelation {
  const relation = relations.get(relationId);
  if (!relation) {
    // Postgres always emits a Relation before the first change referencing it in
    // a given decoding session, so this means we lost the start of the batch.
    throw new HexclaveAssertionError(`pgoutput referenced unknown relation ${relationId}`);
  }
  return relation;
}

/** Postgres renders LSNs as two hex halves, e.g. `1A/3F0000D8`. */
export function formatLsn(lsn: bigint): string {
  const high = (lsn >> 32n) & 0xffffffffn;
  const low = lsn & 0xffffffffn;
  return `${high.toString(16).toUpperCase()}/${low.toString(16).toUpperCase()}`;
}

export function parseLsn(text: string): bigint {
  const match = /^([0-9A-Fa-f]+)\/([0-9A-Fa-f]+)$/.exec(text.trim());
  if (!match) throw new HexclaveAssertionError(`Malformed LSN: ${JSON.stringify(text)}`);
  return (BigInt(`0x${match[1]}`) << 32n) | BigInt(`0x${match[2]}`);
}
