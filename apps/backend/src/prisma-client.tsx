import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from '@prisma/adapter-pg';
import { readReplicas } from '@prisma/extension-read-replicas';
import { CompleteConfig } from "@hexclave/shared/dist/config/schema";
import { yupObject, yupValidate } from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable, getNodeEnvironment } from '@hexclave/shared/dist/utils/env';
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { globalVar } from "@hexclave/shared/dist/utils/globals";
import { deepPlainEquals, filterUndefined, typedFromEntries, typedKeys } from "@hexclave/shared/dist/utils/objects";
import { concatStacktracesIfRejected, ignoreUnhandledRejection, wait } from "@hexclave/shared/dist/utils/promises";
import { throwingProxy } from "@hexclave/shared/dist/utils/proxies";
import { Result } from "@hexclave/shared/dist/utils/results";
import { traceSpan } from "@hexclave/shared/dist/utils/telemetry";
import { attachDatabasePool } from "@vercel/functions";
import net from "node:net";
import { Pool } from "pg";
import { isPromise } from "util/types";
import { registerPgPool } from "./lib/dev-perf-stats";
import { Tenancy } from "./lib/tenancies";
import { ensurePolyfilled } from "./polyfills";

// just ensure we're polyfilled because this file relies on envvars being expanded
ensurePolyfilled();

export type PrismaClientTransaction =
  | Omit<PrismaClient, "$on">  // $on is not available on extended Prisma clients, so we don't require it here. see: https://www.prisma.io/docs/orm/reference/prisma-client-reference#on
  | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

function getSchemaFromConnectionString(connectionString: string) {
  return (new URL(connectionString)).searchParams.get('schema') ?? "public";
}

export async function getPrismaClientForTenancy(tenancy: Tenancy) {
  return await getPrismaClientForSourceOfTruth(tenancy.config.sourceOfTruth, tenancy.branchId);
}

export async function getPrismaSchemaForTenancy(tenancy: Tenancy) {
  return await getPrismaSchemaForSourceOfTruth(tenancy.config.sourceOfTruth, tenancy.branchId);
}


const postgresPrismaClientsStore: Map<string, {
  client: PrismaClient,
  schema: string,
}> = globalVar.__stack_postgres_prisma_clients ??= new Map();
function getPostgresPrismaClient(connectionString: string, poolLabel?: string) {
  let postgresPrismaClient = postgresPrismaClientsStore.get(connectionString);
  if (!postgresPrismaClient) {
    const schema = getSchemaFromConnectionString(connectionString);
    const pool = new Pool({ connectionString, max: 25 });
    if (getEnvVariable("VERCEL", "") !== "") {
      // Fluid Compute can suspend an instance while an application-owned pool still
      // has idle clients. Registering the pool keeps the invocation alive until
      // those clients reach the pool's idle timeout.
      attachDatabasePool(pool);
    }
    registerPgPool(pool, poolLabel ?? connectionString); // Register pool for dev performance stats
    // Error-capture locations use a label instead of the connection string so
    // credentials never enter the error sink.
    const safePoolLabel = poolLabel ?? "tenant";
    const adapter = new PrismaPg(pool, {
      schema,
      // Prisma receives a Pool created by this application. Without this option,
      // $disconnect removes Prisma's listener but deliberately leaves the pool open.
      disposeExternalPool: true,
      onPoolError: (error) => captureError(`pg-pool-${safePoolLabel}`, error),
      onConnectionError: (error) => captureError(`pg-connection-${safePoolLabel}`, error),
    });
    postgresPrismaClient = {
      client: new PrismaClient({ adapter }),
      schema,
    };
    postgresPrismaClientsStore.set(connectionString, postgresPrismaClient);
  }
  return postgresPrismaClient;
}

export async function disconnectPostgresPrismaClients(): Promise<void> {
  await Promise.all(
    [...postgresPrismaClientsStore.values()].map(({ client }) => client.$disconnect()),
  );
}

async function tcpPing(host: string, port: number, timeout = 2000) {
  return await new Promise<boolean>((resolve) => {
    const s = net.connect({ host, port }).setTimeout(timeout);

    const done = (result: boolean) => {
      s.destroy();
      resolve(result);
    };

    s.on("connect", () => done(true));
    s.on("timeout", () => done(false));
    s.on("error",  () => done(false));
  });
}

