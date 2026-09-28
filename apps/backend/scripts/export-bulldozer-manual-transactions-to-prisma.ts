/**
 * One-off: page Bulldozer's GET /v1/manual-transactions and upsert into Prisma
 * `ManualTransaction`. Safe to re-run (upsert on tenancyId+txnId).
 *
 * Cross-instance by design — talks to Bulldozer over HTTP via the shared server
 * secret, so it works when Postgres and Bulldozer are on different machines.
 *
 * Usage:
 *   pnpm -C apps/backend exec tsx scripts/export-bulldozer-manual-transactions-to-prisma.ts \
 *     [--exclude-tenancy-ids=<uuid,uuid>] \
 *     [--only-tenancy-ids=<uuid,uuid>] \
 *     [--batch-size=100] \
 *     [--continue-on-error]
 */
import { fetchBulldozerManualTransactionsPage } from "@/lib/bulldozer-server-client";
import { manualTransactionToPrismaRow } from "@/lib/payments/bulldozer-dual-write";
import { globalPrismaClient } from "@/prisma-client";
import { performance } from "node:perf_hooks";

const DEFAULT_BATCH_SIZE = 100;
/** Matches GET /v1/manual-transactions clamp in bulldozer-js. */
const MAX_BATCH_SIZE = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ExportManualTransactionsOptions = {
  excludeTenancyIds?: string[],
  onlyTenancyIds?: string[],
  batchSize?: number,
  continueOnError?: boolean,
};

function log(message: string) {
  console.log(`[ExportManualTransactions] ${message}`);
}

function parseTenancyIdList(raw: string, flagName: string): string[] {
  const ids = raw.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  if (ids.length === 0) {
    throw new Error(`${flagName} requires at least one tenancy UUID`);
  }
  for (const id of ids) {
    if (!UUID_RE.test(id)) {
      throw new Error(`${flagName}: invalid tenancy UUID "${id}"`);
    }
  }
  // Same as backfill: normalize so --only/--exclude match logged lowercase tenancy cursors.
  return ids.map((id) => id.toLowerCase());
}

function readFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const eq = args.find((arg) => arg.startsWith(prefix));
  if (eq !== undefined) return eq.slice(prefix.length);
  const bareIndex = args.indexOf(`--${name}`);
  if (bareIndex === -1) return undefined;
  if (bareIndex + 1 >= args.length || args[bareIndex + 1].startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return args[bareIndex + 1];
}

/**
 * Parses CLI argv for the export script. Exported for tests.
 */
export function parseExportManualTransactionsArgs(args: string[]): ExportManualTransactionsOptions {
  const continueOnError = args.includes("--continue-on-error");
  const excludeRaw = readFlag(args, "exclude-tenancy-ids");
  const onlyRaw = readFlag(args, "only-tenancy-ids");
  if (excludeRaw !== undefined && onlyRaw !== undefined) {
    throw new Error("cannot combine --exclude-tenancy-ids and --only-tenancy-ids");
  }

  const batchSizeRaw = readFlag(args, "batch-size");
  let batchSize: number | undefined = undefined;
  if (batchSizeRaw !== undefined) {
    const parsed = Number(batchSizeRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`--batch-size must be a positive integer (got "${batchSizeRaw}")`);
    }
    batchSize = parsed;
  }

  return {
    continueOnError,
    ...(batchSize !== undefined ? { batchSize } : {}),
    ...(excludeRaw !== undefined ? { excludeTenancyIds: parseTenancyIdList(excludeRaw, "--exclude-tenancy-ids") } : {}),
    ...(onlyRaw !== undefined ? { onlyTenancyIds: parseTenancyIdList(onlyRaw, "--only-tenancy-ids") } : {}),
  };
}

export function shouldKeepTenancy(tenancyId: string, options: ExportManualTransactionsOptions): boolean {
  const normalized = tenancyId.toLowerCase();
  if (options.onlyTenancyIds !== undefined) {
    return options.onlyTenancyIds.includes(normalized);
  }
  if (options.excludeTenancyIds !== undefined) {
    return !options.excludeTenancyIds.includes(normalized);
  }
  return true;
}

