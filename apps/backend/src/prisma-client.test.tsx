import { Client, Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { globalPrismaClient, globalPrismaConnectionString, isDatabaseUnavailableError, isRetryableTransactionError, waitForReplication, withPrimaryFallbackForReads } from "@/prisma-client";

const replicationStrategy = getEnvVariable("STACK_DATABASE_REPLICATION_WAIT_STRATEGY", "none");
const replicaConnectionString = getEnvVariable("STACK_DATABASE_REPLICA_CONNECTION_STRING", "");
const replicationWaitEnabled = replicationStrategy !== "none" && replicaConnectionString !== "";

function queryText(query: unknown): string {
  if (typeof query === "string") return query;
  if (query !== null && typeof query === "object" && "text" in query && typeof query.text === "string") {
    return query.text;
  }
  return "";
}

const hasReplicationTargetQuery = (calls: readonly (readonly unknown[])[]) =>
  calls.some(([query]) => queryText(query).toLowerCase().includes("select pg_current_wal_lsn"));

describe.skipIf(!replicationWaitEnabled)("replication wait behavior", () => {
  let restoreQuerySpy: (() => void) | undefined;

  afterEach(() => {
    restoreQuerySpy?.();
    restoreQuerySpy = undefined;
  });

  it("does not wait after a model read routed to the replica", async () => {
    const querySpy = vi.spyOn(Client.prototype, "query");
    restoreQuerySpy = () => querySpy.mockRestore();

    await globalPrismaClient.team.findMany({
      take: 1,
      select: { teamId: true },
    });

    expect(hasReplicationTargetQuery(querySpy.mock.calls)).toBe(false);
  });

  it("waits after a write on the primary", async () => {
    const querySpy = vi.spyOn(Client.prototype, "query");
    restoreQuerySpy = () => querySpy.mockRestore();

    await globalPrismaClient.team.updateMany({
      where: { teamId: "00000000-0000-0000-0000-000000000000" },
      data: { displayName: "replication wait test" },
    });

    expect(hasReplicationTargetQuery(querySpy.mock.calls)).toBe(true);
  });

  it("waits after a transaction commits", async () => {
    const querySpy = vi.spyOn(Client.prototype, "query");
    restoreQuerySpy = () => querySpy.mockRestore();

    // eslint-disable-next-line no-restricted-syntax
    await globalPrismaClient.$transaction(async (tx) => {
      await tx.team.findMany({
        take: 1,
        select: { teamId: true },
      });
    });

    expect(hasReplicationTargetQuery(querySpy.mock.calls)).toBe(true);
  });
});

describe("isRetryableTransactionError", () => {
  it("recognizes the Prisma adapter serialization conflict shape", () => {
    const error = new Error("TransactionWriteConflict", {
      cause: {
        originalCode: "40001",
        originalMessage: "could not serialize access due to read/write dependencies among transactions",
        kind: "TransactionWriteConflict",
      },
    });
    error.name = "DriverAdapterError";

    expect(isRetryableTransactionError(error)).toBe(true);
  });

  it.each(["P2028", "P2034"])("recognizes Prisma error code %s", (code) => {
    const error = new Prisma.PrismaClientKnownRequestError("transaction error", {
      code,
      clientVersion: "test",
    });

    expect(isRetryableTransactionError(error)).toBe(true);
  });

  it("does not retry unrelated Prisma errors", () => {
    const error = new Prisma.PrismaClientKnownRequestError("unique constraint", {
      code: "P2002",
      clientVersion: "test",
    });

    expect(isRetryableTransactionError(error)).toBe(false);
  });

  it("recognizes a raw-query P2010 wrapping the adapter serialization conflict", () => {
    const error = new Prisma.PrismaClientKnownRequestError("raw query error", {
      code: "P2010",
      clientVersion: "test",
      meta: {
        driverAdapterError: {
          cause: { kind: "TransactionWriteConflict" },
        },
      },
    });

    expect(isRetryableTransactionError(error)).toBe(true);
  });

  it("does not retry a P2010 wrapping an unrelated adapter error", () => {
    const error = new Prisma.PrismaClientKnownRequestError("raw query error", {
      code: "P2010",
      clientVersion: "test",
      meta: {
        driverAdapterError: {
          cause: { kind: "UniqueConstraintViolation" },
        },
      },
    });

    expect(isRetryableTransactionError(error)).toBe(false);
  });

  it("does not retry unrelated adapter errors", () => {
    const error = new Error("UniqueConstraintViolation", {
      cause: { kind: "UniqueConstraintViolation" },
    });
    error.name = "DriverAdapterError";

    expect(isRetryableTransactionError(error)).toBe(false);
  });

  it("does not retry an adapter error based on its message alone", () => {
    const error = new Error("TransactionWriteConflict", {
      cause: { kind: "UniqueConstraintViolation" },
    });
    error.name = "DriverAdapterError";

    expect(isRetryableTransactionError(error)).toBe(false);
  });

  it("does not retry plain errors", () => {
    expect(isRetryableTransactionError(new Error("transaction error"))).toBe(false);
  });
});

function createDriverAdapterError(cause: Record<string, unknown>) {
  const error = new Error(String(cause.kind), { cause });
  error.name = "DriverAdapterError";
  return error;
}

function createPgDriverError(code: string, message: string) {
  return Object.assign(new Error(message), { code, severity: "FATAL" });
}

describe("isDatabaseUnavailableError", () => {
  it.each([
    ["admin shutdown (reader restarting)", createPgDriverError("57P01", "terminating connection due to administrator command")],
    ["crash shutdown", createPgDriverError("57P02", "terminating connection because of crash of another server process")],
    ["server starting up", createPgDriverError("57P03", "the database system is starting up")],
    ["connection exception class", createPgDriverError("08006", "connection failure")],
    ["socket error", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED", errno: -61, syscall: "connect" })],
    ["socket error not mapped by the adapter", Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32, syscall: "write" })],
    // Node tries every address `localhost` resolves to (::1 and 127.0.0.1) and reports an AggregateError without
    // `syscall`, which @prisma/adapter-pg doesn't recognize as a socket error and passes through unwrapped
    ["connection refused on all resolved addresses", Object.assign(new AggregateError([new Error("connect ECONNREFUSED ::1:5432"), new Error("connect ECONNREFUSED 127.0.0.1:5432")]), { code: "ECONNREFUSED" })],
    ["connection terminated mid-query", new Error("Connection terminated unexpectedly")],
    ["connection ended with pending queries", new Error("Connection terminated")],
    ["adapter-wrapped unreachable database", createDriverAdapterError({ kind: "DatabaseNotReachable", host: "127.0.0.1", port: 1 })],
    ["adapter-wrapped closed connection", createDriverAdapterError({ kind: "ConnectionClosed" })],
    ["adapter-wrapped socket timeout", createDriverAdapterError({ kind: "SocketTimeout" })],
    ["adapter-wrapped server starting up", createDriverAdapterError({ kind: "postgres", originalCode: "57P03", originalMessage: "the database system is starting up" })],
  ])("recognizes %s", (_name, error) => {
    expect(isDatabaseUnavailableError(error)).toBe(true);
  });

  it.each([
    ["unique constraint violation", createPgDriverError("23505", "duplicate key value violates unique constraint")],
    ["syntax error", createPgDriverError("42601", "syntax error at or near \"SELEC\"")],
    ["adapter-wrapped unique constraint violation", createDriverAdapterError({ kind: "UniqueConstraintViolation", originalCode: "23505" })],
    ["adapter-wrapped serialization conflict", createDriverAdapterError({ kind: "TransactionWriteConflict", originalCode: "40001" })],
    ["adapter error whose message alone looks like a connection error", Object.assign(createDriverAdapterError({ kind: "UniqueConstraintViolation" }), { message: "Connection terminated" })],
    ["plain error", new Error("something went wrong")],
    ["non-error value", "Connection terminated"],
    ["null", null],
  ])("does not recognize %s", (_name, error) => {
    expect(isDatabaseUnavailableError(error)).toBe(false);
  });
});

