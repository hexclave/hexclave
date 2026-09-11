import type { Transaction } from "@hexclave/shared/dist/interface/crud/transactions";
import { describe, expect, it } from "vitest";
import {
  describeDetail,
  getRefundTarget,
  getRefundUnavailableReason,
  getRelatedSubscriptionId,
  getRelatedTransactionRefs,
  getTransactionFamilyId,
  getTransactionRowActions,
  getTransactionSummary,
  isLifecycleRowAction,
  isPaymentRowAction,
  listedIdFromLedgerTxnId,
  parseCustomerTypeParam,
  parsePaymentsEntityPath,
  parseRefundSourceTxnId,
  collectRelatedTransactions,
  describeProductGrantPrice,
  transactionPageHref,
} from "../payments/transaction-actions";

function makeTransaction(overrides: Partial<Transaction>): Transaction {
  return {
    id: "txn-1",
    created_at_millis: 1_700_000_000_000,
    effective_at_millis: 1_700_000_000_000,
    type: "purchase",
    customer_type: "user",
    customer_id: "user-1",
    renewal_target_subscription_id: null,
    entries: [],
    adjusted_by: [],
    test_mode: false,
    ...overrides,
  } as Transaction;
}

const PRO_GRANT = {
  type: "product_grant",
  adjusted_transaction_id: null,
  adjusted_entry_index: null,
  customer_type: "user",
  customer_id: "user-1",
  product_id: "pro",
  product: {
    display_name: "Pro",
    customer_type: "user",
    server_only: false,
    stackable: false,
    prices: {},
    included_items: {},
  },
  price_id: "monthly",
  quantity: 1,
  subscription_id: "sub-1",
} as const;

describe("getRefundTarget", () => {
  it("targets subscription renewals with invoiceId when renewal_target_subscription_id is set", () => {
    const renewal = makeTransaction({
      id: "inv-renewal-1",
      type: "subscription-renewal",
      renewal_target_subscription_id: "sub-42",
      entries: [
        {
          type: "money_transfer",
          adjusted_transaction_id: null,
          adjusted_entry_index: null,
          customer_type: "user",
          customer_id: "user-1",
          charged_amount: { USD: "19.00" },
          net_amount: { USD: "19.00" },
        },
      ],
    });
    expect(getRefundTarget(renewal)).toEqual({
      type: "subscription",
      id: "sub-42",
      invoiceId: "inv-renewal-1",
    });
  });

  it("does not target renewals missing renewal_target_subscription_id (pre-field rows)", () => {
    const renewal = makeTransaction({
      id: "inv-renewal-old",
      type: "subscription-renewal",
      renewal_target_subscription_id: null,
      entries: [
        {
          type: "money_transfer",
          adjusted_transaction_id: null,
          adjusted_entry_index: null,
          customer_type: "user",
          customer_id: "user-1",
          charged_amount: { USD: "19.00" },
          net_amount: { USD: "19.00" },
        },
      ],
    });
    expect(getRefundTarget(renewal)).toBeNull();
  });

  it("targets purchase rows via product_grant.subscription_id without invoiceId", () => {
    const purchase = makeTransaction({
      id: "sub-1",
      type: "purchase",
      entries: [PRO_GRANT],
    });
    expect(getRefundTarget(purchase)).toEqual({
      type: "subscription",
      id: "sub-1",
    });
  });
});

