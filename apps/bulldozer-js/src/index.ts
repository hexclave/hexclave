import { node } from "@elysia/node";
import type { Transaction, TransactionEntry, TransactionType } from "@hexclave/shared/dist/interface/crud/transactions";
import { moneyAmountToStripeUnits } from "@hexclave/shared/dist/utils/currencies";
import { SUPPORTED_CURRENCIES, type MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import { captureError, HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously, wait } from "@hexclave/shared/dist/utils/promises";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { Elysia } from "elysia";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { isBulldozerRequestAuthorized } from "./auth.js";
import { declareBulldozerDatabase, type BulldozerDatabase } from "./databases/bulldozer/index.js";
import { declareInMemoryLowLevelDatabase } from "./databases/low-level/implementations/in-memory.js";
import { declareInstantAvailabilityLowLevelDatabase } from "./databases/low-level/implementations/instant-availability.js";
import { declareLmdbLowLevelDatabase, getLmdbDiagnostics } from "./databases/low-level/implementations/lmdb.js";
import type { LowLevelDatabase } from "./databases/low-level/index.js";
import { declareBasePiledriverDatabase } from "./databases/piledriver/implementations/base.js";
import { declareBufferedPiledriverDatabase } from "./databases/piledriver/implementations/buffered.js";
import type { PiledriverObject } from "./databases/piledriver/index.js";
import "./load-env.js";
import { shouldSuppressPeriodicBulldozerLogs } from "./logging.js";
import { parseManualTransactionsListQuery } from "./manual-transactions-http.js";
import { instrumentation, traceSpan } from "./otel.js";
import { createPaymentsSchema, itemQuantitiesLedgerUpperBoundAsOf } from "./payments/schema/index.js";
import type { CustomerType, Json, ManualTransactionRow, SubscriptionRow, TransactionRow } from "./payments/schema/types.js";
import { initSentry, resolveBulldozerSentryEnvironment } from "./sentry.js";

const sentryEnabled = initSentry();

const REFUND_TXN_PREFIX = "refund:";
const USD_CURRENCY = SUPPORTED_CURRENCIES.find(currency => currency.code === "USD") ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");
const schema = createPaymentsSchema();
const port = Number(process.env.BULLDOZER_JS_PORT ?? process.env.BULLDOZER_SERVER_PORT ?? `${process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX ?? "81"}46`);
const HEAP_GC_USAGE_THRESHOLD = 0.6;
const HEAP_GC_TARGET_USAGE_THRESHOLD = 0.3;
const HEAP_GC_MAX_PASSES = 5;
const HEAP_GC_FINALIZATION_DELAY_MS = 20;
const HEAP_GC_RETRY_COOLDOWN_MS = 60_000;
const TICK_LOOP_SLOW_MS = 500;
type BulldozerSnapshot = Awaited<ReturnType<BulldozerDatabase["getSnapshot"]>>["snapshot"];
type OwnedProductsRow = { ownedProducts: Record<string, unknown> };
type SubscriptionMapRow = { subscriptions: Record<string, SubscriptionRow> };
let heapGcMaintenanceScheduled = false;
let mostRecentHeapGcMaintenanceLabel: string | null = null;
let heapGcMaintenanceRetryAfter = 0;

function defaultLmdbPath() {
  const configured = process.env.HEXCLAVE_BULLDOZER_JS_LMDB_PATH;
  if (configured !== undefined && configured.length > 0) return configured;
  if (process.env.HEXCLAVE_BULLDOZER_JS_USE_TMP_LMDB === "1") return mkdtempSync(join(tmpdir(), "hexclave-bulldozer-js-"));
  return join(process.cwd(), ".data", "bulldozer-js-lmdb");
}

function readOptionalNonNegativeNumberEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative finite number`);
  return parsed;
}

function createLowLevelDatabase(): LowLevelDatabase {
  if (process.env.HEXCLAVE_BULLDOZER_JS_LOW_LEVEL_BACKEND === "in-memory") {
    return declareInMemoryLowLevelDatabase(crypto.randomUUID());
  }

  const lmdbPath = defaultLmdbPath();
  mkdirSync(lmdbPath, { recursive: true });
  return declareInstantAvailabilityLowLevelDatabase(declareLmdbLowLevelDatabase({
    path: lmdbPath,
    // Sticky per path: once a store has compressed values, keep this set on every open.
    // Enabling on an existing uncompressed store is safe (old values still read; new writes compress).
    compression: process.env.HEXCLAVE_BULLDOZER_JS_LMDB_COMPRESSION === "1",
    simulateReadMissDelayMs: readOptionalNonNegativeNumberEnv("HEXCLAVE_BULLDOZER_JS_SIMULATE_READ_MISS_DELAY_MS"),
  }));
}

const basePiledriver = declareBasePiledriverDatabase(createLowLevelDatabase(), {
  disableHeapReadCache: process.env.HEXCLAVE_BULLDOZER_JS_DISABLE_PILEDRIVER_HEAP_READ_CACHE === "1",
});
// Buffering keeps availability instant while durability/replication waits for the wrapped root write;
// it is worthwhile for write-lock occupancy and throughput, not per-call latency.
const bufferedPiledriverEnabled = process.env.HEXCLAVE_BULLDOZER_JS_DISABLE_BUFFERED_PILEDRIVER !== "1";
const piledriver = bufferedPiledriverEnabled ? declareBufferedPiledriverDatabase(basePiledriver) : basePiledriver;
const bulldozerDb = declareBulldozerDatabase(
  piledriver,
  { migrations: schema.migrations },
);
(globalThis as any).bulldozerDb = bulldozerDb;
console.log(`Stored bulldozerDb in globalThis for pid ${process.pid}. Run \`kill -USR1 ${process.pid} && node inspect 127.0.0.1:9229\` and then \`exec("globalThis.bulldozerDb")\` to inspect it.`);
await traceSpan("bulldozer-js.applyRemainingMigrations", async () => await bulldozerDb.applyRemainingMigrations());

function jsonResponse(body: Json, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
}

function notImplemented(operation: string) {
  return jsonResponse({ error: "not_implemented", operation }, { status: 501 });
}

function timingHeaders(startedAt: number): HeadersInit | undefined {
  if (process.env.HEXCLAVE_BULLDOZER_EMIT_HANDLER_TIMING !== "1") return undefined;
  return { "x-bulldozer-handler-ms": (performance.now() - startedAt).toFixed(3) };
}

function currentHeapUsage() {
  const heapUsed = process.memoryUsage().heapUsed;
  const heapSizeLimit = getHeapStatistics().heap_size_limit;
  return {
    heapUsed,
    heapSizeLimit,
    heapUsedMb: heapUsed / 1_000_000,
    heapSizeLimitMb: heapSizeLimit / 1_000_000,
    heapUsedRatio: heapUsed / heapSizeLimit,
  };
}

function serviceMemoryUsage() {
  const memory = process.memoryUsage();
  const heapStats = getHeapStatistics();
  return {
    heapUsedMb: memory.heapUsed / 1_000_000,
    heapTotalMb: memory.heapTotal / 1_000_000,
    heapSizeLimitMb: heapStats.heap_size_limit / 1_000_000,
    heapUsedRatio: memory.heapUsed / heapStats.heap_size_limit,
    rssMb: memory.rss / 1_000_000,
    externalMb: memory.external / 1_000_000,
    arrayBuffersMb: memory.arrayBuffers / 1_000_000,
    totalAvailableHeapMb: heapStats.total_available_size / 1_000_000,
    nativeContexts: heapStats.number_of_native_contexts,
    detachedContexts: heapStats.number_of_detached_contexts,
  };
}

