/**
 * Dual-write helpers: convert Prisma payment rows to Bulldozer stored table
 * format and execute setRow. Called alongside every Prisma create/update/upsert
 * on the four payment models.
 *
 * The conversion functions (subscriptionToStoredRow, etc.) are also reused by
 * the ingress script (bulldozer-payments-init.ts).
 */

import { Prisma } from "@/generated/prisma/client";
import { bulldozerCustomerPath, fetchBulldozerServerJson } from "@/lib/bulldozer-server-client";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { isJsonSerializable } from "@hexclave/shared/dist/utils/json";
import {
  PAYMENT_PROVIDERS,
  TRANSACTION_TYPES,
  type ManualTransactionRow,
  type Json as PaymentJson,
  type PaymentProvider,
  type TransactionEntryData,
  type TransactionType,
} from "@/lib/payments/schema/types";

function dateToMillis(d: Date | null | undefined): number | null {
  return d ? d.getTime() : null;
}

function toStoredJson(value: unknown): PaymentJson {
  if (!isJsonSerializable(value)) {
    throw new Error("Payment row contains a value that cannot be stored as JSON");
  }
  return value;
}

// ── Conversion functions ──────────────────────────────────────────────
// Each takes a Prisma row (any shape from create/upsert/findUnique) and
// returns the Bulldozer stored table row format.

export function subscriptionToStoredRow(sub: {
  id: string,
  tenancyId: string,
  customerId: string,
  customerType: string,
  productId: string | null,
  priceId: string | null,
  product: unknown,
  quantity: number,
  stripeSubscriptionId: string | null,
  status: string,
  currentPeriodStart: Date,
  currentPeriodEnd: Date,
  cancelAtPeriodEnd: boolean,
  canceledAt: Date | null,
  endedAt: Date | null,
  refundedAt: Date | null,
  productRevokedAt: Date | null,
  creationSource: string,
  createdAt: Date,
}): Record<string, PaymentJson> {
  return {
    id: sub.id,
    tenancyId: sub.tenancyId,
    customerId: sub.customerId,
    customerType: sub.customerType.toLowerCase(),
    productId: sub.productId,
    priceId: sub.priceId,
    product: toStoredJson(sub.product),
    quantity: sub.quantity,
    stripeSubscriptionId: sub.stripeSubscriptionId,
    status: sub.status.toLowerCase(),
    currentPeriodStartMillis: dateToMillis(sub.currentPeriodStart),
    currentPeriodEndMillis: dateToMillis(sub.currentPeriodEnd),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    canceledAtMillis: dateToMillis(sub.canceledAt),
    endedAtMillis: dateToMillis(sub.endedAt),
    refundedAtMillis: dateToMillis(sub.refundedAt),
    productRevokedAtMillis: dateToMillis(sub.productRevokedAt),
    creationSource: sub.creationSource,
    createdAtMillis: dateToMillis(sub.createdAt),
  };
}

export function subscriptionInvoiceToStoredRow(inv: {
  id: string,
  tenancyId: string,
  stripeSubscriptionId: string,
  stripeInvoiceId: string,
  isSubscriptionCreationInvoice: boolean,
  status: string | null,
  amountTotal: number | null,
  hostedInvoiceUrl: string | null,
  createdAt: Date,
}): Record<string, PaymentJson> {
  return {
    id: inv.id,
    tenancyId: inv.tenancyId,
    stripeSubscriptionId: inv.stripeSubscriptionId,
    stripeInvoiceId: inv.stripeInvoiceId,
    isSubscriptionCreationInvoice: inv.isSubscriptionCreationInvoice,
    status: inv.status,
    amountTotal: inv.amountTotal,
    hostedInvoiceUrl: inv.hostedInvoiceUrl,
    createdAtMillis: dateToMillis(inv.createdAt),
  };
}