describe("getTransactionSummary — refund rows", () => {
  it("populates customer from transaction-level fields on a test-mode end-now refund row", () => {
    // A test-mode `end_action="now"` refund row's only surviving public entry
    // is a product_revocation, which carries no customer fields. The summary
    // must still resolve the customer from the transaction-level fields.
    const refundRow = makeTransaction({
      id: "refund:sub-start:sub-1:uuid",
      type: "refund",
      customer_type: "team",
      customer_id: "team-42",
      test_mode: true,
      entries: [
        { type: "product_revocation", adjusted_transaction_id: "sub-start:sub-1", adjusted_entry_index: 0, quantity: 1 },
      ],
    });

    const summary = getTransactionSummary(refundRow);
    expect(summary.customerType).toBe("team");
    expect(summary.customerId).toBe("team-42");
    expect(summary.detail).toBe("Subscription canceled");
    expect(summary.amountDisplay).toBe("—");
    expect(summary.displayType.label).toBe("Cancellation");
    expect(summary.status).toEqual({ label: "Test", color: "purple" });
  });

  it("renders an empty-entries refund row (test-mode end-at-period-end) with customer and detail", () => {
    // An `end_action="at-period-end"` test-mode refund writes a row with no
    // entries at all — it must not render as a fully blank line, and it is
    // a cancel, not a refund.
    const emptyRefund = makeTransaction({
      id: "refund:sub-start:sub-2:uuid",
      type: "refund",
      customer_type: "user",
      customer_id: "user-9",
      test_mode: true,
      entries: [],
    });

    const summary = getTransactionSummary(emptyRefund);
    expect(summary.customerType).toBe("user");
    expect(summary.customerId).toBe("user-9");
    expect(summary.detail).toBe("Cancels at period end");
    expect(summary.displayType.label).toBe("Cancellation");
    expect(summary.amountDisplay).toBe("—");
  });

  it("describes a money-only refund row as 'Refund' (no product revocation)", () => {
    const moneyRefund = makeTransaction({
      type: "refund",
      entries: [
        {
          type: "money_transfer",
          adjusted_transaction_id: "otp:p1",
          adjusted_entry_index: 0,
          customer_type: "user",
          customer_id: "user-1",
          charged_amount: { USD: "50.00" },
          net_amount: { USD: "50.00" },
        },
      ],
    });
    expect(describeDetail(moneyRefund)).toBe("Refund");
    expect(getTransactionSummary(moneyRefund).displayType.label).toBe("Refund");
    expect(getTransactionSummary(moneyRefund).amountDisplay).toBe("−$50.00");
  });

  it("labels a $0 one-time revoke as Revoke, not Refund", () => {
    const revokeRow = makeTransaction({
      id: "refund:otp:p1:uuid",
      type: "refund",
      test_mode: true,
      entries: [
        { type: "product_revocation", adjusted_transaction_id: "otp:p1", adjusted_entry_index: 0, quantity: 1 },
      ],
    });
    const summary = getTransactionSummary(revokeRow);
    expect(summary.displayType.label).toBe("Revoke");
    expect(summary.detail).toBe("Access revoked");
  });
});

describe("getTransactionSummary — original purchase status", () => {
  it("badges a canceled subscription purchase as Canceled, not Refunded, when no money moved", () => {
    const purchase = makeTransaction({
      type: "purchase",
      test_mode: true,
      entries: [PRO_GRANT],
      adjusted_by: [{ transaction_id: "refund:sub-start:sub-1:uuid", entry_index: 0 }],
    });
    expect(getTransactionSummary(purchase).status).toEqual({ label: "Canceled", color: "orange" });
    expect(getTransactionSummary(purchase).refunded).toBe(false);
  });

  it("badges a paid purchase as Refunded only when a money_transfer entry was adjusted", () => {
    const purchase = makeTransaction({
      entries: [
        PRO_GRANT,
        {
          type: "money_transfer",
          adjusted_transaction_id: null,
          adjusted_entry_index: null,
          customer_type: "user",
          customer_id: "user-1",
          charged_amount: { USD: "19.00" },
          net_amount: { USD: "19.00" },
        },
      ],
      adjusted_by: [{ transaction_id: "refund-1", entry_index: 1 }],
    });
    expect(getTransactionSummary(purchase).status).toEqual({ label: "Refunded", color: "orange" });
    expect(getTransactionSummary(purchase).refunded).toBe(true);
  });

  it("badges a revoked one-time purchase as Revoked", () => {
    const purchase = makeTransaction({
      test_mode: true,
      entries: [{ ...PRO_GRANT, subscription_id: undefined, one_time_purchase_id: "otp-1" }],
      adjusted_by: [{ transaction_id: "refund:otp:otp-1:uuid", entry_index: 0 }],
    });
    expect(getTransactionSummary(purchase).status).toEqual({ label: "Revoked", color: "orange" });
  });
});