const replicaConfigured = replicaConnectionString !== "";

// A port that nothing listens on, so connecting fails immediately with ECONNREFUSED (like a restarting reader)
function getUnreachableConnectionString() {
  const url = new URL(globalPrismaConnectionString);
  url.hostname = "127.0.0.1";
  url.port = "1";
  return url.toString();
}

describe.skipIf(!replicaConfigured)("read replica fallback to primary", () => {
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  const createPool = (connectionString: string) => {
    const pool = new Pool({ connectionString, max: 3 });
    pools.push(pool);
    return pool;
  };
  const createFallbackClient = (replicaPool: Pool) => {
    const client = new PrismaClient({
      adapter: withPrimaryFallbackForReads(new PrismaPg(replicaPool), new PrismaPg(createPool(globalPrismaConnectionString))),
    });
    clients.push(client);
    return client;
  };
  const isInRecovery = async (client: PrismaClient) => {
    const [{ in_recovery }] = await client.$queryRaw<[{ in_recovery: boolean }]>`SELECT pg_is_in_recovery() AS in_recovery`;
    return in_recovery;
  };

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.$disconnect()));
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it("classifies the adapter's error for an unreachable database as unavailable", async () => {
    const adapter = await new PrismaPg(createPool(getUnreachableConnectionString())).connect();
    const error = await adapter.queryRaw({ sql: "SELECT 1", args: [], argTypes: [] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();
    expect(isDatabaseUnavailableError(error)).toBe(true);
  });

  it("reads from the replica while it is available", async () => {
    const client = createFallbackClient(createPool(replicaConnectionString));
    expect(await isInRecovery(client)).toBe(true);
  });

  it("falls back to the primary while the replica is unreachable", async () => {
    const client = createFallbackClient(createPool(getUnreachableConnectionString()));
    expect(await isInRecovery(client)).toBe(false);
  });

  it("falls back to the primary for model reads while the replica is unreachable", async () => {
    const client = createFallbackClient(createPool(getUnreachableConnectionString()));
    const teams = await client.team.findMany({ take: 1, select: { teamId: true } });
    expect(Array.isArray(teams)).toBe(true);
  });

  it("retries on the primary when the replica terminates the connection mid-query", async () => {
    const client = createFallbackClient(createPool(replicaConnectionString));
    const marker = `replica-fallback-test-${crypto.randomUUID()}`;
    const queryPromise = client.$queryRawUnsafe<[{ in_recovery: boolean }]>(
      `SELECT pg_is_in_recovery() AS in_recovery, pg_sleep(1) /* ${marker} */`,
    );

    // Same as what happens to open connections when an Aurora reader is restarted
    const adminPool = createPool(replicaConnectionString);
    let terminatedCount = 0;
    for (let attempt = 0; attempt < 50 && terminatedCount === 0; attempt++) {
      await wait(20);
      const { rows } = await adminPool.query(
        "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE query LIKE $1 AND pid <> pg_backend_pid()",
        [`%${marker}%`],
      );
      terminatedCount = rows.filter((row) => row.terminated === true).length;
    }
    expect(terminatedCount).toBe(1);

    const [{ in_recovery }] = await queryPromise;
    expect(in_recovery).toBe(false);
  });

  it("does not fall back on errors in the query itself", async () => {
    const client = createFallbackClient(createPool(replicaConnectionString));
    await expect(client.$queryRawUnsafe("SELECT * FROM this_table_does_not_exist_replica_fallback_test")).rejects.toThrow(/this_table_does_not_exist_replica_fallback_test/);
  });
});

