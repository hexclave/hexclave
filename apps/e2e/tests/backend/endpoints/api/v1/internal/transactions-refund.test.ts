import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { it } from "../../../../../helpers";
import { Auth, Payments, Project, niceBackendFetch } from "../../../../backend-helpers";
import {
  createLiveModeOneTimePurchaseTransaction,
  createPurchaseCode,
  createTestModeTransaction,
  setupProjectWithPaymentsConfig,
} from "../../../../helpers/payments";

/**
 * Spin up a project that has a subscription product configured, sign up a
 * user, and create a test-mode subscription via the test-mode-purchase-session
 * endpoint. Returns the new subscription's id.
 */
async function createTestModeSubscription(): Promise<{ subscriptionId: string, userId: string }> {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      products: {
        "sub-product": {
          displayName: "Sub Product",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            monthly: { USD: "50.00", interval: [1, "month"] },
          },
          includedItems: {},
        },
      },
      items: {},
    },
  });
  const { userId } = await Auth.fastSignUp();
  const code = await createPurchaseCode({ userId, productId: "sub-product" });
  const sessionRes = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    accessType: "admin",
    method: "POST",
    body: { full_code: code, price_id: "monthly", quantity: 1 },
  });
  expect(sessionRes.status).toBe(200);
  // The created subscription's id is on the resulting transaction's id.
  const txnsRes = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  const purchaseTxn = txnsRes.body.transactions.find((tx: any) => tx.type === "purchase");
  expect(purchaseTxn).toBeDefined();
  return { subscriptionId: purchaseTxn.id, userId };
}

/**
 * Create a server-granted (`API_GRANT`) subscription — granted via the
 * server products endpoint rather than purchased through Stripe, so it has
 * no `SubscriptionInvoice` and no money flow.
 */
async function createApiGrantSubscription(): Promise<{ subscriptionId: string, userId: string }> {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      products: {
        "sub-product": {
          displayName: "Sub Product",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            monthly: { USD: "50.00", interval: [1, "month"] },
          },
          includedItems: {},
        },
      },
      items: {},
    },
  });
  const { userId } = await Auth.fastSignUp();
  const grantRes = await niceBackendFetch(`/api/latest/payments/products/user/${userId}`, {
    accessType: "server",
    method: "POST",
    body: { product_id: "sub-product" },
  });
  expect(grantRes.status).toBe(200);
  const txnsRes = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  const purchaseTxn = txnsRes.body.transactions.find((tx: any) => tx.type === "purchase");
  expect(purchaseTxn).toBeDefined();
  return { subscriptionId: purchaseTxn.id, userId };
}

it("refunds a server-granted (API_GRANT) subscription with end_action='now'", async () => {
  // API_GRANT subs have no SubscriptionInvoice. The refund route must take
  // the no-invoice path for them instead of throwing SubscriptionInvoiceNotFound.
  const { subscriptionId, userId } = await createApiGrantSubscription();

  const productsBefore = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
  });
  expect(productsBefore.body.items).toHaveLength(1);

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refundRes.status).toBe(200);
  expect(refundRes.body.success).toBe(true);
  expect(refundRes.body.refund_transaction_id).toMatch(/^refund:sub-start:/);

  const productsAfter = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
  });
  expect(productsAfter.body.items).toHaveLength(0);
});

it("rejects a money refund on a server-granted (API_GRANT) subscription", async () => {
  // A granted subscription has no payment — a nonzero amount must be rejected
  // with a clear message (and a distinct error from test-mode's).
  const { subscriptionId } = await createApiGrantSubscription();

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      amount_usd: "10.00",
      end_action: "now",
    },
  });
  expect(refundRes.status).toBe(400);
  expect(refundRes.body.code).toBe("SCHEMA_ERROR");
  expect(refundRes.body.error).toMatch(/granted, not purchased/);
});

it("rejects refund when target subscription does not exist", async () => {
  await setupProjectWithPaymentsConfig();

  const missingId = randomUUID();
  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: missingId,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refundRes.status).toBe(404);
  expect(refundRes.body.code).toBe("SUBSCRIPTION_INVOICE_NOT_FOUND");
});

