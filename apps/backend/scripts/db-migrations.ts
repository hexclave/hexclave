import { applyMigrations } from "@/auto-migrations";
import { MIGRATION_FILES_DIR, getMigrationFiles } from "@/auto-migrations/utils";
import { Prisma } from "@/generated/prisma/client";
import { getClickhouseAdminClient } from "@/lib/clickhouse";
import { globalPrismaClient, globalPrismaConnectionString, globalPrismaSchema, sqlQuoteIdent } from "@/prisma-client";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import * as readline from "readline";
import { seed } from "../prisma/seed";
import { runBackfillInternalFreePlans } from "./backfill-internal-free-plans";
import {
  parseCopySpecifiedTenancySubscriptionsArgs,
  runCopySpecifiedTenancySubscriptions,
} from "./copy-specified-tenancy-subscriptions";
import { parseBackfillResumeOptions, runBulldozerPaymentsInit } from "./bulldozer-payments-init";
import { runClickhouseMigrations } from "./clickhouse-migrations";
import { runRegenInternalSubscriptionsToLatest } from "./regen-internal-subscriptions-to-latest";

const getClickhouseClient = () => getClickhouseAdminClient();

const dropSchema = async () => {
  await globalPrismaClient.$executeRaw(Prisma.sql`DROP SCHEMA ${sqlQuoteIdent(globalPrismaSchema)} CASCADE`);
  await globalPrismaClient.$executeRaw(Prisma.sql`CREATE SCHEMA ${sqlQuoteIdent(globalPrismaSchema)}`);
  await globalPrismaClient.$executeRaw(Prisma.sql`GRANT ALL ON SCHEMA ${sqlQuoteIdent(globalPrismaSchema)} TO postgres`);
  await globalPrismaClient.$executeRaw(Prisma.sql`GRANT ALL ON SCHEMA ${sqlQuoteIdent(globalPrismaSchema)} TO public`);
  const clickhouseClient = getClickhouseClient();
  await clickhouseClient.command({ query: "DROP DATABASE IF EXISTS analytics_internal" });
  await clickhouseClient.command({ query: "CREATE DATABASE IF NOT EXISTS analytics_internal" });
};


const askQuestion = (question: string) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
};

const promptDropDb = async () => {
  const answer = (await askQuestion(
    'Are you sure you want to drop everything in the database? This action cannot be undone. (y/N): ',
  )).trim();

  if (answer.toLowerCase() !== 'y') {
    console.log('Operation cancelled');
    process.exit(0);
  }
};

const formatMigrationName = (input: string) =>
  input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const promptMigrationName = async () => {
  while (true) {
    const rawName = (await askQuestion('Enter a migration name: ')).trim();
    const formattedName = formatMigrationName(rawName);

    if (!formattedName) {
      console.log('Migration name cannot be empty. Please try again.');
      continue;
    }

    if (formattedName !== rawName) {
      console.log(`Using sanitized migration name: ${formattedName}`);
    }

    return formattedName;
  }
};

const timestampPrefix = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14);

