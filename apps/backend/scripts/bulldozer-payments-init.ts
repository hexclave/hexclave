/**
 * One-way backfill of the payment tables from Postgres into bulldozer-js.
 *
 * It pages each table out of Postgres (via the read replica) and POSTs each
 * page into bulldozer-js through the batch ingress routes, which apply the whole
 * page in one snapshot write + one downstream cascade (far cheaper than one
 * cascade per row). There is no read-back / compare / fingerprint: bulldozer-js
 * stores each row under its `id` (or `txnId` for ManualTransaction) and the
 * write is idempotent, so overwriting unconditionally is correct and the whole
 * script is safe to re-run (it just re-converges).
 *
 * Resume (only needed for huge tables that crashed mid-way):
 *   Rows are walked in ascending sort order — Postgres
 *   `ORDER BY "tenancyId" ASC, "id" ASC` (for ManualTransaction, `"txnId"`
 *   instead of `"id"`). For UUIDs/text that means dictionary order
 *   (0-9 then a-f…), not “smallest by size.”
 *   Each batch log prints `cursor=<tenancyId>,<id>` for the LAST row that
 *   batch finished. Everything at-or-before that cursor (in that same order,
 *   under the same tenancy filters) has already been written. To continue,
 *   copy that exact cursor from the log — do not invent one. Use the same
 *   --only-tenancy-ids / --exclude-tenancy-ids as the run that printed it.
 *   The cursor only advances after the batch write succeeds, so resuming from
 *   the last logged cursor may re-do that last batch (safe) but will not skip
 *   unwritten rows.
 *
 * Tenancy filters (optional; pick at most one):
 *   (omit both)                   copy every tenancy
 *   --only-tenancy-ids=...        copy JUST these tenancies
 *   --exclude-tenancy-ids=...     copy everyone EXCEPT these
 */

import { Prisma } from "@/generated/prisma/client";
import {
  bulldozerWriteItemQuantityChanges,
  bulldozerWriteManualTransactions,
  bulldozerWriteOneTimePurchases,
  bulldozerWriteSubscriptionInvoices,
  bulldozerWriteSubscriptions,
  prismaManualTransactionToBulldozerRow,
} from "@/lib/payments/bulldozer-dual-write";
import type { CustomerType, ManualTransactionRow } from "@/lib/payments/schema/types";
import {
  ONE_TIME_PURCHASE_PRODUCT_GRANT_ENTRY_INDEX,
  SUBSCRIPTION_START_PRODUCT_GRANT_ENTRY_INDEX,
} from "@/lib/payments/transaction-entry-indexes";
import { globalPrismaClient } from "@/prisma-client";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";

const DEFAULT_BATCH_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type PrismaReplica = ReturnType<typeof globalPrismaClient.$replica>;
type SubscriptionBackfillRow = Parameters<typeof bulldozerWriteSubscriptions>[0][number];
type SubscriptionInvoiceBackfillRow = Parameters<typeof bulldozerWriteSubscriptionInvoices>[0][number];
type OneTimePurchaseBackfillRow = Parameters<typeof bulldozerWriteOneTimePurchases>[0][number];
type ItemQuantityChangeBackfillRow = Parameters<typeof bulldozerWriteItemQuantityChanges>[0][number];
type ManualTransactionPrismaRow = {
  tenancyId: string,
  txnId: string,
  type: string,
  customerId: string,
  customerType: string,
  paymentProvider: string | null,
  effectiveAt: Date,
  createdAt: Date,
  entries: unknown,
};
/** Cursor uses `id` = txnId so the shared pagination loop stays homogeneous. */
type ManualTransactionBackfillRow = ManualTransactionPrismaRow & { id: string };

// Fixed processing order. Resume positions are interpreted against this list.
// ManualTransaction is last so refund targets (subs/OTPs) exist before refunds land.
export const BACKFILL_TABLES = [
  "Subscription",
  "SubscriptionInvoice",
  "OneTimePurchase",
  "ItemQuantityChange",
  "ManualTransaction",
] as const;
export type BackfillTableName = (typeof BACKFILL_TABLES)[number];

type Cursor = { tenancyId: string, id: string };

export type TenancyIdFilter =
  | { mode: "exclude", tenancyIds: string[] }
  | { mode: "only", tenancyIds: string[] };

export type BackfillResumeOptions = {
  resumeTable?: BackfillTableName,
  resumeCursor?: Cursor,
  // When true, a row that bulldozer-js rejects is recorded and skipped instead
  // of aborting the run; the whole run still throws loudly at the end with the
  // full list. Lets a single poison row not block a large migration, without
  // silently dropping it. Default (false) is fail-fast on the first bad row.
  continueOnError?: boolean,
  // Number of rows to page per keyset query and per bulldozer-js batch POST.
  // Larger values reduce round-trips but increase per-batch memory/latency and
  // the amount of work redone if a batch fails mid-run. Defaults to
  // DEFAULT_BATCH_SIZE when omitted.
  batchSize?: number,
  tenancyFilter?: TenancyIdFilter,
};

/** A row bulldozer-js refused, captured under --continue-on-error. */
type BackfillFailure = { table: BackfillTableName, tenancyId: string, id: string, message: string };

/** Per-run state threaded into each table's pagination loop. */
type BackfillRunContext = {
  continueOnError: boolean,
  recordFailure: (failure: BackfillFailure) => void,
  batchSize: number,
};