it("rejects refund when target one-time purchase does not exist", async () => {
  await setupProjectWithPaymentsConfig();

  const missingId = randomUUID();
  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: missingId,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refundRes.status).toBe(404);
  expect(refundRes.body.code).toBe("ONE_TIME_PURCHASE_NOT_FOUND");
});

it("rejects end_action='at-period-end' on a one-time purchase", async () => {
  await setupProjectWithPaymentsConfig();

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: randomUUID(),
      amount_usd: "0",
      end_action: "at-period-end",
    },
  });
  expect(refundRes.status).toBe(400);
  expect(refundRes.body.code).toBe("SCHEMA_ERROR");
  expect(refundRes.body.error).toMatch(/'at-period-end' is only valid for subscriptions/);
});

it("rejects no-op refund (amount=0, no end_action)", async () => {
  await setupProjectWithPaymentsConfig();

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: randomUUID(),
      amount_usd: "0",
    },
  });
  expect(refundRes.status).toBe(400);
  expect(refundRes.body.code).toBe("SCHEMA_ERROR");
  expect(refundRes.body.error).toMatch(/Refund must do something/);
});

it("rejects negative refund amount", async () => {
  const { purchaseTransaction } = await createLiveModeOneTimePurchaseTransaction();

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: purchaseTransaction.id,
      amount_usd: "-1",
    },
  });
  expect(refundRes.status).toBe(400);
  expect(refundRes.body.code).toBe("SCHEMA_ERROR");
});

it("refunds a test-mode one-time purchase by ending product access (no money flow)", async () => {
  await setupProjectWithPaymentsConfig();
  const { transactionId, userId } = await createTestModeTransaction("otp-product", "single");

  const productsBefore = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
  });
  expect(productsBefore.body.items).toHaveLength(1);

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: transactionId,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refundRes.status).toBe(200);
  expect(refundRes.body.success).toBe(true);
  expect(typeof refundRes.body.refund_transaction_id).toBe("string");
  expect(refundRes.body.refund_transaction_id).toMatch(/^refund:otp:/);

  const productsAfter = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
  });
  expect(productsAfter.body.items).toHaveLength(0);
});

it("rejects nonzero amount on a test-mode purchase (no money to refund)", async () => {
  await setupProjectWithPaymentsConfig();
  const { transactionId } = await createTestModeTransaction("otp-product", "single");

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: transactionId,
      amount_usd: "10",
      end_action: "now",
    },
  });
  expect(refundRes.status).toBe(400);
  expect(refundRes.body.code).toBe("TEST_MODE_PURCHASE_NON_REFUNDABLE");
});

it("refunds a live-mode OTP fully (money + end_action='now'), surfaces refund row, links via adjusted_by", async () => {
  const { userId, purchaseTransaction } = await createLiveModeOneTimePurchaseTransaction();

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: purchaseTransaction.id,
      amount_usd: "50.00",
      end_action: "now",
    },
  });
  expect(refundRes.status).toBe(200);
  expect(refundRes.body.success).toBe(true);
  const refundTxnId = refundRes.body.refund_transaction_id as string;
  expect(refundTxnId).toMatch(/^refund:otp:/);

  const transactionsAfter = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  expect(transactionsAfter.status).toBe(200);

  // Source purchase has adjusted_by linking to the refund.
  const refundedTransaction = transactionsAfter.body.transactions.find((tx: any) => tx.id === purchaseTransaction.id);
  expect(refundedTransaction).toBeDefined();
  expect(refundedTransaction.adjusted_by).toEqual([
    {
      entry_index: 0,
      transaction_id: refundTxnId,
    },
  ]);

  // Refund row appears in the listing with type="refund". Its `id` must
  // match the `adjusted_by.transaction_id` linkage so the dashboard can join
  // source rows to their refund rows.
  const refundRow = transactionsAfter.body.transactions.find((tx: any) => tx.type === "refund");
  expect(refundRow).toBeDefined();
  expect(refundRow.id).toBe(refundTxnId);

  const productsAfter = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
  });
  expect(productsAfter.body.items).toHaveLength(0);
});