describe("getTransactionSummary — non-refund rows still work", () => {
  it("derives customer from transaction-level fields and keeps item-change detail", () => {
    const itemTxn = makeTransaction({
      type: "manual-item-quantity-change",
      customer_type: "team",
      customer_id: "team-7",
      entries: [
        {
          type: "item_quantity_change",
          adjusted_transaction_id: null,
          adjusted_entry_index: null,
          customer_type: "team",
          customer_id: "team-7",
          item_id: "credits",
          quantity: 100,
        },
      ],
    });

    const summary = getTransactionSummary(itemTxn);
    expect(summary.customerType).toBe("team");
    expect(summary.customerId).toBe("team-7");
    expect(summary.detail).toBe("credits (+100)");
  });
});

describe("getRefundUnavailableReason", () => {
  it("explains refund rows, chargebacks, cancellations, and item changes", () => {
    expect(getRefundUnavailableReason(makeTransaction({
      type: "refund",
      entries: [{
        type: "money_transfer",
        adjusted_transaction_id: "otp:p1",
        adjusted_entry_index: 0,
        customer_type: "user",
        customer_id: "user-1",
        charged_amount: { USD: "50.00" },
        net_amount: { USD: "50.00" },
      }],
    }))).toMatch(/already a refund/);
    expect(getRefundUnavailableReason(makeTransaction({
      id: "refund:sub-start:sub-1:uuid",
      type: "refund",
      entries: [{ type: "product_revocation", adjusted_transaction_id: "sub-start:sub-1", adjusted_entry_index: 0, quantity: 1 }],
    }))).toMatch(/cancellation/);
    expect(getRefundUnavailableReason(makeTransaction({ type: "chargeback" }))).toMatch(/card network/);
    expect(getRefundUnavailableReason(makeTransaction({ type: "subscription-cancellation" }))).toMatch(/cancellation/);
    expect(getRefundUnavailableReason(makeTransaction({ type: "manual-item-quantity-change" }))).toMatch(/Item quantity/);
  });

  it("explains pre-field renewals and unlinked purchases", () => {
    expect(getRefundUnavailableReason(makeTransaction({
      type: "subscription-renewal",
      renewal_target_subscription_id: null,
    }))).toMatch(/before refunds were supported/);
    expect(getRefundUnavailableReason(makeTransaction({ type: "purchase", entries: [] }))).toMatch(/isn’t linked/);
  });

  it("is null when a paid purchase can be refunded", () => {
    expect(getRefundUnavailableReason(makeTransaction({
      entries: [
        PRO_GRANT,
        {
          type: "money_transfer",
          adjusted_transaction_id: null,
          adjusted_entry_index: null,
          customer_type: "user",
          customer_id: "user-1",
          charged_amount: { USD: "19.00" },
          net_amount: { USD: "19.00" },
        },
      ],
    }))).toBeNull();
  });
});