function log(message: string) {
  console.log(`[BulldozerBackfill] ${message}`);
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function lowerCustomerType(customerType: string): CustomerType {
  const lowered = customerType.toLowerCase();
  if (lowered === "user" || lowered === "team" || lowered === "custom") {
    return lowered;
  }
  throw new Error(`Invalid customer type while backfilling bulldozer: ${customerType}`);
}

function readProductLineId(product: unknown): string | null {
  if (typeof product !== "object" || product === null || Array.isArray(product)) {
    return null;
  }
  const productLineId = product["productLineId"];
  return typeof productLineId === "string" ? productLineId : null;
}

/**
 * Legacy refund synthesis. Rows with a `refundedAt` predate the manual-
 * transaction refund ledger (the current refund route no longer sets
 * `refundedAt`), so bulldozer has no refund row for them. We mint a stable
 * one: a `refund` manual transaction carrying a single product-revocation
 * entry pointing at the source purchase's product grant.
 *
 * The id is deterministic (`<rowId>:refund`) so re-running upserts the same row
 * rather than duplicating it. The adjustedEntryIndex uses the current bulldozer
 * entry-index constants (0), NOT the old bulldozer-server value (1) — the entry
 * layout changed in the rework, and these are the indexes the live refund route
 * writes against today.
 */
function buildBackfilledRefundManualTransaction(options: {
  row: {
    id: string,
    tenancyId: string,
    customerId: string,
    customerType: string,
    productId: string | null,
    product: unknown,
    quantity: number,
    creationSource: string,
    refundedAt: Date | null,
  },
  sourceKind: "subscription" | "one-time-purchase",
}): { txnId: string, rowData: ManualTransactionRow } {
  const refundedAt = options.row.refundedAt
    ?? throwErr("buildBackfilledRefundManualTransaction called for a row without refundedAt");
  const refundedAtMillis = refundedAt.getTime();
  const customerType = lowerCustomerType(options.row.customerType);
  const adjustedTransactionId = options.sourceKind === "subscription"
    ? `sub-start:${options.row.id}`
    : `otp:${options.row.id}`;
  const adjustedEntryIndex = options.sourceKind === "subscription"
    ? SUBSCRIPTION_START_PRODUCT_GRANT_ENTRY_INDEX
    : ONE_TIME_PURCHASE_PRODUCT_GRANT_ENTRY_INDEX;
  const txnId = `${options.row.id}:refund`;
  return {
    txnId,
    rowData: {
      txnId,
      tenancyId: options.row.tenancyId,
      effectiveAtMillis: refundedAtMillis,
      type: "refund",
      entries: [{
        type: "product-revocation",
        customerType,
        customerId: options.row.customerId,
        adjustedTransactionId,
        adjustedEntryIndex,
        quantity: options.row.quantity,
        productId: options.row.productId,
        productLineId: readProductLineId(options.row.product),
      }],
      customerType,
      customerId: options.row.customerId,
      paymentProvider: options.row.creationSource === "TEST_MODE" ? "test_mode" : "stripe",
      createdAtMillis: refundedAtMillis,
      renewalTargetSubscriptionId: null,
    },
  };
}

/**
 * One table the backfill knows how to process: its name (for resume/logging)
 * and a `run` that pages it from a given start cursor. `makeTable` captures the
 * per-table Prisma row type `T` in the closure, so the orchestrator can hold a
 * homogeneous `BackfillTable[]` despite each Prisma delegate being typed
 * differently.
 */
type BackfillTable = {
  name: BackfillTableName,
  run: (startCursor: Cursor | null, ctx: BackfillRunContext) => Promise<void>,
};

function makeTable<T extends Cursor>(
  name: BackfillTableName,
  fetchBatch: (cursor: Cursor | null) => Promise<T[]>,
  writeBatch: (rows: T[]) => Promise<void>,
): BackfillTable {
  return { name, run: (startCursor, ctx) => backfillTable(name, startCursor, fetchBatch, writeBatch, ctx) };
}

/**
 * Pages a single table and writes every row through the batch ingress path.
 * Confirm-then-advance: the cursor (and the progress log) only moves after the
 * whole page's write is awaited, so a mid-run failure leaves the last logged
 * cursor pointing at the previous batch's end — never past an unconfirmed row.
 *
 * Under --continue-on-error a failed page is retried one row at a time so a
 * single poison row can be isolated and skipped without losing the rest of the
 * page; writes are idempotent, so re-posting the good rows is harmless.
 */
async function backfillTable<T extends Cursor>(
  label: BackfillTableName,
  startCursor: Cursor | null,
  fetchBatch: (cursor: Cursor | null) => Promise<T[]>,
  writeBatch: (rows: T[]) => Promise<void>,
  ctx: BackfillRunContext,
): Promise<void> {
  let cursor = startCursor;
  let batchNumber = 0;
  let total = 0;
  let failed = 0;
  // Aggregate the bulldozer request time (the write/POST phase) across the whole
  // table so we can report an average per batch at the end — this is the number
  // we care about in a backfill load test (the Prisma fetch is local + cheap).
  let totalReqMs = 0;
  const tableStartedAt = performance.now();
  log(`[${label}] starting${cursor ? ` from cursor ${cursor.tenancyId},${cursor.id}` : ""}`);

  for (;;) {
    const fetchStartedAt = performance.now();
    const batch = await fetchBatch(cursor);
    const fetchMs = performance.now() - fetchStartedAt;
    if (batch.length === 0) break;
    const fetchDoneAt = performance.now();

    // Time only the bulldozer write (the HTTP batch request[s]), isolated from
    // the Prisma read above. Under --continue-on-error the per-row retry writes
    // are part of the same request phase, so they're included here on purpose.
    const reqStartedAt = performance.now();
    try {
      await writeBatch(batch);
    } catch (error) {
      // Default is fail-fast. Under --continue-on-error we re-send the page row
      // by row to find the poison row(s): the good rows go through the normal
      // (idempotent) write and the bad ones are recorded + logged loudly, then
      // re-thrown as a set at the end of the run — never silently swallowed.
      if (!ctx.continueOnError) throw error;
      for (const row of batch) {
        try {
          await writeBatch([row]);
        } catch (rowError) {
          const message = rowError instanceof Error ? rowError.message : String(rowError);
          ctx.recordFailure({ table: label, tenancyId: row.tenancyId, id: row.id, message });
          failed++;
          log(`[${label}] SKIPPED row ${row.tenancyId},${row.id} after error: ${message}`);
        }
      }
    }
    const reqMs = performance.now() - reqStartedAt;
    totalReqMs += reqMs;
    total += batch.length;
    const writeDoneAt = performance.now();

    const last = batch[batch.length - 1];
    const next: Cursor = { tenancyId: last.tenancyId, id: last.id };
    // Keyset pagination must strictly advance (each page's last row is > cursor).
    // If it ever didn't — e.g. a non-unique sort key slipped in — we'd re-read
    // the same page forever, so fail loud instead of spinning. This guard is
    // what makes the unbounded loop above safe.
    if (cursor !== null && next.tenancyId === cursor.tenancyId && next.id === cursor.id) {
      throw new Error(`[${label}] backfill cursor failed to advance at ${next.tenancyId},${next.id}`);
    }

    cursor = next;
    batchNumber++;
    const allDoneAt = performance.now();
    log(`[${label}] batch=${batchNumber} duration=(r:${formatDuration(fetchMs)} w:${formatDuration(writeDoneAt - fetchDoneAt)} t:${formatDuration(allDoneAt - fetchStartedAt)} rows=${batch.length} total=${total}${failed > 0 ? ` failed=${failed}` : ""} cursor=${cursor.tenancyId},${cursor.id}`);

    // A short page means we've hit the end; skip the extra empty fetch.
    if (batch.length < ctx.batchSize) break;
  }

  const tableElapsedMs = performance.now() - tableStartedAt;
  const avgReqMs = batchNumber > 0 ? totalReqMs / batchNumber : 0;
  log(`[${label}] done total=${total}${failed > 0 ? ` failed=${failed}` : ""} elapsed=${formatDuration(tableElapsedMs)} bulldozerReqTotal=${formatDuration(totalReqMs)} avgReq/batch=${formatDuration(avgReqMs)}`);
}

/** SQL fragment for tenancy filters. Empty when copying all tenancies. */
function tenancyFilterSql(filter: TenancyIdFilter | undefined): Prisma.Sql {
  if (filter === undefined) return Prisma.empty;
  const list = Prisma.join(filter.tenancyIds.map((id) => Prisma.sql`${id}::uuid`));
  // "only" = JUST these tenancies. "exclude" = everyone except these.
  return filter.mode === "exclude"
    ? Prisma.sql`AND "tenancyId" NOT IN (${list})`
    : Prisma.sql`AND "tenancyId" IN (${list})`;
}

/** Keyset predicate for UUID primary-key tables ordered by (tenancyId, id). */
function uuidIdCursorSql(cursor: Cursor | null): Prisma.Sql {
  if (cursor === null) return Prisma.empty;
  return Prisma.sql`AND ("tenancyId", "id") > (${cursor.tenancyId}::uuid, ${cursor.id}::uuid)`;
}

/**
 * Keyset predicate for ManualTransaction. That table's primary key is
 * (tenancyId, txnId) — there is no UUID `id` column — so Cursor.id holds txnId
 * and we compare against "txnId" in SQL. Same resume flag shape as other tables
 * (`--resume-cursor=<tenancyId>,<id>`), just with id meaning txnId here.
 */
function txnIdCursorSql(cursor: Cursor | null): Prisma.Sql {
  if (cursor === null) return Prisma.empty;
  return Prisma.sql`AND ("tenancyId", "txnId") > (${cursor.tenancyId}::uuid, ${cursor.id})`;
}

async function fetchSubscriptionBatch(
  replica: PrismaReplica,
  cursor: Cursor | null,
  batchSize: number,
  tenancyFilter: TenancyIdFilter | undefined,
): Promise<SubscriptionBackfillRow[]> {
  return await replica.$queryRaw<SubscriptionBackfillRow[]>`
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
    WHERE TRUE
    ${tenancyFilterSql(tenancyFilter)}
    ${uuidIdCursorSql(cursor)}
    ORDER BY "tenancyId" ASC, "id" ASC
    LIMIT ${batchSize}
  `;
}

async function fetchSubscriptionInvoiceBatch(
  replica: PrismaReplica,
  cursor: Cursor | null,
  batchSize: number,
  tenancyFilter: TenancyIdFilter | undefined,
): Promise<SubscriptionInvoiceBackfillRow[]> {
  return await replica.$queryRaw<SubscriptionInvoiceBackfillRow[]>`
    SELECT
      "id",
      "tenancyId",
      "stripeSubscriptionId",
      "stripeInvoiceId",
      "isSubscriptionCreationInvoice",
      "status",
      "amountTotal",
      "hostedInvoiceUrl",
      "createdAt"
    FROM "SubscriptionInvoice"
    WHERE TRUE
    ${tenancyFilterSql(tenancyFilter)}
    ${uuidIdCursorSql(cursor)}
    ORDER BY "tenancyId" ASC, "id" ASC
    LIMIT ${batchSize}
  `;
}

async function fetchOneTimePurchaseBatch(
  replica: PrismaReplica,
  cursor: Cursor | null,
  batchSize: number,
  tenancyFilter: TenancyIdFilter | undefined,
): Promise<OneTimePurchaseBackfillRow[]> {
  return await replica.$queryRaw<OneTimePurchaseBackfillRow[]>`
    SELECT
      "id",
      "tenancyId",
      "customerId",
      "customerType",
      "productId",
      "priceId",
      "product",
      "quantity",
      "stripePaymentIntentId",
      "revokedAt",
      "refundedAt",
      "creationSource",
      "createdAt"
    FROM "OneTimePurchase"
    WHERE TRUE
    ${tenancyFilterSql(tenancyFilter)}
    ${uuidIdCursorSql(cursor)}
    ORDER BY "tenancyId" ASC, "id" ASC
    LIMIT ${batchSize}
  `;
}

async function fetchItemQuantityChangeBatch(
  replica: PrismaReplica,
  cursor: Cursor | null,
  batchSize: number,
  tenancyFilter: TenancyIdFilter | undefined,
): Promise<ItemQuantityChangeBackfillRow[]> {
  return await replica.$queryRaw<ItemQuantityChangeBackfillRow[]>`
    SELECT
      "id",
      "tenancyId",
      "customerId",
      "customerType",
      "itemId",
      "quantity",
      "description",
      "expiresAt",
      "createdAt"
    FROM "ItemQuantityChange"
    WHERE TRUE
    ${tenancyFilterSql(tenancyFilter)}
    ${uuidIdCursorSql(cursor)}
    ORDER BY "tenancyId" ASC, "id" ASC
    LIMIT ${batchSize}
  `;
}

async function fetchManualTransactionBatch(
  replica: PrismaReplica,
  cursor: Cursor | null,
  batchSize: number,
  tenancyFilter: TenancyIdFilter | undefined,
): Promise<ManualTransactionBackfillRow[]> {
  const rows = await replica.$queryRaw<ManualTransactionPrismaRow[]>`
    SELECT
      "tenancyId",
      "txnId",
      "type",
      "customerId",
      "customerType",
      "paymentProvider",
      "effectiveAt",
      "createdAt",
      "entries"
    FROM "ManualTransaction"
    WHERE TRUE
    ${tenancyFilterSql(tenancyFilter)}
    ${txnIdCursorSql(cursor)}
    ORDER BY "tenancyId" ASC, "txnId" ASC
    LIMIT ${batchSize}
  `;
  // Homogenize with other tables: Cursor.id is txnId for resume logs / keyset.
  return rows.map((row) => ({ ...row, id: row.txnId }));
}

/** Tables before `resumeTable` are treated as already done; the rest run. */
function shouldRunTable(table: BackfillTableName, resumeTable: BackfillTableName | undefined): boolean {
  if (resumeTable === undefined) return true;
  return BACKFILL_TABLES.indexOf(table) >= BACKFILL_TABLES.indexOf(resumeTable);
}

/** The start cursor for a table: the resume cursor only applies to the resume table. */
function startCursorFor(table: BackfillTableName, options: BackfillResumeOptions): Cursor | null {
  return table === options.resumeTable ? options.resumeCursor ?? null : null;
}

/**
 * Resume cursors are "everything after this (tenancyId, id) in sort order".
 * If that tenancy is outside the active filter, continuing would quietly skip
 * (or empty-out) rows the user still wanted — fail loud instead.
 */
function assertResumeCursorMatchesTenancyFilter(
  cursor: Cursor | undefined,
  filter: TenancyIdFilter | undefined,
): void {
  if (cursor === undefined || filter === undefined) return;
  if (filter.mode === "exclude" && filter.tenancyIds.includes(cursor.tenancyId)) {
    throw new Error(
      `--resume-cursor tenancy ${cursor.tenancyId} is on --exclude-tenancy-ids. `
      + `Paste a cursor from a run that used the same filters (or drop the exclude). `
      + `Otherwise rows before that cursor in sort order can be skipped.`,
    );
  }
  if (filter.mode === "only" && !filter.tenancyIds.includes(cursor.tenancyId)) {
    throw new Error(
      `--resume-cursor tenancy ${cursor.tenancyId} is not on --only-tenancy-ids. `
      + `Paste a cursor from a run that used the same filters (or fix the only-list). `
      + `Otherwise this run can finish with nothing left to copy.`,
    );
  }
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
  // Postgres uuid + logged cursors are lowercase; keep membership checks case-stable.
  return ids.map((id) => id.toLowerCase());
}

/**
 * Reads `--name=value` or `--name value`. Missing value fails loud so we never
 * silently fall back to a default.
 */
function readFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const eq = args.find((arg) => arg.startsWith(prefix));
  if (eq !== undefined) return eq.slice(prefix.length);
  const bareIndex = args.indexOf(`--${name}`);
  if (bareIndex === -1) return undefined;
  if (bareIndex + 1 >= args.length || args[bareIndex + 1]!.startsWith("--")) {
    throw new Error(`--${name} requires a value, e.g. --${name}=... or --${name} ...`);
  }
  return args[bareIndex + 1];
}