function logBulldozerService(event: string, fields: Record<string, unknown>, options?: { periodic?: boolean }) {
  if (options?.periodic === true && shouldSuppressPeriodicBulldozerLogs) return;
  console.log(JSON.stringify({
    component: "bulldozer-js",
    event,
    ...fields,
  }));
}

function logHeapGcMaintenance(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({
    component: "bulldozer-js",
    event,
    ...fields,
  }));
}

function delayNextHeapGcMaintenance(reason: string, label: string, usage: ReturnType<typeof currentHeapUsage>) {
  heapGcMaintenanceRetryAfter = performance.now() + HEAP_GC_RETRY_COOLDOWN_MS;
  logHeapGcMaintenance("heap-gc-retry-delayed", {
    label,
    reason,
    threshold: HEAP_GC_USAGE_THRESHOLD,
    targetThreshold: HEAP_GC_TARGET_USAGE_THRESHOLD,
    retryAfterMs: HEAP_GC_RETRY_COOLDOWN_MS,
    usage,
  });
}

/**
 * V8's automatic GC is intentionally heuristic. During the Postgres->Bulldozer
 * backfill investigation on 2026-06-29, we reproduced OOMs even though the
 * Piledriver heap-key interner stores values through WeakRef. The issue was not
 * stale dead WeakRefs: probes showed remaining entries had live `WeakRef.deref()`
 * results until V8 chose to collect them. Once we explicitly ran a short GC
 * sequence at a clean request/batch boundary, FinalizationRegistry callbacks
 * removed those live-until-then interner entries and memory returned to a stable
 * baseline.
 *
 * Reproduction probes used during that investigation:
 * - `payments-backfill-weakref-liveness-probe.untracked.mjs` distinguishes live
 *   WeakRefs from dead-not-finalized entries. In the bad state, entries were live.
 * - `payments-backfill-strong-gc-idle-after-return-probe.untracked.mjs` compares
 *   no forced GC vs forced GC using `STRONG_GC_AFTER_RETURN_FORCE_GC`.
 * - The relevant stress runs were 500x50 and 1000x100 subscription batches
 *   against instant-LMDB. Re-run them on new Node.js versions to check whether
 *   automatic GC/finalization has become aggressive enough to remove this guard.
 *
 * This is not cache eviction. The map is a weak interner required for reference
 * equality while a heap object is live. We do not manually delete entries here;
 * we only give V8/FinalizationRegistry a chance to do their normal work at a
 * point where the just-finished request's stack has unwound.
 */
async function runHeapGcMaintenanceIfNeeded(label: string) {
  const before = currentHeapUsage();
  if (before.heapUsedRatio <= HEAP_GC_USAGE_THRESHOLD) return;

  if (globalThis.gc === undefined) {
    captureError("bulldozer-js:heap-gc-unavailable", new HexclaveAssertionError(
      "Bulldozer JS heap crossed the GC threshold, but Node was not started with --expose-gc",
      { label, threshold: HEAP_GC_USAGE_THRESHOLD, before },
    ));
    logHeapGcMaintenance("heap-gc-unavailable", { label, threshold: HEAP_GC_USAGE_THRESHOLD, before });
    delayNextHeapGcMaintenance("gc-unavailable", label, before);
    return;
  }

  const startedAt = performance.now();
  logHeapGcMaintenance("heap-gc-start", { label, threshold: HEAP_GC_USAGE_THRESHOLD, targetThreshold: HEAP_GC_TARGET_USAGE_THRESHOLD, before });

  let previous = before;
  let completedPasses = 0;
  for (let pass = 1; pass <= HEAP_GC_MAX_PASSES; pass++) {
    const passStartedAt = performance.now();
    const gcStartedAt = performance.now();
    globalThis.gc();
    const gcBlockingMs = performance.now() - gcStartedAt;
    await wait(HEAP_GC_FINALIZATION_DELAY_MS);

    const afterPass = currentHeapUsage();
    const passElapsedMs = performance.now() - passStartedAt;
    const targetThresholdReached = afterPass.heapUsedRatio <= HEAP_GC_TARGET_USAGE_THRESHOLD;
    logHeapGcMaintenance("heap-gc-pass", {
      label,
      pass,
      targetThreshold: HEAP_GC_TARGET_USAGE_THRESHOLD,
      before: previous,
      after: afterPass,
      freedHeapMb: (previous.heapUsed - afterPass.heapUsed) / 1_000_000,
      freedHeapRatioPoints: previous.heapUsedRatio - afterPass.heapUsedRatio,
      gcBlockingMs,
      passElapsedMs,
    });
    previous = afterPass;
    completedPasses = pass;
    if (targetThresholdReached) break;
  }

  const after = currentHeapUsage();
  logHeapGcMaintenance("heap-gc-finish", {
    label,
    threshold: HEAP_GC_USAGE_THRESHOLD,
    targetThreshold: HEAP_GC_TARGET_USAGE_THRESHOLD,
    after,
    totalFreedHeapMb: (before.heapUsed - after.heapUsed) / 1_000_000,
    completedPasses,
    maxPasses: HEAP_GC_MAX_PASSES,
    elapsedMs: performance.now() - startedAt,
  });

  if (after.heapUsedRatio > HEAP_GC_TARGET_USAGE_THRESHOLD) {
    captureError("bulldozer-js:heap-still-above-threshold-after-gc", new HexclaveAssertionError(
      "Bulldozer JS heap remained above the GC target threshold after explicit collection",
      { label, threshold: HEAP_GC_USAGE_THRESHOLD, targetThreshold: HEAP_GC_TARGET_USAGE_THRESHOLD, before, after },
    ));
    delayNextHeapGcMaintenance("still-above-target-threshold", label, after);
  } else {
    heapGcMaintenanceRetryAfter = 0;
  }
}

function scheduleHeapGcMaintenanceIfNeeded(label: string) {
  const before = currentHeapUsage();
  if (before.heapUsedRatio <= HEAP_GC_USAGE_THRESHOLD) return;

  const now = performance.now();
  if (now < heapGcMaintenanceRetryAfter) return;

  mostRecentHeapGcMaintenanceLabel = label;
  if (heapGcMaintenanceScheduled) {
    logHeapGcMaintenance("heap-gc-already-scheduled", { label, threshold: HEAP_GC_USAGE_THRESHOLD, before });
    return;
  }

  heapGcMaintenanceScheduled = true;
  logHeapGcMaintenance("heap-gc-scheduled", { label, threshold: HEAP_GC_USAGE_THRESHOLD, before });
  runAsynchronously(async () => {
    // Give the response-producing handler frame a tick to unwind before asking
    // V8 what is still genuinely live. The scheduled task only closes over the
    // route label, not the response body that was just returned.
    await wait(0);
    try {
      await runHeapGcMaintenanceIfNeeded(mostRecentHeapGcMaintenanceLabel ?? label);
    } finally {
      heapGcMaintenanceScheduled = false;
      mostRecentHeapGcMaintenanceLabel = null;
    }
  });
}