export function oneTimePurchaseToStoredRow(p: {
  id: string,
  tenancyId: string,
  customerId: string,
  customerType: string,
  productId: string | null,
  priceId: string | null,
  product: unknown,
  quantity: number,
  stripePaymentIntentId: string | null,
  revokedAt: Date | null,
  refundedAt: Date | null,
  creationSource: string,
  createdAt: Date,
}): Record<string, PaymentJson> {
  return {
    id: p.id,
    tenancyId: p.tenancyId,
    customerId: p.customerId,
    customerType: p.customerType.toLowerCase(),
    productId: p.productId,
    priceId: p.priceId,
    product: toStoredJson(p.product),
    quantity: p.quantity,
    stripePaymentIntentId: p.stripePaymentIntentId,
    revokedAtMillis: dateToMillis(p.revokedAt),
    refundedAtMillis: dateToMillis(p.refundedAt),
    creationSource: p.creationSource,
    createdAtMillis: dateToMillis(p.createdAt),
  };
}

export function itemQuantityChangeToStoredRow(c: {
  id: string,
  tenancyId: string,
  customerId: string,
  customerType: string,
  itemId: string,
  quantity: number,
  description: string | null,
  expiresAt: Date | null,
  createdAt: Date,
}): Record<string, PaymentJson> {
  return {
    id: c.id,
    tenancyId: c.tenancyId,
    customerId: c.customerId,
    customerType: c.customerType.toLowerCase(),
    itemId: c.itemId,
    quantity: c.quantity,
    description: c.description ?? null,
    expiresAtMillis: dateToMillis(c.expiresAt),
    createdAtMillis: dateToMillis(c.createdAt),
  };
}

export function manualTransactionToStoredRow(transaction: ManualTransactionRow): ManualTransactionRow {
  return transaction;
}

function prismaCustomerTypeFromManualTransaction(customerType: ManualTransactionRow["customerType"]): "USER" | "TEAM" | "CUSTOM" {
  switch (customerType) {
    case "user": {
      return "USER";
    }
    case "team": {
      return "TEAM";
    }
    case "custom": {
      return "CUSTOM";
    }
    default: {
      customerType satisfies never;
      throw new Error(`Invalid manual transaction customerType: ${JSON.stringify(customerType)}`);
    }
  }
}

function lowerCustomerType(customerType: string): "user" | "team" | "custom" {
  const lowered = customerType.toLowerCase();
  if (lowered === "user" || lowered === "team" || lowered === "custom") {
    return lowered;
  }
  throw new Error(`Invalid customer type for Bulldozer row: ${customerType}`);
}

export function manualTransactionToPrismaRow(transaction: ManualTransactionRow) {
  return {
    tenancyId: transaction.tenancyId,
    txnId: transaction.txnId,
    type: transaction.type,
    customerId: transaction.customerId,
    customerType: prismaCustomerTypeFromManualTransaction(transaction.customerType),
    paymentProvider: transaction.paymentProvider,
    effectiveAt: new Date(transaction.effectiveAtMillis),
    createdAt: new Date(transaction.createdAtMillis),
    // SAFETY: ManualTransactionRow entries are JSON-safe by construction; the
    // Prisma input type is wider than that persisted entry union.
    entries: transaction.entries as unknown as Prisma.InputJsonValue,
  };
}

function parseManualTransactionType(type: string): TransactionType {
  for (const candidate of TRANSACTION_TYPES) {
    if (candidate === type) return candidate;
  }
  throw new Error(`Invalid manual transaction type: ${type}`);
}

function parseManualTransactionPaymentProvider(paymentProvider: string | null): PaymentProvider | null {
  if (paymentProvider == null) return null;
  for (const candidate of PAYMENT_PROVIDERS) {
    if (candidate === paymentProvider) return candidate;
  }
  throw new Error(`Invalid manual transaction paymentProvider: ${paymentProvider}`);
}

/**
 * Inverse of `manualTransactionToPrismaRow` for backfill: Prisma → Bulldozer row.
 * Fail loud on scalar shape errors; entries must be a JSON array (element shapes are
 * enforced when Bulldozer applies the row).
 */