const originalGlobalConnectionString = getEnvVariable("STACK_DATABASE_CONNECTION_STRING", "");
const originalReplicaConnectionString = getEnvVariable("STACK_DATABASE_REPLICA_CONNECTION_STRING", "");

async function resolveConnectionStringWithOrbStack(connectionString: string): Promise<string> {
  if (!connectionString) {
    return connectionString;
  }

  // If we are on a Mac with OrbStack installed, it's much much faster to use the OrbStack-provided domain instead of
  // the container's port forwarding.
  //
  // For this reason, we check whether we can connect to the database using the OrbStack-provided domain, and if so,
  // we use it instead of the original connection string.
  if (getNodeEnvironment() === 'development' && process.platform === 'darwin') {
    const match = connectionString.match(/^postgres:\/\/([^:]+):(.*)@localhost:(\d\d)28\/(.*)$/);
    if (match) {
      const [, user, password, portPrefix, schema] = match;
      const orbStackDomain = `db.stack-dependencies-${portPrefix}.orb.local`;
      const ok = await tcpPing(orbStackDomain, 5432, 50);  // extremely short timeout; OrbStack should be fast to respond, otherwise why are we doing this?
      if (ok) {
        return `postgres://${user}:${password}@${orbStackDomain}:5432/${schema}`;
      }
    }
  }
  return connectionString;
}

let actualGlobalConnectionString: string = globalVar.__hexclave_actual_global_connection_string ??= await resolveConnectionStringWithOrbStack(originalGlobalConnectionString);
let actualReplicaConnectionString: string = globalVar.__hexclave_actual_replica_connection_string ??= await resolveConnectionStringWithOrbStack(originalReplicaConnectionString);

export type PrismaClientWithReplica<T extends PrismaClient = PrismaClient> = Omit<T, "$on"> & {
  $replica: () => Omit<T, "$on">,
};


/**
 * Waits until ALL replicas have caught up to the specified target.
 * This ensures read-after-write consistency when using read replicas.
 *
 * Queries each replica directly to get real-time LSN (avoids cached aurora_replica_status()).
 *
 * Strategy types (STACK_DATABASE_REPLICATION_WAIT_STRATEGY):
 * - "none": Don't wait for replication (default)
 * - "pg-stat-replication": Query replicas for pg_last_wal_replay_lsn() (for local dev)
 * - "aurora": Query replicas for current_read_lsn via aurora_replica_status() (for AWS Aurora)
 *
 * @param replicas - List of replica Prisma clients to query directly
 * @param target - The target to wait for:
 *   - For pg-stat-replication: pg_lsn format (e.g., "0/1234ABC")
 *   - For aurora: bigint as string (e.g., "123456789")
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @returns true if all replicas caught up, false if timed out
 */
