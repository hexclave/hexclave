import { Prisma, PrismaClient } from '@/generated/prisma/client';
import { sqlQuoteIdent, sqlQuoteIdentToString } from '@/prisma-client';
import { captureError, HexclaveAssertionError } from '@hexclave/shared/dist/utils/errors';
import { wait } from '@hexclave/shared/dist/utils/promises';
import postgres from 'postgres';
import { MIGRATION_FILES } from './../generated/migration-files';

// The bigint key for the pg advisory lock
const MIGRATION_LOCK_ID = 59129034;
const MIGRATION_LOCK_RETRY_DELAY_MS = 500;
const MIGRATION_LOCK_TIMEOUT_MS = 30_000;

type MigrationStatement = {
  sql: string,
  runOutsideTransaction: boolean,
  singleStatement: boolean,
  conditionallyRepeatMigration: boolean,
};

function parseMigrationStatements(migrationSql: string, schema: string): MigrationStatement[] {
  return migrationSql.split('SPLIT_STATEMENT_SENTINEL').map((statementRaw) => {
    const sql = statementRaw.replaceAll('/* SCHEMA_NAME_SENTINEL */', sqlQuoteIdentToString(schema));
    const runOutsideTransaction = sql.includes('RUN_OUTSIDE_TRANSACTION_SENTINEL');
    const singleStatement = sql.includes('SINGLE_STATEMENT_SENTINEL');
    const conditionallyRepeatMigration = sql.includes('CONDITIONALLY_REPEAT_MIGRATION_SENTINEL');

    if (conditionallyRepeatMigration && !singleStatement) {
      throw new HexclaveAssertionError("CONDITIONALLY_REPEAT_MIGRATION_SENTINEL requires SINGLE_STATEMENT_SENTINEL", { statement: sql });
    }
    if (runOutsideTransaction && !singleStatement) {
      throw new HexclaveAssertionError("RUN_OUTSIDE_TRANSACTION_SENTINEL requires SINGLE_STATEMENT_SENTINEL", { statement: sql });
    }

    return { sql, runOutsideTransaction, singleStatement, conditionallyRepeatMigration };
  });
}

async function acquireMigrationSessionLock(connectionString: string): Promise<{
  connection: postgres.ReservedSql,
  close: () => Promise<void>,
}> {
  const deadline = performance.now() + MIGRATION_LOCK_TIMEOUT_MS;
  while (true) {
    const sql = postgres(connectionString, { max: 1 });
    const connection = await sql.reserve();
    let lockAcquired = false;
    try {
      const rows = await connection<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(${MIGRATION_LOCK_ID}) AS locked
      `;
      if (rows.length === 1 && rows[0].locked) {
        lockAcquired = true;
        return {
          connection,
          close: async () => {
            try {
              await connection`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
            } finally {
              connection.release();
              await sql.end();
            }
          },
        };
      }
    } finally {
      if (!lockAcquired) {
        connection.release();
        await sql.end();
      }
    }
    // A blocked pool of migration transactions can starve the connection needed
    // for non-transactional DDL. Retry without retaining a database connection.
    if (performance.now() >= deadline) {
      throw new HexclaveAssertionError("Timed out waiting to acquire the migration lock.", {
        timeoutMs: MIGRATION_LOCK_TIMEOUT_MS,
      });
    }
    await wait(Math.min(MIGRATION_LOCK_RETRY_DELAY_MS, deadline - performance.now()));
  }
}
class MigrationNeededError extends Error {
  constructor() {
    super('MIGRATION_NEEDED');
    this.name = 'MigrationNeededError';
  }
}

function getMigrationError(error: unknown): string {
  // P2010: Raw query failed error
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010') {
    if (error.meta?.code === 'P0001') {
      const errorName = (error.meta as { message: string }).message.split(' ')[1];
      return errorName;
    }
  }
  throw error;
}

function isMigrationNeededError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // 42P01: relation does not exist error
    if (/relation "(?:.*\.)?SchemaMigration" does not exist/.test(error.message) || /No such table: (?:.*\.)?SchemaMigration/.test(error.message)) {
      return true;
    }
  }
  if (error instanceof MigrationNeededError) {
    return true;
  }
  return false;
}

