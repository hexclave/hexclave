import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from '@prisma/adapter-pg';
import postgres from 'postgres';
import { ExpectStatic } from "vitest";
import { applyMigrations, runMigrationNeeded } from "./index";

const TEST_DB_PREFIX = 'stack_auth_test_db';

const getDatabaseConnectionString = (): string => {
  // @ts-ignore - ImportMeta.env is provided by Vite
  const hexclaveValue: string | undefined = import.meta.env.HEXCLAVE_DATABASE_CONNECTION_STRING;
  // @ts-ignore - ImportMeta.env is provided by Vite
  const stackValue: string | undefined = import.meta.env.STACK_DATABASE_CONNECTION_STRING;
  if (hexclaveValue && stackValue && hexclaveValue !== stackValue) {
    throw new Error("Environment variables HEXCLAVE_DATABASE_CONNECTION_STRING and STACK_DATABASE_CONNECTION_STRING are both set to different values. Remove one of them or set them to the same value.");
  }
  const value = hexclaveValue || stackValue;
  if (!value) {
    throw new Error("Missing environment variable HEXCLAVE_DATABASE_CONNECTION_STRING or STACK_DATABASE_CONNECTION_STRING.");
  }
  return value;
};

const getTestDbURL = (testDbName: string) => {
  const connString = getDatabaseConnectionString();
  const base = connString.replace(/\/[^/]*$/, '');
  const query = connString.split('?')[1] ?? '';
  return {
    full: `${base}/${testDbName}`,
    base,
    query,
  };
};

const applySql = async (options: { sql: string | string[], dbUrl: string }) => {
  const sql = postgres(options.dbUrl);

  try {
    for (const query of Array.isArray(options.sql) ? options.sql : [options.sql]) {
      await sql.unsafe(query);
    }

  } finally {
    await sql.end();
  }
};

const setupTestDatabase = async () => {
  const randomSuffix = Math.random().toString(16).substring(2, 12);
  const testDbName = `${TEST_DB_PREFIX}_${randomSuffix}`;
  const dbURL = getTestDbURL(testDbName);
  await applySql({ sql: `CREATE DATABASE ${testDbName}`, dbUrl: dbURL.base });

  const connectionString = `${dbURL.full}?${dbURL.query}`;
  const adapter = new PrismaPg({ connectionString });
  const prismaClient = new PrismaClient({ adapter });

  await prismaClient.$connect();

  return {
    connectionString,
    prismaClient,
    testDbName,
    dbURL,
  };
};

const teardownTestDatabase = async (prismaClient: PrismaClient, testDbName: string) => {
  await prismaClient.$disconnect();
  const dbURL = getTestDbURL(testDbName);
  await applySql({
    sql: [
      `
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = '${testDbName}'
        AND pid <> pg_backend_pid();
      `,
      `DROP DATABASE IF EXISTS ${testDbName}`
    ],
    dbUrl: dbURL.base
  });

  // Wait a bit to ensure connections are terminated
  await new Promise(resolve => setTimeout(resolve, 500));
};

function runTest(fn: (options: { connectionString: string, expect: ExpectStatic, prismaClient: PrismaClient, dbURL: { full: string, base: string } }) => Promise<void>) {
  return async ({ expect }: { expect: ExpectStatic }) => {
    const { connectionString, prismaClient, testDbName, dbURL } = await setupTestDatabase();
    try {
      await fn({ connectionString, prismaClient, expect, dbURL });
    } finally {
      await teardownTestDatabase(prismaClient, testDbName);
    }
  };
}

const exampleMigrationFiles1 = [
  {
    migrationName: "001-create-table",
    sql: "CREATE TABLE test (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL);",
  },
  {
    migrationName: "002-update-table",
    sql: "ALTER TABLE test ADD COLUMN age INTEGER NOT NULL DEFAULT 0;",
  },
];

