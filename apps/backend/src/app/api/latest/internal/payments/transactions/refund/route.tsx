import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { buildCreatedFieldsAuditMetadata, recordAuditEvent } from "@/lib/audit-log";
import { fetchBulldozerServerJson } from "@/lib/bulldozer-server-client";
import { bulldozerWriteOneTimePurchase, bulldozerWriteSubscription, persistRefundManualTransaction } from "@/lib/payments/bulldozer-dual-write";
import { ensureFreePlanForBillingTeam } from "@/lib/payments/ensure-free-plan";
import { makeRefundTxnId } from "@/lib/payments/refund-txn-id";
import { resolveSelectedPriceFromProduct } from "@/app/api/latest/internal/payments/transactions/transaction-builder";
import { ONE_TIME_PURCHASE_PRODUCT_GRANT_ENTRY_INDEX, SUBSCRIPTION_START_PRODUCT_GRANT_ENTRY_INDEX } from "@/lib/payments/transaction-entry-indexes";
import type { ManualTransactionRow, TransactionEntryData } from "@/lib/payments/schema/types";
import { getStripeForAccount } from "@/lib/stripe";
import type { Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, type PrismaClientTransaction } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared/dist/known-errors";
import { adaptSchema, adminAuthTypeSchema, moneyAmountSchema, productSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { moneyAmountToStripeUnits, stripeUnitsToMoneyAmount } from "@hexclave/shared/dist/utils/currencies";
import { SUPPORTED_CURRENCIES, type MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import type Stripe from "stripe";
import { InferType } from "yup";

const USD_CURRENCY = SUPPORTED_CURRENCIES.find((currency) => currency.code === "USD")
  ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");

/**
 * Builds parameters for `stripe.refunds.create`. The platform-fee invariant —
 * we never let Stripe reverse our charge-leg 0.9% application fee on refund —
 * lives here so it has exactly one source of truth.
 */
export function buildStripeRefundParams(args: {
  paymentIntentId: string,
  amountStripeUnits: number,
  metadata?: Record<string, string>,
}): Stripe.RefundCreateParams {
  return {
    payment_intent: args.paymentIntentId,
    amount: args.amountStripeUnits,
    ...(args.metadata ? { metadata: args.metadata } : {}),
    refund_application_fee: false,
  };
}

function readProductLineId(product: InferType<typeof productSchema>): string | null {
  const productLineId = Reflect.get(product, "productLineId");
  return typeof productLineId === "string" ? productLineId : null;
}

function getTotalUsdStripeUnits(options: {
  product: InferType<typeof productSchema>,
  priceId: string | null,
  quantity: number,
}): number {
  const selectedPrice = resolveSelectedPriceFromProduct(options.product, options.priceId);
  const usdPrice = selectedPrice?.USD;
  if (typeof usdPrice !== "string") {
    throw new KnownErrors.SchemaError("Refunds are only supported for USD-priced purchases.");
  }
  if (!Number.isFinite(options.quantity) || Math.trunc(options.quantity) !== options.quantity) {
    throw new HexclaveAssertionError("Purchase quantity is not an integer", { quantity: options.quantity });
  }
  return moneyAmountToStripeUnits(usdPrice as MoneyAmount, USD_CURRENCY) * options.quantity;
}

// ── Refund row construction ────────────────────────────────────────────────

/**
 * Derive a deterministic Stripe idempotency key from the tenancy, source
 * transaction, refund amount, and the cumulative amount already refunded
 * before this call. A network-level retry of the same admin click hits all
 * three identical inputs and dedupes at Stripe. Two intentional partials of
 * the same amount get distinct keys because `priorRefundedStripeUnits`
 * advances after the first one commits.
 *
 * Deliberately does NOT include `endAction` — changing this fingerprint would
 * break in-flight Stripe retries. Refund-row idempotency across Prisma /
 * Bulldozer dual-write retries is handled by `makeRefundTxnId` instead.
 */
function makeStripeIdempotencyKey(args: {
  tenancyId: string,
  sourceTxnId: string,
  amountStripeUnits: number,
  priorRefundedStripeUnits: number,
}): string {
  const fingerprint = `${args.tenancyId}:${args.sourceTxnId}:${args.amountStripeUnits}:${args.priorRefundedStripeUnits}`;
  return `refund:${createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
}

function buildProductRevocationEntry(options: {
  customerType: "user" | "team" | "custom",
  customerId: string,
  sourceTxnId: string,
  productGrantEntryIndex: number,
  productId: string | null,
  productLineId: string | null,
  quantity: number,
}): Extract<TransactionEntryData, { type: "product-revocation" }> {
  return {
    type: "product-revocation",
    customerType: options.customerType,
    customerId: options.customerId,
    adjustedTransactionId: options.sourceTxnId,
    adjustedEntryIndex: options.productGrantEntryIndex,
    quantity: options.quantity,
    productId: options.productId,
    productLineId: options.productLineId,
  };
}

/**
 * Money-transfer entry on a refund row. The amount is stored as a positive
 * decimal money string; the parent `type: "refund"` is the semantic
 * discriminator that tells consumers this is money flowing back to the
 * customer. (Storing a literal negative would break `moneyAmountSchema`,
 * which requires non-negative values.)
 */
function buildMoneyTransferEntry(options: {
  customerType: "user" | "team" | "custom",
  customerId: string,
  refundAmountStripeUnits: number,
}): Extract<TransactionEntryData, { type: "money-transfer" }> {
  return {
    type: "money-transfer",
    customerType: options.customerType,
    customerId: options.customerId,
    chargedAmount: {
      USD: stripeUnitsToMoneyAmount(options.refundAmountStripeUnits, USD_CURRENCY),
    },
  };
}

export function shouldRejectSubscriptionProductRevocationReplay(options: {
  endNow: boolean,
  productRevokedAt: Date | null,
  priorProductRevoked: boolean,
}): boolean {
  // The subscription marker alone is not enough to reject. If the Prisma /
  // subscription bulldozer write succeeded but the refund manual transaction
  // failed, the retry must still be allowed to write the canonical refund
  // product-revocation row.
  return options.endNow && options.productRevokedAt != null && options.priorProductRevoked;
}

export function getRefundDrivenImmediateEndedAt(options: {
  existingEndedAt: Date | null,
  now: Date,
}): Date {
  if (options.existingEndedAt != null && options.existingEndedAt <= options.now) {
    return options.existingEndedAt;
  }
  return options.now;
}

// ── Bulldozer reads: prior refund summary for a source txn ─────────────────

type PriorRefundSummary = {
  refundedStripeUnits: number,
  productRevoked: boolean,
};

async function readPriorRefundSummary(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  customerType: "user" | "team" | "custom",
  customerId: string,
  sourceTxnId: string,
}): Promise<PriorRefundSummary> {
  return await fetchBulldozerServerJson<PriorRefundSummary>({
    method: "POST",
    path: `/v1/${encodeURIComponent(options.tenancyId)}/refunds/prior-summary`,
    body: {
      customerType: options.customerType,
      customerId: options.customerId,
      sourceTxnId: options.sourceTxnId,
    },
  });
}

// ── Bulldozer reads: outstanding item grants for a refund ──────────────────
//
// A refund that ends product access immediately must expire every still-
// outstanding item grant tied to the purchase/subscription lifetime — grants
// from the initial txn (`otp:<id>` / `sub-start:<id>`) and from every
// `item-grant-repeat` txn — whose `expiresWhen` is `"when-purchase-expires"`
// or `"when-repeated"`. Permanent grants (`expiresWhen: null`) are left alone
// by design (matches `subscription-timefold-algo.ts:430-441`).
//
// Both refund paths emit these `item-quantity-expire` entries on the refund
// row itself: OTPs have no end event, and refund-driven subscription ends
// suppress their `subscription-end` transaction (see phase-1/transactions.ts),
// so the refund row is the single place the expiry is recorded. The walk is
// identical for both — only the source txnId and the igr `sourceId` differ.

type OutstandingItemGrant = {
  txnId: string,
  entryIndex: number,
  itemId: string,
  quantity: number,
};

/**
 * Pure dedup logic: given the source txn (`otp:<id>` / `sub-start:<id>`) and
 * all its item-grant-repeat txns, collect every `item-quantity-change` entry
 * then subtract any grant already referenced by a later `item-quantity-expire`
 * entry (which is how "when-repeated" grants get retired by subsequent IGRs).
 * Entries with `expiresWhen: null` are excluded — they're permanent by design.
 */
export function computeOutstandingItemGrants(
  rows: Array<{ txnId: unknown, entries: unknown }>,
): OutstandingItemGrant[] {
  const grants: OutstandingItemGrant[] = [];
  const expiredKeys = new Set<string>();
  const grantKey = (txnId: string, entryIndex: number) => `${txnId}:${entryIndex}`;

  for (const row of rows) {
    const txnId = row.txnId;
    if (typeof txnId !== "string") continue;
    const entries = row.entries;
    if (!Array.isArray(entries)) continue;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (typeof entry !== "object" || entry === null) continue;
      const type = Reflect.get(entry, "type");
      if (type === "item-quantity-change") {
        const expiresWhen = Reflect.get(entry, "expiresWhen");
        if (expiresWhen !== "when-purchase-expires" && expiresWhen !== "when-repeated") {
          // Permanent grants survive revocation (matches sub-end semantics).
          continue;
        }
        const itemId = Reflect.get(entry, "itemId");
        const quantity = Reflect.get(entry, "quantity");
        if (typeof itemId !== "string" || typeof quantity !== "number") continue;
        grants.push({ txnId, entryIndex: index, itemId, quantity });
      } else if (type === "item-quantity-expire") {
        const adjustedTxnId = Reflect.get(entry, "adjustedTransactionId");
        const adjustedIdx = Reflect.get(entry, "adjustedEntryIndex");
        if (typeof adjustedTxnId !== "string" || typeof adjustedIdx !== "number") continue;
        expiredKeys.add(grantKey(adjustedTxnId, adjustedIdx));
      }
    }
  }

  return grants.filter((g) => !expiredKeys.has(grantKey(g.txnId, g.entryIndex)));
}

/**
 * Reads the source txn and all its item-grant-repeat txns from bulldozer,
 * then computes the outstanding item grants. Works for both refund sources:
 *   - OTPs:          sourceTxnId `otp:<purchaseId>`,  igrSourceId `<purchaseId>`
 *   - subscriptions: sourceTxnId `sub-start:<subId>`, igrSourceId `<subId>`
 * `igrSourceId` is the `<sourceId>` segment of the igr txnId
 * (`igr:<sourceId>:<effectiveAtMillis>`).
 */
async function readOutstandingItemGrants(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  customerType: "user" | "team" | "custom",
  customerId: string,
  sourceTxnId: string,
  igrSourceId: string,
}): Promise<OutstandingItemGrant[]> {
  const response = await fetchBulldozerServerJson<{ grants: OutstandingItemGrant[] }>({
    method: "POST",
    path: `/v1/${encodeURIComponent(options.tenancyId)}/refunds/outstanding-item-grants`,
    body: {
      customerType: options.customerType,
      customerId: options.customerId,
      sourceTxnId: options.sourceTxnId,
      igrSourceId: options.igrSourceId,
    },
  });
  return response.grants;
}

// ── Stripe payment-intent resolution for invoice refunds ───────────────────

async function resolveInvoicePaymentIntentId(stripe: Stripe, stripeInvoiceId: string): Promise<string> {
  const invoice = await stripe.invoices.retrieve(stripeInvoiceId, { expand: ["payments"] });
  const payments = invoice.payments?.data;
  if (!payments || payments.length === 0) {
    throw new HexclaveAssertionError("Invoice has no payments", { stripeInvoiceId });
  }
  const paidPayment = payments.find((payment) => payment.status === "paid");
  if (!paidPayment) {
    throw new HexclaveAssertionError("Invoice has no paid payment", { stripeInvoiceId });
  }
  const paymentIntentId = paidPayment.payment.payment_intent;
  if (!paymentIntentId || typeof paymentIntentId !== "string") {
    throw new HexclaveAssertionError("Payment has no payment intent", { stripeInvoiceId });
  }
  return paymentIntentId;
}

/**
 * True when an error from a Stripe subscription lifecycle write
 * (`subscriptions.cancel` / `subscriptions.update`) means the subscription is
 * already terminal, so our write is a moot no-op and can be swallowed.
 *
 * Error shapes determined empirically against Stripe API `2025-06-30.basil`
 * (stripe-node 18.3.0):
 *   - `cancel()` on an already-canceled or never-existed sub
 *       → 404, `code: "resource_missing"`.
 *   - `update()` on a canceled sub (e.g. `cancel_at_period_end`)
 *       → 400, `rawType: "invalid_request_error"`, message "A canceled
 *         subscription can only update its cancellation_details and
 *         metadata.", and crucially **no `code`** — so it can only be matched
 *         on the message.
 *
 * Note `subscription_already_canceled` is intentionally absent: re-cancelling
 * a canceled sub returns `resource_missing`, not that code — it is never
 * actually emitted on this path.
 */
function isStripeSubscriptionAlreadyTerminalError(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  if (code === "resource_missing") {
    return true;
  }
  const rawType = (e as { rawType?: unknown }).rawType;
  const message = (e as { message?: unknown }).message;
  return rawType === "invalid_request_error"
    && typeof message === "string"
    && /canceled subscription can only update/i.test(message);
}

// ── Route ─────────────────────────────────────────────────────────────────

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      project: adaptSchema.defined(),
      tenancy: adaptSchema.defined(),
      adminUser: adaptSchema.optional(),
    }).defined(),
    body: yupObject({
      type: yupString().oneOf(["subscription", "one-time-purchase"]).defined(),
      id: yupString().defined(),
      invoice_id: yupString().optional(),
      amount_usd: moneyAmountSchema(USD_CURRENCY).defined(),
      // `end_action` collapses the previous two-flag API (`revoke_product`,
      // `end_subscription`) into a single tri-state matching the dashboard's
      // section-2 lifecycle picker:
      //   "now"           → end product access immediately. For subs:
      //                     cancel Stripe immediately + set endedAt=now +
      //                     write a product-revocation entry on the refund
      //                     row (which expires outstanding item grants via
      //                     subscription-end). For OTPs: set revokedAt=now +
      //                     write product-revocation + emit explicit
      //                     item-quantity-expire entries (no sub-end exists
      //                     for OTPs).
      //   "at-period-end" → cancel-at-period-end on the Stripe sub + set
      //                     endedAt=currentPeriodEnd. Subscriptions only —
      //                     OTPs have no period.
      //   undefined       → no lifecycle change; refund money only.
      end_action: yupString().oneOf(["now", "at-period-end"]).optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      success: yupBoolean().defined(),
      refund_transaction_id: yupString().defined(),
    }).defined(),
  }),
  handler: async ({ auth, body }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const amountUsd = body.amount_usd as MoneyAmount;
    const amountStripeUnits = moneyAmountToStripeUnits(amountUsd, USD_CURRENCY);
    const endAction = body.end_action;

    if (amountStripeUnits < 0) {
      throw new KnownErrors.SchemaError("Refund amount cannot be negative.");
    }

    const result = body.type === "one-time-purchase"
      ? await (async () => {
        if (body.invoice_id !== undefined) {
          throw new KnownErrors.SchemaError("invoice_id is not applicable to one-time purchases.");
        }
        if (endAction === "at-period-end") {
          throw new KnownErrors.SchemaError("end_action='at-period-end' is only valid for subscriptions; one-time purchases have no period.");
        }
        if (amountStripeUnits === 0 && endAction === undefined) {
          throw new KnownErrors.SchemaError("Refund must do something: specify a non-zero amount or set end_action='now'.");
        }
        return await handleOneTimePurchaseRefund({
          prisma,
          tenancy: auth.tenancy,
          purchaseId: body.id,
          amountUsd,
          amountStripeUnits,
          endNow: endAction === "now",
        });
      })()
      : await (async () => {
        // subscription path
        if (amountStripeUnits === 0 && endAction === undefined) {
          throw new KnownErrors.SchemaError("Refund must do something: specify a non-zero amount or set end_action.");
        }
        return await handleSubscriptionRefund({
          prisma,
          tenancy: auth.tenancy,
          subscriptionId: body.id,
          invoiceId: body.invoice_id,
          amountUsd,
          amountStripeUnits,
          endAction,
        });
      })();

    // Dashboard-only via recordAuditEvent. Never persist Stripe payment-intent IDs.
    const metadata = buildCreatedFieldsAuditMetadata({
      source: "payments.transactions.refund",
      fields: {
        purchase_type: body.type,
        purchase_id: body.id,
        amount_usd: amountUsd,
        refund_transaction_id: result.body.refund_transaction_id,
        ...(body.invoice_id != null ? { invoice_id: body.invoice_id } : {}),
        ...(endAction != null ? { end_action: endAction } : {}),
        customer_type: result.audit.customerType,
        customer_id: result.audit.customerId,
      },
    }) ?? {
        source: "payments.transactions.refund",
        purchase_type: body.type,
        purchase_id: body.id,
        refund_transaction_id: result.body.refund_transaction_id,
      };
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "payment.refund.created",
      targetUserId: result.audit.customerType === "user" ? result.audit.customerId : null,
      metadata,
    });

    return {
      statusCode: result.statusCode,
      bodyType: result.bodyType,
      body: result.body,
    };
  },
});

// ── Subscription refund handler ────────────────────────────────────────────
//
// Known concurrency / atomicity gaps (deferred to a follow-up):
//
// 1. **Race on cap check.** Two concurrent refund requests for the same
//    source can both call `readPriorRefundSummary` before either commits its
//    refund row, so both pass the cap check and over-refund. Wrapping this
//    flow in a Prisma `$transaction` does NOT fix it — the Bulldozer
//    manual-transaction write embeds its own `BEGIN; ... COMMIT;` (see
//    `lib/bulldozer/db/index.ts:162`), so its writes commit independently of any outer Prisma tx. A real fix
//    needs either a bulldozer-aware mutex (writes-table sentinel row, advisory
//    lock taken on a long-lived dedicated connection, etc.) or a "pending
//    refund intent" pattern that participates in the cap calc before Stripe is
//    called. In practice, refunds are admin-only and rare, so the race window
//    is small.
//
// 2. **Stripe + DB are not atomic.** A successful `stripe.refunds.create`
//    followed by a write failure leaves the customer refunded with no ledger
//    row. The Stripe idempotency key is derived from
//    `(tenancyId, sourceTxnId, amountStripeUnits, priorRefundedStripeUnits)`
//    — *not* from `refundTxnId` — so:
//      - Stripe-success → both-stores-fail → caller retries: `prior` is
//        unchanged (no Bulldozer row), the Stripe key matches, Stripe
//        dedupes, and the second attempt's dual-write recovers. Self-heals.
//      - Stripe-success → Prisma-ok / Bulldozer-fail → caller retries with
//        the same payload: `makeRefundTxnId` reuses the same `txnId`
//        (fingerprint includes Bulldozer prior, which did not advance), so
//        Prisma upserts and Bulldozer setRows converge. Self-heals.
//      - Both stores succeed → response lost → caller retries: `prior` now
//        includes the just-committed amount, so a fresh Stripe key and a
//        fresh refund txn id are generated and Stripe issues a second real
//        refund. This is the open hole — no out-of-band reconciliation
//        today. Tracked alongside (1).
async function handleSubscriptionRefund(options: {
  prisma: Awaited<ReturnType<typeof getPrismaClientForTenancy>>,
  tenancy: Tenancy,
  subscriptionId: string,
  invoiceId: string | undefined,
  amountUsd: MoneyAmount,
  amountStripeUnits: number,
  endAction: "now" | "at-period-end" | undefined,
}) {
  const { prisma, tenancy } = options;
  const endNow = options.endAction === "now";
  const endAtPeriodEnd = options.endAction === "at-period-end";
  const subscription = await prisma.subscription.findUnique({
    where: { tenancyId_id: { tenancyId: tenancy.id, id: options.subscriptionId } },
  });
  if (!subscription) {
    throw new KnownErrors.SubscriptionInvoiceNotFound(options.subscriptionId);
  }
  // Legacy refund backstop: the pre-rework flow set `refundedAt` and gated
  // all further refunds on it. The new bulldozer-derived prior-refund
  // summary doesn't see those legacy refunds, so without this gate an admin
  // could double-refund through Stripe on a previously-refunded purchase.
  // Preserve the legacy `SubscriptionAlreadyRefunded` known-error code so
  // callers catching by code still work.
  if (subscription.refundedAt) {
    throw new KnownErrors.SubscriptionAlreadyRefunded(subscription.id);
  }

  // End-at-period-end guard. Scheduling a subscription to end "at period
  // end" is meaningless once it is already ending or has ended — whether
  // that is a future cancel-at-period-end, a past natural expiry, or a
  // prior refund-driven immediate end (all of which leave `cancelAtPeriodEnd`
  // or `endedAt` set). Two failure modes follow from not catching it here:
  //   - Logical: the empty-entries refund row written by `amount=0` is
  //     invisible to `readPriorRefundSummary` (which only tracks money +
  //     product-revocation), so replays accumulate phantom no-op rows.
  //   - Hard error: when the sub already ended (e.g. a prior refund with
  //     end_action="now" canceled the Stripe sub), the endAtPeriodEnd branch
  //     below calls `stripe.subscriptions.update(..., cancel_at_period_end)`,
  //     which Stripe rejects outright — "A canceled subscription can only
  //     update its cancellation_details and metadata" — surfacing as a 500.
  // Reject the contradictory action regardless of refund amount; the admin
  // can still refund the money without `end_action`.
  if (endAtPeriodEnd && (subscription.cancelAtPeriodEnd || subscription.endedAt)) {
    throw new KnownErrors.SchemaError("Subscription is already scheduled to end; refund the amount without end_action='at-period-end'.");
  }

  // End-now guard for subscriptions that already ended *naturally* (webhook
  // cancel, period expiry — `endedAt` in the past, `productRevokedAt` null).
  // Such a subscription already emitted its `product-revocation` /
  // `item-quantity-expire` entries at the real `endedAt`. Re-ending it via a
  // refund would set `productRevokedAt`, making phase-1 drop that original
  // subscription-end txn and re-emit the lifecycle entries on the refund row
  // at refund time — silently moving the end forward and corrupting
  // point-in-time history for the [endedAt, now] window. There is nothing
  // left to end, so reject: the product is already gone and the admin should
  // refund the amount without `end_action`.
  //
  // Two cases are intentionally NOT caught here: a *future* `endedAt`
  // (cancel-at-period-end) — `end_action="now"` legitimately pulls that
  // forward; and a refund-driven end (`productRevokedAt` set) — that's a
  // replay and is handled below by `shouldRejectSubscriptionProductRevocationReplay`,
  // which still allows a crashed prior attempt to repair its missing refund row.
  if (endNow && subscription.endedAt && subscription.endedAt.getTime() <= Date.now() && !subscription.productRevokedAt) {
    throw new KnownErrors.SchemaError("Subscription has already ended; refund the amount without end_action='now'.");
  }

  const customerType = subscription.customerType.toLowerCase() as "user" | "team" | "custom";
  const isTestMode = subscription.creationSource === "TEST_MODE";
  // Only `PURCHASE_PAGE` subscriptions went through Stripe — they alone have a
  // creation invoice and a money flow. `TEST_MODE` and `API_GRANT` (server-/
  // admin-granted products, free/internal plans) have neither: there is no
  // `SubscriptionInvoice` to look up and no payment to refund. Both take the
  // same no-invoice, lifecycle-only refund path. Branching on `isTestMode`
  // alone (the pre-fix behaviour) sent `API_GRANT` subs down the Stripe path,
  // where the missing creation invoice threw `SubscriptionInvoiceNotFound`.
  const hasStripeInvoice = subscription.creationSource === "PURCHASE_PAGE";
  const product = subscription.product as InferType<typeof productSchema>;
  const productLineId = readProductLineId(product);

  if (options.amountStripeUnits > 0 && !hasStripeInvoice) {
    if (isTestMode) {
      throw new KnownErrors.TestModePurchaseNonRefundable();
    }
    throw new KnownErrors.SchemaError("This subscription was granted, not purchased through Stripe — there is no payment to refund. Retry without a refund amount (end_action only).");
  }

  // Determine which invoice this refund targets — defaults to the start invoice.
  let invoice: { id: string, stripeInvoiceId: string, amountTotal: number | null } | null = null;
  let sourceTxnId: string;
  if (options.invoiceId !== undefined) {
    const found = await prisma.subscriptionInvoice.findUnique({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: options.invoiceId } },
    });
    if (!found || found.stripeSubscriptionId !== subscription.stripeSubscriptionId) {
      throw new KnownErrors.SubscriptionInvoiceNotFound(options.invoiceId);
    }
    // `end_action="now"` is a sub-wide action (the product grant lives on
    // the sub-start txn, not on renewal txns), so it can only meaningfully
    // be paired with a refund targeting the creation invoice — or the default
    // no-invoice-id call which already implies start. Targeting a renewal
    // invoice with immediate end would write a product-revocation entry
    // pointing at a non-existent entry on the renewal txn.
    if (endNow && !found.isSubscriptionCreationInvoice) {
      throw new KnownErrors.SchemaError("Cannot end product access immediately when refunding a renewal invoice — product revocation applies to the subscription as a whole. Omit invoice_id or pass the creation invoice id.");
    }
    invoice = { id: found.id, stripeInvoiceId: found.stripeInvoiceId, amountTotal: found.amountTotal };
    sourceTxnId = found.isSubscriptionCreationInvoice
      ? `sub-start:${subscription.id}`
      : `sub-renewal:${found.id}`;
  } else if (hasStripeInvoice) {
    const startInvoices = await prisma.subscriptionInvoice.findMany({
      where: {
        tenancyId: tenancy.id,
        isSubscriptionCreationInvoice: true,
        subscription: { tenancyId: tenancy.id, id: subscription.id },
      },
    });
    if (startInvoices.length === 0) {
      throw new KnownErrors.SubscriptionInvoiceNotFound(subscription.id);
    }
    if (startInvoices.length > 1) {
      throw new HexclaveAssertionError("Multiple subscription creation invoices found for subscription", { subscriptionId: subscription.id });
    }
    const startInvoice = startInvoices[0];
    invoice = { id: startInvoice.id, stripeInvoiceId: startInvoice.stripeInvoiceId, amountTotal: startInvoice.amountTotal };
    sourceTxnId = `sub-start:${subscription.id}`;
  } else {
    // Test-mode / API-granted sub has no Stripe invoice; refund references
    // the synthetic start txn.
    sourceTxnId = `sub-start:${subscription.id}`;
  }

  // Cap = original − sum(prior refunds for this source txn). Test-mode and
  // API-granted subs have no money flow (amount must be 0 anyway, see check
  // above), so the cap is irrelevant — short-circuit to 0 to avoid a USD-only
  // throw on non-USD granted/test-mode products. For Stripe purchases,
  // `getTotalUsdStripeUnits` enforces USD-only pricing (throws otherwise). The
  // invoice's `amountTotal` is the more accurate cap (reflects proration,
  // quantity changes, discounts), but SubscriptionInvoice doesn't persist the
  // invoice currency — so we only trust `amountTotal` after the USD pre-flight
  // has succeeded.
  const productCapStripeUnits = hasStripeInvoice
    ? getTotalUsdStripeUnits({
      product,
      priceId: subscription.priceId ?? null,
      quantity: subscription.quantity,
    })
    : 0;
  const totalStripeUnits = hasStripeInvoice
    ? (invoice?.amountTotal ?? productCapStripeUnits)
    : 0;

  const prior = await readPriorRefundSummary({
    prisma,
    tenancyId: tenancy.id,
    customerType,
    customerId: subscription.customerId,
    sourceTxnId,
  });
  const remainingStripeUnits = Math.max(0, totalStripeUnits - prior.refundedStripeUnits);
  if (options.amountStripeUnits > remainingStripeUnits) {
    throw new KnownErrors.SchemaError(`Refund amount cannot exceed the remaining refundable amount ($${stripeUnitsToMoneyAmount(remainingStripeUnits, USD_CURRENCY)}).`);
  }
  // Replay gate for endNow on subs. Require both the durable subscription
  // marker and the refund ledger entry before rejecting; if a prior attempt
  // failed after marking the subscription but before writing the refund row,
  // the retry must still be able to repair the missing canonical revocation.
  if (shouldRejectSubscriptionProductRevocationReplay({
    endNow,
    productRevokedAt: subscription.productRevokedAt,
    priorProductRevoked: prior.productRevoked,
  })) {
    throw new KnownErrors.SchemaError("This subscription's product has already been revoked.");
  }

  // amountStripeUnits / prior.refundedStripeUnits are already integer cents:
  // the handler entrypoint ran moneyAmountToStripeUnits, and prior is summed
  // the same way in bulldozer. makeRefundTxnId asserts that invariant
  // (HexclaveAssertionError → sanitized 500 if violated).
  const refundTxnId = makeRefundTxnId(
    tenancy.id,
    sourceTxnId,
    options.amountStripeUnits,
    prior.refundedStripeUnits,
    options.endAction ?? "none",
  );

  // ── Stripe side ───────────────────────────────────────────────────────
  if (options.amountStripeUnits > 0 && !isTestMode) {
    const stripe = await getStripeForAccount({ tenancy });
    const paymentIntentId = await resolveInvoicePaymentIntentId(stripe, invoice!.stripeInvoiceId);
    await stripe.refunds.create(
      buildStripeRefundParams({
        paymentIntentId,
        amountStripeUnits: options.amountStripeUnits,
        metadata: {
          tenancyId: tenancy.id,
          subscriptionId: subscription.id,
          refundTxnId,
          ...(invoice ? { invoiceId: invoice.id } : {}),
        },
      }),
      {
        idempotencyKey: makeStripeIdempotencyKey({
          tenancyId: tenancy.id,
          sourceTxnId,
          amountStripeUnits: options.amountStripeUnits,
          priorRefundedStripeUnits: prior.refundedStripeUnits,
        }),
      },
    );
  }

  // ── Lifecycle: Prisma + Stripe ────────────────────────────────────────
  const now = new Date();
  let updatedSub: typeof subscription | null = null;
  if (endNow) {
    // Immediate end. Stripe sub canceled, Prisma endedAt=now → timefold
    // auto-emits subscription-end with item-quantity-expire entries. Preserve
    // an existing past `endedAt` if the sub already ended naturally; a future
    // scheduled end must be pulled forward to now.
    const endedAt = getRefundDrivenImmediateEndedAt({
      existingEndedAt: subscription.endedAt,
      now,
    });
    if (!isTestMode && subscription.stripeSubscriptionId) {
      const stripe = await getStripeForAccount({ tenancy });
      // Idempotent cancel: the Stripe sub may already be canceled (natural
      // end before this refund, or a prior refund). Re-cancelling a canceled
      // sub is not an error from our perspective — see
      // `isStripeSubscriptionAlreadyTerminalError` for the exact shapes.
      try {
        await stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
      } catch (e: unknown) {
        if (!isStripeSubscriptionAlreadyTerminalError(e)) {
          throw e;
        }
      }
    }
    updatedSub = await prisma.subscription.update({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: subscription.id } },
      data: {
        // Don't touch `cancelAtPeriodEnd` — it's meaningless once `endedAt`
        // is in the past, and writing `true` alongside an immediate `endedAt`
        // creates inconsistent state for any reader that consults the flag
        // without joining `endedAt`.
        status: "canceled",
        canceledAt: subscription.canceledAt ?? now,
        endedAt,
        // Signal to phase-1 that this end was refund-driven, so its sub-end
        // mapper skips the auto-emitted `product-revocation` entry (the
        // refund row below already carries one — see the comment on the
        // entry push for why we need to avoid double-revocation).
        productRevokedAt: subscription.productRevokedAt ?? now,
      },
    });
  } else if (endAtPeriodEnd) {
    // End at period end. Items follow natural lifecycle when sub-end fires
    // at period boundary.
    if (!isTestMode && subscription.stripeSubscriptionId) {
      const stripe = await getStripeForAccount({ tenancy });
      // Idempotent guard, mirroring the endNow branch. The end-at-period-end
      // guard near the top of this handler already rejects subs that are
      // ending/ended, so this catch is defence-in-depth: it only fires if the
      // sub became terminal between that check and here (e.g. a concurrent
      // cancel). The Stripe money refund has already been issued at this
      // point, so an unhandled error would propagate before the Prisma +
      // Bulldozer dual-write commits the ledger row, leaving the
      // customer refunded with no record.
      try {
        await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
          cancel_at_period_end: true,
        });
      } catch (e: unknown) {
        if (!isStripeSubscriptionAlreadyTerminalError(e)) {
          throw e;
        }
      }
    }
    updatedSub = await prisma.subscription.update({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: subscription.id } },
      data: {
        cancelAtPeriodEnd: true,
        canceledAt: subscription.canceledAt ?? now,
        endedAt: subscription.endedAt ?? subscription.currentPeriodEnd,
      },
    });
  }

  if (updatedSub) {
    await bulldozerWriteSubscription(updatedSub);
  }

  // Regrant the free plan if a Hexclave billing team just lost its only
  // plans-line subscription to this refund. Scoped to the internal tenancy
  // (which hosts the free/team/growth plans) and team customers, mirroring
  // the DELETE cancel route and the Stripe webhook sync. Idempotent — no-ops
  // if the team still occupies the line (e.g. an `at-period-end` refund whose
  // `endedAt` is still in the future). Crucial for test-mode subs: they have
  // no Stripe object, so — unlike live-mode refunds — no
  // `customer.subscription.deleted` webhook fires to run this regrant via
  // `syncStripeSubscriptions`. Runs after `bulldozerWriteSubscription` so the
  // fast-path subscription LFold reflects the just-ended sub.
  if (updatedSub && tenancy.project.id === "internal" && customerType === "team") {
    await ensureFreePlanForBillingTeam(subscription.customerId);
  }

  // ── Refund row ────────────────────────────────────────────────────────
  const refundEntries: TransactionEntryData[] = [];
  if (options.amountStripeUnits > 0 && !isTestMode) {
    refundEntries.push(buildMoneyTransferEntry({
      customerType,
      customerId: subscription.customerId,
      refundAmountStripeUnits: options.amountStripeUnits,
    }));
  }
  if (endNow) {
    // Refund-driven immediate end. The `productRevokedAt=now` write on the
    // subscription row above makes phase-1 suppress the entire
    // subscription-end transaction (see phase-1/transactions.ts), so the
    // refund row carries the full end record itself — active-subscription-end,
    // product-revocation, and the item-quantity-expire entries — exactly
    // mirroring how one-time-purchase refunds work. Emitting them here rather
    // than letting sub-end do it keeps the revocation count correct for
    // stackable subs: two product-revocation entries against the same source
    // would double-subtract in the phase-3 owned-products LFold (masked by
    // the GREATEST(..., 0) clamp for single-sub customers, but corrupting
    // sibling subs' still-active grants).
    refundEntries.push({
      type: "active-subscription-end",
      customerType,
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
    });
    refundEntries.push(buildProductRevocationEntry({
      customerType,
      customerId: subscription.customerId,
      sourceTxnId,
      productGrantEntryIndex: SUBSCRIPTION_START_PRODUCT_GRANT_ENTRY_INDEX,
      productId: subscription.productId ?? null,
      productLineId,
      quantity: subscription.quantity,
    }));
    // Expire outstanding item grants from the sub-start txn and any
    // item-grant-repeat txns — the same walk used for OTP refunds. `endNow`
    // is rejected for renewal invoices, so `sourceTxnId` is always
    // `sub-start:<subId>` here.
    const outstandingGrants = await readOutstandingItemGrants({
      prisma,
      tenancyId: tenancy.id,
      customerType,
      customerId: subscription.customerId,
      sourceTxnId,
      igrSourceId: subscription.id,
    });
    for (const grant of outstandingGrants) {
      refundEntries.push({
        type: "item-quantity-expire",
        customerType,
        customerId: subscription.customerId,
        adjustedTransactionId: grant.txnId,
        adjustedEntryIndex: grant.entryIndex,
        itemId: grant.itemId,
        quantity: grant.quantity,
      });
    }
  }

  const nowMillis = now.getTime();
  const refundRow: ManualTransactionRow = {
    txnId: refundTxnId,
    tenancyId: tenancy.id,
    effectiveAtMillis: nowMillis,
    type: "refund",
    entries: refundEntries,
    customerType,
    customerId: subscription.customerId,
    // API-granted subs are neither test-mode nor Stripe-backed — `null`
    // payment provider (the listing route derives `test_mode: false` from it).
    paymentProvider: isTestMode ? "test_mode" : (hasStripeInvoice ? "stripe" : null),
    createdAtMillis: nowMillis,
    renewalTargetSubscriptionId: null,
  };
  // Same dual-write shape as subscriptions/OTPs: Prisma first, then Bulldozer.
  await persistRefundManualTransaction(prisma, refundRow);

  return {
    statusCode: 200 as const,
    bodyType: "json" as const,
    body: { success: true, refund_transaction_id: refundTxnId },
    audit: {
      customerType,
      customerId: subscription.customerId,
    },
  };
}

// ── One-time-purchase refund handler ───────────────────────────────────────
//
// See the concurrency / atomicity caveats on `handleSubscriptionRefund`
// above — the cap-check race and Stripe-vs-DB non-atomicity apply equally
// to OTPs.
async function handleOneTimePurchaseRefund(options: {
  prisma: Awaited<ReturnType<typeof getPrismaClientForTenancy>>,
  tenancy: Tenancy,
  purchaseId: string,
  amountUsd: MoneyAmount,
  amountStripeUnits: number,
  endNow: boolean,
}) {
  const { prisma, tenancy } = options;
  const purchase = await prisma.oneTimePurchase.findUnique({
    where: { tenancyId_id: { tenancyId: tenancy.id, id: options.purchaseId } },
  });
  if (!purchase) {
    throw new KnownErrors.OneTimePurchaseNotFound(options.purchaseId);
  }
  // Legacy refund backstop — see handleSubscriptionRefund above. Preserves
  // the legacy `OneTimePurchaseAlreadyRefunded` known-error code for callers
  // catching by code.
  if (purchase.refundedAt) {
    throw new KnownErrors.OneTimePurchaseAlreadyRefunded(purchase.id);
  }

  const customerType = purchase.customerType.toLowerCase() as "user" | "team" | "custom";
  const isTestMode = purchase.creationSource === "TEST_MODE";
  const product = purchase.product as InferType<typeof productSchema>;
  const productLineId = readProductLineId(product);

  if (isTestMode && options.amountStripeUnits > 0) {
    throw new KnownErrors.TestModePurchaseNonRefundable();
  }

  const sourceTxnId = `otp:${purchase.id}`;
  const totalStripeUnits = isTestMode
    ? 0
    : getTotalUsdStripeUnits({
      product,
      priceId: purchase.priceId ?? null,
      quantity: purchase.quantity,
    });

  const prior = await readPriorRefundSummary({
    prisma,
    tenancyId: tenancy.id,
    customerType,
    customerId: purchase.customerId,
    sourceTxnId,
  });
  const remainingStripeUnits = Math.max(0, totalStripeUnits - prior.refundedStripeUnits);
  if (options.amountStripeUnits > remainingStripeUnits) {
    throw new KnownErrors.SchemaError(`Refund amount cannot exceed the remaining refundable amount ($${stripeUnitsToMoneyAmount(remainingStripeUnits, USD_CURRENCY)}).`);
  }
  if (options.endNow && prior.productRevoked) {
    throw new KnownErrors.SchemaError("This purchase's product has already been revoked.");
  }

  // amountStripeUnits / prior.refundedStripeUnits are already integer cents:
  // the handler entrypoint ran moneyAmountToStripeUnits, and prior is summed
  // the same way in bulldozer. makeRefundTxnId asserts that invariant
  // (HexclaveAssertionError → sanitized 500 if violated).
  const refundTxnId = makeRefundTxnId(
    tenancy.id,
    sourceTxnId,
    options.amountStripeUnits,
    prior.refundedStripeUnits,
    options.endNow ? "now" : "none",
  );

  // ── Stripe side ───────────────────────────────────────────────────────
  if (options.amountStripeUnits > 0 && !isTestMode) {
    if (!purchase.stripePaymentIntentId) {
      throw new HexclaveAssertionError("Live-mode one-time purchase missing stripePaymentIntentId", { purchaseId: purchase.id });
    }
    const stripe = await getStripeForAccount({ tenancy });
    await stripe.refunds.create(
      buildStripeRefundParams({
        paymentIntentId: purchase.stripePaymentIntentId,
        amountStripeUnits: options.amountStripeUnits,
        metadata: { tenancyId: tenancy.id, purchaseId: purchase.id, refundTxnId },
      }),
      {
        idempotencyKey: makeStripeIdempotencyKey({
          tenancyId: tenancy.id,
          sourceTxnId,
          amountStripeUnits: options.amountStripeUnits,
          priorRefundedStripeUnits: prior.refundedStripeUnits,
        }),
      },
    );
  }

  // ── Lifecycle: Prisma ─────────────────────────────────────────────────
  const now = new Date();
  if (options.endNow) {
    const updatedPurchase = await prisma.oneTimePurchase.update({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: purchase.id } },
      data: { revokedAt: now },
    });
    await bulldozerWriteOneTimePurchase(updatedPurchase);
  }

  // ── Refund row ────────────────────────────────────────────────────────
  const refundEntries: TransactionEntryData[] = [];
  if (options.amountStripeUnits > 0 && !isTestMode) {
    refundEntries.push(buildMoneyTransferEntry({
      customerType,
      customerId: purchase.customerId,
      refundAmountStripeUnits: options.amountStripeUnits,
    }));
  }
  if (options.endNow) {
    refundEntries.push(buildProductRevocationEntry({
      customerType,
      customerId: purchase.customerId,
      sourceTxnId,
      productGrantEntryIndex: ONE_TIME_PURCHASE_PRODUCT_GRANT_ENTRY_INDEX,
      productId: purchase.productId ?? null,
      productLineId,
      quantity: purchase.quantity,
    }));
    // Expire outstanding item grants from the OTP txn and any
    // item-grant-repeat txns. See the helper docs above for the rationale.
    const outstandingGrants = await readOutstandingItemGrants({
      prisma,
      tenancyId: tenancy.id,
      customerType,
      customerId: purchase.customerId,
      sourceTxnId,
      igrSourceId: purchase.id,
    });
    for (const grant of outstandingGrants) {
      refundEntries.push({
        type: "item-quantity-expire",
        customerType,
        customerId: purchase.customerId,
        adjustedTransactionId: grant.txnId,
        adjustedEntryIndex: grant.entryIndex,
        itemId: grant.itemId,
        quantity: grant.quantity,
      });
    }
  }

  const nowMillis = now.getTime();
  const refundRow: ManualTransactionRow = {
    txnId: refundTxnId,
    tenancyId: tenancy.id,
    effectiveAtMillis: nowMillis,
    type: "refund",
    entries: refundEntries,
    customerType,
    customerId: purchase.customerId,
    paymentProvider: isTestMode ? "test_mode" : "stripe",
    createdAtMillis: nowMillis,
    renewalTargetSubscriptionId: null,
  };
  // Same dual-write shape as subscriptions/OTPs: Prisma first, then Bulldozer.
  await persistRefundManualTransaction(prisma, refundRow);

  return {
    statusCode: 200 as const,
    bodyType: "json" as const,
    body: { success: true, refund_transaction_id: refundTxnId },
    audit: {
      customerType,
      customerId: purchase.customerId,
    },
  };
}

// ── Inline tests for the Stripe params builder ─────────────────────────────

import.meta.vitest?.describe("buildStripeRefundParams", (test) => {
  test("always sets refund_application_fee: false to keep our 0.9% with the platform", ({ expect }) => {
    const params = buildStripeRefundParams({ paymentIntentId: "pi_test", amountStripeUnits: 5000 });
    expect(params.refund_application_fee).toBe(false);
  });
  test("propagates payment_intent and amount as-is", ({ expect }) => {
    const params = buildStripeRefundParams({ paymentIntentId: "pi_abc", amountStripeUnits: 1234 });
    expect(params.payment_intent).toBe("pi_abc");
    expect(params.amount).toBe(1234);
  });
  test("propagates metadata when provided and omits the key when not", ({ expect }) => {
    const withMeta = buildStripeRefundParams({
      paymentIntentId: "pi_x",
      amountStripeUnits: 1,
      metadata: { tenancyId: "t1", purchaseId: "p1" },
    });
    expect(withMeta.metadata).toEqual({ tenancyId: "t1", purchaseId: "p1" });
    expect(withMeta.refund_application_fee).toBe(false);

    const withoutMeta = buildStripeRefundParams({ paymentIntentId: "pi_x", amountStripeUnits: 1 });
    expect("metadata" in withoutMeta).toBe(false);
    expect(withoutMeta.refund_application_fee).toBe(false);
  });
  test("includes refundTxnId in metadata when threaded through", ({ expect }) => {
    const params = buildStripeRefundParams({
      paymentIntentId: "pi_x",
      amountStripeUnits: 1,
      metadata: { tenancyId: "t1", subscriptionId: "s1", refundTxnId: "refund:sub-start:abc:uuid" },
    });
    // Stripe types `metadata` as `MetadataParam | "" | undefined`; we know
    // we passed an object, so narrow before reading.
    const metadata = params.metadata;
    if (typeof metadata !== "object" || metadata === null) {
      throw new Error("expected metadata object");
    }
    expect(metadata.refundTxnId).toBe("refund:sub-start:abc:uuid");
  });
});

import.meta.vitest?.describe("computeOutstandingItemGrants", (test) => {
  test("returns when-purchase-expires and when-repeated grants from the OTP txn", ({ expect }) => {
    const otp = {
      txnId: "otp:p1",
      entries: [
        { type: "product-grant", customerType: "user", customerId: "u" },
        { type: "money-transfer", customerType: "user", customerId: "u" },
        { type: "item-quantity-change", customerType: "user", customerId: "u", itemId: "tokens", quantity: 50, expiresWhen: "when-purchase-expires" },
        { type: "item-quantity-change", customerType: "user", customerId: "u", itemId: "credits", quantity: 100, expiresWhen: "when-repeated" },
      ],
    };
    const out = computeOutstandingItemGrants([otp]);
    expect(out).toEqual([
      { txnId: "otp:p1", entryIndex: 2, itemId: "tokens", quantity: 50 },
      { txnId: "otp:p1", entryIndex: 3, itemId: "credits", quantity: 100 },
    ]);
  });

  test("excludes permanent (expiresWhen=null) grants — matches sub-end semantics", ({ expect }) => {
    const otp = {
      txnId: "otp:p1",
      entries: [
        { type: "product-grant", customerType: "user", customerId: "u" },
        { type: "item-quantity-change", customerType: "user", customerId: "u", itemId: "perma", quantity: 10, expiresWhen: null },
        { type: "item-quantity-change", customerType: "user", customerId: "u", itemId: "temp", quantity: 5, expiresWhen: "when-purchase-expires" },
      ],
    };
    const out = computeOutstandingItemGrants([otp]);
    expect(out).toEqual([
      { txnId: "otp:p1", entryIndex: 2, itemId: "temp", quantity: 5 },
    ]);
  });

  test("subtracts grants already retired by a later IGR's item-quantity-expire", ({ expect }) => {
    // OTP grants 100 credits (when-repeated). Then an IGR expires those and grants 100 fresh.
    // Only the latest 100 remain outstanding.
    const otp = {
      txnId: "otp:p1",
      entries: [
        { type: "product-grant", customerType: "user", customerId: "u" },
        { type: "item-quantity-change", customerType: "user", customerId: "u", itemId: "credits", quantity: 100, expiresWhen: "when-repeated" },
      ],
    };
    const igr = {
      txnId: "igr:p1:1000",
      entries: [
        { type: "item-quantity-expire", customerType: "user", customerId: "u", adjustedTransactionId: "otp:p1", adjustedEntryIndex: 1, itemId: "credits", quantity: 100 },
        { type: "item-quantity-change", customerType: "user", customerId: "u", itemId: "credits", quantity: 100, expiresWhen: "when-repeated" },
      ],
    };
    const out = computeOutstandingItemGrants([otp, igr]);
    expect(out).toEqual([
      { txnId: "igr:p1:1000", entryIndex: 1, itemId: "credits", quantity: 100 },
    ]);
  });

  test("accumulates when-purchase-expires grants across multiple IGRs (no auto-expiry)", ({ expect }) => {
    // Three monthly IGRs each granting 100 bonus tokens that expire only when the purchase does.
    const otp = {
      txnId: "otp:p1",
      entries: [{ type: "product-grant", customerType: "user", customerId: "u" }],
    };
    const igrs = [1000, 2000, 3000].map((t) => ({
      txnId: `igr:p1:${t}`,
      entries: [
        { type: "item-quantity-change", customerType: "user", customerId: "u", itemId: "bonus", quantity: 100, expiresWhen: "when-purchase-expires" },
      ],
    }));
    const out = computeOutstandingItemGrants([otp, ...igrs]);
    expect(out).toHaveLength(3);
    expect(out.map((g) => g.txnId)).toEqual(["igr:p1:1000", "igr:p1:2000", "igr:p1:3000"]);
  });

  test("ignores non-item entries and malformed rows", ({ expect }) => {
    const out = computeOutstandingItemGrants([
      { txnId: "otp:p1", entries: [
        { type: "product-grant" },
        { type: "money-transfer" },
        { type: "item-quantity-change", itemId: "x", quantity: 1, expiresWhen: "when-purchase-expires" },
      ] },
      // malformed: missing entries array
      { txnId: "otp:bad", entries: null },
      // malformed: non-string txnId
      { txnId: 42, entries: [] },
    ]);
    expect(out).toEqual([
      { txnId: "otp:p1", entryIndex: 2, itemId: "x", quantity: 1 },
    ]);
  });

  test("works identically for subscription sources (sub-start + igr txns)", ({ expect }) => {
    // sub-start txn entries: [active-subscription-start, product-grant,
    // money-transfer, ...item-quantity-change] — grants start at index 3.
    const subStart = {
      txnId: "sub-start:s1",
      entries: [
        { type: "active-subscription-start", customerType: "user", customerId: "u" },
        { type: "product-grant", customerType: "user", customerId: "u" },
        { type: "money-transfer", customerType: "user", customerId: "u" },
        { type: "item-quantity-change", customerType: "user", customerId: "u", itemId: "seats", quantity: 5, expiresWhen: "when-purchase-expires" },
        { type: "item-quantity-change", customerType: "user", customerId: "u", itemId: "credits", quantity: 100, expiresWhen: "when-repeated" },
      ],
    };
    // An item-grant-repeat retires the prior when-repeated grant and grants fresh.
    const igr = {
      txnId: "igr:s1:1000",
      entries: [
        { type: "item-quantity-expire", customerType: "user", customerId: "u", adjustedTransactionId: "sub-start:s1", adjustedEntryIndex: 4, itemId: "credits", quantity: 100 },
        { type: "item-quantity-change", customerType: "user", customerId: "u", itemId: "credits", quantity: 100, expiresWhen: "when-repeated" },
      ],
    };
    const out = computeOutstandingItemGrants([subStart, igr]);
    expect(out).toEqual([
      { txnId: "sub-start:s1", entryIndex: 3, itemId: "seats", quantity: 5 },
      { txnId: "igr:s1:1000", entryIndex: 1, itemId: "credits", quantity: 100 },
    ]);
  });
});
