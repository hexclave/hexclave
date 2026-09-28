import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { describe, expect, it } from "vitest";
import type { PiledriverObject } from "../../databases/piledriver/index.js";
import { createPaymentsSchema, mergeCompactionAggregates, normalizedRepeatInterval, type ItemCompactionAggregate, type ItemQuantityChangeEntry } from "./index.js";
import { asRecord, balanceAt, collect, customerGroup, initializedSnapshot, MONTH_MS, product, rowDatas, rowsBySortKey, set, subscription, type Snapshot } from "./schema-test-helpers.js";
import type { CustomerType, TransactionRow } from "./types.js";

describe("payments schema", () => {
  it("generates subscription renewal events and ignores creation invoices", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.subscriptions, "sub-renewal", subscription("sub-renewal", {
      stripeSubscriptionId: "stripe-sub-renewal",
      creationSource: "PURCHASE_PAGE",
      createdAtMillis: 1_000,
    }) as unknown as PiledriverObject);
    snapshot = await set(snapshot, schema.subscriptionInvoices, "inv-renewal", {
      id: "inv-renewal",
      tenancyId: "t1",
      stripeSubscriptionId: "stripe-sub-renewal",
      stripeInvoiceId: "stripe-inv-renewal",
      isSubscriptionCreationInvoice: false,
      status: "paid",
      amountTotal: 1000,
      hostedInvoiceUrl: null,
      createdAtMillis: 2_000,
    });
    snapshot = await set(snapshot, schema.subscriptionInvoices, "inv-creation", {
      id: "inv-creation",
      tenancyId: "t1",
      stripeSubscriptionId: "stripe-sub-renewal",
      stripeInvoiceId: "stripe-inv-creation",
      isSubscriptionCreationInvoice: true,
      status: "paid",
      amountTotal: 0,
      hostedInvoiceUrl: null,
      createdAtMillis: 3_000,
    });

    const events = await rowDatas(snapshot, schema.subscriptionRenewalEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      subscriptionId: "sub-renewal",
      invoiceId: "inv-renewal",
      paymentProvider: "stripe",
      effectiveAtMillis: 2_000,
      chargedAmount: { USD: "10.00" },
    });
  });

  it("books catalog money on subscription-start for paid Stripe purchases", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.subscriptions, "sub-stripe-start", subscription("sub-stripe-start", {
      stripeSubscriptionId: "stripe-sub-start",
      creationSource: "PURCHASE_PAGE",
      status: "active",
      createdAtMillis: 1_000,
    }) as unknown as PiledriverObject);

    const group = customerGroup("customer-sub-stripe-start");
    const txns = (await rowDatas(snapshot, schema.transactions, group)) as unknown as TransactionRow[];
    const startTxn = txns.find(txn => txn.txnId === "sub-start:sub-stripe-start");
    expect(startTxn?.renewalTargetSubscriptionId).toBeNull();
    expect(startTxn?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "product-grant" }),
      expect.objectContaining({ type: "money-transfer", chargedAmount: { USD: "10.00" } }),
    ]));
  });

  it("does not book money on subscription-start for free trials", async () => {
    // Trial starts omit start money; the first real charge is the later
    // non-creation invoice (subscription-renewal txn), not the $0 creation invoice.
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.subscriptions, "sub-trial-start", subscription("sub-trial-start", {
      stripeSubscriptionId: "stripe-sub-trial",
      creationSource: "PURCHASE_PAGE",
      status: "trialing",
      product: {
        ...product(),
        prices: { p1: { USD: "19.00", interval: [1, "month"], freeTrial: [14, "day"] } },
      },
      createdAtMillis: 1_000,
    }) as unknown as PiledriverObject);
    snapshot = await set(snapshot, schema.subscriptionInvoices, "inv-trial-create", {
      id: "inv-trial-create",
      tenancyId: "t1",
      stripeSubscriptionId: "stripe-sub-trial",
      stripeInvoiceId: "stripe-inv-trial-create",
      isSubscriptionCreationInvoice: true,
      status: "paid",
      amountTotal: 0,
      hostedInvoiceUrl: null,
      createdAtMillis: 1_500,
    });
    snapshot = await set(snapshot, schema.subscriptionInvoices, "inv-trial-convert", {
      id: "inv-trial-convert",
      tenancyId: "t1",
      stripeSubscriptionId: "stripe-sub-trial",
      stripeInvoiceId: "stripe-inv-trial-convert",
      isSubscriptionCreationInvoice: false,
      status: "paid",
      amountTotal: 1900,
      hostedInvoiceUrl: null,
      createdAtMillis: 2_000,
    });

    const group = customerGroup("customer-sub-trial-start");
    const txns = (await rowDatas(snapshot, schema.transactions, group)) as unknown as TransactionRow[];
    const startTxn = txns.find(txn => txn.txnId === "sub-start:sub-trial-start");
    expect(startTxn?.entries.some(entry => entry.type === "money-transfer")).toBe(false);
    expect(startTxn?.renewalTargetSubscriptionId).toBeNull();

    const renewalEvents = await rowDatas(snapshot, schema.subscriptionRenewalEvents);
    expect(renewalEvents).toHaveLength(1);
    expect(renewalEvents[0]).toMatchObject({
      invoiceId: "inv-trial-convert",
      chargedAmount: { USD: "19.00" },
    });
    const renewalTxn = txns.find(txn => txn.txnId === "sub-renewal:inv-trial-convert");
    expect(renewalTxn?.renewalTargetSubscriptionId).toBe("sub-trial-start");
    expect(renewalTxn?.entries).toMatchObject([
      { type: "money-transfer", chargedAmount: { USD: "19.00" } },
    ]);
  });

  it("does not book money on subscription-start for $0 Stripe subscriptions", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.subscriptions, "sub-free-start", subscription("sub-free-start", {
      stripeSubscriptionId: "stripe-sub-free",
      creationSource: "PURCHASE_PAGE",
      status: "active",
      product: {
        ...product(),
        prices: { p1: { USD: "0.00", interval: [1, "month"] } },
      },
      createdAtMillis: 1_000,
    }) as unknown as PiledriverObject);

    const group = customerGroup("customer-sub-free-start");
    const txns = (await rowDatas(snapshot, schema.transactions, group)) as unknown as TransactionRow[];
    const startTxn = txns.find(txn => txn.txnId === "sub-start:sub-free-start");
    expect(startTxn?.entries.some(entry => entry.type === "money-transfer")).toBe(false);
  });

  it("uses the invoice's actual total for the renewal amount, not the current product price", async () => {
    // The product lists at 10.00, but the invoice was actually billed 7.50 (e.g. a coupon or
    // proration). The renewal ledger must show what was charged (7.50), not a recomputation from
    // the current product price. This is also what protects the ledger when a product version's
    // price changes after the subscription was created.
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.subscriptions, "sub-coupon", subscription("sub-coupon", {
      stripeSubscriptionId: "stripe-sub-coupon",
      creationSource: "PURCHASE_PAGE",
      createdAtMillis: 1_000,
    }) as unknown as PiledriverObject);
    snapshot = await set(snapshot, schema.subscriptionInvoices, "inv-coupon", {
      id: "inv-coupon",
      tenancyId: "t1",
      stripeSubscriptionId: "stripe-sub-coupon",
      stripeInvoiceId: "stripe-inv-coupon",
      isSubscriptionCreationInvoice: false,
      status: "paid",
      amountTotal: 750,
      hostedInvoiceUrl: null,
      createdAtMillis: 2_000,
    });

    const events = await rowDatas(snapshot, schema.subscriptionRenewalEvents);
    expect(events[0]).toMatchObject({ invoiceId: "inv-coupon", chargedAmount: { USD: "7.50" } });

    const group = customerGroup("customer-sub-coupon");
    const txns = (await rowDatas(snapshot, schema.transactions, group)) as unknown as TransactionRow[];
    const renewalTxn = txns.find(txn => txn.txnId === "sub-renewal:inv-coupon");
    expect(renewalTxn?.entries).toMatchObject([
      { type: "money-transfer", chargedAmount: { USD: "7.50" } },
    ]);
  });

  it("falls back to the product price when the invoice has no persisted total", async () => {
    // A null amountTotal means the charge is unknown (not $0), so we recompute from the product
    // price (10.00 x quantity 1). A real $0 charge would keep amountTotal 0 and yield "0.00".
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.subscriptions, "sub-nototal", subscription("sub-nototal", {
      stripeSubscriptionId: "stripe-sub-nototal",
      creationSource: "PURCHASE_PAGE",
      createdAtMillis: 1_000,
    }) as unknown as PiledriverObject);
    snapshot = await set(snapshot, schema.subscriptionInvoices, "inv-nototal", {
      id: "inv-nototal",
      tenancyId: "t1",
      stripeSubscriptionId: "stripe-sub-nototal",
      stripeInvoiceId: "stripe-inv-nototal",
      isSubscriptionCreationInvoice: false,
      status: "paid",
      amountTotal: null,
      hostedInvoiceUrl: null,
      createdAtMillis: 2_000,
    });

    const events = await rowDatas(snapshot, schema.subscriptionRenewalEvents);
    expect(events[0]).toMatchObject({ invoiceId: "inv-nototal", chargedAmount: { USD: "10.00" } });
  });

  it("maps one-time purchases through events, transactions, owned products, and item quantities", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.oneTimePurchases, "otp-1", {
      id: "otp-1",
      tenancyId: "t1",
      customerId: "u-otp",
      customerType: "user",
      productId: "prod-coins",
      priceId: "p1",
      product: product({ coins: { quantity: 100, expires: "never" } }),
      quantity: 2,
      stripePaymentIntentId: "pi-1",
      revokedAtMillis: null,
      refundedAtMillis: null,
      creationSource: "PURCHASE_PAGE",
      createdAtMillis: 3_000,
    });

    const events = await rowDatas(snapshot, schema.oneTimePurchaseEvents);
    expect(events[0]).toMatchObject({ purchaseId: "otp-1", chargedAmount: { USD: "20.00" }, itemGrants: [{ itemId: "coins", quantity: 200, expiresWhen: null }] });

    const group = customerGroup("u-otp");
    const txns = (await rowDatas(snapshot, schema.transactions, group)) as unknown as TransactionRow[];
    expect(txns.map(txn => txn.txnId)).toEqual(["otp:otp-1"]);
    expect(txns[0].entries).toMatchObject([
      { type: "product-grant", productId: "prod-coins", oneTimePurchaseId: "otp-1" },
      { type: "money-transfer", chargedAmount: { USD: "20.00" } },
      { type: "item-quantity-change", itemId: "coins", quantity: 200 },
    ]);

    const owned = asRecord((await rowsBySortKey(snapshot, schema.ownedProducts, group)).at(-1)?.rowData ?? null);
    expect(asRecord(asRecord(owned.ownedProducts)["prod-coins"]).quantity).toBe(2);

    const quantities = asRecord((await rowDatas(snapshot, schema.itemQuantities, group)).at(-1) ?? null);
    expect(asRecord(quantities.itemQuantities).coins).toBe(200);
  });

  it("computes charged amount in minor units so price x quantity has no float artifacts", async () => {
    // Regression: `19.99 * 3` in float is 59.97000000000001, which then fails
    // moneyAmountSchema (USD allows 2 decimals) and 500s the transactions API.
    // The charged amount must be exact and canonically formatted ("59.97").
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.oneTimePurchases, "otp-float", {
      id: "otp-float",
      tenancyId: "t1",
      customerId: "u-float",
      customerType: "user",
      productId: "prod-float",
      priceId: "p1",
      product: { ...product({ coins: { quantity: 1, expires: "never" } }), prices: { p1: { USD: "19.99" } } },
      quantity: 3,
      stripePaymentIntentId: "pi-float",
      revokedAtMillis: null,
      refundedAtMillis: null,
      creationSource: "PURCHASE_PAGE",
      createdAtMillis: 3_000,
    });

    const events = await rowDatas(snapshot, schema.oneTimePurchaseEvents);
    expect(events[0]).toMatchObject({ purchaseId: "otp-float", chargedAmount: { USD: "59.97" } });

    const txns = (await rowDatas(snapshot, schema.transactions, customerGroup("u-float"))) as unknown as TransactionRow[];
    expect(txns[0].entries).toMatchObject([
      { type: "product-grant", productId: "prod-float" },
      { type: "money-transfer", chargedAmount: { USD: "59.97" } },
      { type: "item-quantity-change", itemId: "coins", quantity: 3 },
    ]);
  });

  it("keeps grant entry indices aligned for a free non-test-mode one-time purchase on repeat", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.oneTimePurchases, "otp-free", {
      id: "otp-free",
      tenancyId: "t1",
      customerId: "u-otp-free",
      customerType: "user",
      productId: "prod-free",
      priceId: null,
      product: product({ credits: { quantity: 10, repeat: [1, "month"], expires: "when-repeated" } }),
      quantity: 1,
      stripePaymentIntentId: "pi-free",
      revokedAtMillis: null,
      refundedAtMillis: null,
      creationSource: "PURCHASE_PAGE",
      createdAtMillis: 0,
    });

    const group = customerGroup("u-otp-free");
    const txns = (await rowDatas(snapshot, schema.transactions, group)) as unknown as TransactionRow[];
    expect(txns[0].entries).toMatchObject([
      { type: "product-grant", productId: "prod-free" },
      { type: "item-quantity-change", itemId: "credits", quantity: 10 },
    ]);

    // With calendar-anchored repeats, the first monthly boundary off the epoch anchor is
    // 1970-02-01 (31 days), not the 30-day MONTH_MS approximation.
    const firstRepeatMillis = Date.UTC(1970, 1, 1);
    snapshot = (await snapshot.tick(new Date(firstRepeatMillis))).newSnapshot;

    expect(await balanceAt(snapshot, group, "credits", 0)).toBe(10);
    expect(await balanceAt(snapshot, group, "credits", firstRepeatMillis)).toBe(10);
  });

  it("handles subscription start, repeat replacement, and end expiry", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    // First monthly boundary off the epoch anchor is 1970-02-01; end the subscription mid-Feb so
    // exactly one repeat fires before the end (before the second boundary at 1970-03-01).
    const firstRepeatMillis = Date.UTC(1970, 1, 1);
    const subEndMillis = Date.UTC(1970, 1, 15);
    snapshot = await set(snapshot, schema.subscriptions, "sub-repeat", subscription("sub-repeat", {
      customerId: "u-repeat",
      productId: "prod-repeat",
      product: product({
        credits: { quantity: 10, repeat: [1, "month"], expires: "when-repeated" },
      }),
      currentPeriodEndMillis: subEndMillis,
      endedAtMillis: subEndMillis,
    }) as unknown as PiledriverObject);

    snapshot = (await snapshot.tick(new Date(firstRepeatMillis))).newSnapshot;
    snapshot = (await snapshot.tick(new Date(subEndMillis))).newSnapshot;

    const group = customerGroup("u-repeat");
    const txns = ((await rowDatas(snapshot, schema.transactions, group)) as unknown as TransactionRow[])
      .sort((a, b) => a.effectiveAtMillis - b.effectiveAtMillis || stringCompare(a.txnId, b.txnId));
    expect(txns.map(txn => txn.txnId)).toEqual(["sub-start:sub-repeat", `igr:sub-repeat:${firstRepeatMillis}`, "sub-end:sub-repeat"]);
    expect(txns[1].entries).toMatchObject([
      { type: "item-quantity-expire", adjustedTransactionId: "sub-start:sub-repeat", itemId: "credits", quantity: 10 },
      { type: "item-quantity-change", itemId: "credits", quantity: 10, expiresWhen: "when-repeated" },
    ]);
    expect(txns[2].entries).toMatchObject([
      { type: "active-subscription-end", subscriptionId: "sub-repeat" },
      { type: "product-revocation", adjustedTransactionId: "sub-start:sub-repeat", quantity: 1 },
      { type: "item-quantity-expire", adjustedTransactionId: `igr:sub-repeat:${firstRepeatMillis}`, itemId: "credits", quantity: 10 },
    ]);

    const quantities = (await rowsBySortKey(snapshot, schema.itemQuantities, group)).map(row => asRecord(row.rowData));
    expect(asRecord(quantities.at(-1)!.itemQuantities).credits).toBe(0);
    const owned = asRecord((await rowsBySortKey(snapshot, schema.ownedProducts, group)).at(-1)?.rowData ?? null);
    expect(asRecord(asRecord(owned.ownedProducts)["prod-repeat"]).quantity).toBe(0);
  });

  it("preserves emitted repeat grants when the subscription row is rewritten", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    const firstRepeatMillis = Date.UTC(1970, 1, 1);
    const secondRepeatMillis = Date.UTC(1970, 2, 1);
    // expires: "never" makes the grants accumulate, which is exactly the shape that a re-derived
    // history would corrupt (an upgrade would retroactively double every past month's grant).
    const subRow = (overrides: Partial<Parameters<typeof subscription>[1]> = {}) => subscription("sub-rewrite", {
      customerId: "u-rewrite",
      productId: "prod-rewrite",
      product: product({ credits: { quantity: 10, repeat: [1, "month"], expires: "never" } }),
      currentPeriodEndMillis: Date.UTC(1971, 0, 1),
      ...overrides,
    }) as unknown as PiledriverObject;
    snapshot = await set(snapshot, schema.subscriptions, "sub-rewrite", subRow());
    snapshot = (await snapshot.tick(new Date(firstRepeatMillis))).newSnapshot;

    const group = customerGroup("u-rewrite");
    const txnIds = async () => ((await rowDatas(snapshot, schema.transactions, group)) as unknown as TransactionRow[]).map(txn => txn.txnId).sort(stringCompare);
    expect(await txnIds()).toEqual([`igr:sub-rewrite:${firstRepeatMillis}`, "sub-start:sub-rewrite"]);
    expect(await balanceAt(snapshot, group, "credits", firstRepeatMillis)).toBe(20);

    // Renewal-style webhook resync: same product/quantity, only volatile fields move. The ledger
    // must be untouched *immediately* after the write — the reset-on-update behavior deleted every
    // item-grant-repeat transaction here and only restored them on the next tick.
    snapshot = await set(snapshot, schema.subscriptions, "sub-rewrite", subRow({ status: "past_due", currentPeriodStartMillis: firstRepeatMillis }));
    expect(await txnIds()).toEqual([`igr:sub-rewrite:${firstRepeatMillis}`, "sub-start:sub-rewrite"]);
    expect(await balanceAt(snapshot, group, "credits", firstRepeatMillis)).toBe(20);

    // Quantity upgrade: history keeps the originally granted quantities; only future repeats scale.
    snapshot = await set(snapshot, schema.subscriptions, "sub-rewrite", subRow({ quantity: 2, currentPeriodStartMillis: firstRepeatMillis }));
    expect(await balanceAt(snapshot, group, "credits", firstRepeatMillis)).toBe(20);
    snapshot = (await snapshot.tick(new Date(secondRepeatMillis))).newSnapshot;
    expect(await balanceAt(snapshot, group, "credits", secondRepeatMillis)).toBe(40);
    const secondGrant = ((await rowDatas(snapshot, schema.transactions, group)) as unknown as TransactionRow[]).find(txn => txn.txnId === `igr:sub-rewrite:${secondRepeatMillis}`);
    expect(secondGrant?.entries).toMatchObject([{ type: "item-quantity-change", itemId: "credits", quantity: 20 }]);
  });

  it("preserves emitted one-time-purchase repeat grants when the purchase row is rewritten", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    const firstRepeatMillis = Date.UTC(1970, 1, 1);
    const otpRow = (overrides: Record<string, PiledriverObject> = {}) => ({
      id: "otp-rewrite",
      tenancyId: "t1",
      customerId: "u-otp-rewrite",
      customerType: "user",
      productId: "prod-otp",
      priceId: null,
      product: product({ credits: { quantity: 5, repeat: [1, "month"], expires: "never" } }),
      quantity: 1,
      stripePaymentIntentId: "pi-rewrite",
      revokedAtMillis: null,
      refundedAtMillis: null,
      creationSource: "PURCHASE_PAGE",
      createdAtMillis: 0,
      ...overrides,
    });
    snapshot = await set(snapshot, schema.oneTimePurchases, "otp-rewrite", otpRow());
    snapshot = (await snapshot.tick(new Date(firstRepeatMillis))).newSnapshot;

    const group = customerGroup("u-otp-rewrite");
    expect(await balanceAt(snapshot, group, "credits", firstRepeatMillis)).toBe(10);

    // Revocation arrives as a rewrite of the purchase row: the already-granted repeat must
    // survive the write, and future repeats stop at the revocation.
    snapshot = await set(snapshot, schema.oneTimePurchases, "otp-rewrite", otpRow({ revokedAtMillis: Date.UTC(1970, 1, 10) }));
    expect(await balanceAt(snapshot, group, "credits", firstRepeatMillis)).toBe(10);
    snapshot = (await snapshot.tick(new Date(Date.UTC(1970, 2, 1)))).newSnapshot;
    const txnIds = ((await rowDatas(snapshot, schema.transactions, group)) as unknown as TransactionRow[]).map(txn => txn.txnId).sort(stringCompare);
    expect(txnIds).toEqual([`igr:otp-rewrite:${firstRepeatMillis}`, "otp:otp-rewrite"]);
  });

  it("ends a subscription via a row rewrite and seals the fold against further rewrites", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    const firstRepeatMillis = Date.UTC(1970, 1, 1);
    const subEndMillis = Date.UTC(1970, 1, 15);
    const subRow = (overrides: Partial<Parameters<typeof subscription>[1]> = {}) => subscription("sub-seal", {
      customerId: "u-seal",
      productId: "prod-seal",
      product: product({ credits: { quantity: 10, repeat: [1, "month"], expires: "when-repeated" } }),
      currentPeriodEndMillis: Date.UTC(1970, 2, 1),
      ...overrides,
    }) as unknown as PiledriverObject;
    snapshot = await set(snapshot, schema.subscriptions, "sub-seal", subRow());
    snapshot = (await snapshot.tick(new Date(firstRepeatMillis))).newSnapshot;

    // Cancellation arrives as a rewrite of the live row (that's how the Stripe sync works); the
    // end event must fire off the *existing* fold state, expiring the actually-emitted grants.
    snapshot = await set(snapshot, schema.subscriptions, "sub-seal", subRow({ status: "canceled", endedAtMillis: subEndMillis, canceledAtMillis: subEndMillis }));
    snapshot = (await snapshot.tick(new Date(subEndMillis))).newSnapshot;

    const group = customerGroup("u-seal");
    const txns = ((await rowDatas(snapshot, schema.transactions, group)) as unknown as TransactionRow[])
      .sort((a, b) => a.effectiveAtMillis - b.effectiveAtMillis || stringCompare(a.txnId, b.txnId));
    expect(txns.map(txn => txn.txnId)).toEqual(["sub-start:sub-seal", `igr:sub-seal:${firstRepeatMillis}`, "sub-end:sub-seal"]);
    expect(txns[2].entries).toMatchObject([
      { type: "active-subscription-end", subscriptionId: "sub-seal" },
      { type: "product-revocation", adjustedTransactionId: "sub-start:sub-seal", quantity: 1 },
      { type: "item-quantity-expire", adjustedTransactionId: `igr:sub-seal:${firstRepeatMillis}`, itemId: "credits", quantity: 10 },
    ]);
    expect(await balanceAt(snapshot, group, "credits", subEndMillis)).toBe(0);

    // Once ended, further webhook rewrites must not re-arm the fold: no duplicate subscription-end,
    // no resumed repeats past the end.
    snapshot = await set(snapshot, schema.subscriptions, "sub-seal", subRow({ status: "canceled", endedAtMillis: subEndMillis, canceledAtMillis: subEndMillis, currentPeriodStartMillis: firstRepeatMillis }));
    snapshot = (await snapshot.tick(new Date(Date.UTC(1970, 3, 1)))).newSnapshot;
    const txnIdsAfter = ((await rowDatas(snapshot, schema.transactions, group)) as unknown as TransactionRow[]).map(txn => txn.txnId).sort(stringCompare);
    expect(txnIdsAfter).toEqual([`igr:sub-seal:${firstRepeatMillis}`, "sub-end:sub-seal", "sub-start:sub-seal"]);
  });

  it("emits the end synchronously when a rewrite ends a no-repeat subscription (plan switch)", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    // Plan-switch shape: no included items (so no repeat schedule), replaced mid-period by
    // rewriting the row with endedAtMillis = "now". The switch endpoint reads owned products in
    // the same request, so the revocation must land in the same write — not on the next tick.
    const subEndMillis = Date.UTC(1970, 0, 10);
    const subRow = (overrides: Partial<Parameters<typeof subscription>[1]> = {}) => subscription("sub-switch", {
      customerId: "u-switch",
      productId: "prod-basic",
      product: product(),
      currentPeriodEndMillis: Date.UTC(1970, 1, 1),
      ...overrides,
    }) as unknown as PiledriverObject;
    snapshot = await set(snapshot, schema.subscriptions, "sub-switch", subRow());

    const group = customerGroup("u-switch");
    const ownedQuantity = async () => {
      const owned = asRecord((await rowsBySortKey(snapshot, schema.ownedProducts, group)).at(-1)?.rowData ?? null);
      return Number(asRecord(asRecord(owned.ownedProducts)["prod-basic"]).quantity);
    };
    expect(await ownedQuantity()).toBe(1);

    // End the subscription via rewrite; no tick in between.
    snapshot = await set(snapshot, schema.subscriptions, "sub-switch", subRow({ status: "canceled", endedAtMillis: subEndMillis, canceledAtMillis: subEndMillis }));
    const txns = ((await rowDatas(snapshot, schema.transactions, group)) as unknown as TransactionRow[])
      .sort((a, b) => a.effectiveAtMillis - b.effectiveAtMillis || stringCompare(a.txnId, b.txnId));
    expect(txns.map(txn => txn.txnId)).toEqual(["sub-start:sub-switch", "sub-end:sub-switch"]);
    expect(await ownedQuantity()).toBe(0);

    // The fold is sealed: later rewrites and ticks add nothing (no duplicate end).
    snapshot = await set(snapshot, schema.subscriptions, "sub-switch", subRow({ status: "canceled", endedAtMillis: subEndMillis, canceledAtMillis: subEndMillis, currentPeriodStartMillis: subEndMillis }));
    snapshot = (await snapshot.tick(new Date(Date.UTC(1970, 2, 1)))).newSnapshot;
    const txnIdsAfter = ((await rowDatas(snapshot, schema.transactions, group)) as unknown as TransactionRow[]).map(txn => txn.txnId).sort(stringCompare);
    expect(txnIdsAfter).toEqual(["sub-end:sub-switch", "sub-start:sub-switch"]);
  });

  it("treats a manual item quantity change whose expiry is at/before its grant as a no-op", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    // expiresAtMillis (3000) is before createdAtMillis (4000): the grant is already expired,
    // so the net quantity must be 0, not a permanent grant.
    snapshot = await set(snapshot, schema.manualItemQuantityChanges, "manual-past-expiry", {
      id: "manual-past-expiry",
      tenancyId: "t1",
      customerId: "u-past",
      customerType: "user",
      itemId: "boosts",
      quantity: 4,
      description: null,
      expiresAtMillis: 3000,
      createdAtMillis: 4000,
    });

    const group = customerGroup("u-past");
    const quantities = (await rowsBySortKey(snapshot, schema.itemQuantities, group)).map(row => asRecord(row.rowData));
    const latest = quantities.at(-1);
    expect(latest === undefined ? 0 : Number(asRecord(latest.itemQuantities).boosts ?? 0)).toBe(0);
  });

  it("maps manual item quantity changes with absolute expiry", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.manualItemQuantityChanges, "manual-1", {
      id: "manual-1",
      tenancyId: "t1",
      customerId: "u-manual",
      customerType: "user",
      itemId: "boosts",
      quantity: 5,
      description: null,
      expiresAtMillis: 5000,
      createdAtMillis: 4000,
    });

    const group = customerGroup("u-manual");
    const quantities = (await rowDatas(snapshot, schema.itemQuantities, group)).map(asRecord);
    expect(asRecord(quantities[0].itemQuantities).boosts).toBe(5);
    expect(asRecord(quantities[1].itemQuantities).boosts).toBe(0);
  });

  it("applies compacted non-expiring item quantity changes by item", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.manualItemQuantityChanges, "compact-a", {
      id: "compact-a",
      tenancyId: "t1",
      customerId: "u-compact",
      customerType: "user",
      itemId: "credits",
      quantity: 5,
      description: null,
      expiresAtMillis: null,
      createdAtMillis: 1000,
    });
    snapshot = await set(snapshot, schema.manualItemQuantityChanges, "compact-b", {
      id: "compact-b",
      tenancyId: "t1",
      customerId: "u-compact",
      customerType: "user",
      itemId: "credits",
      quantity: 7,
      description: null,
      expiresAtMillis: null,
      createdAtMillis: 2000,
    });

    const group = customerGroup("u-compact");
    const quantities = asRecord((await rowsBySortKey(snapshot, schema.itemQuantities, group)).at(-1)?.rowData ?? null);
    expect(asRecord(quantities.itemQuantities).credits).toBe(12);
  });

  it("does not compact non-expiring changes across an expiring grant of the same item, and drops it on expiry", async () => {
    /*
     * credits timeline (one customer):
     *   t=1000  +5  (no expiry)         -> compactable "before" grant
     *   t=1000  +3  expires at 1500     -> a real, identity-bearing expiring grant
     *   t=2000  +7  (no expiry)         -> compactable "after" grant
     *
     * The expiring grant's expiry at 1500 is a per-item compaction boundary, so the +5 and +7
     * permanent changes must NOT merge into one compacted entry (they'd otherwise sum to 12 at t=1000
     * and corrupt point-in-time balances). The expiring grant then actually drops its remaining 3 at
     * 1500.
     */
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.manualItemQuantityChanges, "perm-before", {
      id: "perm-before", tenancyId: "t1", customerId: "u-boundary", customerType: "user",
      itemId: "credits", quantity: 5, description: null, expiresAtMillis: null, createdAtMillis: 1000,
    });
    snapshot = await set(snapshot, schema.manualItemQuantityChanges, "expiring", {
      id: "expiring", tenancyId: "t1", customerId: "u-boundary", customerType: "user",
      itemId: "credits", quantity: 3, description: null, expiresAtMillis: 1500, createdAtMillis: 1000,
    });
    snapshot = await set(snapshot, schema.manualItemQuantityChanges, "perm-after", {
      id: "perm-after", tenancyId: "t1", customerId: "u-boundary", customerType: "user",
      itemId: "credits", quantity: 7, description: null, expiresAtMillis: null, createdAtMillis: 2000,
    });

    const group = customerGroup("u-boundary");
    // The two permanent grants stay as separate compacted entries (5 and 7), never merged to 12.
    const compacted = (await rowDatas(snapshot, schema.compactedItemQuantityChangeEntries, group)).map(asRecord);
    expect(compacted.map(row => Number(row.quantity)).sort((a, b) => a - b)).toEqual([5, 7]);

    expect(await balanceAt(snapshot, group, "credits", 1200)).toBe(8); // 5 + 3
    expect(await balanceAt(snapshot, group, "credits", 1600)).toBe(5); // expiring grant dropped
    expect(await balanceAt(snapshot, group, "credits", 2500)).toBe(12); // 5 + 7
  });

  it("passes refund manual transactions through and applies product revocation", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.manualTransactions, "refund-1", {
      txnId: "refund-1",
      tenancyId: "t1",
      effectiveAtMillis: 8000,
      type: "refund",
      entries: [{
        type: "product-revocation",
        customerType: "user",
        customerId: "u-refund",
        adjustedTransactionId: "otp:old",
        adjustedEntryIndex: 0,
        quantity: 1,
        productId: "prod-refund",
        productLineId: "line-refund",
      }],
      customerType: "user",
      customerId: "u-refund",
      paymentProvider: "stripe",
      createdAtMillis: 8000,
      renewalTargetSubscriptionId: null,
    });

    const group = customerGroup("u-refund");
    const txns = await rowDatas(snapshot, schema.transactions, group);
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ txnId: "refund-1", type: "refund" });
    const owned = asRecord((await rowDatas(snapshot, schema.ownedProducts, group)).at(-1) ?? null);
    expect(asRecord(asRecord(owned.ownedProducts)["prod-refund"]).quantity).toBe(0);
  });

  it("maintains a per-customer subscription map", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await set(snapshot, schema.subscriptions, "sub-map-a", subscription("sub-map-a", { customerId: "u-map", createdAtMillis: 1000 }) as unknown as PiledriverObject);
    snapshot = await set(snapshot, schema.subscriptions, "sub-map-b", subscription("sub-map-b", { customerId: "u-map", createdAtMillis: 2000 }) as unknown as PiledriverObject);
    snapshot = await set(snapshot, schema.subscriptions, "sub-map-a", subscription("sub-map-a", { customerId: "u-map", status: "past_due", createdAtMillis: 3000 }) as unknown as PiledriverObject);

    const rowsForCustomer = (await rowsBySortKey(snapshot, schema.subscriptionMapByCustomer, customerGroup("u-map"))).map(row => asRecord(row.rowData));
    const latest = rowsForCustomer.at(-1);
    expect(Object.keys(asRecord(latest!.subscriptions)).sort()).toEqual(["sub-map-a", "sub-map-b"]);
    expect(asRecord(asRecord(latest!.subscriptions)["sub-map-a"]).status).toBe("past_due");
  });
});