const examplePrismaBasedInitQueries = [
  // Settings
  `SET statement_timeout = 0`,
  `SET lock_timeout = 0`,
  `SET idle_in_transaction_session_timeout = 0`,
  `SET client_encoding = 'UTF8'`,
  `SET standard_conforming_strings = on`,
  `SELECT pg_catalog.set_config('search_path', '', false)`,
  `SET check_function_bodies = false`,
  `SET xmloption = content`,
  `SET client_min_messages = warning`,
  `SET row_security = off`,
  `ALTER SCHEMA public OWNER TO postgres`,
  `COMMENT ON SCHEMA public IS ''`,
  `SET default_tablespace = ''`,
  `SET default_table_access_method = heap`,
  `CREATE TABLE public."User" (
    id integer NOT NULL,
    name text NOT NULL
  )`,
  `ALTER TABLE public."User" OWNER TO postgres`,
  `CREATE TABLE public._prisma_migrations (
    id character varying(36) NOT NULL,
    checksum character varying(64) NOT NULL,
    finished_at timestamp with time zone,
    migration_name character varying(255) NOT NULL,
    logs text,
    rolled_back_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_steps_count integer DEFAULT 0 NOT NULL
  )`,
  `ALTER TABLE public._prisma_migrations OWNER TO postgres`,
  `INSERT INTO public._prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
  VALUES ('a34e5ccf-c472-44c7-9d9c-0d4580d18ac3', '9785d85f8c5a8b3dbfbbbd8143cc7485bb48dd8bf30ca3eafd3cd2e1ba15a953', '2025-03-14 21:50:26.794721+00', '20250314215026_init', NULL, NULL, '2025-03-14 21:50:26.656161+00', 1)`,
  `INSERT INTO public._prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
  VALUES ('7e7f0e5b-f91b-40fa-b061-d8f2edd274ed', '6853f42ae69239976b84d058430774c8faa83488545e84162844dab84b47294d', '2025-03-14 21:50:47.761397+00', '20250314215047_name', NULL, NULL, '2025-03-14 21:50:47.624814+00', 1)`,
  `ALTER TABLE ONLY public."User" ADD CONSTRAINT "User_pkey" PRIMARY KEY (id)`,
  `ALTER TABLE ONLY public._prisma_migrations ADD CONSTRAINT _prisma_migrations_pkey PRIMARY KEY (id)`,
  `REVOKE USAGE ON SCHEMA public FROM PUBLIC`
];

const examplePrismaBasedMigrationFiles = [
  {
    migrationName: '20250314215026_init',
    sql: `CREATE TABLE "User" ("id" INTEGER NOT NULL, CONSTRAINT "User_pkey" PRIMARY KEY ("id"));`,
  },
  {
    migrationName: '20250314215047_name',
    sql: `ALTER TABLE "User" ADD COLUMN "name" TEXT NOT NULL;`,
  },
  {
    migrationName: '20250314215050_age',
    sql: `ALTER TABLE "User" ADD COLUMN "age" INTEGER NOT NULL DEFAULT 0;`,
  },
];


import.meta.vitest?.test("connects to DB", runTest(async ({ expect, prismaClient }) => {
  const result = await prismaClient.$executeRaw`SELECT 1`;
  expect(result).toBe(1);
}));

import.meta.vitest?.test("applies migrations", runTest(async ({ expect, prismaClient }) => {
  const { newlyAppliedMigrationNames } = await applyMigrations({ prismaClient, migrationFiles: exampleMigrationFiles1, schema: 'public' });

  expect(newlyAppliedMigrationNames).toEqual(['001-create-table', '002-update-table']);

  await prismaClient.$executeRaw`INSERT INTO test (name) VALUES ('test_value')`;

  const result = await prismaClient.$queryRaw`SELECT name FROM test` as { name: string }[];
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(1);
  expect(result[0].name).toBe('test_value');

  const ageResult = await prismaClient.$queryRaw`SELECT age FROM test WHERE name = 'test_value'` as { age: number }[];
  expect(Array.isArray(ageResult)).toBe(true);
  expect(ageResult.length).toBe(1);
  expect(ageResult[0].age).toBe(0);
}));

