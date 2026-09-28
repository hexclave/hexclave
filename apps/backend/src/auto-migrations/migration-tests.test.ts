import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from '@prisma/adapter-pg';
import fs from 'fs';
import path from 'path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { applyMigrations } from "./index";
import { getMigrationFiles } from "./utils";

// Resolve migrations dir relative to this file, not process.cwd()
const MIGRATIONS_DIR = path.resolve(__dirname, '../../prisma/migrations');

const TEST_DB_PREFIX = 'stack_migration_test';

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
  const base = connString.replace(/\/[^/]*(\?.*)?$/, '');
  const query = connString.split('?')[1] ?? '';
  return { full: `${base}/${testDbName}`, base, query };
};

type MigrationTestModule = {
  preMigration?: (sql: postgres.Sql) => Promise<unknown>,
  postMigration?: (sql: postgres.Sql, ctx: unknown) => Promise<void>,
};

type TestInfo = {
  fileName: string,
  modulePath: string,
};

type MigrationWithTests = {
  migrationName: string,
  migrationIndex: number,
  tests: TestInfo[],
};

function discoverTestFiles(): { allMigrations: { migrationName: string, sql: string }[], migrationsWithTests: MigrationWithTests[] } {
  const allMigrations = getMigrationFiles(MIGRATIONS_DIR);
  const migrationsWithTests: MigrationWithTests[] = [];

  for (const [i, mf] of allMigrations.entries()) {
    const testsDir = path.join(MIGRATIONS_DIR, mf.migrationName, 'tests');
    if (!fs.existsSync(testsDir)) continue;
    const files = fs.readdirSync(testsDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
    if (files.length === 0) continue;
    migrationsWithTests.push({
      migrationName: mf.migrationName,
      migrationIndex: i,
      tests: files.map(f => ({ fileName: f, modulePath: path.join(testsDir, f) })),
    });
  }
  return { allMigrations, migrationsWithTests };
}

const { allMigrations, migrationsWithTests } = discoverTestFiles();

describe.sequential('database migration tests', { timeout: 600_000 }, () => {
  let sql: postgres.Sql;
  let prismaClient: PrismaClient;
  let connectionString: string;
  let testDbName: string;
  let appliedUpTo = 0;

  async function applyMigrationsUpTo(targetIndex: number) {
    if (appliedUpTo >= targetIndex) return;
    const batch = allMigrations.slice(0, targetIndex);
    await applyMigrations({ prismaClient, migrationFiles: batch, outsideTransactionConnectionString: connectionString, schema: 'public' });
    appliedUpTo = targetIndex;
  }

  async function applySingleMigration(index: number) {
    await applyMigrations({ prismaClient, migrationFiles: allMigrations.slice(0, index + 1), outsideTransactionConnectionString: connectionString, schema: 'public' });
    appliedUpTo = index + 1;
  }

  beforeAll(async () => {
    const randomSuffix = Math.random().toString(16).substring(2, 12);
    testDbName = `${TEST_DB_PREFIX}_${randomSuffix}`;
    const dbURL = getTestDbURL(testDbName);

    const adminSql = postgres(dbURL.base);
    try {
      await adminSql.unsafe(`CREATE DATABASE ${testDbName}`);
    } finally {
      await adminSql.end();
    }

    connectionString = `${dbURL.full}?${dbURL.query}`;
    sql = postgres(connectionString);

    const adapter = new PrismaPg({ connectionString });
    prismaClient = new PrismaClient({ adapter });
    await prismaClient.$connect();
  }, 60_000);

  afterAll(async () => {
    await sql.end();
    await prismaClient.$disconnect();
    if (testDbName) {
      const dbURL = getTestDbURL(testDbName);
      const adminSql = postgres(dbURL.base);
      try {
        await adminSql.unsafe(`
          SELECT pg_terminate_backend(pg_stat_activity.pid)
          FROM pg_stat_activity
          WHERE pg_stat_activity.datname = '${testDbName}'
          AND pid <> pg_backend_pid()
        `);
        await adminSql.unsafe(`DROP DATABASE IF EXISTS ${testDbName}`);
      } finally {
        await adminSql.end();
      }
    }
  }, 60_000);

  if (migrationsWithTests.length === 0) {
    test('no migration tests found', () => {
      expect(true).toBe(true);
    });
    return;
  }

  for (const mwt of migrationsWithTests) {
    describe(mwt.migrationName, () => {
      const preResults = new Map<string, unknown>();

      beforeAll(async () => {
        // Apply all migrations up to (but not including) this one
        await applyMigrationsUpTo(mwt.migrationIndex);

        // Run preMigration for each test file
        for (const t of mwt.tests) {
          const mod: MigrationTestModule = await import(t.modulePath);
          if (mod.preMigration) {
            preResults.set(t.fileName, await mod.preMigration(sql));
          }
        }

        // Apply this migration
        await applySingleMigration(mwt.migrationIndex);
      }, 600_000);

      for (const t of mwt.tests) {
        test(t.fileName.replace(/\.[tj]s$/, ''), async () => {
          const mod: MigrationTestModule = await import(t.modulePath);
          if (mod.postMigration) {
            await mod.postMigration(sql, preResults.get(t.fileName));
          }
        });
      }
    });
  }
});