it("supports multiple partial refunds capped at remaining amount", async () => {
  const { purchaseTransaction } = await createLiveModeOneTimePurchaseTransaction();

  // Two intentional partials of the *same* dollar amount must get distinct
  // refund txn ids — prior advances after the first commit, so the
  // deterministic fingerprint changes. (A same-payload *retry* before prior
  // advances would reuse the id; that is covered by unit tests on
  // makeRefundTxnId.)
  const refund1 = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: purchaseTransaction.id,
      amount_usd: "10.00",
    },
  });
  expect(refund1.status).toBe(200);
  expect(refund1.body.refund_transaction_id).toMatch(/^refund:otp:/);

  const refund2 = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: purchaseTransaction.id,
      amount_usd: "10.00",
    },
  });
  expect(refund2.status).toBe(200);
  expect(refund2.body.refund_transaction_id).toMatch(/^refund:otp:/);
  expect(refund2.body.refund_transaction_id).not.toBe(refund1.body.refund_transaction_id);

  // Remaining is $30.00 — a $30.00 refund should succeed and exhaust the cap.
  const refund3 = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: purchaseTransaction.id,
      amount_usd: "30.00",
    },
  });
  expect(refund3.status).toBe(200);
  expect(refund3.body.refund_transaction_id).not.toBe(refund1.body.refund_transaction_id);
  expect(refund3.body.refund_transaction_id).not.toBe(refund2.body.refund_transaction_id);

  // Fourth $0.01 refund — exceeds remaining ($0).
  const refund4 = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: purchaseTransaction.id,
      amount_usd: "0.01",
    },
  });
  expect(refund4.status).toBe(400);
  expect(refund4.body.code).toBe("SCHEMA_ERROR");
  expect(refund4.body.error).toMatch(/cannot exceed the remaining refundable amount/);
});

it("refunds fractional dollar amounts (2.39 then 2.50) with distinct txn ids", async () => {
  // moneyAmountToStripeUnits turns these into integer cents (239 / 250)
  // before makeRefundTxnId fingerprints them — so fractional USD must work
  // end-to-end and must not collide with each other.
  const { purchaseTransaction } = await createLiveModeOneTimePurchaseTransaction();

  const refund239 = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: purchaseTransaction.id,
      amount_usd: "2.39",
    },
  });
  expect(refund239.status).toBe(200);
  expect(refund239.body.refund_transaction_id).toMatch(/^refund:otp:.+:[0-9a-f]{32}$/);

  const refund250 = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: purchaseTransaction.id,
      amount_usd: "2.50",
    },
  });
  expect(refund250.status).toBe(200);
  expect(refund250.body.refund_transaction_id).toMatch(/^refund:otp:.+:[0-9a-f]{32}$/);
  expect(refund250.body.refund_transaction_id).not.toBe(refund239.body.refund_transaction_id);

  // Also accept the shorter "2.5" form (same cents as "2.50") as a later
  // partial once prior has advanced — distinct from the first 2.50 because
  // priorRefundedStripeUnits changed.
  const refund25Again = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: purchaseTransaction.id,
      amount_usd: "2.5",
    },
  });
  expect(refund25Again.status).toBe(200);
  expect(refund25Again.body.refund_transaction_id).not.toBe(refund250.body.refund_transaction_id);
});

it("rejects a full-amount money refund replay once the cap is exhausted", async () => {
  const { purchaseTransaction } = await createLiveModeOneTimePurchaseTransaction();

  const refund1 = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: purchaseTransaction.id,
      amount_usd: "50.00",
    },
  });
  expect(refund1.status).toBe(200);
  expect(refund1.body.refund_transaction_id).toMatch(/^refund:otp:.+:[0-9a-f]{32}$/);

  const refund2 = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: purchaseTransaction.id,
      amount_usd: "50.00",
    },
  });
  expect(refund2.status).toBe(400);
  expect(refund2.body.code).toBe("SCHEMA_ERROR");
  expect(refund2.body.error).toMatch(/cannot exceed the remaining refundable amount/);
});