import.meta.vitest?.test("first apply half of the migrations, then apply the other half", runTest(async ({ expect, prismaClient }) => {
  const { newlyAppliedMigrationNames } = await applyMigrations({ prismaClient, migrationFiles: exampleMigrationFiles1.slice(0, 1), schema: 'public' });
  expect(newlyAppliedMigrationNames).toEqual(['001-create-table']);

  const { newlyAppliedMigrationNames: newlyAppliedMigrationNames2 } = await applyMigrations({ prismaClient, migrationFiles: exampleMigrationFiles1, schema: 'public' });
  expect(newlyAppliedMigrationNames2).toEqual(['002-update-table']);

  await prismaClient.$executeRaw`INSERT INTO test (name) VALUES ('test_value')`;

  const result = await prismaClient.$queryRaw`SELECT name FROM test` as { name: string }[];
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(1);
  expect(result[0].name).toBe('test_value');

  const ageResult = await prismaClient.$queryRaw`SELECT age FROM test WHERE name = 'test_value'` as { age: number }[];
  expect(Array.isArray(ageResult)).toBe(true);
  expect(ageResult.length).toBe(1);
  expect(ageResult[0].age).toBe(0);
}));

import.meta.vitest?.test("applies migrations concurrently", runTest(async ({ expect, prismaClient }) => {
  const [result1, result2] = await Promise.all([
    applyMigrations({ prismaClient, migrationFiles: exampleMigrationFiles1, artificialDelayInSeconds: 1, schema: 'public' }),
    applyMigrations({ prismaClient, migrationFiles: exampleMigrationFiles1, artificialDelayInSeconds: 1, schema: 'public' }),
  ]);

  const l1 = result1.newlyAppliedMigrationNames.length;
  const l2 = result2.newlyAppliedMigrationNames.length;

  // the sum of the two should be 2
  expect(l1 + l2).toBe(2);

  await prismaClient.$executeRaw`INSERT INTO test (name) VALUES ('test_value')`;
  const result = await prismaClient.$queryRaw`SELECT name FROM test` as { name: string }[];
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(1);
  expect(result[0].name).toBe('test_value');
}));

import.meta.vitest?.test("applies migrations concurrently with 20 concurrent migrations", runTest(async ({ expect, prismaClient }) => {
  const promises = Array.from({ length: 20 }, async (_, i) => {
    console.log("Applying migration", i);
    const result = await applyMigrations({ prismaClient, migrationFiles: exampleMigrationFiles1, artificialDelayInSeconds: 1, schema: 'public', logging: true });
    console.log("Migration", i, "applied", result.newlyAppliedMigrationNames);
    return result;
  });

  const results = await Promise.all(promises);

  // Count how many migrations were applied by each promise
  const appliedCounts = results.map(result => result.newlyAppliedMigrationNames.length);

  // Only one of the promises should have applied all migrations, the rest should have applied none
  const successfulCounts = appliedCounts.reduce((sum, count) => sum + count, 0);
  expect(successfulCounts).toBe(2);

  await prismaClient.$executeRaw`INSERT INTO test (name) VALUES ('test_value')`;
  const result = await prismaClient.$queryRaw`SELECT name FROM test` as { name: string }[];
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(1);
  expect(result[0].name).toBe('test_value');
}), {
  timeout: 400_000,
});

import.meta.vitest?.test("applies migrations concurrently without blocking its own outside-transaction statement", runTest(async ({ connectionString, expect, prismaClient }) => {
  const migrationFiles = [{
    migrationName: "001-concurrent-index",
    sql: `
      CREATE TABLE outside_transaction_test (id SERIAL PRIMARY KEY, value TEXT NOT NULL);
      -- SPLIT_STATEMENT_SENTINEL
      -- SINGLE_STATEMENT_SENTINEL
      -- RUN_OUTSIDE_TRANSACTION_SENTINEL
      CREATE INDEX CONCURRENTLY outside_transaction_test_value_idx ON outside_transaction_test(value);
    `,
  }];

  const results = await Promise.all(Array.from({ length: 20 }, async () => await applyMigrations({
    prismaClient,
    migrationFiles,
    outsideTransactionConnectionString: connectionString,
    schema: "public",
  })));

  expect(results.reduce((sum, result) => sum + result.newlyAppliedMigrationNames.length, 0)).toBe(1);
  const indexes = await prismaClient.$queryRaw<{ indisready: boolean, indisvalid: boolean }[]>`
    SELECT i.indisready, i.indisvalid
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'outside_transaction_test_value_idx'
  `;
  expect(indexes).toEqual([{ indisready: true, indisvalid: true }]);
}), {
  timeout: 120_000,
});

