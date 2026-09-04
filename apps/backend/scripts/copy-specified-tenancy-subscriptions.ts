/**
 * One-off: copy Subscription (+ related SubscriptionInvoice) rows for one
 * tenancy and a specified productId set from Prisma → bulldozer-js over HTTP
 * (same batch ingress as the main backfill). Writes land in Bulldozer stored
 * tables; cascades run on the server.
 *
 * Always runs both tables start→finish (Subscription, then invoices for those
 * productIds). Idempotent — re-run if it dies mid-way. No resume flags.
 *
 * Does NOT copy ItemQuantityChange / OTP / full ManualTransaction history.
 * Refunded matching subs still get a synthesized `<id>:refund` manual txn.
 *
 * Within each table, pages with keyset pagination:
 * `ORDER BY (tenancyId, id) ASC` + `WHERE (tenancyId, id) > last`.
 *
 * Usage:
 *   pnpm -C apps/backend exec dotenv -c production -- tsx scripts/copy-specified-tenancy-subscriptions.ts \
 *     --tenancy-id=<uuid> \
 *     --only-product-ids=team,growth \
 *     [--batch-size=50] \
 *     [--continue-on-error]
 *
 * Or: ... tsx scripts/db-migrations.ts copy-specified-tenancy-subscriptions ...
 */
import { Prisma } from "@/generated/prisma/client";
import {
  bulldozerWriteManualTransactions,
  bulldozerWriteSubscriptionInvoices,
  bulldozerWriteSubscriptions,
} from "@/lib/payments/bulldozer-dual-write";
import type { ManualTransactionRow } from "@/lib/payments/schema/types";
import { SUBSCRIPTION_START_PRODUCT_GRANT_ENTRY_INDEX } from "@/lib/payments/transaction-entry-indexes";
import { globalPrismaClient } from "@/prisma-client";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";

const DEFAULT_BATCH_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TableLabel = "Subscription" | "SubscriptionInvoice";
type Cursor = { tenancyId: string, id: string };
type PrismaReplica = ReturnType<typeof globalPrismaClient.$replica>;
type SubscriptionRow = Parameters<typeof bulldozerWriteSubscriptions>[0][number];
type SubscriptionInvoiceRow = Parameters<typeof bulldozerWriteSubscriptionInvoices>[0][number];

export type CopySpecifiedTenancySubscriptionsOptions = {
  tenancyId: string,
  productIds: string[],
  batchSize?: number,
  continueOnError?: boolean,
};

type Failure = { table: TableLabel, tenancyId: string, id: string, message: string };

function log(message: string) {
  console.log(`[CopySpecifiedTenancySubscriptions] ${message}`);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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

function parseProductIdList(raw: string): string[] {
  const ids = raw.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  if (ids.length === 0) {
    throw new Error("--only-product-ids requires at least one product id");
  }
  return ids;
}

function parseTenancyId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!UUID_RE.test(id)) {
    throw new Error(`--tenancy-id: invalid tenancy UUID "${raw}"`);
  }
  return id;
}

/**
 * Parses CLI argv. Requires --tenancy-id and --only-product-ids. Exported for tests.
 */
export function parseCopySpecifiedTenancySubscriptionsArgs(args: string[]): CopySpecifiedTenancySubscriptionsOptions {
  const continueOnError = args.includes("--continue-on-error");
  const tenancyRaw = readFlag(args, "tenancy-id");
  const productRaw = readFlag(args, "only-product-ids");
  if (tenancyRaw === undefined) {
    throw new Error("--tenancy-id is required");
  }
  if (productRaw === undefined) {
    throw new Error("--only-product-ids is required");
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
    tenancyId: parseTenancyId(tenancyRaw),
    productIds: parseProductIdList(productRaw),
    ...(batchSize !== undefined ? { batchSize } : {}),
  };
}

function readProductLineId(product: unknown): string | null {
  if (product == null || typeof product !== "object") return null;
  const lineId = product["productLineId"];
  return typeof lineId === "string" ? lineId : null;
}

function lowerCustomerType(customerType: string): "user" | "team" | "custom" {
  const lowered = customerType.toLowerCase();
  if (lowered === "user" || lowered === "team" || lowered === "custom") {
    return lowered;
  }
  throw new Error(`Invalid customer type: ${customerType}`);
}