it("rejects ending product access twice on the same OTP (productRevoked short-circuit)", async () => {
  const { purchaseTransaction } = await createLiveModeOneTimePurchaseTransaction();

  const refund1 = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: purchaseTransaction.id,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refund1.status).toBe(200);

  const refund2 = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: purchaseTransaction.id,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refund2.status).toBe(400);
  expect(refund2.body.code).toBe("SCHEMA_ERROR");
  expect(refund2.body.error).toMatch(/already been revoked/);
});

it("rejects refund amount exceeding original purchase amount", async () => {
  const { purchaseTransaction } = await createLiveModeOneTimePurchaseTransaction();

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: purchaseTransaction.id,
      amount_usd: "50.01",
    },
  });
  expect(refundRes.status).toBe(400);
  expect(refundRes.body.code).toBe("SCHEMA_ERROR");
  expect(refundRes.body.error).toMatch(/cannot exceed the remaining refundable amount/);
});

it("revoking one of two stackable subs leaves the sibling's product grant intact", async () => {
  // Regression for the double-revocation bug: when end_action="now" on a
  // sub, the refund row writes a product-revocation entry AND the
  // subscription timefold's sub-end event historically also emitted one.
  // The phase-3 owned-products LFold subtracted twice. Single-sub
  // customers were saved by the GREATEST(..., 0) clamp; stackable subs
  // weren't — the second subtraction ate into the sibling's still-active
  // grant. The fix: a refund-driven end sets Subscription.productRevokedAt,
  // which makes phase-1 suppress the whole subscription-end transaction —
  // so the refund row is the sole emitter of product-revocation (and of
  // active-subscription-end / item-quantity-expire).
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      products: {
        "stack-sub": {
          displayName: "Stack Sub",
          customerType: "user",
          serverOnly: false,
          stackable: true,
          prices: { monthly: { USD: "10.00", interval: [1, "month"] } },
          includedItems: {},
        },
      },
      items: {},
    },
  });
  const { userId } = await Auth.fastSignUp();

  // Create two subscriptions of the same stackable product.
  for (let i = 0; i < 2; i++) {
    const code = await createPurchaseCode({ userId, productId: "stack-sub" });
    const sessionRes = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
      accessType: "admin",
      method: "POST",
      body: { full_code: code, price_id: "monthly", quantity: 1 },
    });
    expect(sessionRes.status).toBe(200);
  }

  const productsBefore = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
  });
  const stackBefore = productsBefore.body.items.find((p: { id: string }) => p.id === "stack-sub");
  expect(stackBefore?.quantity).toBe(2);

  // Refund (and end) just ONE of the two subs.
  const txnsRes = await niceBackendFetch("/api/latest/internal/payments/transactions", { accessType: "admin" });
  const purchases = txnsRes.body.transactions.filter((tx: { type: string }) => tx.type === "purchase");
  expect(purchases.length).toBe(2);
  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: purchases[0].id,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refundRes.status).toBe(200);

  // The sibling sub still grants the product — count should be 1, not 0.
  const productsAfter = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
  });
  const stackAfter = productsAfter.body.items.find((p: { id: string }) => p.id === "stack-sub");
  expect(stackAfter?.quantity).toBe(1);
});

it("refunds a test-mode subscription with end_action='now'", async () => {
  const { subscriptionId, userId } = await createTestModeSubscription();

  // Customer has the product before refund.
  const productsBefore = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
  });
  expect(productsBefore.body.items).toHaveLength(1);

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refundRes.status).toBe(200);
  expect(refundRes.body.success).toBe(true);
  expect(refundRes.body.refund_transaction_id).toMatch(/^refund:sub-start:/);

  // The refund row's product-revocation entry strips the customer's product.
  const productsAfter = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
  });
  expect(productsAfter.body.items).toHaveLength(0);
});

