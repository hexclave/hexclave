import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { Prisma } from "@/generated/prisma/client";
import { globalPrismaClient, isRetryableTransactionError } from "@/prisma-client";

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