export async function runExportBulldozerManualTransactionsToPrisma(
  options: ExportManualTransactionsOptions = {},
): Promise<{ upserted: number, skipped: number, failed: number }> {
  const requestedBatchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const batchSize = Math.min(requestedBatchSize, MAX_BATCH_SIZE);
  if (batchSize !== requestedBatchSize) {
    log(`Clamping --batch-size from ${requestedBatchSize} to ${MAX_BATCH_SIZE} (GET /v1/manual-transactions max)`);
  }
  const startedAt = performance.now();
  let cursor: string | null = null;
  let upserted = 0;
  let skipped = 0;
  let failed = 0;
  const failures: Array<{ tenancyId: string, txnId: string, message: string }> = [];

  log(`Starting export (batchSize=${batchSize})`);

  for (;;) {
    const page = await fetchBulldozerManualTransactionsPage({ limit: batchSize, cursor });
    for (const row of page.rows) {
      if (!shouldKeepTenancy(row.tenancyId, options)) {
        skipped++;
        continue;
      }
      try {
        const prismaRow = manualTransactionToPrismaRow(row);
        await globalPrismaClient.manualTransaction.upsert({
          where: {
            tenancyId_txnId: {
              tenancyId: prismaRow.tenancyId,
              txnId: prismaRow.txnId,
            },
          },
          create: prismaRow,
          update: {
            type: prismaRow.type,
            customerId: prismaRow.customerId,
            customerType: prismaRow.customerType,
            paymentProvider: prismaRow.paymentProvider,
            effectiveAt: prismaRow.effectiveAt,
            // Preserve original create time on conflict (re-runs / retries).
            entries: prismaRow.entries,
          },
        });
        upserted++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!options.continueOnError) {
          throw error;
        }
        failed++;
        failures.push({ tenancyId: row.tenancyId, txnId: row.txnId, message });
        log(`SKIPPED ${row.tenancyId},${row.txnId}: ${message}`);
      }
    }
    log(`page rows=${page.rows.length} upserted=${upserted} skipped=${skipped} failed=${failed} next_cursor=${page.next_cursor ?? "(done)"}`);
    if (page.next_cursor == null) break;
    // Same as backfillTable: a non-advancing cursor would re-fetch forever.
    if (page.next_cursor === cursor) {
      throw new Error(`Export cursor failed to advance at ${page.next_cursor}`);
    }
    cursor = page.next_cursor;
  }

  if (failures.length > 0) {
    throw new Error(
      `Export finished with ${failures.length} failure(s) (--continue-on-error). `
      + `First: ${failures[0].tenancyId},${failures[0].txnId}: ${failures[0].message}`,
    );
  }

  log(`Done upserted=${upserted} skipped=${skipped} elapsed=${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
  return { upserted, skipped, failed };
}

import.meta.vitest?.describe("parseExportManualTransactionsArgs", (test) => {
  const tenA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const tenB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  test("defaults with no flags", ({ expect }) => {
    expect(parseExportManualTransactionsArgs([])).toEqual({ continueOnError: false });
  });

  test("parses exclude / only and rejects combining them", ({ expect }) => {
    expect(parseExportManualTransactionsArgs([`--exclude-tenancy-ids=${tenA},${tenB}`])).toEqual({
      continueOnError: false,
      excludeTenancyIds: [tenA, tenB],
    });
    expect(parseExportManualTransactionsArgs([`--only-tenancy-ids=${tenA}`])).toEqual({
      continueOnError: false,
      onlyTenancyIds: [tenA],
    });
    expect(parseExportManualTransactionsArgs([`--only-tenancy-ids=${tenA.toUpperCase()}`])).toEqual({
      continueOnError: false,
      onlyTenancyIds: [tenA],
    });
    expect(() => parseExportManualTransactionsArgs([
      `--exclude-tenancy-ids=${tenA}`,
      `--only-tenancy-ids=${tenB}`,
    ])).toThrow("cannot combine --exclude-tenancy-ids and --only-tenancy-ids");
  });

  test("accepts --flag=value and --flag value; comma-separates multiple tenancy ids", ({ expect }) => {
    const tenC = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    // Both CLI forms; spaces around commas are trimmed.
    expect(parseExportManualTransactionsArgs([
      "--exclude-tenancy-ids",
      `${tenA}, ${tenB},${tenC}`,
    ])).toEqual({
      continueOnError: false,
      excludeTenancyIds: [tenA, tenB, tenC],
    });
    expect(parseExportManualTransactionsArgs([
      `--exclude-tenancy-ids=${tenA},${tenB}`,
      "--batch-size",
      "50",
    ])).toEqual({
      continueOnError: false,
      excludeTenancyIds: [tenA, tenB],
      batchSize: 50,
    });
  });

  test("rejects empty or invalid tenancy lists", ({ expect }) => {
    expect(() => parseExportManualTransactionsArgs(["--exclude-tenancy-ids="]))
      .toThrow("requires at least one tenancy UUID");
    expect(() => parseExportManualTransactionsArgs(["--only-tenancy-ids=nope"]))
      .toThrow('invalid tenancy UUID "nope"');
  });
});

import.meta.vitest?.describe("shouldKeepTenancy", (test) => {
  const tenA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const tenB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const tenC = "cccccccc-cccc-cccc-cccc-cccccccccccc";

  test("respects exclude/only filters", ({ expect }) => {
    expect(shouldKeepTenancy(tenA, { onlyTenancyIds: [tenA] })).toBe(true);
    expect(shouldKeepTenancy(tenB, { onlyTenancyIds: [tenA] })).toBe(false);
    expect(shouldKeepTenancy(tenA, { excludeTenancyIds: [tenA] })).toBe(false);
    expect(shouldKeepTenancy(tenB, { excludeTenancyIds: [tenA] })).toBe(true);
    expect(shouldKeepTenancy(tenA, {})).toBe(true);
  });

  test("excludes every id in a multi-tenancy exclude list", ({ expect }) => {
    const opts = { excludeTenancyIds: [tenA, tenB] };
    expect(shouldKeepTenancy(tenA, opts)).toBe(false);
    expect(shouldKeepTenancy(tenB, opts)).toBe(false);
    expect(shouldKeepTenancy(tenC, opts)).toBe(true);
  });
});

const isDirectRun = (process.argv[1] ?? "").endsWith("export-bulldozer-manual-transactions-to-prisma.ts")
  || (process.argv[1] ?? "").endsWith("export-bulldozer-manual-transactions-to-prisma.js");

if (isDirectRun) {
  try {
    await runExportBulldozerManualTransactionsToPrisma(parseExportManualTransactionsArgs(process.argv.slice(2)));
  } catch (error) {
    console.error("[ExportManualTransactions] FAILED", error);
    process.exitCode = 1;
  }
}