it("surfaces customer_type and customer_id on a test-mode subscription refund row", async () => {
  // A test-mode subscription refund row's only public entry is a
  // product_revocation (or none, for at-period-end) — neither carries
  // customer fields. The transaction-level customer_type/customer_id let the
  // dashboard render the customer column instead of a blank row.
  const { subscriptionId, userId } = await createTestModeSubscription();

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refundRes.status).toBe(200);
  const refundTxnId = refundRes.body.refund_transaction_id as string;

  const transactionsAfter = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  expect(transactionsAfter.status).toBe(200);

  const refundRow = transactionsAfter.body.transactions.find((tx: any) => tx.id === refundTxnId);
  expect(refundRow).toBeDefined();
  expect(refundRow.type).toBe("refund");
  expect(refundRow.customer_type).toBe("user");
  expect(refundRow.customer_id).toBe(userId);
  expect(refundRow.test_mode).toBe(true);

  // Every transaction in the listing carries customer attribution, not just
  // refund rows.
  for (const tx of transactionsAfter.body.transactions) {
    expect(tx.customer_type).toBe("user");
    expect(tx.customer_id).toBe(userId);
  }
});

it("expires the subscription's item grants when refunded with end_action='now'", async () => {
  // Refund-driven ends emit no subscription-end transaction, so the refund
  // row itself must carry the item-quantity-expire entries — walked from the
  // sub-start txn (and any item-grant-repeat txns), exactly like OTP refunds.
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      items: {
        seats: { displayName: "Seats" },
      },
      products: {
        "sub-product": {
          displayName: "Sub Product",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            monthly: { USD: "50.00", interval: [1, "month"] },
          },
          includedItems: {
            seats: {
              quantity: 5,
              repeat: "never",
              expires: "when-purchase-expires",
            },
          },
        },
      },
    },
  });
  const { userId } = await Auth.fastSignUp();
  const code = await createPurchaseCode({ userId, productId: "sub-product" });
  const sessionRes = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    accessType: "admin",
    method: "POST",
    body: { full_code: code, price_id: "monthly", quantity: 1 },
  });
  expect(sessionRes.status).toBe(200);

  const txnsRes = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  const purchaseTxn = txnsRes.body.transactions.find((tx: any) => tx.type === "purchase");
  expect(purchaseTxn).toBeDefined();

  // The subscription grants 5 seats before the refund.
  const seatsBefore = await niceBackendFetch(`/api/v1/payments/items/user/${userId}/seats`, {
    accessType: "admin",
  });
  expect(seatsBefore.status).toBe(200);
  expect(seatsBefore.body.quantity).toBe(5);

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: purchaseTxn.id,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refundRes.status).toBe(200);

  // The refund row's item-quantity-expire entries should have retired the grant.
  const seatsAfter = await niceBackendFetch(`/api/v1/payments/items/user/${userId}/seats`, {
    accessType: "admin",
  });
  expect(seatsAfter.status).toBe(200);
  expect(seatsAfter.body.quantity).toBe(0);
});

it("rejects a second product revocation on the same subscription (productRevoked short-circuit)", async () => {
  const { subscriptionId } = await createTestModeSubscription();

  const refund1 = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refund1.status).toBe(200);

  const refund2 = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refund2.status).toBe(400);
  expect(refund2.body.code).toBe("SCHEMA_ERROR");
  expect(refund2.body.error).toMatch(/already been revoked/);
});