async function waitForReplication(replicas: PrismaClient[], target: string, timeoutMs: number): Promise<boolean> {
  // TODO: Right now, this waits for replication on all replicas right after every operation on the primary. In the future, we could
  // instead make it per-replica and per-request, so that each replica keeps track for each request of which LSN it needs
  // to wait for on the next read. This way, the waiting period is significantly reduced. Care needs to be taken because
  // this means we'll also have to wait for all replicas to catch up at the end of the request.
  const strategy = getEnvVariable("STACK_DATABASE_REPLICATION_WAIT_STRATEGY", "none");
  return await traceSpan({
    description: 'waiting for replication',
    attributes: {
      'stack.db-replication.strategy': strategy,
      'stack.db-replication.target': target,
      'stack.db-replication.replica-count': replicas.length,
      'stack.db-replication.timeout-ms': timeoutMs,
    },
  }, async (span) => {
    if (strategy === "none" || replicas.length === 0) {
      return true;
    }

    // Build the check function based on strategy
    let checkCaughtUp: (replica: PrismaClient) => Promise<boolean>;

    if (strategy === "pg-stat-replication") {
      if (!/^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/.test(target)) {
        throw new HexclaveAssertionError(`Invalid pg_lsn format: ${target}`);
      }
      checkCaughtUp = async (replica) => {
        return await traceSpan({
          description: 'checking replication status from replica',
          attributes: {
            'stack.db-replication.strategy': strategy,
            'stack.db-replication.target': target,
            'stack.db-replication.replica-count': replicas.length,
            'stack.db-replication.timeout-ms': timeoutMs,
          },
        }, async (span) => {
          const [{ caught_up }] = await (replica as any).$queryRaw<[{ caught_up: boolean }]>`
            SELECT pg_last_wal_replay_lsn() >= ${target}::pg_lsn AS caught_up
          `;
          span.setAttribute('stack.db-replication.caught-up', caught_up);
          return caught_up;
        });
      };
    } else if (strategy === "aurora") {
      if (!/^\d+$/.test(target)) {
        throw new HexclaveAssertionError(`Invalid bigint format for Aurora durable_lsn: ${target}`);
      }
      const targetBigInt = BigInt(target);
      checkCaughtUp = async (replica) => {
        return await traceSpan({
          description: 'checking replication status from replica',
          attributes: {
            'stack.db-replication.strategy': strategy,
            'stack.db-replication.target': target,
            'stack.db-replication.replica-count': replicas.length,
            'stack.db-replication.timeout-ms': timeoutMs,
          },
        }, async (span) => {
          const replicaStatus = await (replica as any).$queryRaw<[{ current_lsn: bigint | null }]>`
            SELECT *
            FROM aurora_replica_status()
            WHERE server_id = aurora_db_instance_identifier()
          `;
          span.setAttribute(
            'stack.db-replication.replica-status',
            JSON.stringify(replicaStatus, (_key, value) => typeof value === "bigint" ? value.toString() : value),
          );
          const currentLsn = replicaStatus[0]?.current_read_lsn ?? null;
          span.setAttribute('stack.db-replication.current-lsn', currentLsn === null ? "null" : currentLsn.toString());
          return currentLsn === null || currentLsn >= targetBigInt;
        });
      };
    } else {
      throw new HexclaveAssertionError(`Unknown replication wait strategy: ${strategy}`);
    }

    // Wait for all replicas in parallel with timeout and exponential backoff
    const deadline = performance.now() + timeoutMs;
    const results = await Promise.all(replicas.map(async (replica): Promise<{ caughtUp: boolean, iterations: number }> => {
      let extraWaitMs = 5;
      let iterations = 0;
      while (true) {
        iterations++;
        if (await checkCaughtUp(replica)) {
          return { caughtUp: true, iterations };
        }
        if (performance.now() > deadline) break;
        await wait(Math.min(15 + extraWaitMs, deadline - performance.now() + 10));  // Capped to avoid overshooting
        extraWaitMs = extraWaitMs * 3;
      }
      return { caughtUp: false, iterations };
    }));

    // Compute stats
    const iterations = results.map(r => r.iterations);
    const timedOutCount = results.filter(r => !r.caughtUp).length;
    const allCaughtUp = timedOutCount === 0;

    span.setAttribute('stack.db-replication.caught-up', allCaughtUp);
    span.setAttribute('stack.db-replication.timed-out-count', timedOutCount);
    span.setAttribute('stack.db-replication.iterations-min', Math.min(...iterations));
    span.setAttribute('stack.db-replication.iterations-max', Math.max(...iterations));
    span.setAttribute('stack.db-replication.iterations-avg', iterations.reduce((a, b) => a + b, 0) / iterations.length);

    return allCaughtUp;
  });
}

/**
 * Extends a Prisma client to wait for replication after all operations.
 * This ensures read-after-write consistency when using a read replica.
 *
 * @param primary - The primary Prisma client to extend
 * @param replicaClients - List of replica Prisma clients to query for replication status
 */