describe("transactions-by-tenancy date index", () => {
  // The tenancy date index is what lets listTransactions read one page (~limit rows) in
  // newest-first order without scanning the whole tenancy. These tests pin the ordering,
  // cursor-range semantics, and tenancy isolation that the index.ts pagination relies on.
  const refundTxn = (opts: { txnId: string, customerId: string, createdAtMillis: number, tenancyId?: string, customerType?: CustomerType }) => ({
    txnId: opts.txnId,
    tenancyId: opts.tenancyId ?? "t1",
    effectiveAtMillis: opts.createdAtMillis,
    type: "refund" as const,
    entries: [] as unknown[],
    customerType: opts.customerType ?? "user",
    customerId: opts.customerId,
    paymentProvider: "stripe" as const,
    createdAtMillis: opts.createdAtMillis,
    renewalTargetSubscriptionId: null,
  });
  const setRefund = async (snapshot: Snapshot, opts: Parameters<typeof refundTxn>[0]) =>
    await set(snapshot, "payments-manual-transactions", opts.txnId, refundTxn(opts) as unknown as PiledriverObject);
  // Mirror the index.ts (createdAtMillis, txnId) recency key and its reverse-walk read.
  const recencyKey = (createdAtMillis: number, txnId: string): PiledriverObject => [createdAtMillis, txnId];
  const readPage = async (snapshot: Snapshot, tenancyId: string, opts: { lt?: PiledriverObject, limit?: number } = {}) =>
    (await collect(snapshot.listRowsInGroup({
      tableId: createPaymentsSchema().transactionsByTenancy,
      groupKey: { tenancyId },
      range: { reverse: true, lt: opts.lt, limit: opts.limit },
    }))).map(row => (row.rowData as unknown as TransactionRow).txnId);

  const seedTenancies = async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    snapshot = await setRefund(snapshot, { txnId: "r-a", customerId: "c1", createdAtMillis: 100 });
    snapshot = await setRefund(snapshot, { txnId: "r-b", customerId: "c2", createdAtMillis: 200 });
    snapshot = await setRefund(snapshot, { txnId: "r-c", customerId: "c1", createdAtMillis: 300 });
    snapshot = await setRefund(snapshot, { txnId: "r-d", customerId: "c2", createdAtMillis: 300 }); // tie at 300
    snapshot = await setRefund(snapshot, { txnId: "r-e", customerId: "c1", createdAtMillis: 400 });
    snapshot = await setRefund(snapshot, { txnId: "r-f", customerId: "c3", createdAtMillis: 250, tenancyId: "t2" });
    return { schema, snapshot };
  };

  it("orders a tenancy newest-first, breaking createdAt ties by txnId", async () => {
    const { snapshot } = await seedTenancies();
    expect(await readPage(snapshot, "t1")).toEqual(["r-e", "r-d", "r-c", "r-b", "r-a"]);
  });

  it("isolates tenancies", async () => {
    const { snapshot } = await seedTenancies();
    expect(await readPage(snapshot, "t2")).toEqual(["r-f"]);
  });

  it("pages with a cursor lower bound and covers every row exactly once", async () => {
    const { snapshot } = await seedTenancies();
    const page1 = await readPage(snapshot, "t1", { limit: 2 });
    expect(page1).toEqual(["r-e", "r-d"]);
    // Cursor from the last row of page1 (createdAtMillis=300, txnId="r-d").
    const page2 = await readPage(snapshot, "t1", { limit: 2, lt: recencyKey(300, "r-d") });
    expect(page2).toEqual(["r-c", "r-b"]);
    const page3 = await readPage(snapshot, "t1", { limit: 2, lt: recencyKey(200, "r-b") });
    expect(page3).toEqual(["r-a"]);
    expect([...page1, ...page2, ...page3]).toEqual(["r-e", "r-d", "r-c", "r-b", "r-a"]);
  });

  it("keeps per-customer reads scoped to that customer (the customer-scoped list path)", async () => {
    const { schema, snapshot } = await seedTenancies();
    const c1 = ((await rowDatas(snapshot, schema.transactions, customerGroup("c1"))) as unknown as TransactionRow[])
      .map(txn => txn.txnId).sort(stringCompare);
    expect(c1).toEqual(["r-a", "r-c", "r-e"]);
  });

  it("co-locates a source txn, its igr repeats, and refunds in one customer group (the single-group refund-read invariant)", async () => {
    const schema = createPaymentsSchema();
    let snapshot = await initializedSnapshot();
    // A subscription with a repeating, expiring item produces sub-start + igr repeat txns
    // in the customer's group; a refund for the source lands in the same group. The
    // index.ts refund reads depend on all of these living together.
    const firstRepeatMillis = Date.UTC(1970, 1, 1);
    snapshot = await set(snapshot, schema.subscriptions, "sub-grant", subscription("sub-grant", {
      customerId: "u-grant",
      productId: "prod-grant",
      product: product({ credits: { quantity: 10, repeat: [1, "month"], expires: "when-repeated" } }),
      currentPeriodEndMillis: 2 * MONTH_MS,
    }) as unknown as PiledriverObject);
    snapshot = (await snapshot.tick(new Date(firstRepeatMillis))).newSnapshot;
    snapshot = await setRefund(snapshot, { txnId: "refund:sub-start:sub-grant:uuid1", customerId: "u-grant", createdAtMillis: 5_000 });

    const txnIds = ((await rowDatas(snapshot, schema.transactions, customerGroup("u-grant"))) as unknown as TransactionRow[])
      .map(txn => txn.txnId).sort(stringCompare);
    expect(txnIds).toEqual([`igr:sub-grant:${firstRepeatMillis}`, "refund:sub-start:sub-grant:uuid1", "sub-start:sub-grant"]);
  });
});