describe("getTransactionRowActions", () => {
  it("offers refund and cancel on a paid subscription purchase", () => {
    const actions = getTransactionRowActions(makeTransaction({
      entries: [
        PRO_GRANT,
        {
          type: "money_transfer",
          adjusted_transaction_id: null,
          adjusted_entry_index: null,
          customer_type: "user",
          customer_id: "user-1",
          charged_amount: { USD: "19.00" },
          net_amount: { USD: "19.00" },
        },
      ],
    }));
    expect(actions.map((action) => action.kind)).toEqual(["refund", "cancel"]);
    expect(actions.every((action) => action.available)).toBe(true);
  });

  it("offers refund as the payment action on renewal rows, without a peer Cancel", () => {
    // Cancel-now is not possible against a renewal invoice. Period-end
    // cancel remains an opt-in on the refund form; cancel-now lives on the
    // original purchase (the subscription root).
    const actions = getTransactionRowActions(makeTransaction({
      id: "inv-renewal-1",
      type: "subscription-renewal",
      renewal_target_subscription_id: "sub-1",
      entries: [
        {
          type: "money_transfer",
          adjusted_transaction_id: null,
          adjusted_entry_index: null,
          customer_type: "user",
          customer_id: "user-1",
          charged_amount: { USD: "19.00" },
          net_amount: { USD: "19.00" },
        },
      ],
    }));
    expect(actions).toEqual([
      { kind: "refund", available: true, target: { type: "subscription", id: "sub-1", invoiceId: "inv-renewal-1" } },
    ]);
  });

  it("offers a disabled refund plus cancel on a test-mode subscription purchase (no money to return)", () => {
    const actions = getTransactionRowActions(makeTransaction({
      test_mode: true,
      entries: [PRO_GRANT],
    }));
    expect(actions).toEqual([
      { kind: "refund", available: false, reason: expect.stringMatching(/no money to refund/) },
      { kind: "cancel", available: true, target: { type: "subscription", id: "sub-1" } },
    ]);
  });

  it("offers a disabled refund plus revoke on a test-mode one-time purchase", () => {
    const actions = getTransactionRowActions(makeTransaction({
      test_mode: true,
      entries: [{
        ...PRO_GRANT,
        subscription_id: undefined,
        one_time_purchase_id: "otp-1",
      }],
    }));
    expect(actions).toEqual([
      { kind: "refund", available: false, reason: expect.stringMatching(/no money to refund/) },
      { kind: "revoke", available: true, target: { type: "one-time-purchase", id: "otp-1" } },
    ]);
  });

  it("offers refund and revoke on a paid one-time purchase", () => {
    const actions = getTransactionRowActions(makeTransaction({
      entries: [
        { ...PRO_GRANT, subscription_id: undefined, one_time_purchase_id: "otp-1" },
        {
          type: "money_transfer",
          adjusted_transaction_id: null,
          adjusted_entry_index: null,
          customer_type: "user",
          customer_id: "user-1",
          charged_amount: { USD: "50.00" },
          net_amount: { USD: "50.00" },
        },
      ],
    }));
    expect(actions.map((action) => [action.kind, action.available])).toEqual([["refund", true], ["revoke", true]]);
  });

  it("does not put refund/cancel on ledger rows that aren’t a payment", () => {
    for (const type of ["refund", "chargeback", "subscription-cancellation", "manual-item-quantity-change"] as const) {
      expect(getTransactionRowActions(makeTransaction({ type }))).toEqual([]);
    }
  });

  it("still offers refund after a cancel-only adjustment, and disables cancel", () => {
    const actions = getTransactionRowActions(makeTransaction({
      entries: [
        PRO_GRANT,
        {
          type: "money_transfer",
          adjusted_transaction_id: null,
          adjusted_entry_index: null,
          customer_type: "user",
          customer_id: "user-1",
          charged_amount: { USD: "19.00" },
          net_amount: { USD: "19.00" },
        },
      ],
      adjusted_by: [{ transaction_id: "refund:sub-start:sub-1:uuid", entry_index: 0 }],
    }));
    expect(actions).toEqual([
      { kind: "refund", available: true, target: { type: "subscription", id: "sub-1" } },
      { kind: "cancel", available: false, reason: "This subscription is already canceled." },
    ]);
  });
});

describe("payment vs lifecycle action helpers", () => {
  it("classifies refund as the payment action and cancel/revoke as lifecycle", () => {
    const refund = { kind: "refund", available: true, target: { type: "subscription", id: "sub-1" } } as const;
    const cancel = { kind: "cancel", available: true, target: { type: "subscription", id: "sub-1" } } as const;
    const revoke = { kind: "revoke", available: true, target: { type: "one-time-purchase", id: "otp-1" } } as const;
    expect(isPaymentRowAction(refund)).toBe(true);
    expect(isLifecycleRowAction(refund)).toBe(false);
    expect(isPaymentRowAction(cancel)).toBe(false);
    expect(isLifecycleRowAction(cancel)).toBe(true);
    expect(isLifecycleRowAction(revoke)).toBe(true);
  });
});