function extendWithReplicationWait<T extends PrismaClient>(primary: T, replicaClients: PrismaClient[]): T {
  const strategy = getEnvVariable("STACK_DATABASE_REPLICATION_WAIT_STRATEGY", "none");
  if (strategy === "none") {
    return primary;
  }

  const readTargetAndWaitForReplication = async () => {
    await traceSpan({
      description: 'getting replication target and waiting',
      attributes: {
        'stack.db-replication.strategy': strategy,
      },
    }, async (span) => {
      try {
        let target: string;
        if (strategy === "pg-stat-replication") {
          // For local PostgreSQL streaming replication, use pg_current_wal_lsn()
          const [{ lsn }] = await (primary as any).$queryRaw<[{ lsn: string }]>`SELECT pg_current_wal_lsn()::text AS lsn`;
          target = lsn;
        } else if (strategy === "aurora") {
          // For Aurora, get durable_lsn from the writer instance
          const [{ durable_lsn }] = await (primary as any).$queryRaw<[{ durable_lsn: bigint }]>`
            SELECT durable_lsn FROM aurora_replica_status() WHERE session_id = 'MASTER_SESSION_ID'
          `;
          target = durable_lsn.toString();
        } else {
          throw new HexclaveAssertionError(`Unknown replication wait strategy: ${strategy}`);
        }
        span.setAttribute('stack.db-replication.target', target);

        // Wait for replication with a 2s timeout to prevent hanging
        const caughtUp = await waitForReplication(replicaClients, target, 2000);
        if (!caughtUp) {
          span.setAttribute('stack.db-replication.timeout', true);
          captureError("prisma-client-replication-timeout", new HexclaveAssertionError("Replication wait timed out after 2s. The replica may be behind, or something weird is going on!"));
        }
      } catch (e) {
        span.setAttribute('stack.db-replication.error', `${e}`);
        captureError("prisma-client-replication-error", new HexclaveAssertionError("Error getting replication target and waiting. We'll just wait 1000ms instead, but please fix this as the replication may not be working.", { cause: e }));
        await wait(1_000);
      }
    });
  };

  return primary.$extends({
    client: {
      async $transaction(...args: Parameters<PrismaClient['$transaction']>) {
        // eslint-disable-next-line no-restricted-syntax
        const result = await primary.$transaction(...args);
        await readTargetAndWaitForReplication();
        return result;
      },
    },
    query: {
      async $allOperations(params: { args: any, query: (args: any) => Promise<any>, operation: string, model?: string, __internalParams?: unknown }) {
        const { args, query, operation, model } = params;

        // This extension must be applied AFTER (i.e. inside) the read-replicas extension: query extension callbacks
        // run in the order they were applied, so the read-replicas hook runs first and dispatches read operations
        // directly onto the replica client, which never reaches this hook. Everything that does arrive here executes
        // on the primary and therefore needs a replication wait.
        // (do note that $allOperations does not trigger for the transaction commit itself, so we do that separately above)

        // __internalParams is an undocumented property, so let's validate that it fits our schema with yup first
        const internalParamsSchema = yupObject({
          transaction: yupObject().nullable(),
        }).defined();
        const internalParams = await yupValidate(internalParamsSchema, params.__internalParams);

        if (internalParams.transaction) {
          // we're inside a transaction, so we don't need to wait for replication
          return await query(args);
        }

        const result = await query(args);
        await readTargetAndWaitForReplication();
        return result;
      },
    },
  }) as T;
}

function extendWithReadReplicas<T extends PrismaClient>(client: T, replicaConnectionString: string): PrismaClientWithReplica<T> {
  // Create a separate PrismaClient for the read replica
  const replicaClient = getPostgresPrismaClient(replicaConnectionString, "replica").client;

  // Extend with read replicas FIRST so its query hook runs outermost: it routes read operations directly onto the
  // replica client, so the replication-wait hook (applied second, i.e. inner) only ever sees operations that hit
  // the primary. This is what makes replica-routed reads skip the replication wait.
  const clientWithReadReplicas = client.$extends(readReplicas({
    replicas: [replicaClient],
  }));

  // SAFETY: Prisma's extension type omits `$on`, but the runtime object keeps every method used by
  // extendWithReplicationWait. The final type preserves the caller's original client shape.
  return extendWithReplicationWait(clientWithReadReplicas as T, [replicaClient]) as PrismaClientWithReplica<T>;
}

function extendWithFakeReadReplica<T extends PrismaClient>(client: T): PrismaClientWithReplica<T> {
  // No replication wait for fake replica (same client, no actual replication)
  return client.$extends(readReplicas({
    replicas: [client],
  })) as PrismaClientWithReplica<T>;
}

export const { client: globalPrismaClient, schema: globalPrismaSchema }: {
  client: PrismaClientWithReplica<PrismaClient>,
  schema: string,
} = actualGlobalConnectionString
  ? (() => {
    const { client, schema } = getPostgresPrismaClient(actualGlobalConnectionString, "primary");
    return {
      client: actualReplicaConnectionString ? extendWithReadReplicas(client, actualReplicaConnectionString) : extendWithFakeReadReplica(client),
      schema,
    };
  })()
  : {
    client: throwingProxy<PrismaClientWithReplica<PrismaClient>>("STACK_DATABASE_CONNECTION_STRING environment variable is not set. Please set it to a valid PostgreSQL connection string, or use a mock Prisma client for testing."),
    schema: throwingProxy<string>("STACK_DATABASE_CONNECTION_STRING environment variable is not set. Please set it to a valid PostgreSQL connection string, or use a mock Prisma client for testing."),
  };