/** Same `<id>:refund` shape as the main bulldozer backfill (duplicated on purpose). */
function buildRefundManualTransaction(row: SubscriptionRow): ManualTransactionRow {
  const refundedAt = row.refundedAt
    ?? throwErr("buildRefundManualTransaction called without refundedAt");
  const refundedAtMillis = refundedAt.getTime();
  const customerType = lowerCustomerType(row.customerType);
  return {
    txnId: `${row.id}:refund`,
    tenancyId: row.tenancyId,
    effectiveAtMillis: refundedAtMillis,
    type: "refund",
    entries: [{
      type: "product-revocation",
      customerType,
      customerId: row.customerId,
      adjustedTransactionId: `sub-start:${row.id}`,
      adjustedEntryIndex: SUBSCRIPTION_START_PRODUCT_GRANT_ENTRY_INDEX,
      quantity: row.quantity,
      productId: row.productId,
      productLineId: readProductLineId(row.product),
    }],
    customerType,
    customerId: row.customerId,
    paymentProvider: row.creationSource === "TEST_MODE" ? "test_mode" : "stripe",
    createdAtMillis: refundedAtMillis,
  };
}

function uuidIdCursorSql(cursor: Cursor | null): Prisma.Sql {
  if (cursor === null) return Prisma.empty;
  return Prisma.sql`AND ("tenancyId", "id") > (${cursor.tenancyId}::uuid, ${cursor.id}::uuid)`;
}

function productIdsSql(productIds: string[]): Prisma.Sql {
  return Prisma.join(productIds.map((id) => Prisma.sql`${id}`));
}

async function fetchSubscriptionBatch(
  replica: PrismaReplica,
  tenancyId: string,
  productIds: string[],
  cursor: Cursor | null,
  batchSize: number,
): Promise<SubscriptionRow[]> {
  return await replica.$queryRaw<SubscriptionRow[]>`
    SELECT
      "id",
      "tenancyId",
      "customerId",
      "customerType",
      "productId",
      "priceId",
      "product",
      "quantity",
      "stripeSubscriptionId",
      "status",
      "currentPeriodEnd",
      "currentPeriodStart",
      "cancelAtPeriodEnd",
      "canceledAt",
      "endedAt",
      "refundedAt",
      "productRevokedAt",
      "creationSource",
      "createdAt"
    FROM "Subscription"
    WHERE "tenancyId" = ${tenancyId}::uuid
      AND "productId" IN (${productIdsSql(productIds)})
      ${uuidIdCursorSql(cursor)}
    ORDER BY "tenancyId" ASC, "id" ASC
    LIMIT ${batchSize}
  `;
}

/** Invoices whose Stripe sub belongs to a matching subscription in this tenancy. */
async function fetchSubscriptionInvoiceBatch(
  replica: PrismaReplica,
  tenancyId: string,
  productIds: string[],
  cursor: Cursor | null,
  batchSize: number,
): Promise<SubscriptionInvoiceRow[]> {
  return await replica.$queryRaw<SubscriptionInvoiceRow[]>`
    SELECT
      si."id",
      si."tenancyId",
      si."stripeSubscriptionId",
      si."stripeInvoiceId",
      si."isSubscriptionCreationInvoice",
      si."status",
      si."amountTotal",
      si."hostedInvoiceUrl",
      si."createdAt"
    FROM "SubscriptionInvoice" si
    WHERE si."tenancyId" = ${tenancyId}::uuid
      AND EXISTS (
        SELECT 1
        FROM "Subscription" s
        WHERE s."tenancyId" = si."tenancyId"
          AND s."stripeSubscriptionId" = si."stripeSubscriptionId"
          AND s."productId" IN (${productIdsSql(productIds)})
      )
      ${cursor === null
        ? Prisma.empty
        : Prisma.sql`AND (si."tenancyId", si."id") > (${cursor.tenancyId}::uuid, ${cursor.id}::uuid)`}
    ORDER BY si."tenancyId" ASC, si."id" ASC
    LIMIT ${batchSize}
  `;
}

async function pageTable<T extends { tenancyId: string, id: string }>(options: {
  label: TableLabel,
  batchSize: number,
  continueOnError: boolean,
  failures: Failure[],
  fetchBatch: (cursor: Cursor | null) => Promise<T[]>,
  writeBatch: (rows: T[]) => Promise<void>,
}): Promise<void> {
  let cursor: Cursor | null = null;
  let batchNumber = 0;
  let total = 0;
  let failed = 0;
  const tableStartedAt = performance.now();
  log(`[${options.label}] starting`);

  for (;;) {
    const batch = await options.fetchBatch(cursor);
    if (batch.length === 0) break;

    try {
      await options.writeBatch(batch);
    } catch (error) {
      if (!options.continueOnError) throw error;
      for (const row of batch) {
        try {
          await options.writeBatch([row]);
        } catch (rowError) {
          const message = rowError instanceof Error ? rowError.message : String(rowError);
          options.failures.push({
            table: options.label,
            tenancyId: row.tenancyId,
            id: row.id,
            message,
          });
          failed++;
          log(`[${options.label}] SKIPPED row ${row.tenancyId},${row.id} after error: ${message}`);
        }
      }
    }

    total += batch.length;
    const last = batch[batch.length - 1];
    const next: Cursor = { tenancyId: last.tenancyId, id: last.id };
    // Fail loud if keyset does not advance — otherwise the loop spins forever.
    if (cursor !== null && next.tenancyId === cursor.tenancyId && next.id === cursor.id) {
      throw new Error(`[${options.label}] cursor failed to advance at ${next.tenancyId},${next.id}`);
    }
    cursor = next;
    batchNumber++;
    log(`[${options.label}] batch=${batchNumber} rows=${batch.length} total=${total}${failed > 0 ? ` failed=${failed}` : ""}`);
    if (batch.length < options.batchSize) break;
  }

  log(`[${options.label}] done total=${total}${failed > 0 ? ` failed=${failed}` : ""} elapsed=${formatDuration(performance.now() - tableStartedAt)}`);
}