import.meta.vitest?.test("does not record a migration when its outside-transaction statement fails", runTest(async ({ connectionString, expect, prismaClient }) => {
  const migrationName = "001-failing-outside-transaction";
  const failingMigration = {
    migrationName,
    sql: `
      CREATE TABLE IF NOT EXISTS outside_transaction_failure_test (id SERIAL PRIMARY KEY);
      -- SPLIT_STATEMENT_SENTINEL
      -- SINGLE_STATEMENT_SENTINEL
      -- RUN_OUTSIDE_TRANSACTION_SENTINEL
      SELECT 1 / 0;
    `,
  };

  await expect(applyMigrations({
    prismaClient,
    migrationFiles: [failingMigration],
    outsideTransactionConnectionString: connectionString,
    schema: "public",
  })).rejects.toThrow();
  expect(await prismaClient.$queryRaw`
    SELECT "migrationName"
    FROM "SchemaMigration"
    WHERE "migrationName" = ${migrationName}
  `).toEqual([]);

  const fixedMigration = {
    ...failingMigration,
    sql: `
      CREATE TABLE IF NOT EXISTS outside_transaction_failure_test (id SERIAL PRIMARY KEY);
      -- SPLIT_STATEMENT_SENTINEL
      -- SINGLE_STATEMENT_SENTINEL
      -- RUN_OUTSIDE_TRANSACTION_SENTINEL
      CREATE INDEX CONCURRENTLY IF NOT EXISTS outside_transaction_failure_test_id_idx
        ON outside_transaction_failure_test(id);
    `,
  };
  await expect(applyMigrations({
    prismaClient,
    migrationFiles: [fixedMigration],
    outsideTransactionConnectionString: connectionString,
    schema: "public",
  })).resolves.toEqual({ newlyAppliedMigrationNames: [migrationName] });
}), {
  timeout: 120_000,
});


import.meta.vitest?.test("applies migration with a DB previously migrated with prisma", runTest(async ({ expect, prismaClient, dbURL }) => {
  await applySql({ sql: examplePrismaBasedInitQueries, dbUrl: dbURL.full });
  const result = await applyMigrations({ prismaClient, migrationFiles: examplePrismaBasedMigrationFiles, schema: 'public' });
  expect(result.newlyAppliedMigrationNames).toEqual(['20250314215050_age']);

  // apply migrations again
  const result2 = await applyMigrations({ prismaClient, migrationFiles: examplePrismaBasedMigrationFiles, schema: 'public' });
  expect(result2.newlyAppliedMigrationNames).toEqual([]);
}));

import.meta.vitest?.test("applies migration while running a query", runTest(async ({ expect, prismaClient, dbURL }) => {
  await runMigrationNeeded({
    prismaClient,
    migrationFiles: exampleMigrationFiles1,
    artificialDelayInSeconds: 1,
    schema: 'public',
  });

  await prismaClient.$executeRaw`INSERT INTO test (name) VALUES ('test_value')`;

  const result = await prismaClient.$queryRaw`SELECT name FROM test` as { name: string }[];
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(1);
  expect(result[0].name).toBe('test_value');
}));