export async function getPrismaClientForSourceOfTruth(_sourceOfTruth: CompleteConfig["sourceOfTruth"], _branchId: string) {
  return globalPrismaClient;
}

export async function getPrismaSchemaForSourceOfTruth(_sourceOfTruth: CompleteConfig["sourceOfTruth"], _branchId: string) {
  return globalPrismaSchema;
}


class TransactionErrorThatShouldBeRetried extends Error {
  constructor(cause: unknown) {
    super("This is an internal error used by Hexclave to rollback Prisma transactions. It should not be visible to you, so please report this.", { cause });
    this.name = 'TransactionErrorThatShouldBeRetried';
  }
}

class TransactionErrorThatShouldNotBeRetried extends Error {
  constructor(cause: unknown) {
    super("This is an internal error used by Hexclave to rollback Prisma transactions. It should not be visible to you, so please report this.", { cause });
    this.name = 'TransactionErrorThatShouldNotBeRetried';
  }
}

function hasTransactionWriteConflictCause(e: unknown): boolean {
  if (typeof e !== "object" || e === null || !("cause" in e)) {
    return false;
  }
  const { cause } = e;
  return typeof cause === "object" && cause !== null && "kind" in cause && cause.kind === "TransactionWriteConflict";
}

export function isRetryableTransactionError(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const retryablePrismaErrorCodes = [
      "P2028", // Serializable/repeatable read conflict
      "P2034", // Transaction already closed (eg. timeout)
    ];
    if (retryablePrismaErrorCodes.includes(e.code)) {
      return true;
    }
    if (e.code !== "P2010" || e.meta == null || !("driverAdapterError" in e.meta)) {
      return false;
    }
    return hasTransactionWriteConflictCause(e.meta.driverAdapterError);
  }

  // @prisma/driver-adapter-utils is transitive, so classify its stable error shape instead of using instanceof.
  // PrismaPg exposes serialization conflicts as an Error named DriverAdapterError with a structured cause.kind.
  return e instanceof Error && e.name === "DriverAdapterError" && hasTransactionWriteConflictCause(e);
}

/**
 * @deprecated Prisma transactions are slow and lock the database. Use rawQuery with CTEs instead. Ask Konsti if you're confused or think you need transactions.
 */
export async function retryTransaction<T>(client: Omit<PrismaClient, "$on">, fn: (tx: PrismaClientTransaction) => Promise<T>, options: { level?: "default" | "serializable", timeout?: number } = {}): Promise<T> {
  // serializable transactions are currently off by default, later we may turn them on
  const enableSerializable = options.level === "serializable";

  return await traceSpan('Prisma transaction', async (span) => {
    const res = await Result.retry(async (attemptIndex) => {
      return await traceSpan(`transaction attempt #${attemptIndex}`, async (attemptSpan) => {
        const attemptRes = await (async () => {
          try {
            // eslint-disable-next-line no-restricted-syntax
            return Result.ok(await client.$transaction(async (tx, ...args) => {
              let res;
              try {
                res = await fn(tx, ...args);
              } catch (e) {
                // we don't want to retry errors that happened in the function, because otherwise we may be retrying due
                // to other (nested) transactions failing
                // however, we make an exception for "Transaction already closed", as those are (annoyingly) thrown on
                // the actual query, not the $transaction function itself
                if (isRetryableTransactionError(e)) {
                  throw new TransactionErrorThatShouldBeRetried(e);
                }
                throw new TransactionErrorThatShouldNotBeRetried(e);
              }
              if (getNodeEnvironment() === 'development' || getNodeEnvironment() === 'test') {
                // In dev/test, let's just fail the transaction with a certain probability, if we haven't already failed multiple times
                // this is to test the logic that every transaction is retryable
                if (attemptIndex < 2 && Math.random() < 0.5) {
                  throw new TransactionErrorThatShouldBeRetried(new Error("Test error for dev/test. This should automatically be retried."));
                }
              }
              return res;
            }, {
              isolationLevel: enableSerializable ? Prisma.TransactionIsolationLevel.Serializable : undefined,
              ...(options.timeout != null ? { timeout: options.timeout } : {}),
            }));
          } catch (e) {
            // we don't want to retry too aggressively here, because the error may have been thrown after the transaction was already committed
            // so, we select the specific errors that we know are safe to retry
            if (e instanceof TransactionErrorThatShouldBeRetried) {
              return Result.error(e.cause);
            }
            if (e instanceof TransactionErrorThatShouldNotBeRetried) {
              throw e.cause;
            }
            if (isRetryableTransactionError(e)) {
              return Result.error(e);
            }
            throw e;
          }
        })();
        if (attemptRes.status === "error") {
          attemptSpan.setAttribute("stack.prisma.transaction-retry.error", `${attemptRes.error}`);
        }
        return attemptRes;
      });
    }, 4, {
      exponentialDelayBase: getNodeEnvironment() === 'development' || getNodeEnvironment() === 'test' ? 3 : 1000,
    });

    span.setAttribute("stack.prisma.transaction.success", res.status === "ok");
    span.setAttribute("stack.prisma.transaction.attempts", res.attempts);
    span.setAttribute("stack.prisma.transaction.serializable-enabled", enableSerializable ? "true" : "false");

    return Result.orThrow(res);
  });
}