/** Plain-English description of which tenancies this run will touch. */
function describeTenancyFilter(filter: TenancyIdFilter | undefined): string {
  if (filter === undefined) return "all tenancies";
  const ids = filter.tenancyIds.join(", ");
  if (filter.mode === "only") {
    // --only-tenancy-ids means: copy JUST these tenancies, skip everyone else.
    return `just these tenancies: ${ids}`;
  }
  // --exclude-tenancy-ids means: copy everyone EXCEPT these.
  return `all tenancies except: ${ids}`;
}

/**
 * Parses the optional flags from a raw argv list:
 *   --resume-table=<TableName>  --resume-cursor=<tenancyId>,<id>
 *   --exclude-tenancy-ids=<uuid,uuid> | --only-tenancy-ids=<uuid,uuid>
 * All value flags accept both `--flag=value` and `--flag value`.
 * Lives here (not in the CLI entrypoint) so it's testable without importing the
 * db-migrations entrypoint, which runs `main()` on import.
 */
export function parseBackfillResumeOptions(args: string[]): BackfillResumeOptions {
  const continueOnError = args.includes("--continue-on-error");

  const batchSizeArg = readFlag(args, "batch-size");
  let batchSize: number | undefined = undefined;
  if (batchSizeArg !== undefined) {
    const parsed = Number(batchSizeArg);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`--batch-size must be a positive integer (got "${batchSizeArg}")`);
    }
    batchSize = parsed;
  }

  const excludeTenancyIdsRaw = readFlag(args, "exclude-tenancy-ids");
  const onlyTenancyIdsRaw = readFlag(args, "only-tenancy-ids");
  if (excludeTenancyIdsRaw !== undefined && onlyTenancyIdsRaw !== undefined) {
    throw new Error("cannot combine --exclude-tenancy-ids and --only-tenancy-ids");
  }
  let tenancyFilter: TenancyIdFilter | undefined = undefined;
  if (excludeTenancyIdsRaw !== undefined) {
    tenancyFilter = { mode: "exclude", tenancyIds: parseTenancyIdList(excludeTenancyIdsRaw, "--exclude-tenancy-ids") };
  } else if (onlyTenancyIdsRaw !== undefined) {
    tenancyFilter = { mode: "only", tenancyIds: parseTenancyIdList(onlyTenancyIdsRaw, "--only-tenancy-ids") };
  }

  // Common options that apply regardless of whether a resume cursor was passed.
  const base: BackfillResumeOptions = {
    continueOnError,
    ...(batchSize !== undefined ? { batchSize } : {}),
    ...(tenancyFilter !== undefined ? { tenancyFilter } : {}),
  };

  const resumeTableArg = readFlag(args, "resume-table");
  const resumeCursorArg = readFlag(args, "resume-cursor");
  if (resumeTableArg === undefined && resumeCursorArg === undefined) {
    return base;
  }
  if (resumeTableArg === undefined) {
    throw new Error("--resume-cursor requires --resume-table");
  }
  const resumeTable = BACKFILL_TABLES.find((table) => table === resumeTableArg);
  if (resumeTable === undefined) {
    throw new Error(`--resume-table must be one of: ${BACKFILL_TABLES.join(", ")}`);
  }
  if (resumeCursorArg === undefined) {
    return { ...base, resumeTable };
  }
  const commaIndex = resumeCursorArg.indexOf(",");
  const tenancyId = commaIndex === -1 ? "" : resumeCursorArg.slice(0, commaIndex);
  const id = commaIndex === -1 ? "" : resumeCursorArg.slice(commaIndex + 1);
  if (tenancyId.length === 0 || id.length === 0) {
    throw new Error("--resume-cursor must be in the form <tenancyId>,<id>");
  }
  // Normalize tenancy UUID casing to match --only/--exclude parsing.
  const resumeCursor = { tenancyId: tenancyId.toLowerCase(), id };
  assertResumeCursorMatchesTenancyFilter(resumeCursor, tenancyFilter);
  return { ...base, resumeTable, resumeCursor };
}