it("rejects end_action='now' on a subscription that already ended naturally", async () => {
  // A naturally-ended subscription already emitted its lifecycle entries at
  // the real endedAt. Re-ending it via a refund would re-stamp them at refund
  // time, corrupting point-in-time history — so end_action='now' is rejected.
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      items: {},
      productLines: {
        grp: { displayName: "Group" },
      },
      products: {
        base: {
          displayName: "Base",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          productLineId: "grp",
          prices: { monthly: { USD: "10.00", interval: [1, "month"] } },
          includedItems: {},
        },
        premium: {
          displayName: "Premium",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          productLineId: "grp",
          prices: { monthly: { USD: "20.00", interval: [1, "month"] } },
          includedItems: {},
        },
      },
    },
  });
  const { userId } = await Auth.fastSignUp();

  // Grant `base` → creates subscription A.
  const grantBase = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: { product_id: "base" },
  });
  expect(grantBase.status).toBe(200);
  const subscriptionId: string = grantBase.body.subscription_id;

  // Granting `premium` in the same product line ends subscription A naturally
  // (endedAt set, productRevokedAt null — no refund involved).
  const grantPremium = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: { product_id: "premium" },
  });
  expect(grantPremium.status).toBe(200);

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refundRes.status).toBe(400);
  expect(refundRes.body.code).toBe("SCHEMA_ERROR");
  expect(refundRes.body.error).toMatch(/already ended/);

  // Same for at-period-end — the sub already has endedAt from the product-line
  // switch, so scheduling another end is rejected.
  const atPeriodEndRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      amount_usd: "0",
      end_action: "at-period-end",
    },
  });
  expect(atPeriodEndRes.status).toBe(400);
  expect(atPeriodEndRes.body.code).toBe("SCHEMA_ERROR");
  expect(atPeriodEndRes.body.error).toMatch(/already scheduled to end|already ended/i);

  // Money-only must get past the lifecycle guards (not "already ended") and
  // fail for the money reason instead. API_GRANT has no Stripe payment, so
  // this is as far as e2e can go without invoice.payments on stripe-mock —
  // live-mode money-after-end is covered by manual QA.
  const moneyOnlyRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      amount_usd: "10.00",
    },
  });
  expect(moneyOnlyRes.status).toBe(400);
  expect(moneyOnlyRes.body.code).toBe("SCHEMA_ERROR");
  expect(moneyOnlyRes.body.error).toMatch(/granted, not purchased/);
  expect(moneyOnlyRes.body.error).not.toMatch(/already ended/);
});

it("allows a money-only refund attempt after end_action='now' (not blocked as already-ended)", async () => {
  // After a refund-driven immediate end, `productRevokedAt` is set so the
  // natural-end guard must not fire. Money-only should reach the test-mode
  // money check instead of "already ended".
  const { subscriptionId } = await createTestModeSubscription();

  const endNowRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(endNowRes.status).toBe(200);

  const moneyOnlyRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      amount_usd: "10.00",
    },
  });
  expect(moneyOnlyRes.status).toBe(400);
  // Reaches the money path (not the natural-end lifecycle guard).
  expect(moneyOnlyRes.body.code).toBe("TEST_MODE_PURCHASE_NON_REFUNDABLE");
});

it("refunds a test-mode subscription with end_action='at-period-end' (no money)", async () => {
  const { subscriptionId } = await createTestModeSubscription();

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      amount_usd: "0",
      end_action: "at-period-end",
    },
  });
  expect(refundRes.status).toBe(200);
  expect(refundRes.body.success).toBe(true);
});

it("rejects end-at-period-end sub refund replay (already scheduled to end)", async () => {
  const { subscriptionId } = await createTestModeSubscription();

  // First end-only refund succeeds and sets cancelAtPeriodEnd.
  const refund1 = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      amount_usd: "0",
      end_action: "at-period-end",
    },
  });
  expect(refund1.status).toBe(200);

  // Replay must be rejected; otherwise it'd accumulate phantom empty-entries
  // refund rows (readPriorRefundSummary doesn't track end-only events).
  const refund2 = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      amount_usd: "0",
      end_action: "at-period-end",
    },
  });
  expect(refund2.status).toBe(400);
  expect(refund2.body.code).toBe("SCHEMA_ERROR");
  expect(refund2.body.error).toMatch(/already scheduled to end/);
});

/**
 * Spin up a live-mode subscription via Stripe webhooks (creation + renewal
 * invoices), and return the prisma ids of both invoices plus the user/sub.
 * Used to exercise the `invoice_id` refund path against a renewal.
 */