async function getAppliedMigrations(options: {
  prismaClient: Omit<PrismaClient, "$on">,
  schema: string,
}) {
  // eslint-disable-next-line no-restricted-syntax
  const [_1, _2, _3, appliedMigrations] = await options.prismaClient.$transaction([
    options.prismaClient.$executeRaw`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`,
    options.prismaClient.$executeRaw(Prisma.sql`
      SET search_path TO ${sqlQuoteIdent(options.schema)};
    `),
    options.prismaClient.$executeRaw`
      DO $$
      BEGIN
        CREATE TABLE IF NOT EXISTS "SchemaMigration" (
          "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
          "finishedAt" TIMESTAMP(3) NOT NULL,
          "migrationName" TEXT NOT NULL UNIQUE,
          CONSTRAINT "SchemaMigration_pkey" PRIMARY KEY ("id")
        );
        
        IF EXISTS (
          SELECT 1 FROM information_schema.tables 
          WHERE table_name = '_prisma_migrations'
        ) THEN
          INSERT INTO "SchemaMigration" ("migrationName", "finishedAt")
          SELECT 
            migration_name, 
            finished_at
          FROM _prisma_migrations
          WHERE migration_name NOT IN (
            SELECT "migrationName" FROM "SchemaMigration"
          )
          AND finished_at IS NOT NULL;
        END IF;
      END $$;
    `,
    options.prismaClient.$queryRaw`SELECT "migrationName" FROM "SchemaMigration"`,
  ]);

  return (appliedMigrations as { migrationName: string }[]).map((migration) => migration.migrationName);
}

type UnsafeSqlExecutor = {
  execute: (query: string) => PromiseLike<unknown>,
  query: (query: string) => PromiseLike<unknown>,
};

async function executeMigrationStatement(executor: UnsafeSqlExecutor, statement: MigrationStatement): Promise<boolean> {
  if (!statement.singleStatement) {
    await executor.execute(`
      DO $$
      BEGIN
        ${statement.sql}
      END
      $$;
    `);
    return false;
  }

  const result = await executor.query(statement.sql);
  if (!statement.conditionallyRepeatMigration) return false;
  if (!Array.isArray(result)) {
    throw new HexclaveAssertionError("Expected an array as a return value of repeat condition", { result });
  }
  if (result.length === 0) return false;
  if (!("should_repeat_migration" in result[0])) {
    throw new HexclaveAssertionError("Expected should_repeat_migration column in return value of repeat condition", { result });
  }
  if (typeof result[0].should_repeat_migration !== "boolean") {
    throw new HexclaveAssertionError("Expected should_repeat_migration column in return value of repeat condition to be a boolean (found: " + typeof result[0].should_repeat_migration + ")", { result });
  }
  return result[0].should_repeat_migration;
}

async function runInReservedTransaction<T>(connection: postgres.ReservedSql, callback: () => Promise<T>): Promise<T> {
  await connection.unsafe("BEGIN");
  try {
    const result = await callback();
    await connection.unsafe("COMMIT");
    return result;
  } catch (error) {
    const [rollbackResult] = await Promise.allSettled([
      Promise.resolve().then(() => connection.unsafe("ROLLBACK")),
    ]);
    if (rollbackResult.status === "rejected") {
      captureError("auto-migrations-rollback", rollbackResult.reason);
    }
    throw error;
  }
}