const allSupportedPrismaClients = ["global", "source-of-truth"] as const;

export type RawQuery<T> = {
  supportedPrismaClients: readonly (typeof allSupportedPrismaClients)[number][],
  sql: Prisma.Sql,
  postProcess: (rows: any[]) => T,  // Tip: If your postProcess is async, just set T = Promise<any> (compared to doing Promise.all in rawQuery, this ensures that there are no accidental timing attacks)
  readOnlyQuery: boolean,  // If true, use the read replica if available
};

export const RawQuery = {
  then: <T, R>(query: RawQuery<T>, fn: (result: T) => R): RawQuery<R> => {
    return {
      supportedPrismaClients: query.supportedPrismaClients,
      sql: query.sql,
      postProcess: (rows) => {
        const result = query.postProcess(rows);
        return fn(result);
      },
      readOnlyQuery: query.readOnlyQuery,
    };
  },
  all: <T extends readonly any[]>(queries: { [K in keyof T]: RawQuery<T[K]> }): RawQuery<T> => {
    const supportedPrismaClients = queries.reduce((acc, q) => {
      return acc.filter(c => q.supportedPrismaClients.includes(c));
    }, allSupportedPrismaClients as RawQuery<any>["supportedPrismaClients"]);
    if (supportedPrismaClients.length === 0) {
      throw new HexclaveAssertionError("The queries must have at least one overlapping supported Prisma client");
    }

    // Only mark combined query as read-only if all individual queries are read-only
    const readOnlyQuery = queries.every(q => q.readOnlyQuery);

    return {
      supportedPrismaClients,
      readOnlyQuery,
      sql: Prisma.sql`
        WITH ${Prisma.join(queries.map((q, index) => {
        return Prisma.sql`${Prisma.raw("q" + index)} AS (
            ${q.sql}
          )`;
      }), ",\n")}

        ${Prisma.join(queries.map((q, index) => {
        return Prisma.sql`
            SELECT
              ${"q" + index} AS type,
              row_to_json(c) AS json
            FROM (SELECT * FROM ${Prisma.raw("q" + index)}) c
          `;
      }), "\nUNION ALL\n")}
      `,
      postProcess: (rows) => {
        const unprocessed = new Array(queries.length).fill(null).map(() => [] as any[]);
        for (const row of rows) {
          const type = row.type;
          const index = +type.slice(1);
          unprocessed[index].push(row.json);
        }
        const postProcessed = queries.map((q, index) => {
          const postProcessed = q.postProcess(unprocessed[index]);
          // If the postProcess is async, postProcessed is a Promise. If that Promise is rejected, it will cause an unhandled promise rejection.
          // We don't want that, because Vercel crashes on unhandled promise rejections.
          if (isPromise(postProcessed)) {
            ignoreUnhandledRejection(postProcessed);
          }
          return postProcessed;
        });
        return postProcessed as any;
      },
    };
  },
  resolve: <T,>(obj: T): RawQuery<T> => {
    return {
      supportedPrismaClients: allSupportedPrismaClients,
      sql: Prisma.sql`SELECT 1`,
      postProcess: (rows) => {
        return obj;
      },
      readOnlyQuery: true,  // resolve is just a static value, doesn't actually write
    };
  },
};

export async function rawQuery<Q extends RawQuery<any>>(tx: PrismaClientTransaction, query: Q): Promise<Awaited<ReturnType<Q["postProcess"]>>> {
  const result = await rawQueryArray(tx, [query]);
  return result[0];
}