describe("mergeCompactionAggregates", () => {
  const compactionEntry = (overrides: { itemId: string, quantity: number, txnId: string, index: number }): ItemQuantityChangeEntry => ({
    type: "item-quantity-change",
    index: overrides.index,
    txnId: overrides.txnId,
    txnEffectiveAtMillis: overrides.index,
    txnCreatedAtMillis: overrides.index,
    txnType: "manual-item-quantity-change",
    tenancyId: "t1",
    paymentProvider: null,
    customerType: "user",
    customerId: "c1",
    quantity: overrides.quantity,
    itemId: overrides.itemId,
    expiresWhen: null,
  });
  const aggregate = (txnId: string, index: number, items: Record<string, number>): ItemCompactionAggregate => ({
    type: "item-quantity-compaction-aggregate",
    txnEffectiveAtMillis: index,
    txnId,
    index,
    items: Object.fromEntries(
      Object.entries(items).map(([itemId, quantity]) => [itemId, { firstRow: compactionEntry({ itemId, quantity, txnId, index }), quantity }]),
    ),
  });
  const itemQuantities = (aggregate: ItemCompactionAggregate) =>
    Object.fromEntries(Object.entries(aggregate.items).map(([itemId, item]) => [itemId, item.quantity]));

  it("produces the same result regardless of merge grouping", () => {
    // overlapping (credits, seats, gpu) and distinct (ram) items cover both branches
    const a = aggregate("a", 0, { credits: 1, seats: 2 });
    const b = aggregate("b", 1, { credits: 3, gpu: 5 });
    const c = aggregate("c", 2, { seats: 7, gpu: 11, ram: 13 });

    const leftAssociative = mergeCompactionAggregates(mergeCompactionAggregates(a, b), c);
    const rightAssociative = mergeCompactionAggregates(a, mergeCompactionAggregates(b, c));

    expect(leftAssociative).toEqual(rightAssociative);
    expect(itemQuantities(leftAssociative)).toEqual({ credits: 4, seats: 9, gpu: 16, ram: 13 });
    expect(leftAssociative.txnId).toBe("a");
    expect(leftAssociative.index).toBe(0);
  });
});

describe("normalizedRepeatInterval", () => {
  it("returns a positive interval unchanged (calendar math lives in nthDayIntervalMillis)", () => {
    expect(normalizedRepeatInterval([1, "day"])).toEqual([1, "day"]);
    expect(normalizedRepeatInterval([2, "week"])).toEqual([2, "week"]);
    expect(normalizedRepeatInterval([1, "month"])).toEqual([1, "month"]);
    expect(normalizedRepeatInterval([1, "year"])).toEqual([1, "year"]);
  });

  it("treats a zero/negative/non-finite count as no-repeat (null)", () => {
    // A zero (or negative) repeat interval would produce a next-repeat time that
    // never advances, wedging the tick loop forever — so it must mean "no repeat".
    expect(normalizedRepeatInterval([0, "day"])).toBeNull();
    expect(normalizedRepeatInterval([-1, "month"])).toBeNull();
    expect(normalizedRepeatInterval([Number.NaN, "day"])).toBeNull();
  });

  it("treats 'never'/null/undefined as no-repeat (null)", () => {
    expect(normalizedRepeatInterval("never")).toBeNull();
    expect(normalizedRepeatInterval(null)).toBeNull();
    expect(normalizedRepeatInterval(undefined)).toBeNull();
  });
});