async function applyMigrationWithOutsideTransactionStatements(options: {
  artificialDelayInSeconds?: number,
  connectionString: string,
  log: (message: string) => void,
  migration: { migrationName: string, sql: string },
  schema: string,
}): Promise<"applied" | "already-applied" | "repeat"> {
  // Every statement group can commit before SchemaMigration is recorded, so
  // migrations on this path must be safe to re-run after an interrupted attempt.
  const statements = parseMigrationStatements(options.migration.sql, options.schema);
  const lock = await acquireMigrationSessionLock(options.connectionString);
  try {
    // The session-level lock remains held while transaction boundaries are crossed.
    // This is required for PostgreSQL operations such as CREATE INDEX CONCURRENTLY,
    // which must not run alongside an older snapshot owned by this migration runner.
    await lock.connection.unsafe(`SET search_path TO ${sqlQuoteIdentToString(options.schema)}`);
    const existingMigration = await lock.connection<{ migrationName: string }[]>`
      SELECT "migrationName" FROM "SchemaMigration"
      WHERE "migrationName" = ${options.migration.migrationName}
    `;
    if (existingMigration.length > 0) {
      options.log(`  |> Migration ${options.migration.migrationName} already applied, skipping`);
      return "already-applied";
    }

    let statementIndex = 0;
    while (statementIndex < statements.length) {
      const statement = statements[statementIndex];
      if (statement.runOutsideTransaction) {
        options.log(`  |> Running statement outside of transaction: ${statement.sql.replace(/(\n|\s)/gm, " ").slice(0, 20)}...`);
        if (await executeMigrationStatement({
          execute: (query) => lock.connection.unsafe(query),
          query: (query) => lock.connection.unsafe(query),
        }, statement)) return "repeat";
        statementIndex += 1;
        continue;
      }

      const transactionStatements: MigrationStatement[] = [];
      while (statementIndex < statements.length && !statements[statementIndex].runOutsideTransaction) {
        transactionStatements.push(statements[statementIndex]);
        statementIndex += 1;
      }
      const shouldRepeat = await runInReservedTransaction(lock.connection, async () => {
        for (const transactionStatement of transactionStatements) {
          options.log(`  |> Running statement${transactionStatement.singleStatement ? "" : "s"}: ${transactionStatement.sql.replace(/(\n|\s)/gm, " ").slice(0, 20)}...`);
          if (await executeMigrationStatement({
            execute: (query) => lock.connection.unsafe(query),
            query: (query) => lock.connection.unsafe(query),
          }, transactionStatement)) return true;
        }
        return false;
      });
      if (shouldRepeat) return "repeat";
    }

    await runInReservedTransaction(lock.connection, async () => {
      if (options.artificialDelayInSeconds) {
        await lock.connection`SELECT pg_sleep(${options.artificialDelayInSeconds})`;
      }
      options.log(`  |> Inserting migration into SchemaMigration...`);
      await lock.connection`
        INSERT INTO "SchemaMigration" ("migrationName", "finishedAt")
        VALUES (${options.migration.migrationName}, clock_timestamp())
      `;
    });
    options.log(`  |> Done!`);
    return "applied";
  } finally {
    await lock.close();
  }
}

