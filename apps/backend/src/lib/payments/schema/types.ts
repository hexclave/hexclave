/**
 * Type definitions for the payments Bulldozer table algebra pipeline.
 *
 * Data flows: SeedEventsTables -> Events -> Transactions -> TransactionEntries -> CompactedEntries -> OwnedProducts / ItemQuantities
 *
 * All field names use camelCase since they're stored as JSONB keys
 * in bulldozer-js's stored tables.
 */


// ============================================================
// Shared value types
// ============================================================

export const PAYMENT_PROVIDERS = ["test_mode", "stripe"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const CUSTOMER_TYPES = ["user", "team", "custom"] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "canceled",
  "paused",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "unpaid",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const PURCHASE_CREATION_SOURCES = ["PURCHASE_PAGE", "TEST_MODE", "API_GRANT"] as const;
export type PurchaseCreationSource = (typeof PURCHASE_CREATION_SOURCES)[number];

/** A day-based interval, e.g. [30, "day"] or [1, "month"]. Matches dayIntervalSchema from schema-fields. */
export type DayInterval = [number, "day" | "week" | "month" | "year"];

/** Recursive JSON type, compatible with bulldozer's Json from db/utilities.ts */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };


// ============================================================
// Product types (stored as JSONB snapshots in events/entries)
// ============================================================

export type IncludedItemConfig = {
  quantity: number,
  repeat?: DayInterval | "never" | null,
  expires?: "never" | "when-purchase-expires" | "when-repeated" | null,
};

/**
 * Product snapshot as stored in JSONB. Uses the camelCase format matching
 * productSchema from schema-fields.ts (the shape stored in Prisma's Json `product` column).
 */
export type ProductSnapshot = {
  displayName?: string | null,
  productLineId?: string | null,
  customerType: CustomerType,
  stackable?: boolean | null,
  serverOnly?: boolean | null,
  freeTrial?: DayInterval | null,
  isAddOnTo?: false | Record<string, true> | null,
  prices: Record<string, Record<string, Json>>,
  includedItems: Record<string, IncludedItemConfig>,
  clientMetadata?: Json | null,
  clientReadOnlyMetadata?: Json | null,
  serverMetadata?: Json | null,
};


// ============================================================
// StoredTable row types (mirrors of Prisma models, dates as millis)
// ============================================================

export type SubscriptionRow = {
  id: string,
  tenancyId: string,
  customerId: string,
  customerType: CustomerType,
  productId: string | null,
  priceId: string | null,
  product: ProductSnapshot,
  quantity: number,
  stripeSubscriptionId: string | null,
  status: SubscriptionStatus,
  currentPeriodStartMillis: number,
  currentPeriodEndMillis: number,
  cancelAtPeriodEnd: boolean,
  canceledAtMillis: number | null,
  endedAtMillis: number | null,
  refundedAtMillis: number | null,
  /**
   * Set when a refund explicitly revoked product access (end_action="now").
   * Distinct from `endedAtMillis` so phase-1 can tell refund-driven ends
   * from natural ends: refund-driven ends are filtered out and emit no
   * subscription-end transaction (the refund row carries the end entries
   * itself). Null for subscriptions that ended naturally / via webhook cancel.
   */
  productRevokedAtMillis: number | null,
  creationSource: PurchaseCreationSource,
  createdAtMillis: number,
};

export type SubscriptionInvoiceRow = {
  id: string,
  tenancyId: string,
  stripeSubscriptionId: string,
  stripeInvoiceId: string,
  isSubscriptionCreationInvoice: boolean,
  status: string | null,
  amountTotal: number | null,
  hostedInvoiceUrl: string | null,
  paidAtMillis?: number | null,
  markedUncollectibleAtMillis?: number | null,
  voidedAtMillis?: number | null,
  currency?: string | null,
  amountPaid?: number | null,
  createdAtMillis: number,
};

export type OneTimePurchaseRow = {
  id: string,
  tenancyId: string,
  customerId: string,
  customerType: CustomerType,
  productId: string | null,
  priceId: string | null,
  product: ProductSnapshot,
  quantity: number,
  stripePaymentIntentId: string | null,
  amountReceived?: number | null,
  currency?: string | null,
  paidAtMillis?: number | null,
  revokedAtMillis: number | null,
  refundedAtMillis: number | null,
  creationSource: PurchaseCreationSource,
  createdAtMillis: number,
};

export type ManualItemQuantityChangeRow = {
  id: string,
  tenancyId: string,
  customerId: string,
  customerType: CustomerType,
  itemId: string,
  quantity: number,
  description: string | null,
  expiresAtMillis: number | null,
  createdAtMillis: number,
};


// ============================================================
// Transaction types and entry types
// ============================================================