describe("related transaction links", () => {
  it("parses refund ledger ids whose source id contains colons", () => {
    expect(parseRefundSourceTxnId("refund:otp:10766081-37fd-410c-8b2e-1c3351e2d364:dd1173b97f0ad39a3f5e97ab0112d6fe")).toBe("otp:10766081-37fd-410c-8b2e-1c3351e2d364");
    expect(parseRefundSourceTxnId("refund:sub-start:sub-1:uuid")).toBe("sub-start:sub-1");
    expect(parseRefundSourceTxnId("refund:sub-renewal:inv-9:uuid")).toBe("sub-renewal:inv-9");
    expect(parseRefundSourceTxnId("otp:10766081-37fd-410c-8b2e-1c3351e2d364")).toBeNull();
  });

  it("strips ledger prefixes to the listed transaction id", () => {
    expect(listedIdFromLedgerTxnId("otp:purchase-1")).toBe("purchase-1");
    expect(listedIdFromLedgerTxnId("sub-start:sub-1")).toBe("sub-1");
    expect(listedIdFromLedgerTxnId("sub-renewal:inv-9")).toBe("inv-9");
    expect(listedIdFromLedgerTxnId("refund:otp:purchase-1:uuid")).toBe("refund:otp:purchase-1:uuid");
  });

  it("points a one-time refund at the original purchase", () => {
    const refund = makeTransaction({
      id: "refund:otp:purchase-1:uuid",
      type: "refund",
      entries: [{
        type: "money_transfer",
        adjusted_transaction_id: "otp:purchase-1",
        adjusted_entry_index: 0,
        customer_type: "user",
        customer_id: "user-1",
        charged_amount: { USD: "500.00" },
        net_amount: { USD: "500.00" },
      }],
    });
    expect(getRelatedTransactionRefs(refund)).toEqual([
      { listedId: "purchase-1", relation: "original" },
    ]);
  });

  it("points a renewal at the original purchase and later refunds of this invoice", () => {
    const renewal = makeTransaction({
      id: "inv-9",
      type: "subscription-renewal",
      renewal_target_subscription_id: "sub-1",
      entries: [{
        type: "money_transfer",
        adjusted_transaction_id: null,
        adjusted_entry_index: null,
        customer_type: "user",
        customer_id: "user-1",
        charged_amount: { USD: "19.00" },
        net_amount: { USD: "19.00" },
      }],
      adjusted_by: [{ transaction_id: "refund:sub-renewal:inv-9:uuid", entry_index: 0 }],
    });
    expect(getRelatedTransactionRefs(renewal)).toEqual([
      { listedId: "sub-1", relation: "original" },
      { listedId: "refund:sub-renewal:inv-9:uuid", relation: "follows" },
    ]);
    expect(getTransactionFamilyId(renewal)).toBe("sub-1");
  });

  it("resolves original + sibling renewal from a customer pool", () => {
    const purchase = makeTransaction({
      id: "sub-1",
      entries: [PRO_GRANT],
    });
    const renewal = makeTransaction({
      id: "inv-9",
      type: "subscription-renewal",
      renewal_target_subscription_id: "sub-1",
      created_at_millis: 1_800_000_000_000,
      entries: [{
        type: "money_transfer",
        adjusted_transaction_id: null,
        adjusted_entry_index: null,
        customer_type: "user",
        customer_id: "user-1",
        charged_amount: { USD: "19.00" },
        net_amount: { USD: "19.00" },
      }],
    });
    const refund = makeTransaction({
      id: "refund:otp:other:uuid",
      type: "refund",
      entries: [{
        type: "money_transfer",
        adjusted_transaction_id: "otp:other",
        adjusted_entry_index: 0,
        customer_type: "user",
        customer_id: "user-1",
        charged_amount: { USD: "1.00" },
        net_amount: { USD: "1.00" },
      }],
    });
    const { matches, unresolved } = collectRelatedTransactions(renewal, new Map([
      [purchase.id, purchase],
      [renewal.id, renewal],
      [refund.id, refund],
    ]));
    expect(unresolved).toEqual([]);
    expect(matches.map((match) => [match.label, match.transaction.id])).toEqual([
      ["Original purchase", "sub-1"],
    ]);
  });

  it("labels a later refund as coming from this payment, and sibling renewals as the same subscription", () => {
    const purchase = makeTransaction({
      id: "sub-1",
      entries: [PRO_GRANT],
      adjusted_by: [{ transaction_id: "refund:sub-start:sub-1:uuid", entry_index: 0 }],
    });
    const renewal = makeTransaction({
      id: "inv-9",
      type: "subscription-renewal",
      renewal_target_subscription_id: "sub-1",
      created_at_millis: 1_800_000_000_000,
      entries: [{
        type: "money_transfer",
        adjusted_transaction_id: null,
        adjusted_entry_index: null,
        customer_type: "user",
        customer_id: "user-1",
        charged_amount: { USD: "19.00" },
        net_amount: { USD: "19.00" },
      }],
    });
    const refund = makeTransaction({
      id: "refund:sub-start:sub-1:uuid",
      type: "refund",
      entries: [{
        type: "money_transfer",
        adjusted_transaction_id: "sub-start:sub-1",
        adjusted_entry_index: 0,
        customer_type: "user",
        customer_id: "user-1",
        charged_amount: { USD: "19.00" },
        net_amount: { USD: "19.00" },
      }],
    });
    const fromPurchase = collectRelatedTransactions(purchase, new Map([
      [purchase.id, purchase],
      [renewal.id, renewal],
      [refund.id, refund],
    ]));
    expect(fromPurchase.matches.map((match) => [match.label, match.transaction.id])).toEqual([
      ["Refund of this payment", "refund:sub-start:sub-1:uuid"],
      ["Same subscription", "inv-9"],
    ]);

    const fromRenewal = collectRelatedTransactions(renewal, new Map([
      [purchase.id, purchase],
      [renewal.id, renewal],
      [refund.id, refund],
    ]));
    expect(fromRenewal.matches.map((match) => [match.label, match.transaction.id])).toEqual([
      ["Original purchase", "sub-1"],
      ["Same subscription", "refund:sub-start:sub-1:uuid"],
    ]);
  });

  it("builds shareable detail page hrefs that encode colon-heavy refund ids", () => {
    const refund = makeTransaction({
      id: "refund:otp:purchase-1:uuid",
      type: "refund",
      customer_type: "team",
      customer_id: "team-9",
    });
    expect(transactionPageHref("proj-1", refund)).toBe(
      "/projects/proj-1/payments/transactions/refund%3Aotp%3Apurchase-1%3Auuid?customer_type=team&customer_id=team-9",
    );
    expect(parsePaymentsEntityPath("/projects/proj-1/payments/transactions/refund:otp:purchase-1:uuid", "transactions")).toBe(
      "refund:otp:purchase-1:uuid",
    );
    expect(parseCustomerTypeParam("team")).toBe("team");
    expect(parseCustomerTypeParam("nope")).toBeNull();
  });

  it("points subscription purchases at a subscription page id", () => {
    const purchase = makeTransaction({
      id: "sub-1",
      entries: [PRO_GRANT],
    });
    expect(getRelatedSubscriptionId(purchase)).toBe("sub-1");
    expect(getRelatedSubscriptionId(makeTransaction({
      id: "otp-1",
      entries: [{
        ...PRO_GRANT,
        subscription_id: null,
        one_time_purchase_id: "otp-1",
      }],
    }))).toBeNull();
    expect(getRelatedSubscriptionId(makeTransaction({
      id: "cancel-1",
      type: "subscription-cancellation",
      entries: [{
        type: "product_revocation",
        adjusted_transaction_id: "sub-start:sub-1",
        adjusted_entry_index: 0,
        quantity: 1,
      }],
    }))).toBe("sub-1");
    expect(getRelatedSubscriptionId(makeTransaction({
      id: "refund:otp:purchase-1:uuid",
      type: "refund",
      entries: [{
        type: "product_revocation",
        adjusted_transaction_id: "otp:purchase-1",
        adjusted_entry_index: 0,
        quantity: 1,
      }],
    }))).toBeNull();
  });

  it("describes a grant price with interval", () => {
    expect(describeProductGrantPrice({
      ...PRO_GRANT,
      product: {
        ...PRO_GRANT.product,
        prices: {
          monthly: { USD: "19.00", interval: [1, "month"] },
        },
      },
    })).toBe("19.00 USD · per month");
  });
});