export async function runCopySpecifiedTenancySubscriptions(
  options: CopySpecifiedTenancySubscriptionsOptions,
): Promise<void> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const { tenancyId, productIds } = options;
  const replica = globalPrismaClient.$replica();
  const failures: Failure[] = [];
  const runStartedAt = performance.now();
  const continueOnError = options.continueOnError ?? false;

  log(`Starting tenancy=${tenancyId} productIds=[${productIds.join(",")}] batchSize=${batchSize}`);

  await pageTable({
    label: "Subscription",
    batchSize,
    continueOnError,
    failures,
    fetchBatch: (cursor) => fetchSubscriptionBatch(replica, tenancyId, productIds, cursor, batchSize),
    writeBatch: async (subs) => {
      await bulldozerWriteSubscriptions(subs);
      const refunds = subs
        .filter((sub) => sub.refundedAt != null)
        .map((sub) => buildRefundManualTransaction(sub));
      await bulldozerWriteManualTransactions(refunds);
    },
  });

  await pageTable({
    label: "SubscriptionInvoice",
    batchSize,
    continueOnError,
    failures,
    fetchBatch: (cursor) => fetchSubscriptionInvoiceBatch(replica, tenancyId, productIds, cursor, batchSize),
    writeBatch: (invoices) => bulldozerWriteSubscriptionInvoices(invoices),
  });

  if (failures.length > 0) {
    const preview = failures
      .slice(0, 50)
      .map((f) => `  ${f.table} ${f.tenancyId},${f.id}: ${f.message}`)
      .join("\n");
    throw new Error(
      `copy-specified-tenancy-subscriptions finished with ${failures.length} un-ingestable row(s). Re-run after fixing:\n${preview}`,
    );
  }

  await wait(1500);
  log(`Done. elapsed=${formatDuration(performance.now() - runStartedAt)}`);
}

const isDirectRun = process.argv[1]?.includes("copy-specified-tenancy-subscriptions");
if (isDirectRun) {
  await runCopySpecifiedTenancySubscriptions(parseCopySpecifiedTenancySubscriptionsArgs(process.argv.slice(2)));
}

import.meta.vitest?.describe("parseCopySpecifiedTenancySubscriptionsArgs", (test) => {
  const ten = "AAAAAAAA-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  test("requires --tenancy-id and --only-product-ids", ({ expect }) => {
    expect(() => parseCopySpecifiedTenancySubscriptionsArgs([]))
      .toThrow("--tenancy-id is required");
    expect(() => parseCopySpecifiedTenancySubscriptionsArgs([`--tenancy-id=${ten}`]))
      .toThrow("--only-product-ids is required");
  });

  test("parses tenancy, product ids, batch size", ({ expect }) => {
    expect(parseCopySpecifiedTenancySubscriptionsArgs([
      `--tenancy-id=${ten}`,
      "--only-product-ids=team, growth",
      "--batch-size=25",
    ])).toEqual({
      continueOnError: false,
      tenancyId: ten.toLowerCase(),
      productIds: ["team", "growth"],
      batchSize: 25,
    });
  });

  test("rejects invalid tenancy / empty product list / bad batch size", ({ expect }) => {
    expect(() => parseCopySpecifiedTenancySubscriptionsArgs([
      "--tenancy-id=nope",
      "--only-product-ids=team",
    ])).toThrow("invalid tenancy UUID");
    expect(() => parseCopySpecifiedTenancySubscriptionsArgs([
      `--tenancy-id=${ten}`,
      "--only-product-ids=",
    ])).toThrow("requires at least one product id");
    expect(() => parseCopySpecifiedTenancySubscriptionsArgs([
      `--tenancy-id=${ten}`,
      "--only-product-ids=team",
      "--batch-size=0",
    ])).toThrow("positive integer");
  });
});