export const TRANSACTION_TYPES = [
  "subscription-renewal",
  "subscription-cancel",
  "subscription-end",
  "subscription-start",
  "item-grant-repeat",
  "one-time-purchase",
  "manual-item-quantity-change",
  "refund",
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

// -- Individual transaction entry data types --
// All entries carry customerType + customerId as common fields.

export type ActiveSubscriptionChangeEntryData = {
  type: "active-subscription-change",
  customerType: CustomerType,
  customerId: string,
  subscriptionId: string,
  changeType: "cancel",
};

export type ActiveSubscriptionEndEntryData = {
  type: "active-subscription-end",
  customerType: CustomerType,
  customerId: string,
  subscriptionId: string,
};

export type MoneyTransferEntryData = {
  type: "money-transfer",
  customerType: CustomerType,
  customerId: string,
  chargedAmount: Record<string, string>,
};

export type ActiveSubscriptionStartEntryData = {
  type: "active-subscription-start",
  customerType: CustomerType,
  customerId: string,
  subscriptionId: string,
};

export type ProductGrantEntryData = {
  type: "product-grant",
  customerType: CustomerType,
  customerId: string,
  productId: string | null,
  product: ProductSnapshot,
  quantity: number,
  productLineId: string | null,
  subscriptionId?: string | null,
  oneTimePurchaseId?: string | null,
};

export type ProductRevocationEntryData = {
  type: "product-revocation",
  customerType: CustomerType,
  customerId: string,
  adjustedTransactionId: string,
  adjustedEntryIndex: number,
  quantity: number,
  productId: string | null,
  productLineId: string | null,
};

export type ItemQuantityExpireEntryData = {
  type: "item-quantity-expire",
  customerType: CustomerType,
  customerId: string,
  adjustedTransactionId: string,
  adjustedEntryIndex: number,
  quantity: number,
  itemId: string,
};

export type ItemQuantityChangeEntryData = {
  type: "item-quantity-change",
  customerType: CustomerType,
  customerId: string,
  quantity: number,
  itemId: string,
  /** How this grant expires. null means it never expires (compactable). */
  expiresWhen: "when-purchase-expires" | "when-repeated" | null,
};

/** Compacted variant produced in Phase 2. Cannot be expired (compaction precondition). */
export type CompactedItemQuantityChangeEntryData = {
  type: "compacted-item-quantity-change",
  customerType: CustomerType,
  customerId: string,
  quantity: number,
  itemId: string,
};

/** Union of all entry types within a transaction's `entries` array. */
export type TransactionEntryData =
  | ActiveSubscriptionChangeEntryData
  | ActiveSubscriptionEndEntryData
  | MoneyTransferEntryData
  | ActiveSubscriptionStartEntryData
  | ProductGrantEntryData
  | ProductRevocationEntryData
  | ItemQuantityExpireEntryData
  | ItemQuantityChangeEntryData;

/** All entry types including the compacted variant, used after Phase 2 compaction. */
export type CompactedTransactionEntryData =
  | TransactionEntryData
  | CompactedItemQuantityChangeEntryData;

export const TRANSACTION_ENTRY_TYPES = [
  "active-subscription-change",
  "active-subscription-end",
  "money-transfer",
  "active-subscription-start",
  "product-grant",
  "product-revocation",
  "item-quantity-expire",
  "item-quantity-change",
  "compacted-item-quantity-change",
] as const;
export type TransactionEntryType = (typeof TRANSACTION_ENTRY_TYPES)[number];


// ============================================================
// Transaction row (in the Transactions bulldozer table)
// ============================================================

export type TransactionRow = {
  txnId: string,
  tenancyId: string,
  effectiveAtMillis: number,
  type: TransactionType,
  entries: TransactionEntryData[],
  customerType: CustomerType,
  customerId: string,
  paymentProvider: PaymentProvider | null,
  createdAtMillis: number,
  // Set only on subscription-renewal rows so list/refund UIs can target the
  // parent sub without a Prisma invoice lookup. Explicit null on other new
  // writes. Optional because pre-field LMDB rows omit the key entirely
  // (`undefined` at read time) — readers must use `?? null` / `== null`.
  renewalTargetSubscriptionId?: string | null,
};

/**
 * ManualTransactions have the same shape as TransactionRow.
 * They bypass the events flow and feed directly into the Transactions concat.
 */
export type ManualTransactionRow = TransactionRow;


// ============================================================
// Transaction entry row (flattened from transactions in Phase 2)
// Adds parent transaction metadata + positional index.
// ============================================================

type BaseEntryRowFields = {
  index: number,
  txnId: string,
  txnEffectiveAtMillis: number,
  txnCreatedAtMillis: number,
  txnType: TransactionType,
  tenancyId: string,
  paymentProvider: PaymentProvider | null,
};

export type TransactionEntryRow = TransactionEntryData & BaseEntryRowFields;
export type CompactedTransactionEntryRow = CompactedTransactionEntryData & BaseEntryRowFields;


// ============================================================
// Event row types (output of Phase 1 event tables)
//
// Each event is "fat": it carries all data needed to produce a
// complete transaction via a single MapTable step.
// ============================================================

/** Identifies a specific entry in another transaction (for expire/revocation back-refs). */
export type EntryBackReference = {
  transactionId: string,
  entryIndex: number,
};

export type SubscriptionRenewalEventRow = {
  subscriptionId: string,
  tenancyId: string,
  customerId: string,
  customerType: CustomerType,
  invoiceId: string,
  chargedAmount: Record<string, string>,
  paymentProvider: PaymentProvider,
  effectiveAtMillis: number,
  createdAtMillis: number,
};

export type SubscriptionCancelEventRow = {
  subscriptionId: string,
  tenancyId: string,
  customerId: string,
  customerType: CustomerType,
  changeType: "cancel",
  paymentProvider: PaymentProvider,
  effectiveAtMillis: number,
  createdAtMillis: number,
};

export type SubscriptionStartEventRow = {
  subscriptionId: string,
  tenancyId: string,
  customerId: string,
  customerType: CustomerType,
  productId: string | null,
  product: ProductSnapshot,
  productLineId: string | null,
  priceId: string | null,
  quantity: number,
  chargedAmount: Record<string, string>,
  itemGrants: Array<{
    itemId: string,
    quantity: number,
    expiresWhen: "when-purchase-expires" | "when-repeated" | null,
  }>,
  paymentProvider: PaymentProvider,
  effectiveAtMillis: number,
  createdAtMillis: number,
};

export type SubscriptionEndEventRow = {
  subscriptionId: string,
  tenancyId: string,
  customerId: string,
  customerType: CustomerType,
  productId: string | null,
  productLineId: string | null,
  quantity: number,
  /** Back-reference to the subscription-start transaction's product-grant entry */
  startProductGrantRef: EntryBackReference,
  /** Back-references to item-quantity-change entries from start and item-grant-repeat txns that need expiry */
  itemQuantityChangesToExpire: Array<EntryBackReference & {
    itemId: string,
    quantity: number,
  }>,
  /**
   * Mirrors `SubscriptionRow.productRevokedAtMillis`. When non-null, this
   * end was driven by a refund; phase-1 filters the event out entirely so
   * no subscription-end transaction is produced — the refund row carries
   * `active-subscription-end` / `product-revocation` / `item-quantity-expire`
   * itself. See refund/route.tsx and phase-1/transactions.ts.
   */
  productRevokedAtMillis: number | null,
  paymentProvider: PaymentProvider,
  effectiveAtMillis: number,
  createdAtMillis: number,
};

export type ItemGrantRepeatEventRow = {
  sourceType: "subscription" | "one_time_purchase",
  sourceId: string,
  tenancyId: string,
  customerId: string,
  customerType: CustomerType,
  itemGrants: Array<{
    itemId: string,
    quantity: number,
    expiresWhen: "when-purchase-expires" | "when-repeated" | null,
  }>,
  /** Back-references to previous item-grant-repeat's entries that expire "when-repeated" */
  previousGrantsToExpire: Array<EntryBackReference & {
    itemId: string,
    quantity: number,
  }>,
  paymentProvider: PaymentProvider,
  effectiveAtMillis: number,
  createdAtMillis: number,
};

export type OneTimePurchaseEventRow = {
  purchaseId: string,
  tenancyId: string,
  customerId: string,
  customerType: CustomerType,
  productId: string | null,
  product: ProductSnapshot,
  productLineId: string | null,
  priceId: string | null,
  quantity: number,
  chargedAmount: Record<string, string>,
  itemGrants: Array<{
    itemId: string,
    quantity: number,
    expiresWhen: "when-purchase-expires" | "when-repeated" | null,
  }>,
  paymentProvider: PaymentProvider,
  effectiveAtMillis: number,
  createdAtMillis: number,
};

export type ManualItemQuantityChangeEventRow = {
  changeId: string,
  tenancyId: string,
  customerId: string,
  customerType: CustomerType,
  itemId: string,
  quantity: number,
  effectiveAtMillis: number,
  createdAtMillis: number,
};


// ============================================================
// Phase 3 output types
// ============================================================

/** One row per transaction in the OwnedProducts LFold output. */
export type OwnedProductsRow = {
  txnEffectiveAtMillis: number,
  txnId: string,
  ownedProducts: Record<string, {
    quantity: number,
    product: ProductSnapshot,
    productLineId: string | null,
  }>,
  customerType: CustomerType,
  customerId: string,
  tenancyId: string,
};

/**
 * An item-quantity-change paired with at most one expiry.
 * Produced by the FlatMap that splits multi-expiry changes into individual sub-grants.
 */
export type ItemChangeWithExpiryRow = {
  txnId: string,
  txnEffectiveAtMillis: number,
  customerType: CustomerType,
  customerId: string,
  tenancyId: string,
  itemId: string,
  quantity: number,
  expiresAtMillis: number | null,
};

/** One row per transaction in the ItemQuantities LFold output. */
export type ItemQuantityRow = {
  txnEffectiveAtMillis: number,
  txnId: string,
  /** Map of itemId → net quantity for all items this customer has interacted with */
  itemQuantities: Record<string, number>,
  customerType: CustomerType,
  customerId: string,
  tenancyId: string,
};

/** LFold output: map of subscriptionId → full SubscriptionRow per customer. */
export type SubscriptionMapRow = {
  subscriptions: Record<string, SubscriptionRow>,
  tenancyId: string,
  customerType: CustomerType,
  customerId: string,
};