async function handler<T extends Json>(label: string, operation: () => Promise<T>) {
  const startedAt = performance.now();
  return await traceSpan("bulldozer-js.http.handler", async () => {
    logBulldozerService("http-handler-start", {
      label,
      memory: serviceMemoryUsage(),
    }, { periodic: true });
    try {
      const operationStartedAt = performance.now();
      const body = await operation();
      const operationMs = performance.now() - operationStartedAt;
      scheduleHeapGcMaintenanceIfNeeded(label);
      const serializationStartedAt = performance.now();
      const response = jsonResponse(body, { headers: timingHeaders(startedAt) });
      const responseSerializationMs = performance.now() - serializationStartedAt;
      logBulldozerService("http-handler-finish", {
        label,
        outcome: "success",
        status: 200,
        operationMs,
        responseSerializationMs,
        elapsedMs: performance.now() - startedAt,
        memory: serviceMemoryUsage(),
      }, { periodic: true });
      return response;
    } catch (error) {
      if (StatusError.isStatusError(error) && error.isClientError()) {
        // Bad request from the caller (malformed body, params, cursor, etc.). The
        // message is non-sensitive and helps the caller fix the request, so echo
        // it; don't capture it as a server fault (it isn't one).
        logBulldozerService("http-handler-finish", {
          label,
          outcome: "client-error",
          status: error.getStatusCode(),
          elapsedMs: performance.now() - startedAt,
          memory: serviceMemoryUsage(),
        });
        return jsonResponse({ error: "bad_request", message: error.message }, { status: error.getStatusCode(), headers: timingHeaders(startedAt) });
      }
      // Genuine server fault (including poisoned stored data). Keep full context
      // server-side via Sentry, but never leak internal error messages to the
      // caller — only a generic body.
      captureError(`bulldozer-js:${label}`, error);
      logBulldozerService("http-handler-finish", {
        label,
        outcome: "server-error",
        status: 500,
        elapsedMs: performance.now() - startedAt,
        memory: serviceMemoryUsage(),
      });
      return jsonResponse({ error: "bulldozer_server_error" }, { status: 500, headers: timingHeaders(startedAt) });
    }
  });
}

function parseCustomerType(value: string): CustomerType {
  if (value === "user" || value === "team" || value === "custom") return value;
  throw new StatusError(StatusError.BadRequest, `Invalid customer type: ${value}`);
}

function parseTransactionType(value: string | undefined): TransactionType | undefined {
  if (value == null) return undefined;
  if (
    value === "purchase" ||
    value === "subscription-cancellation" ||
    value === "manual-item-quantity-change" ||
    value === "subscription-renewal" ||
    value === "refund" ||
    value === "chargeback" ||
    value === "product-change"
  ) {
    return value;
  }
  throw new StatusError(StatusError.BadRequest, `Invalid transaction type: ${value}`);
}

function readObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body == null || Array.isArray(body)) throw new StatusError(StatusError.BadRequest, "Expected JSON object body");
  return Object.fromEntries(Object.entries(body));
}

function readStringField(body: Record<string, unknown>, fieldName: string): string {
  const value = body[fieldName];
  if (typeof value !== "string" || value.length === 0) throw new StatusError(StatusError.BadRequest, `Expected non-empty string field: ${fieldName}`);
  return value;
}

function readPositiveSafeIntegerField(body: Record<string, unknown>, fieldName: string) {
  const value = body[fieldName];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new StatusError(StatusError.BadRequest, `Expected positive safe integer field: ${fieldName}`);
  }
  return value;
}

function readNonNegativeSafeIntegerField(body: Record<string, unknown>, fieldName: string) {
  const value = body[fieldName];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StatusError(StatusError.BadRequest, `Expected non-negative safe integer field: ${fieldName}`);
  }
  return value;
}

function readRowData(body: unknown): Record<string, unknown> {
  const record = readObjectBody(body);
  const rowData = record.rowData;
  if (typeof rowData !== "object" || rowData == null || Array.isArray(rowData)) throw new StatusError(StatusError.BadRequest, "Expected rowData object");
  return Object.fromEntries(Object.entries(rowData));
}

function readRowTenancyId(rowData: Record<string, unknown>) {
  return readStringField(rowData, "tenancyId");
}

