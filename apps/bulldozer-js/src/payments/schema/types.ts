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

export type DayInterval = [number, "day" | "week" | "month" | "year"];
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type IncludedItemConfig = {
  quantity: number,
  repeat?: DayInterval | "never" | null,
  expires?: "never" | "when-purchase-expires" | "when-repeated" | null,
};

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

export type TransactionType =
  | "subscription-renewal"
  | "subscription-cancel"
  | "subscription-end"
  | "subscription-start"
  | "item-grant-repeat"
  | "one-time-purchase"
  | "manual-item-quantity-change"
  | "refund";

export type EntryBackReference = {
  transactionId: string,
  entryIndex: number,
};

export type TransactionEntryData =
  | { type: "active-subscription-change", customerType: CustomerType, customerId: string, subscriptionId: string, changeType: "cancel" }
  | { type: "active-subscription-end", customerType: CustomerType, customerId: string, subscriptionId: string }
  | { type: "money-transfer", customerType: CustomerType, customerId: string, chargedAmount: Record<string, string> }
  | { type: "active-subscription-start", customerType: CustomerType, customerId: string, subscriptionId: string }
  | { type: "product-grant", customerType: CustomerType, customerId: string, productId: string | null, priceId: string | null, product: ProductSnapshot, quantity: number, productLineId: string | null, subscriptionId?: string | null, oneTimePurchaseId?: string | null }
  | { type: "product-revocation", customerType: CustomerType, customerId: string, adjustedTransactionId: string, adjustedEntryIndex: number, quantity: number, productId: string | null, productLineId: string | null }
  | { type: "item-quantity-expire", customerType: CustomerType, customerId: string, adjustedTransactionId: string, adjustedEntryIndex: number, quantity: number, itemId: string }
  // `stampedExpiresAtMillis` is the concrete expiry time the ledger ranks the grant by (soonest-
  // first). It's only set for subscription/one-time-purchase grants whose `expiresWhen` is a
  // string; manual grants carry their absolute expiry directly in `expiresWhen` as a number.
  | { type: "item-quantity-change", customerType: CustomerType, customerId: string, quantity: number, itemId: string, expiresWhen: "when-purchase-expires" | "when-repeated" | number | null, stampedExpiresAtMillis?: number | null };

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

export type ManualTransactionRow = TransactionRow;