const generateMigrationFile = async () => {
  const migrationName = await promptMigrationName();
  const folderName = `${timestampPrefix()}_${migrationName}`;
  const migrationDir = path.join(MIGRATION_FILES_DIR, folderName);
  const migrationSqlPath = path.join(migrationDir, 'migration.sql');

  console.log(`Generating migration ${folderName}...`);
  const diffResult = spawnSync(
    'pnpm',
    [
      '-s',
      'prisma',
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      'prisma/schema.prisma',
      '--script',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );

  if (diffResult.error || diffResult.status !== 0) {
    console.error(diffResult.stdout);
    console.error(diffResult.stderr);
    throw diffResult.error ?? new Error(`Failed to generate migration (exit code ${diffResult.status})`);
  }

  const sql = diffResult.stdout;

  if (!sql.trim()) {
    console.log('No schema changes detected. Migration file was not created.');
  } else {
    fs.mkdirSync(migrationDir, { recursive: true });
    fs.writeFileSync(migrationSqlPath, sql, 'utf8');
    console.log(`Migration written to ${path.relative(process.cwd(), migrationSqlPath)}`);
    console.log('Applying migration...');
    await migrate([{ migrationName: folderName, sql }]);
  }
};

const promptContinueMigration = async (migrationName: string) => {
  const answer = (await askQuestion(
    `\n🔄 Ready to apply migration: ${migrationName}\nPress Enter to continue or 'q' to quit: `,
  )).trim();

  if (answer.toLowerCase() === 'q') {
    console.log('Migration cancelled by user');
    process.exit(0);
  }
};

const migrate = async (selectedMigrationFiles?: { migrationName: string, sql: string }[], options?: { interactive?: boolean }) => {
  const startTime = performance.now();
  const migrationFiles = selectedMigrationFiles ?? getMigrationFiles(MIGRATION_FILES_DIR);
  const totalMigrations = migrationFiles.length;

  const result = await applyMigrations({
    prismaClient: globalPrismaClient,
    outsideTransactionConnectionString: globalPrismaConnectionString,
    migrationFiles,
    logging: true,
    schema: globalPrismaSchema,
    onBeforeMigration: options?.interactive ? promptContinueMigration : undefined,
  });

  const endTime = performance.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 MIGRATION SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ Migrations completed successfully`);
  console.log(`⏱️  Duration: ${duration} seconds`);
  console.log(`📁 Total migrations in folder: ${totalMigrations}`);
  console.log(`🆕 Newly applied migrations: ${result.newlyAppliedMigrationNames.length}`);
  console.log(`✓  Already applied migrations: ${totalMigrations - result.newlyAppliedMigrationNames.length}`);

  if (result.newlyAppliedMigrationNames.length > 0) {
    console.log('\n📝 Newly applied migrations:');
    result.newlyAppliedMigrationNames.forEach((name, index) => {
      console.log(`   ${index + 1}. ${name}`);
    });
  } else {
    console.log('\n✨ Database is already up to date!');
  }

  console.log('='.repeat(60) + '\n');

  await runClickhouseMigrations();

  return result;
};

const showHelp = () => {
  console.log(`Database Migration Script

Usage: pnpm db-migrations <command> [options]

Commands:
  reset                            Drop all data and recreate the database, then apply migrations and seed
  generate-migration-file          Generate a new migration file using Prisma, then reset and migrate
  seed                             [Advanced] Run database seeding only
  init                             Apply migrations, then seed
  migrate                          Apply migrations
  backfill-bulldozer-from-prisma   One-way backfill of the payment tables from Postgres into bulldozer-js.
                                   In dev, run after restart-deps once the bulldozer-js server is running.
                                   Idempotent; safe to re-run. Optional resume for very large tables
                                   (paste cursor from a prior batch log; use the same tenancy filters):
                                   --resume-table=<TableName> --resume-cursor=<tenancyId>,<id>
                                   Order is tenancyId, then id (ManualTransaction: id means txnId).
                                   Tables: Subscription, SubscriptionInvoice, OneTimePurchase,
                                   ItemQuantityChange, ManualTransaction.
                                   Tenancy filters (optional; pick one; --flag=value or --flag value):
                                   (omit both)                 copy every tenancy
                                   --only-tenancy-ids=...      copy JUST these tenancies
                                   --exclude-tenancy-ids=...   copy everyone EXCEPT these
                                   --continue-on-error skips rows bulldozer-js rejects and reports them
                                   all at the end (default is fail-fast on the first bad row)
                                   --batch-size=<n> rows per page/POST (default 50)
  backfill-internal-free-plans     Grant the free plan to internal-tenancy teams that have no plan. Run AFTER seed.
  copy-specified-tenancy-subscriptions
                                   One-off: copy Subscription + related SubscriptionInvoice rows for one
                                   tenancy filtered by productId into bulldozer-js over HTTP.
                                   Requires --tenancy-id=<uuid> --only-product-ids=team,growth
                                   Optional: --batch-size / --continue-on-error (idempotent; re-run if interrupted)
  regen-internal-subscriptions-to-latest
                                   Bring every active internal-tenancy subscription up to the latest version of its
                                   product (rewrites the stored snapshot; rebases Stripe metadata for live subs).
                                   Idempotent. Run AFTER seed and AFTER backfill-internal-free-plans.
  help                             Show this help message

Options:
  --interactive            Prompt before each new migration (not on conditional repeats)
`);
};

const main = async () => {
  const args = process.argv.slice(2);
  const command = args[0];
  const interactive = args.includes('--interactive');

  switch (command) {
    case 'reset': {
      await promptDropDb();
      await dropSchema();
      await migrate(undefined, { interactive });
      await seed();
      break;
    }
    case 'generate-migration-file': {
      await promptDropDb();
      await dropSchema();
      await migrate(undefined, { interactive });
      await generateMigrationFile();
      await seed();
      break;
    }
    case 'seed': {
      await seed();
      break;
    }
    case 'init': {
      await migrate(undefined, { interactive });
      await seed();
      // To populate bulldozer, run db:backfill-bulldozer-from-prisma after restart-deps.
      break;
    }
    case 'migrate': {
      await migrate(undefined, { interactive });
      break;
    }
    case 'backfill-bulldozer-from-prisma': {
      // Standalone one-way backfill of the payment tables from Postgres into
      // bulldozer-js. Idempotent, so a crash is recovered by re-running.
      // Optional resume for very large tables (paste cursor from a prior batch
      // log; keep the same tenancy filters):
      //   --resume-table=<TableName> --resume-cursor=<tenancyId>,<id>
      //   ManualTransaction: <id> is txnId (that table has no separate id column).
      // Optional tenancy filters (mutually exclusive; --flag=value or --flag value):
      //   (omit both)                 → every tenancy
      //   --only-tenancy-ids=...      → JUST these tenancies
      //   --exclude-tenancy-ids=...   → everyone EXCEPT these
      // Optional --continue-on-error: skip rows bulldozer-js rejects and throw
      // with the full list at the end instead of aborting on the first one.
      // Optional --batch-size=<n>: rows per keyset page / bulldozer-js POST
      // (default 50).
      await runBulldozerPaymentsInit(parseBackfillResumeOptions(args));
      break;
    }
    case 'backfill-internal-free-plans': {
      // Explicit step — callers must guarantee the internal tenancy has been
      // seeded before invoking this (the backfill throws loudly otherwise).
      // Precondition: bulldozer-js is already consistent (via dual-writes, or
      // a prior `backfill-bulldozer-from-prisma` on a fresh DB) — this reads
      // the Subscription LFold via `ensureFreePlanForBillingTeam`.
      await runBackfillInternalFreePlans();
      break;
    }
    case 'copy-specified-tenancy-subscriptions': {
      // One-off productId-filtered subscription (+ invoice) ingress.
      // Point HEXCLAVE_BULLDOZER_SERVER_URL at the target bulldozer (e.g. 7146).
      await runCopySpecifiedTenancySubscriptions(parseCopySpecifiedTenancySubscriptionsArgs(args));
      break;
    }
    case 'regen-internal-subscriptions-to-latest': {
      // Explicit step — callers must guarantee the internal tenancy has been
      // seeded. Precondition: bulldozer-js is already consistent (via
      // dual-writes, or a prior `backfill-bulldozer-from-prisma` on a fresh
      // DB) — the regen reads `sub.product` via the Subscription LFold.
      await runRegenInternalSubscriptionsToLatest();
      break;
    }
    case 'help': {
      showHelp();
      break;
    }
    default: {
      console.error('Unknown command.');
      showHelp();
      process.exit(1);
    }
  }
};

// eslint-disable-next-line no-restricted-syntax
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