function customerGroupKey(options: { tenancyId: string, customerType: CustomerType, customerId: string }): PiledriverObject {
  return {
    tenancyId: options.tenancyId,
    customerType: options.customerType,
    customerId: options.customerId,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

async function rowsInGroup(snapshot: BulldozerSnapshot, tableId: string, groupKey: PiledriverObject, reverse = false, limit?: number) {
  return await collect(snapshot.listRowsInGroup({ tableId, groupKey, range: { reverse, limit } }));
}

async function latestRowData<T>(options: { tableId: string, tenancyId: string, customerType: CustomerType, customerId: string }): Promise<T | null> {
  const { snapshot } = await bulldozerDb.getSnapshot();
  const rows = await rowsInGroup(snapshot, options.tableId, customerGroupKey(options), true, 1);
  if (rows.length === 0) return null;
  return rows[0].rowData as unknown as T;
}

// The latest item-quantities fold row whose txnEffectiveAtMillis <= asOfMillis (i.e. the state "as of
// now"), or null if none has taken effect yet. The fold materializes future-dated rows — e.g. a
// manual grant with a future absolute expiry eagerly emits the grant AND its expire marker at the
// future expiry time — so the absolute final row would report the fully-expired balance; we must cut
// off at the present. Rows are ordered by ledgerSortKey (primary key txnEffectiveAtMillis), so a
// reverse seek bounded at asOfMillis lands directly on the current-state row (O(log n) via the
// index), rather than linearly skipping every future-dated row. Mirrors the `balanceAt` test helper.
async function latestItemQuantitiesRowAsOf<T>(options: { tableId: string, tenancyId: string, customerType: CustomerType, customerId: string }, asOfMillis: number): Promise<T | null> {
  const { snapshot } = await bulldozerDb.getSnapshot();
  const range = { reverse: true, lt: itemQuantitiesLedgerUpperBoundAsOf(asOfMillis), limit: 1 };
  for await (const row of snapshot.listRowsInGroup({ tableId: options.tableId, groupKey: customerGroupKey(options), range })) {
    const txnEffectiveAtMillis = (row.rowData as { txnEffectiveAtMillis: number }).txnEffectiveAtMillis;
    // The bound guarantees this; assert loudly rather than silently returning a future-dated balance.
    if (txnEffectiveAtMillis > asOfMillis) throw new HexclaveAssertionError(`latestItemQuantitiesRowAsOf returned a row effective after the cutoff`, { txnEffectiveAtMillis, asOfMillis, tableId: options.tableId });
    return row.rowData as unknown as T;
  }
  return null;
}

async function setStoredRow(options: { tenancyId: string, tableId: string, rowId: string, rowData: Record<string, unknown> }): Promise<void> {
  if (readRowTenancyId(options.rowData) !== options.tenancyId) {
    throw new StatusError(StatusError.BadRequest, `Row tenancyId ${readRowTenancyId(options.rowData)} does not match URL tenancyId ${options.tenancyId}`);
  }
  try {
    // Consistent, so subsequent readers see the write and it survives a coordinated failure.
    await bulldozerDb.withSnapshotConsistent(async snapshot => await snapshot.setOrDeleteRow({
      tableId: options.tableId,
      rowIdentifier: options.rowId,
      newRowData: options.rowData as unknown as PiledriverObject,
    }));
  } catch (error) {
    // Attach which table/row poisoned the cascade so Sentry's beforeSend surfaces it
    // (extraData is enumerable -> errorProps/nicifiedError). Single-row: include full rowData.
    throw new HexclaveAssertionError(`bulldozer-js write failed for table ${options.tableId}`, {
      cause: error,
      tableId: options.tableId,
      tenancyId: options.tenancyId,
      rowId: options.rowId,
      rowData: options.rowData,
    });
  }
}

async function setStoredRowFromBody(options: { tenancyId: string, tableId: string, body: unknown }) {
  const rowData = readRowData(options.body);
  await setStoredRow({
    tenancyId: options.tenancyId,
    tableId: options.tableId,
    rowId: readStringField(rowData, "id"),
    rowData,
  });
}

async function setManualTransactionRow(options: { tenancyId: string, transactionId: string, body: unknown }) {
  const rowData = readRowData(options.body);
  await setStoredRow({
    tenancyId: options.tenancyId,
    tableId: schema.manualTransactions,
    rowId: options.transactionId,
    rowData,
  });
}

function readBatchRows(body: unknown): unknown[] {
  const record = readObjectBody(body);
  const rows = record.rows;
  if (!Array.isArray(rows)) throw new StatusError(StatusError.BadRequest, "Expected `rows` array");
  return rows;
}

/**
 * Ingests a whole batch of stored rows into one table in a single snapshot
 * write, applying the downstream cascade once for the batch (see
 * `setOrDeleteRows`). Each element has the same `{ rowData }` shape as the
 * single-row routes; the row identifier is read from `rowIdField` (defaults to
 * `id`, but manual transactions key on `txnId`). The whole batch shares a tenancy
 * — we validate each row matches the URL tenancy, same as the single routes.
 */
async function setStoredRowsFromBodies(options: { tenancyId: string, tableId: string, body: unknown, rowIdField?: string }) {
  const idField = options.rowIdField ?? "id";
  const rows = readBatchRows(options.body).map(element => {
    const rowData = readRowData(element);
    if (readRowTenancyId(rowData) !== options.tenancyId) {
      throw new StatusError(StatusError.BadRequest, `Row tenancyId ${readRowTenancyId(rowData)} does not match URL tenancyId ${options.tenancyId}`);
    }
    return { rowIdentifier: readStringField(rowData, idField), newRowData: rowData as unknown as PiledriverObject };
  });
  try {
    await bulldozerDb.withSnapshotConsistent(async snapshot => await snapshot.setOrDeleteRows({ tableId: options.tableId, rows }));
  } catch (error) {
    // A batch is one cascade, so a cascade-phase failure can't be pinned to a single row.
    // Attach the table + the batch's row identifiers (no rowData here, to keep batch events small).
    throw new HexclaveAssertionError(`bulldozer-js batch write failed for table ${options.tableId}`, {
      cause: error,
      tableId: options.tableId,
      tenancyId: options.tenancyId,
      rowIdentifiers: rows.map(row => row.rowIdentifier),
      rowCount: rows.length,
    });
  }
}

async function getOwnedProductsForCustomer(options: { tenancyId: string, customerType: CustomerType, customerId: string }) {
  const row = await latestRowData<OwnedProductsRow>({ ...options, tableId: schema.ownedProducts });
  return row?.ownedProducts ?? {};
}

async function getItemQuantitiesForCustomer(options: { tenancyId: string, customerType: CustomerType, customerId: string }) {
  // Read the balance as of now, not the fold's final row: a manual grant with a future expiry
  // materializes a future-dated expire marker, and the final row would already show it as expired.
  const row = await latestItemQuantitiesRowAsOf<{ itemQuantities: Record<string, number> }>({ ...options, tableId: schema.itemQuantities }, Date.now());
  return row?.itemQuantities ?? {};
}

async function getSubscriptionMapForCustomer(options: { tenancyId: string, customerType: CustomerType, customerId: string }) {
  const row = await latestRowData<SubscriptionMapRow>({ ...options, tableId: schema.subscriptionMapByCustomer });
  return row?.subscriptions ?? {};
}

type LedgerTransactionType = "subscription-start" | "one-time-purchase" | "manual-item-quantity-change" | "subscription-renewal" | "refund";
type LedgerCursor = { createdAtMillis: number, txnId: string };
type ListedTransactionRow = TransactionRow & { sourceId: string };

function parseCursor(cursor: string): LedgerCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new StatusError(StatusError.BadRequest, "Invalid cursor");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new StatusError(StatusError.BadRequest, "Invalid cursor");
  const createdAtMillis = parsed["createdAtMillis"];
  const txnId = parsed["txnId"];
  if (typeof createdAtMillis !== "number" || !Number.isInteger(createdAtMillis) || createdAtMillis < 0 || typeof txnId !== "string" || txnId.length === 0) {
    throw new StatusError(StatusError.BadRequest, "Invalid cursor");
  }
  return { createdAtMillis, txnId };
}

function encodeCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function getLedgerTypesForFilter(type: TransactionType | undefined): readonly LedgerTransactionType[] {
  switch (type) {
    case undefined: {
      return ["subscription-start", "one-time-purchase", "manual-item-quantity-change", "subscription-renewal", "refund"];
    }
    case "purchase": {
      return ["subscription-start", "one-time-purchase"];
    }
    case "manual-item-quantity-change": {
      return ["manual-item-quantity-change"];
    }
    case "subscription-renewal": {
      return ["subscription-renewal"];
    }
    case "refund": {
      return ["refund"];
    }
    case "subscription-cancellation":
    case "chargeback":
    case "product-change": {
      return [];
    }
  }
}

function parseSourceId(row: TransactionRow): string {
  if (row.type === "subscription-start") return row.txnId.replace(/^sub-start:/, "");
  if (row.type === "one-time-purchase") return row.txnId.replace(/^otp:/, "");
  if (row.type === "manual-item-quantity-change") return row.txnId.replace(/^miqc:/, "");
  if (row.type === "refund") return row.txnId;
  if (row.type === "subscription-renewal") return row.txnId.replace(/^sub-renewal:/, "");
  return row.txnId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type InlineProduct = Extract<TransactionEntry, { type: "product_grant" }>["product"];

function mapProductSnapshotToInlineProduct(product: unknown): InlineProduct {
  if (!isRecord(product)) throw new Error("Invalid product snapshot");
  const includedItemsRaw = product.includedItems;
  if (!isRecord(includedItemsRaw)) throw new Error("Invalid product includedItems");
  const includedItems: InlineProduct["included_items"] = {};
  for (const [itemId, value] of Object.entries(includedItemsRaw)) {
    if (!isRecord(value)) continue;
    const quantity = value.quantity;
    if (typeof quantity !== "number") continue;
    const repeat = value.repeat;
    const expires = value.expires;
    includedItems[itemId] = {
      quantity,
      repeat: repeat === undefined || repeat === null ? "never" : repeat as InlineProduct["included_items"][string]["repeat"],
      expires: expires === undefined || expires === null ? "never" : expires as InlineProduct["included_items"][string]["expires"],
    };
  }
  const prices: InlineProduct["prices"] = {};
  if (isRecord(product.prices)) {
    for (const [priceId, value] of Object.entries(product.prices)) {
      if (!isRecord(value)) continue;
      const mappedPrice: InlineProduct["prices"][string] = {};
      for (const currency of SUPPORTED_CURRENCIES) {
        const amount = value[currency.code];
        if (typeof amount === "string") mappedPrice[currency.code] = amount;
      }
      if (Array.isArray(value.interval)) mappedPrice.interval = value.interval as [number, "day" | "week" | "month" | "year"];
      if (Array.isArray(value.freeTrial)) mappedPrice.free_trial = value.freeTrial as [number, "day" | "week" | "month" | "year"];
      prices[priceId] = mappedPrice;
    }
  }
  return {
    display_name: typeof product.displayName === "string" ? product.displayName : "Product",
    customer_type: parseCustomerType(String(product.customerType)),
    stackable: product.stackable === true,
    server_only: product.serverOnly === true,
    included_items: includedItems,
    client_metadata: product.clientMetadata as Json | undefined ?? null,
    client_read_only_metadata: product.clientReadOnlyMetadata as Json | undefined ?? null,
    server_metadata: product.serverMetadata as Json | undefined ?? null,
    prices,
  };
}

function mapLedgerEntry(entry: unknown): TransactionEntry | null {
  if (!isRecord(entry)) return null;
  if (entry.type === "money-transfer" && isRecord(entry.chargedAmount)) {
    const chargedAmount = Object.fromEntries(Object.entries(entry.chargedAmount).filter(([, value]) => typeof value === "string")) as Record<string, string>;
    if (Object.keys(chargedAmount).length === 0) return null;
    return {
      type: "money_transfer",
      adjusted_transaction_id: null,
      adjusted_entry_index: null,
      customer_type: parseCustomerType(String(entry.customerType)),
      customer_id: String(entry.customerId),
      charged_amount: chargedAmount,
      net_amount: { USD: "USD" in chargedAmount ? chargedAmount.USD : "0" },
    };
  }
  if (entry.type === "item-quantity-change" || entry.type === "compacted-item-quantity-change") {
    return {
      type: "item_quantity_change",
      adjusted_transaction_id: null,
      adjusted_entry_index: null,
      customer_type: parseCustomerType(String(entry.customerType)),
      customer_id: String(entry.customerId),
      item_id: String(entry.itemId),
      quantity: Number(entry.quantity),
    };
  }
  if (entry.type === "product-grant") {
    return {
      type: "product_grant",
      adjusted_transaction_id: null,
      adjusted_entry_index: null,
      customer_type: parseCustomerType(String(entry.customerType)),
      customer_id: String(entry.customerId),
      product_id: entry.productId === null ? null : String(entry.productId),
      product: mapProductSnapshotToInlineProduct(entry.product),
      price_id: entry.priceId === undefined || entry.priceId === null ? null : String(entry.priceId),
      quantity: Number(entry.quantity),
      ...(entry.subscriptionId != null ? { subscription_id: String(entry.subscriptionId) } : {}),
      ...(entry.oneTimePurchaseId != null ? { one_time_purchase_id: String(entry.oneTimePurchaseId) } : {}),
    };
  }
  if (entry.type === "product-revocation") {
    return {
      type: "product_revocation",
      adjusted_transaction_id: String(entry.adjustedTransactionId),
      adjusted_entry_index: Number(entry.adjustedEntryIndex),
      quantity: Number(entry.quantity),
    };
  }
  if (entry.type === "product-revocation-reversal") {
    return {
      type: "product_revocation_reversal",
      adjusted_transaction_id: String(entry.adjustedTransactionId),
      adjusted_entry_index: Number(entry.adjustedEntryIndex),
      quantity: Number(entry.quantity),
    };
  }
  return null;
}

function mapLedgerTransactionTypeToApiType(type: LedgerTransactionType): Transaction["type"] {
  if (type === "manual-item-quantity-change" || type === "subscription-renewal" || type === "refund") return type;
  return "purchase";
}

function parseRefundTxnId(txnId: string): { sourceTxnId: string, uuid: string } | null {
  if (!txnId.startsWith(REFUND_TXN_PREFIX)) return null;
  const rest = txnId.slice(REFUND_TXN_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) return null;
  const sourceTxnId = rest.slice(0, lastColon);
  const uuid = rest.slice(lastColon + 1);
  return sourceTxnId.length === 0 || uuid.length === 0 ? null : { sourceTxnId, uuid };
}

function buildAdjustedByLookupFromRefundRows(rows: TransactionRow[]): Map<string, Transaction["adjusted_by"]> {
  const lookup = new Map<string, Transaction["adjusted_by"]>();
  // TODO: this spread copies the whole array on every add — O(k^2) for a source
  // with k refunds. Fine while refunds-per-source stays small; switch to pushing
  // into a per-source array if that grows.
  const addLink = (sourceTxnId: string, refundTxnId: string, entryIndex: number) => {
    lookup.set(sourceTxnId, [...lookup.get(sourceTxnId) ?? [], { transaction_id: refundTxnId, entry_index: entryIndex }]);
  };
  for (const row of rows) {
    const parsed = parseRefundTxnId(row.txnId);
    if (parsed) {
      addLink(parsed.sourceTxnId, row.txnId, 0);
      continue;
    }
    for (const entry of row.entries) {
      if (entry.type === "product-revocation") addLink(entry.adjustedTransactionId, row.txnId, entry.adjustedEntryIndex);
    }
  }
  return lookup;
}

function sortTransactions(a: TransactionRow, b: TransactionRow) {
  return b.createdAtMillis - a.createdAtMillis || stringCompare(b.txnId, a.txnId);
}

// Newest-first recency key matching the tenancy date index's sort order.
function recencySortKey(cursor: LedgerCursor): PiledriverObject {
  return [cursor.createdAtMillis, cursor.txnId];
}

// Refund links for a page: a refund (or product revocation) always lives in the same
// customer group as the transaction it adjusts, so we only need to scan the distinct
// customer groups present in the page — bounded by the page, not the tenancy.
async function buildAdjustedByForPage(snapshot: BulldozerSnapshot, pageRows: TransactionRow[]): Promise<Map<string, Transaction["adjusted_by"]>> {
  const seenGroups = new Set<string>();
  const refundRows: TransactionRow[] = [];
  for (const pageRow of pageRows) {
    const groupKey = customerGroupKey(pageRow);
    const groupKeyJson = JSON.stringify(groupKey);
    if (seenGroups.has(groupKeyJson)) continue;
    seenGroups.add(groupKeyJson);
    for await (const groupRow of snapshot.listRowsInGroup({ tableId: schema.transactions, groupKey, range: {} })) {
      const txn = groupRow.rowData as unknown as TransactionRow;
      const isRefund = parseRefundTxnId(txn.txnId) !== null;
      const hasRevocation = txn.entries.some(entry => entry.type === "product-revocation");
      if (isRefund || hasRevocation) refundRows.push(txn);
    }
  }
  return buildAdjustedByLookupFromRefundRows(refundRows);
}

async function listTransactions(options: { tenancyId: string, limit: number, cursor: string | undefined, type: TransactionType | undefined, customerType: CustomerType | undefined, customerId: string | undefined }): Promise<{ transactions: Transaction[], nextCursor: string | null }> {
  const ledgerTypes = new Set(getLedgerTypesForFilter(options.type));
  if (ledgerTypes.size === 0) return { transactions: [], nextCursor: null };
  // Clamp here too (not just at the HTTP routes) so the in-process contract can't be
  // violated by a future caller and dead-end pagination with hasMore but no rows.
  const limit = Math.max(1, Math.min(200, Number.isInteger(options.limit) ? options.limit : 50));
  const cursor = options.cursor === undefined ? null : parseCursor(options.cursor);
  const { snapshot } = await bulldozerDb.getSnapshot();

  const matchesFilters = (row: TransactionRow) =>
    ledgerTypes.has(row.type as LedgerTransactionType)
    && (options.customerType === undefined || row.customerType === options.customerType)
    && (options.customerId === undefined || row.customerId === options.customerId);
  const matchesCursor = (row: TransactionRow) =>
    cursor === null
    || row.createdAtMillis < cursor.createdAtMillis
    || (row.createdAtMillis === cursor.createdAtMillis && stringCompare(row.txnId, cursor.txnId) < 0);

  // We fetch limit+1 to know whether there's a next page.
  let pageRows: TransactionRow[];
  if (options.customerType !== undefined && options.customerId !== undefined) {
    // Customer-scoped: read just that customer's group (memory bounded by one customer's
    // transaction count, normally small) and order by recency in code.
    const groupKey = customerGroupKey({ tenancyId: options.tenancyId, customerType: options.customerType, customerId: options.customerId });
    const matching: TransactionRow[] = [];
    for await (const row of snapshot.listRowsInGroup({ tableId: schema.transactions, groupKey, range: {} })) {
      const txn = row.rowData as unknown as TransactionRow;
      if (matchesFilters(txn) && matchesCursor(txn)) matching.push(txn);
    }
    matching.sort(sortTransactions);
    pageRows = matching.slice(0, limit + 1);
  } else {
    // Tenancy-wide: walk the date index newest-first, bounded below by the cursor. The
    // index is already in (createdAtMillis, txnId) order, so we read ~limit rows and stop
    // early once we've matched limit+1; memory is O(limit), never the whole tenancy.
    const range = cursor === null ? { reverse: true } : { reverse: true, lt: recencySortKey(cursor) };
    pageRows = [];
    for await (const row of snapshot.listRowsInGroup({ tableId: schema.transactionsByTenancy, groupKey: { tenancyId: options.tenancyId }, range })) {
      const txn = row.rowData as unknown as TransactionRow;
      if (!matchesFilters(txn)) continue;
      pageRows.push(txn);
      if (pageRows.length > limit) break;
    }
  }

  const hasMore = pageRows.length > limit;
  pageRows = pageRows.slice(0, limit);
  const adjustedByLookup = await buildAdjustedByForPage(snapshot, pageRows);
  const transactions = pageRows.flatMap((row): Transaction[] => {
    try {
      const listedRow: ListedTransactionRow = { ...row, sourceId: parseSourceId(row) };
      return [{
        id: listedRow.sourceId,
        created_at_millis: listedRow.createdAtMillis,
        effective_at_millis: listedRow.effectiveAtMillis,
        type: mapLedgerTransactionTypeToApiType(listedRow.type as LedgerTransactionType),
        customer_type: listedRow.customerType,
        customer_id: listedRow.customerId,
        renewal_target_subscription_id: listedRow.renewalTargetSubscriptionId ?? null,
        entries: listedRow.entries.flatMap(entry => {
          const mapped = mapLedgerEntry(entry);
          return mapped === null ? [] : [mapped];
        }),
        adjusted_by: adjustedByLookup.get(listedRow.txnId) ?? [],
        test_mode: listedRow.paymentProvider === "test_mode",
      }];
    } catch (error) {
      // A single poisoned stored transaction row shouldn't blow up the whole
      // page. Capture it with enough context (tenancy/txn/type/customer) to
      // locate and repair the bad row, then skip it so the rest still renders.
      // Pagination stays consistent because nextCursor is derived from pageRows,
      // not from this mapped output.
      captureError("bulldozer-js:list-transactions:poisoned-row", new HexclaveAssertionError(
        "Failed to map a stored transaction row to an API transaction; skipping it",
        { tenancyId: row.tenancyId, txnId: row.txnId, type: row.type, customerType: row.customerType, customerId: row.customerId, cause: error },
      ));
      return [];
    }
  });
  const last = pageRows.at(-1);
  return {
    transactions,
    nextCursor: hasMore && last !== undefined ? encodeCursor({ createdAtMillis: last.createdAtMillis, txnId: last.txnId }) : null,
  };
}

async function readPriorRefundSummary(options: { tenancyId: string, customerType: CustomerType, customerId: string, sourceTxnId: string }) {
  let refundedStripeUnits = 0;
  let productRevoked = false;
  const refundPrefix = `${REFUND_TXN_PREFIX}${options.sourceTxnId}:`;
  // The refund route always knows the customer, so scan only that customer's group. This
  // is a running-sum aggregate (O(1) memory) over the full group — completeness matters
  // here, so unlike the paginated list it reads the whole group, not a page.
  const { snapshot } = await bulldozerDb.getSnapshot();
  for await (const groupRow of snapshot.listRowsInGroup({ tableId: schema.transactions, groupKey: customerGroupKey(options), range: {} })) {
    const row = groupRow.rowData as unknown as TransactionRow;
    if (row.type !== "refund" || !row.txnId.startsWith(refundPrefix)) continue;
    for (const entry of row.entries) {
      if (entry.type === "product-revocation" && entry.adjustedTransactionId === options.sourceTxnId) productRevoked = true;
      if (entry.type === "money-transfer") {
        const usd = entry.chargedAmount.USD;
        if (typeof usd === "string") {
          // Match the old server exactly: strip a leading "-" and run through the
          // shared, schema-validated converter. This rejects non-finite/garbage
          // amounts (throws) instead of producing NaN, which would otherwise make
          // `remaining = NaN` and silently disable the refund cap downstream.
          const absolute = usd.startsWith("-") ? usd.slice(1) : usd;
          refundedStripeUnits += moneyAmountToStripeUnits(absolute as MoneyAmount, USD_CURRENCY);
        }
      }
    }
  }
  return { refundedStripeUnits, productRevoked };
}

function computeOutstandingItemGrants(rows: Array<{ txnId: unknown, entries: unknown }>) {
  const grants: Array<{ txnId: string, entryIndex: number, itemId: string, quantity: number }> = [];
  const expiredKeys = new Set<string>();
  const grantKey = (txnId: string, entryIndex: number) => `${txnId}:${entryIndex}`;
  for (const row of rows) {
    if (typeof row.txnId !== "string" || !Array.isArray(row.entries)) continue;
    for (let index = 0; index < row.entries.length; index++) {
      const entry = row.entries[index];
      if (!isRecord(entry)) continue;
      if (entry.type === "item-quantity-change" && (entry.expiresWhen === "when-purchase-expires" || entry.expiresWhen === "when-repeated") && typeof entry.itemId === "string" && typeof entry.quantity === "number") {
        grants.push({ txnId: row.txnId, entryIndex: index, itemId: entry.itemId, quantity: entry.quantity });
      } else if (entry.type === "item-quantity-expire" && typeof entry.adjustedTransactionId === "string" && typeof entry.adjustedEntryIndex === "number") {
        expiredKeys.add(grantKey(entry.adjustedTransactionId, entry.adjustedEntryIndex));
      }
    }
  }
  return grants.filter(grant => !expiredKeys.has(grantKey(grant.txnId, grant.entryIndex)));
}

async function readOutstandingItemGrants(options: { tenancyId: string, customerType: CustomerType, customerId: string, sourceTxnId: string, igrSourceId: string }) {
  const igrPrefix = `igr:${options.igrSourceId}:`;
  // Scan only the customer's group and keep just the source txn + its igr repeats (not the
  // rest of the group), so memory is bounded by one source's repeat events.
  const { snapshot } = await bulldozerDb.getSnapshot();
  const rows: Array<{ txnId: string, entries: TransactionRow["entries"] }> = [];
  for await (const groupRow of snapshot.listRowsInGroup({ tableId: schema.transactions, groupKey: customerGroupKey(options), range: {} })) {
    const row = groupRow.rowData as unknown as TransactionRow;
    if (row.txnId === options.sourceTxnId || (row.type === "item-grant-repeat" && row.txnId.startsWith(igrPrefix))) {
      rows.push({ txnId: row.txnId, entries: row.entries });
    }
  }
  return computeOutstandingItemGrants(rows);
}

async function listManualTransactions(options: { limit: number, cursor: string | undefined }): Promise<{ rows: ManualTransactionRow[], nextCursor: string | null }> {
  const { snapshot } = await bulldozerDb.getSnapshot();
  // Page the identifier-sorted derived table (sort key === rowIdentifier). Stored
  // tables keep a null sort key, so Range stays sort-key-only everywhere.
  const range = options.cursor !== undefined
    ? { gt: options.cursor, limit: options.limit + 1 }
    : { limit: options.limit + 1 };
  const rows: ManualTransactionRow[] = [];
  let lastReturnedRowIdentifier: string | undefined = undefined;
  for await (const row of snapshot.listRowsInGroup({ tableId: schema.manualTransactionsSorted, groupKey: null, range })) {
    rows.push(row.rowData as unknown as ManualTransactionRow);
    // Stop after the peek row, but do not treat it as the page cursor — `gt` must
    // resume after the last *returned* rowIdentifier or we skip that row.
    if (rows.length > options.limit) break;
    lastReturnedRowIdentifier = row.rowIdentifier;
  }
  const hasMore = rows.length > options.limit;
  if (hasMore) rows.pop();
  return {
    rows,
    nextCursor: hasMore && lastReturnedRowIdentifier !== undefined ? lastReturnedRowIdentifier : null,
  };
}

function ok() {
  return { success: true };
}

const bulldozerServerSecret = process.env.HEXCLAVE_BULLDOZER_SERVER_SECRET ?? "";
if (bulldozerServerSecret.length === 0) {
  throw new HexclaveAssertionError("bulldozer-js refuses to start: HEXCLAVE_BULLDOZER_SERVER_SECRET is not set. This shared secret authenticates the backend to bulldozer-js and must be configured (it has a default in .env.development for local/self-host).");
}
let isShuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let stopHttpServer: (() => void | Promise<void>) | undefined;

const app = new Elysia({ adapter: node() })
  .use(instrumentation)
  // Blanket auth gate: runs before routing so it covers every route, including
  // /health (no unauthenticated surface). Returning a Response short-circuits.
  .onRequest(({ request }) => {
    if (!isBulldozerRequestAuthorized(request.headers.get("authorization"), bulldozerServerSecret)) {
      return new Response(JSON.stringify({ error: "unauthenticated" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
  })
  .get("/health", () => ({ ok: true }))
  .get("/diagnostics", () => getLmdbDiagnostics() ?? { available: false })
  .get("/v1/manual-transactions", ({ query }) => handler("list-manual-transactions", async () => {
    // Cross-instance export surface: backend pages this to back up refunds into Prisma.
    const { limit, cursor } = parseManualTransactionsListQuery(query);
    const result = await listManualTransactions({ limit, cursor });
    return { rows: result.rows, next_cursor: result.nextCursor };
  }))
  .post("/internal/wait-until-durable", () => handler("wait-until-durable", async () => {
    await bulldozerDb.waitUntilCurrentStateDurable();
    return ok();
  }))
  .post("/internal/piledriver-gc", ({ body }) => handler("piledriver-gc", async () => {
    const request = readObjectBody(body);
    const cutoffTimestampMillis = readNonNegativeSafeIntegerField(request, "cutoffTimestampMillis");
    if (cutoffTimestampMillis >= bulldozerDb.getPiledriverGarbageCollectionProcessStartedAtMillis()) {
      throw new StatusError(
        StatusError.BadRequest,
        "GC cutoff must be older than this Bulldozer process. Record the cutoff, then fully restart the singleton Bulldozer service before running GC.",
      );
    }
    return await bulldozerDb.collectPiledriverGarbage(
      cutoffTimestampMillis,
      request.maxObjects === undefined ? undefined : readPositiveSafeIntegerField(request, "maxObjects"),
    );
  }))
  .post("/internal/payments/verify-data-integrity", () => handler("verify-data-integrity", async () => ok()))
  .get("/v1/:tenancyId/transactions", ({ params, query }) => handler("list-transactions", async () => {
    const parsedLimit = Number.parseInt(typeof query.limit === "string" ? query.limit : "50", 10);
    const result = await listTransactions({
      tenancyId: params.tenancyId,
      limit: Math.max(1, Math.min(200, Number.isFinite(parsedLimit) ? parsedLimit : 50)),
      cursor: typeof query.cursor === "string" ? query.cursor : undefined,
      type: parseTransactionType(typeof query.type === "string" ? query.type : undefined),
      customerType: typeof query.customer_type === "string" ? parseCustomerType(query.customer_type) : undefined,
      customerId: typeof query.customer_id === "string" ? query.customer_id : undefined,
    });
    return { transactions: result.transactions, next_cursor: result.nextCursor };
  }))
  .get("/v1/:tenancyId/customers/:customerType/:customerId/transactions", ({ params, query }) => handler("list-customer-transactions", async () => {
    const parsedLimit = Number.parseInt(typeof query.limit === "string" ? query.limit : "50", 10);
    const result = await listTransactions({
      tenancyId: params.tenancyId,
      limit: Math.max(1, Math.min(200, Number.isFinite(parsedLimit) ? parsedLimit : 50)),
      cursor: typeof query.cursor === "string" ? query.cursor : undefined,
      type: parseTransactionType(typeof query.type === "string" ? query.type : undefined),
      customerType: parseCustomerType(params.customerType),
      customerId: params.customerId,
    });
    return { transactions: result.transactions, next_cursor: result.nextCursor };
  }))
  .post("/v1/:tenancyId/transactions/:transactionId/refund", ({ params, body }) => handler("set-manual-transaction", async () => {
    await setManualTransactionRow({ tenancyId: params.tenancyId, transactionId: params.transactionId, body });
    return ok();
  }))
  .post("/v1/:tenancyId/refunds/prior-summary", ({ params, body }) => handler("refund-prior-summary", async () => {
    const request = readObjectBody(body);
    return await readPriorRefundSummary({
      tenancyId: params.tenancyId,
      customerType: parseCustomerType(readStringField(request, "customerType")),
      customerId: readStringField(request, "customerId"),
      sourceTxnId: readStringField(request, "sourceTxnId"),
    });
  }))
  .post("/v1/:tenancyId/refunds/outstanding-item-grants", ({ params, body }) => handler("refund-outstanding-item-grants", async () => {
    const request = readObjectBody(body);
    return {
      grants: await readOutstandingItemGrants({
        tenancyId: params.tenancyId,
        customerType: parseCustomerType(readStringField(request, "customerType")),
        customerId: readStringField(request, "customerId"),
        sourceTxnId: readStringField(request, "sourceTxnId"),
        igrSourceId: readStringField(request, "igrSourceId"),
      }),
    };
  }))
  .get("/v1/:tenancyId/customers/:customerType/:customerId/owned-products", ({ params }) => handler("get-owned-products", async () => ({
    ownedProducts: await getOwnedProductsForCustomer({ tenancyId: params.tenancyId, customerType: parseCustomerType(params.customerType), customerId: params.customerId }),
  })))
  .get("/v1/:tenancyId/customers/:customerType/:customerId/item-quantities", ({ params }) => handler("get-item-quantities", async () => ({
    itemQuantities: await getItemQuantitiesForCustomer({ tenancyId: params.tenancyId, customerType: parseCustomerType(params.customerType), customerId: params.customerId }),
  })))
  .get("/v1/:tenancyId/customers/:customerType/:customerId/subscriptions", ({ params }) => handler("get-subscriptions", async () => ({
    subscriptions: await getSubscriptionMapForCustomer({ tenancyId: params.tenancyId, customerType: parseCustomerType(params.customerType), customerId: params.customerId }),
  })))
  .post("/v1/:tenancyId/customers/:customerType/:customerId/manual-product-grants", () => notImplemented("create-manual-product-grant"))
  .post("/v1/:tenancyId/customers/:customerType/:customerId/manual-item-quantity-changes", ({ params, body }) => handler("set-manual-item-quantity-change", async () => {
    const rowData = readRowData(body);
    if (rowData.customerType !== params.customerType || rowData.customerId !== params.customerId) throw new StatusError(StatusError.BadRequest, "Manual item quantity change row does not match URL customer");
    await setStoredRow({ tenancyId: params.tenancyId, tableId: schema.manualItemQuantityChanges, rowId: readStringField(rowData, "id"), rowData });
    return ok();
  }))
  .post("/v1/:tenancyId/stripe/subscription-invoices/changed", ({ params, body }) => handler("set-subscription-invoice", async () => {
    await setStoredRowFromBody({ tenancyId: params.tenancyId, tableId: schema.subscriptionInvoices, body });
    return ok();
  }))
  .post("/v1/:tenancyId/stripe/subscriptions/changed", ({ params, body }) => handler("set-subscription", async () => {
    await setStoredRowFromBody({ tenancyId: params.tenancyId, tableId: schema.subscriptions, body });
    return ok();
  }))
  .post("/v1/:tenancyId/stripe/one-time-purchases/changed", ({ params, body }) => handler("set-one-time-purchase", async () => {
    await setStoredRowFromBody({ tenancyId: params.tenancyId, tableId: schema.oneTimePurchases, body });
    return ok();
  }))
  // ── Batch ingress ────────────────────────────────────────────────────
  // One snapshot write + one downstream cascade per batch (see setOrDeleteRows).
  // Used by the Postgres->bulldozer backfill; the live dual-write still uses the
  // single-row routes above. Body shape: { rows: [{ rowData }, ...] }.
  .post("/v1/:tenancyId/stripe/subscriptions/changed-batch", ({ params, body }) => handler("set-subscriptions-batch", async () => {
    await setStoredRowsFromBodies({ tenancyId: params.tenancyId, tableId: schema.subscriptions, body });
    return ok();
  }))
  .post("/v1/:tenancyId/stripe/subscription-invoices/changed-batch", ({ params, body }) => handler("set-subscription-invoices-batch", async () => {
    await setStoredRowsFromBodies({ tenancyId: params.tenancyId, tableId: schema.subscriptionInvoices, body });
    return ok();
  }))
  .post("/v1/:tenancyId/stripe/one-time-purchases/changed-batch", ({ params, body }) => handler("set-one-time-purchases-batch", async () => {
    await setStoredRowsFromBodies({ tenancyId: params.tenancyId, tableId: schema.oneTimePurchases, body });
    return ok();
  }))
  .post("/v1/:tenancyId/manual-item-quantity-changes/changed-batch", ({ params, body }) => handler("set-manual-item-quantity-changes-batch", async () => {
    await setStoredRowsFromBodies({ tenancyId: params.tenancyId, tableId: schema.manualItemQuantityChanges, body });
    return ok();
  }))
  .post("/v1/:tenancyId/transactions/refund-batch", ({ params, body }) => handler("set-manual-transactions-batch", async () => {
    await setStoredRowsFromBodies({ tenancyId: params.tenancyId, tableId: schema.manualTransactions, body, rowIdField: "txnId" });
    return ok();
  }))
  .post("/v1/:tenancyId/test-mode/subscriptions", () => notImplemented("create-test-mode-subscription"))
  .post("/v1/:tenancyId/test-mode/subscriptions/:subscriptionId/end", () => notImplemented("end-test-mode-subscription"))
  .post("/v1/:tenancyId/test-mode/one-time-purchases", () => notImplemented("create-test-mode-one-time-purchase"))
  .post("/v1/:tenancyId/test-mode/subscriptions/:subscriptionId/switch", () => notImplemented("switch-test-mode-subscription"))
  .listen(port, (server) => {
    // @elysia/node 1.4.6 does not assign the server to app.server, so
    // Elysia.stop() throws even though the callback's server is running.
    stopHttpServer = () => server.stop();
  });

console.log(`Bulldozer JS server listening on http://localhost:${app.server?.port ?? port}`);

function shutDown(): Promise<void> {
  if (shutdownPromise === null) {
    isShuttingDown = true;
    shutdownPromise = traceSpan("bulldozer-js.shutdown", async () => {
      try {
        // Do not force-close active requests; database.close() serializes behind
        // any in-flight write or tick before draining the retained write seq.
        if (stopHttpServer === undefined) throw new Error("Bulldozer HTTP server started without providing a stop handle");
        await stopHttpServer();
      } finally {
        await bulldozerDb.close();
      }
    });
  }
  return shutdownPromise;
}

function requestShutdown(signal: "SIGINT" | "SIGTERM") {
  logBulldozerService("service-shutdown-requested", { signal });
  runAsynchronously(async () => {
    await shutDown();
    process.exitCode = signal === "SIGINT" ? 130 : 0;
    logBulldozerService("service-shutdown-complete", { signal, exitCode: process.exitCode });
  }, {
    onError: () => {
      process.exitCode = 1;
    },
  });
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

const startupFields = {
  port: app.server?.port ?? port,
  pid: process.pid,
  nodeVersion: process.version,
  sentryEnvironment: resolveBulldozerSentryEnvironment(),
  lowLevelBackend: process.env.HEXCLAVE_BULLDOZER_JS_LOW_LEVEL_BACKEND ?? "lmdb",
  usingTmpLmdb: process.env.HEXCLAVE_BULLDOZER_JS_USE_TMP_LMDB === "1",
  lmdbCompression: process.env.HEXCLAVE_BULLDOZER_JS_LMDB_COMPRESSION === "1",
  disableHeapReadCache: process.env.HEXCLAVE_BULLDOZER_JS_DISABLE_PILEDRIVER_HEAP_READ_CACHE === "1",
  bufferedPiledriverEnabled,
  gcExposed: globalThis.gc !== undefined,
  heapGcUsageThreshold: HEAP_GC_USAGE_THRESHOLD,
  heapGcMaxPasses: HEAP_GC_MAX_PASSES,
  memory: serviceMemoryUsage(),
};
logBulldozerService("service-started", startupFields, { periodic: true });

// Emit every boot to Sentry so restart/crash loops are visible. An OOM kill (and
// most hard crashes) terminate the process before anything can be reported, so we
// can't observe the death directly — but the *next* startup is observable. One
// occasional startup is normal (deploy/scale); a burst of them means the process
// keeps dying and being restarted. Gated on a real DSN so local dev reloads (which
// have no DSN and would otherwise route to console.error) don't look like errors.
if (sentryEnabled) {
  captureError("bulldozer-js:service-started", new HexclaveAssertionError(
    "bulldozer-js started. Emitted on every boot to surface restart/crash loops (e.g. OOM kills, which can't be captured at the moment of death).",
    startupFields,
  ));
}

// Periodically tick the bulldozer clock to process timefold-queued rows; clamp monotonically so a
// backwards wall-clock jump can't rewind it.
runAsynchronously(async () => {
  let lastTickMillis = 0;
  while (!isShuttingDown) {
    await traceSpan("bulldozer-js-tick-loop-iteration", async () => {
      const tickStartedAt = performance.now();
      try {
        lastTickMillis = Math.max(Date.now(), lastTickMillis);
        await bulldozerDb.withSnapshotConsistent(async snapshot => await snapshot.tick(new Date(lastTickMillis)));
      } catch (error) {
        logBulldozerService("tick-loop-error", {
          elapsedMs: performance.now() - tickStartedAt,
          lastTickMillis,
          memory: serviceMemoryUsage(),
        });
        captureError("bulldozer-js-tick-loop", error);
      }
      const elapsedMs = performance.now() - tickStartedAt;
      if (elapsedMs > TICK_LOOP_SLOW_MS) {
        logBulldozerService("tick-loop-slow", {
          elapsedMs,
          slowThresholdMs: TICK_LOOP_SLOW_MS,
          lastTickMillis,
          memory: serviceMemoryUsage(),
        }, { periodic: true });
      }
      // The HTTP server owns this periodic loop's lifetime; after it closes,
      // waiting for the next tick must not keep the process alive.
      await wait(1000, { unref: true });
    });
  }
});

export type App = typeof app;