import.meta.vitest?.test("applies migration while running concurrent queries", runTest(async ({ expect, prismaClient, dbURL }) => {
  const runMigrationAndInsert = async (testValue: string) => {
    await runMigrationNeeded({
      prismaClient,
      migrationFiles: exampleMigrationFiles1,
      schema: 'public',
    });
    await prismaClient.$executeRaw`INSERT INTO test (name) VALUES (${testValue})`;
  };

  await Promise.all([
    runMigrationAndInsert('test_value1'),
    runMigrationAndInsert('test_value2'),
  ]);

  const result1 = await prismaClient.$queryRaw`SELECT name FROM test` as { name: string }[];
  expect(Array.isArray(result1)).toBe(true);
  expect(result1.length).toBe(2);
  expect(result1.some(r => r.name === 'test_value1')).toBe(true);
  expect(result1.some(r => r.name === 'test_value2')).toBe(true);
}));

import.meta.vitest?.test("applies migration while running an interactive transaction", runTest(async ({ expect, prismaClient, dbURL }) => {
  // eslint-disable-next-line no-restricted-syntax
  return await prismaClient.$transaction(async (tx, ...args) => {
    await runMigrationNeeded({
      prismaClient,
      migrationFiles: exampleMigrationFiles1,
      schema: 'public',
    });

    await tx.$executeRaw`INSERT INTO test (name) VALUES ('test_value')`;
    const result = await tx.$queryRaw`SELECT name FROM test` as { name: string }[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('test_value');
  }, {
    isolationLevel: undefined,
    timeout: 15_000,
    maxWait: 5_000,
  });
}));

import.meta.vitest?.test("applies migration while running concurrent interactive transactions", runTest(async ({ expect, prismaClient, dbURL }) => {
  const runTransactionWithMigration = async (testValue: string) => {
    // eslint-disable-next-line no-restricted-syntax
    return await prismaClient.$transaction(async (tx) => {
      await runMigrationNeeded({
        prismaClient,
        schema: 'public',
        migrationFiles: exampleMigrationFiles1,
        artificialDelayInSeconds: 1,
      });

      await tx.$executeRaw`INSERT INTO test (name) VALUES (${testValue})`;
      return testValue;
    });
  };

  const results = await Promise.all([
    runTransactionWithMigration('concurrent_tx_1'),
    runTransactionWithMigration('concurrent_tx_2'),
  ]);

  expect(results).toEqual(['concurrent_tx_1', 'concurrent_tx_2']);

  const result = await prismaClient.$queryRaw`SELECT name FROM test` as { name: string }[];
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(2);
  expect(result.some(r => r.name === 'concurrent_tx_1')).toBe(true);
  expect(result.some(r => r.name === 'concurrent_tx_2')).toBe(true);
}));

import.meta.vitest?.test("does not apply migrations if they are already applied", runTest(async ({ expect, prismaClient, dbURL }) => {
  await applyMigrations({ prismaClient, migrationFiles: exampleMigrationFiles1, schema: 'public' });
  const result = await applyMigrations({ prismaClient, migrationFiles: exampleMigrationFiles1, schema: 'public' });
  expect(result.newlyAppliedMigrationNames).toEqual([]);
}));

import.meta.vitest?.test("does not apply a migration again if all migrations are already applied, and some future migrations are also applied (rollback scenario)", runTest(async ({ expect, prismaClient, dbURL }) => {
  // First, apply all migrations
  const initialResult = await applyMigrations({ prismaClient, migrationFiles: exampleMigrationFiles1, schema: 'public' });
  expect(initialResult.newlyAppliedMigrationNames).toEqual(['001-create-table', '002-update-table']);

  // Verify the table structure is complete
  await prismaClient.$executeRaw`INSERT INTO test (name, age) VALUES ('test_value', 25)`;
  const fullResult = await prismaClient.$queryRaw`SELECT name, age FROM test` as { name: string, age: number }[];
  expect(fullResult.length).toBe(1);
  expect(fullResult[0].name).toBe('test_value');
  expect(fullResult[0].age).toBe(25);

  // Now try to apply only a subset of the migrations (simulating a rollback scenario)
  // This should not re-apply any migrations since they're already applied
  const subsetResult = await applyMigrations({ prismaClient, migrationFiles: exampleMigrationFiles1.slice(0, 1), schema: 'public' });
  expect(subsetResult.newlyAppliedMigrationNames).toEqual([]);

  // Verify the data is still intact and no migrations were re-run
  const finalResult = await prismaClient.$queryRaw`SELECT name, age FROM test` as { name: string, age: number }[];
  expect(finalResult.length).toBe(1);
  expect(finalResult[0].name).toBe('test_value');
  expect(finalResult[0].age).toBe(25);
}));

import.meta.vitest?.test("a migration that fails for whatever reasons rolls back all statements successfully, and then reapplying a fixed version of the migration is also successful", runTest(async ({ expect, prismaClient, dbURL }) => {
  const exampleMigration3 = {
    migrationName: '003-create-table',
    sql: `
      CREATE TABLE should_exist_after_the_third_migration (id INTEGER);
    `,
  };
  const failingMigrationFiles = [...exampleMigrationFiles1.slice(0, -1), {
    migrationName: exampleMigrationFiles1[exampleMigrationFiles1.length - 1].migrationName,
    sql: `
      CREATE TABLE should_not_exist (id INTEGER);
      SELECT 1/0;
    `
  }, exampleMigration3];

  await expect(applyMigrations({ prismaClient, migrationFiles: failingMigrationFiles, schema: 'public' })).rejects.toThrow();

  // Verify that the first part of the migration was applied but rolled back
  await expect(prismaClient.$queryRaw`SELECT * FROM test`).resolves.toBeDefined();

  // Verify that the table from the third migration was also not created due to rollback
  await expect(prismaClient.$queryRaw`SELECT * FROM should_exist_after_the_third_migration`).rejects.toThrow();

  // Verify that the failing table was not created due to rollback
  await expect(prismaClient.$queryRaw`SELECT * FROM should_not_exist`).rejects.toThrow();

  const result = await applyMigrations({ prismaClient, migrationFiles: [...exampleMigrationFiles1, exampleMigration3], schema: 'public' });
  expect(result.newlyAppliedMigrationNames).toEqual(['002-update-table', '003-create-table']);

  await expect(prismaClient.$queryRaw`SELECT * FROM should_exist_after_the_third_migration`).resolves.toBeDefined();
}));

import.meta.vitest?.test("repeats migrations when a REPEAT_MIGRATION error is thrown", runTest(async ({ expect, prismaClient, dbURL }) => {
  const exampleMigration3 = {
    migrationName: '003-repeat-ten-times',
    // increment a value; if the value is < 10, raise a REPEAT_MIGRATION error
    sql: `
      CREATE TABLE IF NOT EXISTS repeat_counter (value INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS has_finished_counter (value INTEGER DEFAULT 0);
      
      INSERT INTO repeat_counter (value)
      SELECT 0 
      WHERE NOT EXISTS (SELECT 1 FROM repeat_counter);
      INSERT INTO has_finished_counter (value)
      SELECT 0 
      WHERE NOT EXISTS (SELECT 1 FROM has_finished_counter);
      
      -- SPLIT_STATEMENT_SENTINEL
      -- SINGLE_STATEMENT_SENTINEL
      -- CONDITIONALLY_REPEAT_MIGRATION_SENTINEL
      UPDATE repeat_counter SET value = value + 1 RETURNING 
        CASE WHEN value >= 10 THEN false ELSE true END AS should_repeat_migration;
      -- SPLIT_STATEMENT_SENTINEL

      UPDATE has_finished_counter SET value = value + 1;
    `,
  };

  const result = await applyMigrations({ prismaClient, migrationFiles: [...exampleMigrationFiles1, exampleMigration3], schema: 'public' });
  expect(result.newlyAppliedMigrationNames).toEqual(['001-create-table', '002-update-table', '003-repeat-ten-times']);

  expect(await prismaClient.$queryRaw`SELECT value FROM repeat_counter`).toEqual([{ value: 10 }]);
  expect(await prismaClient.$queryRaw`SELECT value FROM has_finished_counter`).toEqual([{ value: 1 }]);
}));