async function createLiveModeSubscriptionWithRenewal(): Promise<{
  userId: string,
  subscriptionId: string,
  startInvoiceId: string,
  renewalInvoiceId: string,
}> {
  await Project.createAndSwitch();
  await Payments.setup();
  const subProduct = {
    displayName: "Sub Product",
    customerType: "user",
    serverOnly: false,
    stackable: false,
    prices: {
      monthly: { USD: "10.00", interval: [1, "month"] },
    },
    includedItems: {},
  };
  await Project.updateConfig({
    payments: {
      testMode: false,
      products: { "sub-product": subProduct },
      items: {},
    },
  });

  const { userId } = await Auth.fastSignUp();

  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", {
    accessType: "admin",
  });
  expect(accountInfo.status).toBe(200);
  const accountId: string = accountInfo.body.account_id;

  const code = await createPurchaseCode({ userId, productId: "sub-product" });
  const tenancyId = code.split("_")[0];

  const idSuffix = randomUUID().replace(/-/g, "");
  const nowSec = Math.floor(Date.now() / 1000);
  const stripeSubscription = {
    id: `sub_renewal_refund_${idSuffix}`,
    status: "active",
    items: {
      data: [
        {
          quantity: 1,
          current_period_start: nowSec - 60,
          current_period_end: nowSec + 60 * 60,
        },
      ],
    },
    metadata: {
      productId: "sub-product",
      product: JSON.stringify(subProduct),
      priceId: "monthly",
    },
    cancel_at_period_end: false,
  };

  const stackStripeMockData = {
    "accounts.retrieve": { metadata: { tenancyId } },
    "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
    "subscriptions.list": { data: [stripeSubscription] },
  };

  const baseInvoiceObject = {
    customer: `cus_renewal_refund_${idSuffix}`,
    stack_stripe_mock_data: stackStripeMockData,
    lines: {
      data: [
        {
          parent: {
            subscription_item_details: { subscription: stripeSubscription.id },
          },
        },
      ],
    },
  };

  const startWebhook = await Payments.sendStripeWebhook({
    id: `evt_renewal_refund_start_${idSuffix}`,
    type: "invoice.payment_succeeded",
    created: Math.floor(Date.now() / 1000),
    account: accountId,
    data: {
      object: {
        ...baseInvoiceObject,
        id: `in_renewal_refund_start_${idSuffix}`,
        billing_reason: "subscription_create",
      },
    },
  });
  expect(startWebhook.status).toBe(200);

  const renewalWebhook = await Payments.sendStripeWebhook({
    id: `evt_renewal_refund_cycle_${idSuffix}`,
    type: "invoice.payment_succeeded",
    created: Math.floor(Date.now() / 1000),
    account: accountId,
    data: {
      object: {
        ...baseInvoiceObject,
        id: `in_renewal_refund_cycle_${idSuffix}`,
        billing_reason: "subscription_cycle",
      },
    },
  });
  expect(renewalWebhook.status).toBe(200);

  const txnsRes = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  expect(txnsRes.status).toBe(200);

  const purchaseTxn = txnsRes.body.transactions.find((tx: any) => tx.type === "purchase");
  expect(purchaseTxn).toBeDefined();
  expect(purchaseTxn.renewal_target_subscription_id).toBeNull();
  const renewalTxn = txnsRes.body.transactions.find((tx: any) => tx.type === "subscription-renewal");
  expect(renewalTxn).toBeDefined();
  expect(renewalTxn.renewal_target_subscription_id).toBe(purchaseTxn.id);

  return {
    userId,
    subscriptionId: purchaseTxn.id,
    startInvoiceId: purchaseTxn.id,
    renewalInvoiceId: renewalTxn.id,
  };
}