export async function rawQueryAll<Q extends Record<string, undefined | RawQuery<any>>>(tx: PrismaClientTransaction, queries: Q): Promise<{ [K in keyof Q]: ReturnType<NonNullable<Q[K]>["postProcess"]> }> {
  const keys = typedKeys(filterUndefined(queries));
  const result = await rawQueryArray(tx, keys.map(key => queries[key as any] as any));
  return typedFromEntries(keys.map((key, index) => [key, result[index]])) as any;
}

async function rawQueryArray<Q extends RawQuery<any>[]>(tx: PrismaClientTransaction, queries: Q): Promise<[] & { [K in keyof Q]: Awaited<ReturnType<Q[K]["postProcess"]>> }> {
  const allReadOnly = queries.length > 0 && queries.every(q => q.readOnlyQuery);
  return await traceSpan({
    description: `raw SQL quer${queries.length === 1 ? "y" : `ies (${queries.length} total)`}`,
    attributes: {
      "stack.raw-queries.length": queries.length,
      "stack.raw-queries.read-only": allReadOnly,
      ...Object.fromEntries(queries.flatMap((q, index) => [
        [`stack.raw-queries.${index}.text`, q.sql.text],
        [`stack.raw-queries.${index}.params`, JSON.stringify(q.sql.values)],
      ])),
    },
  }, async () => {
    if (queries.length === 0) return [] as any;

    // Prisma does a query for every rawQuery call by default, even if we batch them with transactions
    // So, instead we combine all queries into one, and then return them as a single JSON result
    const combinedQuery = RawQuery.all([...queries]);

    // TODO: check that combinedQuery supports the prisma client that created tx

    // Supabase's index advisor only analyzes rows that start with "SELECT" (for some reason)
    // Since ours starts with "WITH", we prepend a SELECT to it.
    // However, we can't do this for data-modifying queries because PostgreSQL requires
    // CTEs with UPDATE/INSERT/DELETE to be at the top level, not inside a subquery.
    const sqlQuery = allReadOnly
      ? Prisma.sql`SELECT * FROM (${combinedQuery.sql}) AS _`
      : combinedQuery.sql;

    // Use the read replica if all queries are read-only and a replica is available
    const queryClient = allReadOnly && '$replica' in tx
      ? (tx as any).$replica()
      : tx;
    const rawResult = await queryClient.$queryRaw(sqlQuery);

    const postProcessed = combinedQuery.postProcess(rawResult as any);
    // If the postProcess is async, postProcessed is a Promise. If that Promise is rejected, it will cause an unhandled promise rejection.
    // We don't want that, because Vercel crashes on unhandled promise rejections.
    // We also want to concat the current stack trace to the error, so we can see where the rawQuery function was called
    if (isPromise(postProcessed)) {
      ignoreUnhandledRejection(postProcessed);
      concatStacktracesIfRejected(postProcessed);
    }

    return postProcessed;
  });
}

// not exhaustive
export const PRISMA_ERROR_CODES = {
  VALUE_TOO_LONG: "P2000",
  RECORD_NOT_FOUND: "P2001",
  UNIQUE_CONSTRAINT_VIOLATION: "P2002",
  FOREIGN_CONSTRAINT_VIOLATION: "P2003",
  GENERIC_CONSTRAINT_VIOLATION: "P2004",
  // Thrown by `delete`/`update` (and relation requirements) when the targeted row
  // doesn't exist — e.g. when two requests race to consume the same single-use row.
  DEPENDENT_RECORD_NOT_FOUND: "P2025",
} as const;

export function isPrismaError(error: unknown, code: keyof typeof PRISMA_ERROR_CODES): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === PRISMA_ERROR_CODES[code];
}

export function isPrismaUniqueConstraintViolation(error: unknown, modelName: string, target: string | string[]): error is Prisma.PrismaClientKnownRequestError {
  if (!isPrismaError(error, "UNIQUE_CONSTRAINT_VIOLATION")) return false;
  if (!error.meta?.target) return false;
  return error.meta.modelName === modelName && deepPlainEquals(error.meta.target, target);
}

export function sqlQuoteIdentToString(id: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_\-$]*$/.test(id)) {
    throw new Error(`Invalid identifier: ${id}`);
  }
  // escape embedded double quotes just in case
  return `"${id.replace(/"/g, '""')}"`;
}

export function sqlQuoteIdent(id: string) {
  return Prisma.raw(sqlQuoteIdentToString(id));
}