export function prismaManualTransactionToBulldozerRow(row: {
  tenancyId: string,
  txnId: string,
  type: string,
  customerId: string,
  customerType: string,
  paymentProvider: string | null,
  effectiveAt: Date,
  createdAt: Date,
  entries: unknown,
}): ManualTransactionRow {
  if (!Array.isArray(row.entries)) {
    throw new Error(`ManualTransaction ${row.tenancyId},${row.txnId} entries must be a JSON array`);
  }
  // Entries were stored from ManualTransactionRow; Bulldozer re-validates on write.
  // `as` is required because Prisma Json has no structural link to TransactionEntryData[].
  const entries = row.entries as TransactionEntryData[];
  return {
    txnId: row.txnId,
    tenancyId: row.tenancyId,
    type: parseManualTransactionType(row.type),
    customerId: row.customerId,
    customerType: lowerCustomerType(row.customerType),
    paymentProvider: parseManualTransactionPaymentProvider(row.paymentProvider),
    effectiveAtMillis: row.effectiveAt.getTime(),
    createdAtMillis: row.createdAt.getTime(),
    entries,
  };
}

// ── Dual-write executors ──────────────────────────────────────────────

async function postBulldozerRow(path: string, rowData: Record<string, unknown>) {
  await fetchBulldozerServerJson<{ success: true }>({
    method: "POST",
    path,
    body: { rowData },
  });
}

async function postBulldozerRowsBatch(path: string, rowsData: Record<string, unknown>[]) {
  if (rowsData.length === 0) return;
  await fetchBulldozerServerJson<{ success: true }>({
    method: "POST",
    path,
    body: { rows: rowsData.map((rowData) => ({ rowData })) },
  });
}

/**
 * Batch ingress is tenancy-scoped (the URL carries the tenancy), but a backfill
 * page is ordered by (tenancyId, id) and can straddle tenancies. Group first so
 * each POST is a single tenancy's rows.
 */
function groupByTenancy<T>(rows: T[], tenancyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const tenancyId = tenancyOf(row);
    const existing = groups.get(tenancyId);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(tenancyId, [row]);
    }
  }
  return groups;
}

function readManualTransactionTenancyId(transaction: ManualTransactionRow): string {
  const tenancyId = transaction.tenancyId;
  if (typeof tenancyId !== "string" || tenancyId.length === 0) {
    throw new Error("Manual transaction is missing tenancyId");
  }
  return tenancyId;
}

export async function bulldozerWriteSubscription(
  sub: Parameters<typeof subscriptionToStoredRow>[0],
) {
  await postBulldozerRow(
    urlString`/v1/${sub.tenancyId}/stripe/subscriptions/changed`,
    subscriptionToStoredRow(sub),
  );
}

export async function bulldozerWriteSubscriptionInvoice(
  inv: Parameters<typeof subscriptionInvoiceToStoredRow>[0],
) {
  await postBulldozerRow(
    urlString`/v1/${inv.tenancyId}/stripe/subscription-invoices/changed`,
    subscriptionInvoiceToStoredRow(inv),
  );
}

export async function bulldozerWriteOneTimePurchase(
  purchase: Parameters<typeof oneTimePurchaseToStoredRow>[0],
) {
  await postBulldozerRow(
    urlString`/v1/${purchase.tenancyId}/stripe/one-time-purchases/changed`,
    oneTimePurchaseToStoredRow(purchase),
  );
}

export async function bulldozerWriteItemQuantityChange(
  change: Parameters<typeof itemQuantityChangeToStoredRow>[0],
) {
  await postBulldozerRow(
    bulldozerCustomerPath({
      tenancyId: change.tenancyId,
      customerType: lowerCustomerType(change.customerType),
      customerId: change.customerId,
      suffix: "manual-item-quantity-changes",
    }),
    itemQuantityChangeToStoredRow(change),
  );
}

export async function bulldozerWriteManualTransaction(
  transactionId: string,
  transaction: ManualTransactionRow,
) {
  await postBulldozerRow(
    urlString`/v1/${readManualTransactionTenancyId(transaction)}/transactions/${transactionId}/refund`,
    manualTransactionToStoredRow(transaction),
  );
}