it("refunds a renewal invoice (invoice_id path) without money or revoke — sourceTxnId is sub-renewal", { timeout: 120_000 }, async () => {
  const { subscriptionId, renewalInvoiceId } = await createLiveModeSubscriptionWithRenewal();

  // Use amount_usd=0 and end_action='at-period-end' to exercise the
  // invoice_id resolution path without touching Stripe refund-side calls
  // (which require the stripe-mock to return an invoice with paid payments —
  // out of scope for this test). The route must still resolve the renewal
  // invoice and stamp the refund row with `sourceTxnId = sub-renewal:<id>`.
  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      invoice_id: renewalInvoiceId,
      amount_usd: "0",
      end_action: "at-period-end",
    },
  });
  expect(refundRes.status).toBe(200);
  expect(refundRes.body.success).toBe(true);
  expect(refundRes.body.refund_transaction_id).toMatch(
    new RegExp(`^refund:sub-renewal:${renewalInvoiceId}:`),
  );

  // The refund row should link the *renewal* transaction via adjusted_by,
  // not the subscription-start row.
  const txnsAfter = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  expect(txnsAfter.status).toBe(200);
  const renewalTxn = txnsAfter.body.transactions.find(
    (tx: any) => tx.type === "subscription-renewal" && tx.id === renewalInvoiceId,
  );
  expect(renewalTxn).toBeDefined();
  expect(renewalTxn.adjusted_by).toEqual([
    {
      entry_index: 0,
      transaction_id: refundRes.body.refund_transaction_id,
    },
  ]);

  // And the source subscription row should NOT be linked, since this refund
  // targeted the renewal invoice.
  const startTxn = txnsAfter.body.transactions.find(
    (tx: any) => tx.type === "purchase" && tx.id === subscriptionId,
  );
  expect(startTxn?.adjusted_by ?? []).toEqual([]);

  // Refund row's listed `id` must match the linkage carried by adjusted_by.
  // Money-less renewal refunds have no money_transfer entry on the refund row.
  const refundRow = txnsAfter.body.transactions.find(
    (tx: any) => tx.type === "refund" && tx.id === refundRes.body.refund_transaction_id,
  );
  expect(refundRow).toBeDefined();
  expect(refundRow.entries.some((e: { type: string }) => e.type === "money_transfer")).toBe(false);
});

it("rejects a no-op renewal refund (amount=0, no end_action)", { timeout: 120_000 }, async () => {
  const { subscriptionId, renewalInvoiceId } = await createLiveModeSubscriptionWithRenewal();

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      invoice_id: renewalInvoiceId,
      amount_usd: "0",
    },
  });
  expect(refundRes.status).toBe(400);
  expect(refundRes.body.code).toBe("SCHEMA_ERROR");
  expect(refundRes.body.error).toMatch(/Refund must do something/);
});

it("rejects end_action='now' when invoice_id targets a renewal invoice", { timeout: 120_000 }, async () => {
  // The product grant lives on the sub-start txn, not on renewals — so a
  // revocation entry referencing a renewal would point at a non-existent
  // entry. Force admin to end-immediately against the start invoice (or the
  // default no-invoice-id call, which already implies start).
  const { subscriptionId, renewalInvoiceId } = await createLiveModeSubscriptionWithRenewal();

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      invoice_id: renewalInvoiceId,
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refundRes.status).toBe(400);
  expect(refundRes.body.code).toBe("SCHEMA_ERROR");
  expect(refundRes.body.error).toMatch(/Cannot end product access immediately when refunding a renewal invoice/);
});

it("rejects refund with invoice_id that does not belong to the subscription", { timeout: 120_000 }, async () => {
  const { subscriptionId } = await createLiveModeSubscriptionWithRenewal();
  const unrelatedInvoiceId = randomUUID();

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "subscription",
      id: subscriptionId,
      invoice_id: unrelatedInvoiceId,
      amount_usd: "0",
      end_action: "at-period-end",
    },
  });
  expect(refundRes.status).toBe(404);
  expect(refundRes.body.code).toBe("SUBSCRIPTION_INVOICE_NOT_FOUND");
});

it("rejects invoice_id on a one-time purchase", async () => {
  const { purchaseTransaction } = await createLiveModeOneTimePurchaseTransaction();

  const refundRes = await niceBackendFetch("/api/latest/internal/payments/transactions/refund", {
    accessType: "admin",
    method: "POST",
    body: {
      type: "one-time-purchase",
      id: purchaseTransaction.id,
      invoice_id: randomUUID(),
      amount_usd: "0",
      end_action: "now",
    },
  });
  expect(refundRes.status).toBe(400);
  expect(refundRes.body.code).toBe("SCHEMA_ERROR");
  expect(refundRes.body.error).toMatch(/invoice_id is not applicable to one-time purchases/);
});