describe.skipIf(replicationStrategy !== "pg-stat-replication" || !replicaConfigured)("waitForReplication", () => {
  const pools: Pool[] = [];
  const createPool = (connectionString: string) => {
    const pool = new Pool({ connectionString, max: 3 });
    pools.push(pool);
    return pool;
  };
  const getCurrentPrimaryLsn = async () => {
    const { rows } = await createPool(globalPrismaConnectionString).query("SELECT pg_current_wal_lsn()::text AS lsn");
    const lsn: unknown = rows[0]?.lsn;
    if (typeof lsn !== "string") {
      throw new Error(`Expected pg_current_wal_lsn() to return a string, got ${JSON.stringify(lsn)}`);
    }
    return lsn;
  };

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it("waits until the replica has caught up", async () => {
    expect(await waitForReplication([createPool(replicaConnectionString)], await getCurrentPrimaryLsn(), 5_000)).toBe(true);
  });

  it("treats an unreachable replica as caught up instead of waiting for the timeout", async () => {
    const start = performance.now();
    expect(await waitForReplication([createPool(getUnreachableConnectionString())], await getCurrentPrimaryLsn(), 5_000)).toBe(true);
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it("times out if the server never catches up", async () => {
    // The primary isn't a standby, so pg_last_wal_replay_lsn() is NULL and it never counts as caught up
    expect(await waitForReplication([createPool(globalPrismaConnectionString)], await getCurrentPrimaryLsn(), 100)).toBe(false);
  });
});