/**
 * Prisma-then-Bulldozer dual-write for a refund manual transaction. Shared by
 * the subscription and OTP refund handlers so field updates stay in sync.
 *
 * Upsert is the retry path for a *reused* `txnId` (see `makeRefundTxnId`):
 * same-payload retries after Prisma-ok / Bulldozer-fail converge on one row.
 * A freshly minted random id would create a second Prisma row instead.
 *
 * On conflict the first persisted row is immutable — `update: {}` keeps
 * effectiveAt / entries / createdAt from the original attempt. We then
 * dual-write *that* persisted row to Bulldozer (not the newly computed
 * retry payload), so a late retry cannot shift ledger timestamps or
 * recompute revocation/expiry entries under the same txnId.
 */
export async function persistRefundManualTransaction(
  prisma: { manualTransaction: { upsert: (args: {
    where: { tenancyId_txnId: { tenancyId: string, txnId: string } },
    create: ReturnType<typeof manualTransactionToPrismaRow>,
    // Empty on purpose: conflict = keep the canonical first row.
    update: Record<string, never>,
  }) => Promise<{
    tenancyId: string,
    txnId: string,
    type: string,
    customerId: string,
    customerType: string,
    paymentProvider: string | null,
    effectiveAt: Date,
    createdAt: Date,
    entries: unknown,
  }> } },
  refundRow: ManualTransactionRow,
): Promise<void> {
  const refundPrismaRow = manualTransactionToPrismaRow(refundRow);
  const persisted = await prisma.manualTransaction.upsert({
    where: {
      tenancyId_txnId: {
        tenancyId: refundPrismaRow.tenancyId,
        txnId: refundPrismaRow.txnId,
      },
    },
    create: refundPrismaRow,
    update: {},
  });
  await bulldozerWriteManualTransaction(
    persisted.txnId,
    prismaManualTransactionToBulldozerRow(persisted),
  );
}

// ── Batch dual-write executors (backfill only) ────────────────────────
// These mirror the single-row helpers but POST a whole page through the batch
// ingress routes, which collapse the downstream cascade into one pass per batch.
// The live dual-write path keeps using the single-row helpers above.

export async function bulldozerWriteSubscriptions(
  subs: Parameters<typeof subscriptionToStoredRow>[0][],
) {
  for (const [tenancyId, group] of groupByTenancy(subs, (sub) => sub.tenancyId)) {
    await postBulldozerRowsBatch(
      `/v1/${encodeURIComponent(tenancyId)}/stripe/subscriptions/changed-batch`,
      group.map(subscriptionToStoredRow),
    );
  }
}

export async function bulldozerWriteSubscriptionInvoices(
  invoices: Parameters<typeof subscriptionInvoiceToStoredRow>[0][],
) {
  for (const [tenancyId, group] of groupByTenancy(invoices, (inv) => inv.tenancyId)) {
    await postBulldozerRowsBatch(
      `/v1/${encodeURIComponent(tenancyId)}/stripe/subscription-invoices/changed-batch`,
      group.map(subscriptionInvoiceToStoredRow),
    );
  }
}

export async function bulldozerWriteOneTimePurchases(
  purchases: Parameters<typeof oneTimePurchaseToStoredRow>[0][],
) {
  for (const [tenancyId, group] of groupByTenancy(purchases, (purchase) => purchase.tenancyId)) {
    await postBulldozerRowsBatch(
      `/v1/${encodeURIComponent(tenancyId)}/stripe/one-time-purchases/changed-batch`,
      group.map(oneTimePurchaseToStoredRow),
    );
  }
}

export async function bulldozerWriteItemQuantityChanges(
  changes: Parameters<typeof itemQuantityChangeToStoredRow>[0][],
) {
  for (const [tenancyId, group] of groupByTenancy(changes, (change) => change.tenancyId)) {
    await postBulldozerRowsBatch(
      `/v1/${encodeURIComponent(tenancyId)}/manual-item-quantity-changes/changed-batch`,
      group.map(itemQuantityChangeToStoredRow),
    );
  }
}

export async function bulldozerWriteManualTransactions(
  transactions: ManualTransactionRow[],
) {
  for (const [tenancyId, group] of groupByTenancy(transactions, readManualTransactionTenancyId)) {
    await postBulldozerRowsBatch(
      `/v1/${encodeURIComponent(tenancyId)}/transactions/refund-batch`,
      group.map(manualTransactionToStoredRow),
    );
  }
}