const MAX_FAILURE_PREVIEW = 50;

/** Renders the collected --continue-on-error failures into one loud message. */
function formatBackfillFailures(failures: BackfillFailure[]): string {
  const preview = failures
    .slice(0, MAX_FAILURE_PREVIEW)
    .map((f) => `  ${f.table} ${f.tenancyId},${f.id}: ${f.message}`)
    .join("\n");
  const overflow = failures.length > MAX_FAILURE_PREVIEW
    ? `\n  ...and ${failures.length - MAX_FAILURE_PREVIEW} more`
    : "";
  return `Backfill finished with ${failures.length} un-ingestable row(s) (--continue-on-error). `
    + `Fix these rows and re-run (writes are idempotent):\n${preview}${overflow}`;
}

export async function runBulldozerPaymentsInit(options: BackfillResumeOptions = {}) {
  const replica = globalPrismaClient.$replica();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const tenancyFilter = options.tenancyFilter;
  assertResumeCursorMatchesTenancyFilter(options.resumeCursor, tenancyFilter);
  const runStartedAt = performance.now();
  log(`Backfilling bulldozer-js from Prisma... (batchSize=${batchSize}, ${describeTenancyFilter(tenancyFilter)})`);

  const tables: BackfillTable[] = [
    makeTable(
      "Subscription",
      (cursor) => fetchSubscriptionBatch(replica, cursor, batchSize, tenancyFilter),
      async (subs) => {
        await bulldozerWriteSubscriptions(subs);
        // Synthesize refund transactions for the refunded rows in this page and
        // send them as their own batch (idempotent, keyed by `<id>:refund`).
        const refunds = subs
          .filter((sub) => sub.refundedAt != null)
          .map((sub) => buildBackfilledRefundManualTransaction({ row: sub, sourceKind: "subscription" }).rowData);
        await bulldozerWriteManualTransactions(refunds);
      },
    ),
    makeTable(
      "SubscriptionInvoice",
      (cursor) => fetchSubscriptionInvoiceBatch(replica, cursor, batchSize, tenancyFilter),
      (invoices) => bulldozerWriteSubscriptionInvoices(invoices),
    ),
    makeTable(
      "OneTimePurchase",
      (cursor) => fetchOneTimePurchaseBatch(replica, cursor, batchSize, tenancyFilter),
      async (purchases) => {
        await bulldozerWriteOneTimePurchases(purchases);
        const refunds = purchases
          .filter((purchase) => purchase.refundedAt != null)
          .map((purchase) => buildBackfilledRefundManualTransaction({ row: purchase, sourceKind: "one-time-purchase" }).rowData);
        await bulldozerWriteManualTransactions(refunds);
      },
    ),
    makeTable(
      "ItemQuantityChange",
      (cursor) => fetchItemQuantityChangeBatch(replica, cursor, batchSize, tenancyFilter),
      (changes) => bulldozerWriteItemQuantityChanges(changes),
    ),
    makeTable(
      "ManualTransaction",
      (cursor) => fetchManualTransactionBatch(replica, cursor, batchSize, tenancyFilter),
      (rows) => bulldozerWriteManualTransactions(rows.map(prismaManualTransactionToBulldozerRow)),
    ),
  ];

  // Resume positions are interpreted against BACKFILL_TABLES, so the descriptor
  // list above must stay in the same order. Fail loud if they drift.
  if (tables.length !== BACKFILL_TABLES.length || tables.some((t, i) => t.name !== BACKFILL_TABLES[i])) {
    throw new Error("backfill table descriptors are out of sync with BACKFILL_TABLES");
  }

  const failures: BackfillFailure[] = [];
  const ctx: BackfillRunContext = {
    continueOnError: options.continueOnError ?? false,
    recordFailure: (failure) => failures.push(failure),
    batchSize,
  };

  for (const table of tables) {
    if (!shouldRunTable(table.name, options.resumeTable)) continue;
    await table.run(startCursorFor(table.name, options), ctx);
  }

  const processingElapsedMs = performance.now() - runStartedAt;
  log(`All tables processed in ${formatDuration(processingElapsedMs)} (excludes the final ~1.5s tick settle wait below).`);

  // Under --continue-on-error we deferred bad rows to here; surface them loudly
  // so the run is never quietly "complete" with data missing. Re-running after
  // fixing the offending rows re-converges (writes are idempotent).
  if (failures.length > 0) {
    throw new Error(formatBackfillFailures(failures));
  }

  // Stored->derived cascades run synchronously inside each POST, but timefold
  // repeats/expiries only materialize on bulldozer-js's 1s tick loop. Wait one
  // tick interval (plus slack) so a consumer script that runs shortly after
  // sees materialized entitlements. This is a deliberate, slightly-racy choice;
  // a deterministic tick-to-now endpoint would be the upgrade if it ever bites.
  await wait(1500);

  const totalElapsedMs = performance.now() - runStartedAt;
  log(`Backfill complete. Total wall time: ${formatDuration(totalElapsedMs)}.`);
}