export async function applyMigrations(options: {
  prismaClient: Omit<PrismaClient, "$on">,
  outsideTransactionConnectionString?: string,
  migrationFiles?: { migrationName: string, sql: string }[],
  artificialDelayInSeconds?: number,
  logging?: boolean,
  schema: string,
  onBeforeMigration?: (migrationName: string) => Promise<void>,
}): Promise<{
  newlyAppliedMigrationNames: string[],
}> {
  const migrationFiles = options.migrationFiles ?? MIGRATION_FILES;
  const appliedMigrationNames = await getAppliedMigrations({ prismaClient: options.prismaClient, schema: options.schema });
  const newMigrationFiles = migrationFiles.filter(x => !appliedMigrationNames.includes(x.migrationName));

  const log = (msg: string, ...args: any[]) => {
    if (options.logging) {
      console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`, ...args);
    }
  };

  const newlyAppliedMigrationNames: string[] = [];
  for (const migration of newMigrationFiles) {
    // Call the callback before applying a new migration (not on conditional repeats)
    if (options.onBeforeMigration) {
      await options.onBeforeMigration(migration.migrationName);
    }

    let shouldRepeat = true;
    for (let repeat = 0; shouldRepeat; repeat++) {
      log(`Applying migration ${migration.migrationName}${repeat > 0 ? ` (repeat ${repeat})` : ''}`);

      if (migration.sql.includes("RUN_OUTSIDE_TRANSACTION_SENTINEL")) {
        if (options.outsideTransactionConnectionString == null || options.outsideTransactionConnectionString.trim() === "") {
          throw new HexclaveAssertionError(
            "Migrations using RUN_OUTSIDE_TRANSACTION_SENTINEL require outsideTransactionConnectionString",
            { migrationName: migration.migrationName },
          );
        }
        const result = await applyMigrationWithOutsideTransactionStatements({
          artificialDelayInSeconds: options.artificialDelayInSeconds,
          connectionString: options.outsideTransactionConnectionString,
          log,
          migration,
          schema: options.schema,
        });
        if (result === "repeat") {
          log(`  |> Migration ${migration.migrationName} requested to be repeated. This is normal and *not* indicative of a problem.`);
          await wait(MIGRATION_LOCK_RETRY_DELAY_MS);
          continue;
        }
        if (result === "applied") newlyAppliedMigrationNames.push(migration.migrationName);
        shouldRepeat = false;
        continue;
      }

      // eslint-disable-next-line no-restricted-syntax
      await options.prismaClient.$transaction(async (tx) => {
        log(`  |> Preparing...`);
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID});
        `;

        await tx.$executeRaw(Prisma.sql`
          SET search_path TO ${sqlQuoteIdent(options.schema)};
        `);

        const existingMigration = await tx.$queryRaw`
          SELECT 1 FROM "SchemaMigration"
          WHERE "migrationName" = ${migration.migrationName}
        ` as { "?column?": number }[];
        if (existingMigration.length > 0) {
          log(`  |> Migration ${migration.migrationName} already applied, skipping`);
          shouldRepeat = false;
          return;
        }

        for (const statement of parseMigrationStatements(migration.sql, options.schema)) {
          log(`  |> Running statement${statement.singleStatement ? "" : "s"}: ${statement.sql.replace(/(\n|\s)/gm, " ").slice(0, 20)}...`);
          if (await executeMigrationStatement({
            execute: async (query) => await tx.$executeRaw`${Prisma.raw(query)}`,
            query: async (query) => await tx.$queryRaw`${Prisma.raw(query)}`,
          }, statement)) {
            log(`  |> Migration ${migration.migrationName} requested to be repeated. This is normal and *not* indicative of a problem.`);
            await wait(MIGRATION_LOCK_RETRY_DELAY_MS);
            // Commit the transaction and continue re-running the migration
            return;
          }
        }

        if (options.artificialDelayInSeconds) {
          await tx.$executeRaw`
            SELECT pg_sleep(${options.artificialDelayInSeconds});
          `;
        }

        log(`  |> Inserting migration into SchemaMigration...`);
        await tx.$executeRaw`
          INSERT INTO "SchemaMigration" ("migrationName", "finishedAt")
          VALUES (${migration.migrationName}, clock_timestamp())
        `;
        log(`  |> Done!`);
        newlyAppliedMigrationNames.push(migration.migrationName);
        shouldRepeat = false;
      }, {
        // note: in the vast majority of cases, we want our migrations to be much faster than this, but the error message
        // of this timeout is unhelpful, so we prefer relying on pg's statement timeout instead
        // (at the time of writing that one is set to 60s in prod)
        //
        // if you have a migration that's slower, consider using CONDITIONALLY_REPEAT_MIGRATION_SENTINEL (if you are
        // editing too many rows) or split the migration into multiple smaller migrations (if you are running into
        // excessive locking).
        timeout: 80_000,
        // Allow waiting longer to acquire a connection so bursts of concurrent migration attempts don't
        // immediately fail with P2028 ("Unable to start a transaction in the given time"). This keeps the
        // migration logic resilient under high contention, which can happen in CI where many workers race at once.
        maxWait: 30_000,
      });
    }
  }

  return { newlyAppliedMigrationNames };
};

export async function runMigrationNeeded(options: {
  prismaClient: PrismaClient,
  outsideTransactionConnectionString?: string,
  schema: string,
  migrationFiles?: { migrationName: string, sql: string }[],
  artificialDelayInSeconds?: number,
  logging?: boolean,
}): Promise<void> {
  const migrationFiles = options.migrationFiles ?? MIGRATION_FILES;

  try {
    const result = await options.prismaClient.$queryRaw(Prisma.sql`
      SELECT * FROM ${sqlQuoteIdent(options.schema)}."SchemaMigration"
      ORDER BY "finishedAt" ASC
    `);
    for (const migration of migrationFiles) {
      if (!(result as any).includes(migration.migrationName)) {
        throw new MigrationNeededError();
      }
    }
  } catch (e) {
    if (isMigrationNeededError(e)) {
      await applyMigrations({
        prismaClient: options.prismaClient,
        outsideTransactionConnectionString: options.outsideTransactionConnectionString,
        migrationFiles: options.migrationFiles,
        artificialDelayInSeconds: options.artificialDelayInSeconds,
        schema: options.schema,
        logging: options.logging,
      });
    } else {
      throw e;
    }
  }
}