import.meta.vitest?.describe("parseBackfillResumeOptions", (test) => {
  test("returns continueOnError=false when no flags are passed", ({ expect }) => {
    expect(parseBackfillResumeOptions([])).toEqual({ continueOnError: false });
    expect(parseBackfillResumeOptions(["backfill-bulldozer-from-prisma"])).toEqual({ continueOnError: false });
  });

  test("rejects --resume-cursor without --resume-table", ({ expect }) => {
    expect(() => parseBackfillResumeOptions(["--resume-cursor=t1,i1"]))
      .toThrow("--resume-cursor requires --resume-table");
  });

  test("rejects an unknown --resume-table", ({ expect }) => {
    expect(() => parseBackfillResumeOptions(["--resume-table=Bogus"]))
      .toThrow("--resume-table must be one of");
  });

  test("accepts --resume-table on its own (restart that table from the top)", ({ expect }) => {
    expect(parseBackfillResumeOptions(["--resume-table=OneTimePurchase"]))
      .toEqual({ resumeTable: "OneTimePurchase", continueOnError: false });
  });

  test("parses --resume-table with a --resume-cursor", ({ expect }) => {
    expect(parseBackfillResumeOptions(["--resume-table=Subscription", "--resume-cursor=ten-1,sub-9"]))
      .toEqual({ resumeTable: "Subscription", resumeCursor: { tenancyId: "ten-1", id: "sub-9" }, continueOnError: false });
  });

  test("rejects a --resume-cursor without a comma separator", ({ expect }) => {
    expect(() => parseBackfillResumeOptions(["--resume-table=Subscription", "--resume-cursor=nocommahere"]))
      .toThrow("--resume-cursor must be in the form <tenancyId>,<id>");
  });

  test("parses --continue-on-error on its own", ({ expect }) => {
    expect(parseBackfillResumeOptions(["--continue-on-error"])).toEqual({ continueOnError: true });
  });

  test("parses --continue-on-error alongside resume flags", ({ expect }) => {
    expect(parseBackfillResumeOptions(["--resume-table=OneTimePurchase", "--continue-on-error"]))
      .toEqual({ resumeTable: "OneTimePurchase", continueOnError: true });
  });

  test("omits batchSize when --batch-size is not passed (defaults later)", ({ expect }) => {
    expect(parseBackfillResumeOptions([])).not.toHaveProperty("batchSize");
  });

  test("parses --batch-size on its own", ({ expect }) => {
    expect(parseBackfillResumeOptions(["--batch-size=1000"]))
      .toEqual({ continueOnError: false, batchSize: 1000 });
  });

  test("parses the space form --batch-size 100 (two argv tokens)", ({ expect }) => {
    expect(parseBackfillResumeOptions(["--batch-size", "100"]))
      .toEqual({ continueOnError: false, batchSize: 100 });
    // ...including after the command token, as it arrives via the CLI.
    expect(parseBackfillResumeOptions(["backfill-bulldozer-from-prisma", "--batch-size", "100"]))
      .toEqual({ continueOnError: false, batchSize: 100 });
  });

  test("throws (never silently defaults) when --batch-size has no value", ({ expect }) => {
    expect(() => parseBackfillResumeOptions(["--batch-size"]))
      .toThrow("--batch-size requires a value");
    // A following flag is not a value → still fail loud.
    expect(() => parseBackfillResumeOptions(["--batch-size", "--continue-on-error"]))
      .toThrow("--batch-size requires a value");
  });

  test("parses --batch-size alongside resume flags", ({ expect }) => {
    expect(parseBackfillResumeOptions(["--resume-table=Subscription", "--resume-cursor=ten-1,sub-9", "--batch-size=250"]))
      .toEqual({
        resumeTable: "Subscription",
        resumeCursor: { tenancyId: "ten-1", id: "sub-9" },
        continueOnError: false,
        batchSize: 250,
      });
  });

  test("rejects a non-positive or non-integer --batch-size", ({ expect }) => {
    expect(() => parseBackfillResumeOptions(["--batch-size=0"]))
      .toThrow("--batch-size must be a positive integer");
    expect(() => parseBackfillResumeOptions(["--batch-size=-5"]))
      .toThrow("--batch-size must be a positive integer");
    expect(() => parseBackfillResumeOptions(["--batch-size=abc"]))
      .toThrow("--batch-size must be a positive integer");
    expect(() => parseBackfillResumeOptions(["--batch-size=1.5"]))
      .toThrow("--batch-size must be a positive integer");
  });

  test("parses --exclude-tenancy-ids", ({ expect }) => {
    expect(parseBackfillResumeOptions([
      "--exclude-tenancy-ids=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa,bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    ])).toEqual({
      continueOnError: false,
      tenancyFilter: {
        mode: "exclude",
        tenancyIds: [
          "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        ],
      },
    });
  });

  test("parses space-form --exclude-tenancy-ids / --only-tenancy-ids", ({ expect }) => {
    const tenA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const tenB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    expect(parseBackfillResumeOptions([
      "--exclude-tenancy-ids",
      `${tenA}, ${tenB}`,
    ])).toEqual({
      continueOnError: false,
      tenancyFilter: { mode: "exclude", tenancyIds: [tenA, tenB] },
    });
    expect(parseBackfillResumeOptions([
      "--only-tenancy-ids",
      tenA,
      "--batch-size",
      "20",
    ])).toEqual({
      continueOnError: false,
      batchSize: 20,
      tenancyFilter: { mode: "only", tenancyIds: [tenA] },
    });
  });

  test("parses --only-tenancy-ids", ({ expect }) => {
    expect(parseBackfillResumeOptions([
      "--only-tenancy-ids=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    ])).toEqual({
      continueOnError: false,
      tenancyFilter: {
        mode: "only",
        tenancyIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
      },
    });
  });

  test("rejects combining --exclude-tenancy-ids and --only-tenancy-ids", ({ expect }) => {
    expect(() => parseBackfillResumeOptions([
      "--exclude-tenancy-ids=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "--only-tenancy-ids=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    ])).toThrow("cannot combine --exclude-tenancy-ids and --only-tenancy-ids");
  });

  test("rejects empty --exclude-tenancy-ids / --only-tenancy-ids", ({ expect }) => {
    expect(() => parseBackfillResumeOptions(["--exclude-tenancy-ids="]))
      .toThrow("--exclude-tenancy-ids requires at least one tenancy UUID");
    expect(() => parseBackfillResumeOptions(["--only-tenancy-ids="]))
      .toThrow("--only-tenancy-ids requires at least one tenancy UUID");
    expect(() => parseBackfillResumeOptions(["--exclude-tenancy-ids"]))
      .toThrow("--exclude-tenancy-ids requires a value");
    expect(() => parseBackfillResumeOptions(["--only-tenancy-ids"]))
      .toThrow("--only-tenancy-ids requires a value");
  });

  test("rejects invalid tenancy UUID shapes", ({ expect }) => {
    expect(() => parseBackfillResumeOptions(["--exclude-tenancy-ids=not-a-uuid"]))
      .toThrow('invalid tenancy UUID "not-a-uuid"');
    expect(() => parseBackfillResumeOptions(["--only-tenancy-ids=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa,nope"]))
      .toThrow('invalid tenancy UUID "nope"');
  });

  test("accepts ManualTransaction as a --resume-table", ({ expect }) => {
    expect(parseBackfillResumeOptions([
      "--resume-table=ManualTransaction",
      "--resume-cursor=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa,txn-9",
    ])).toEqual({
      resumeTable: "ManualTransaction",
      resumeCursor: { tenancyId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", id: "txn-9" },
      continueOnError: false,
    });
  });

  test("rejects resume cursor tenancy that conflicts with tenancy filters", ({ expect }) => {
    const tenA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const tenB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    expect(() => parseBackfillResumeOptions([
      `--exclude-tenancy-ids=${tenA}`,
      "--resume-table=Subscription",
      `--resume-cursor=${tenA},sub-1`,
    ])).toThrow(/exclude-tenancy-ids/);
    expect(() => parseBackfillResumeOptions([
      `--only-tenancy-ids=${tenA}`,
      "--resume-table=Subscription",
      `--resume-cursor=${tenB},sub-1`,
    ])).toThrow(/only-tenancy-ids/);
    // Matching tenancy is fine (including uppercase filter + lowercase cursor).
    expect(parseBackfillResumeOptions([
      `--only-tenancy-ids=${tenA}`,
      "--resume-table=Subscription",
      `--resume-cursor=${tenA},sub-1`,
    ]).resumeCursor).toEqual({ tenancyId: tenA, id: "sub-1" });
    expect(parseBackfillResumeOptions([
      `--only-tenancy-ids=${tenA.toUpperCase()}`,
      "--resume-table=Subscription",
      `--resume-cursor=${tenA},sub-1`,
    ]).resumeCursor).toEqual({ tenancyId: tenA, id: "sub-1" });
  });

});

import.meta.vitest?.describe("formatBackfillFailures", (test) => {
  test("summarizes a single failure", ({ expect }) => {
    const message = formatBackfillFailures([
      { table: "Subscription", tenancyId: "ten-1", id: "sub-1", message: "boom" },
    ]);
    expect(message).toContain("1 un-ingestable row(s)");
    expect(message).toContain("Subscription ten-1,sub-1: boom");
  });

  test("truncates the preview and reports the overflow count", ({ expect }) => {
    const failures = Array.from({ length: MAX_FAILURE_PREVIEW + 5 }, (_, i) => ({
      table: "Subscription" as const,
      tenancyId: "ten",
      id: `sub-${i}`,
      message: "boom",
    }));
    const message = formatBackfillFailures(failures);
    expect(message).toContain(`${MAX_FAILURE_PREVIEW + 5} un-ingestable row(s)`);
    expect(message).toContain("...and 5 more");
    expect(message).not.toContain(`sub-${MAX_FAILURE_PREVIEW + 4}`);
  });
});

import.meta.vitest?.describe("backfillTable continue-on-error", (test) => {
  const rows = [
    { tenancyId: "t", id: "a" },
    { tenancyId: "t", id: "bad" },
    { tenancyId: "t", id: "c" },
  ];
  // Serves the batch once, then an empty page. (The short-page break means the
  // second fetch is never actually reached, but this keeps the fake honest.)
  const fetchOnce = () => {
    let served = false;
    return async () => {
      if (served) return [];
      served = true;
      return rows;
    };
  };
  // A batch write that fails the whole page if any row is "bad" (mirrors the
  // engine rejecting a batch containing a poison row). It only records the good
  // rows when the page has no poison row, so the per-row isolation retry is what
  // gets the good rows in once the bad one is split out.
  const failOnBadBatch = (written: string[]) => async (rows: Cursor[]) => {
    if (rows.some((row) => row.id === "bad")) throw new Error("nope");
    for (const row of rows) written.push(row.id);
  };

  test("records the failing row and writes the rest when continueOnError is true", async ({ expect }) => {
    const written: string[] = [];
    const failures: BackfillFailure[] = [];
    await backfillTable("Subscription", null, fetchOnce(), failOnBadBatch(written), {
      continueOnError: true,
      recordFailure: (f) => failures.push(f),
      batchSize: DEFAULT_BATCH_SIZE,
    });
    expect(written).toEqual(["a", "c"]);
    expect(failures).toEqual([{ table: "Subscription", tenancyId: "t", id: "bad", message: "nope" }]);
  });

  test("aborts on the first failure when continueOnError is false", async ({ expect }) => {
    const written: string[] = [];
    const failures: BackfillFailure[] = [];
    await expect(
      backfillTable("Subscription", null, fetchOnce(), failOnBadBatch(written), {
        continueOnError: false,
        recordFailure: (f) => failures.push(f),
        batchSize: DEFAULT_BATCH_SIZE,
      }),
    ).rejects.toThrow("nope");
    // The batch fails atomically before recording any row, so nothing is written.
    expect(written).toEqual([]);
    expect(failures).toEqual([]);
  });
});

import.meta.vitest?.describe("shouldRunTable / startCursorFor", (test) => {
  test("runs every table when no resume table is set", ({ expect }) => {
    for (const table of BACKFILL_TABLES) {
      expect(shouldRunTable(table, undefined)).toBe(true);
    }
  });

  test("skips tables before the resume table and runs the rest", ({ expect }) => {
    expect(shouldRunTable("Subscription", "OneTimePurchase")).toBe(false);
    expect(shouldRunTable("SubscriptionInvoice", "OneTimePurchase")).toBe(false);
    expect(shouldRunTable("OneTimePurchase", "OneTimePurchase")).toBe(true);
    expect(shouldRunTable("ItemQuantityChange", "OneTimePurchase")).toBe(true);
    expect(shouldRunTable("ManualTransaction", "OneTimePurchase")).toBe(true);
    expect(shouldRunTable("ItemQuantityChange", "ManualTransaction")).toBe(false);
    expect(shouldRunTable("ManualTransaction", "ManualTransaction")).toBe(true);
  });

  test("applies the resume cursor only to the resume table", ({ expect }) => {
    const options = { resumeTable: "OneTimePurchase" as const, resumeCursor: { tenancyId: "t", id: "p" } };
    expect(startCursorFor("OneTimePurchase", options)).toEqual({ tenancyId: "t", id: "p" });
    expect(startCursorFor("ItemQuantityChange", options)).toBe(null);
  });

  test("starts from the top when the resume table has no cursor", ({ expect }) => {
    expect(startCursorFor("Subscription", { resumeTable: "Subscription" })).toBe(null);
  });
});

import.meta.vitest?.describe("buildBackfilledRefundManualTransaction", (test) => {
  const refundedAt = new Date("2024-01-02T03:04:05.000Z");
  const baseRow = {
    id: "row-1",
    tenancyId: "ten-1",
    customerId: "cust-1",
    customerType: "TEAM",
    productId: "prod-1",
    product: { productLineId: "free" },
    quantity: 3,
    creationSource: "PURCHASE_PAGE",
    refundedAt,
  };

  test("synthesizes a stable, idempotent refund txn for a subscription", ({ expect }) => {
    const { txnId, rowData } = buildBackfilledRefundManualTransaction({ row: baseRow, sourceKind: "subscription" });
    expect(txnId).toBe("row-1:refund");
    expect(rowData.txnId).toBe("row-1:refund");
    expect(rowData.type).toBe("refund");
    expect(rowData.tenancyId).toBe("ten-1");
    expect(rowData.customerType).toBe("team");
    expect(rowData.effectiveAtMillis).toBe(refundedAt.getTime());
    expect(rowData.createdAtMillis).toBe(refundedAt.getTime());
    expect(rowData.paymentProvider).toBe("stripe");
    expect(rowData.entries).toEqual([{
      type: "product-revocation",
      customerType: "team",
      customerId: "cust-1",
      adjustedTransactionId: "sub-start:row-1",
      adjustedEntryIndex: SUBSCRIPTION_START_PRODUCT_GRANT_ENTRY_INDEX,
      quantity: 3,
      productId: "prod-1",
      productLineId: "free",
    }]);
  });

  test("uses the otp source txn id for one-time purchases", ({ expect }) => {
    const { rowData } = buildBackfilledRefundManualTransaction({ row: baseRow, sourceKind: "one-time-purchase" });
    expect(rowData.entries[0]).toMatchObject({
      adjustedTransactionId: "otp:row-1",
      adjustedEntryIndex: ONE_TIME_PURCHASE_PRODUCT_GRANT_ENTRY_INDEX,
    });
  });

  test("marks test-mode rows with the test_mode payment provider", ({ expect }) => {
    const { rowData } = buildBackfilledRefundManualTransaction({
      row: { ...baseRow, creationSource: "TEST_MODE" },
      sourceKind: "subscription",
    });
    expect(rowData.paymentProvider).toBe("test_mode");
  });

  test("falls back to a null productLineId when the product has none", ({ expect }) => {
    const { rowData } = buildBackfilledRefundManualTransaction({
      row: { ...baseRow, product: {} },
      sourceKind: "subscription",
    });
    expect(rowData.entries[0]).toMatchObject({ productLineId: null });
  });

  test("throws if called for a row without refundedAt", ({ expect }) => {
    expect(() => buildBackfilledRefundManualTransaction({
      row: { ...baseRow, refundedAt: null },
      sourceKind: "subscription",
    })).toThrow("without refundedAt");
  });
});
