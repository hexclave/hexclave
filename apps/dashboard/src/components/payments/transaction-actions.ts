import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { ArrowClockwiseIcon, ArrowCounterClockwiseIcon, GearIcon, ProhibitIcon, QuestionIcon, ReceiptXIcon, ShoppingCartIcon, ShuffleIcon } from "@phosphor-icons/react";
import type { Transaction, TransactionEntry, TransactionType } from "@hexclave/shared/dist/interface/crud/transactions";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { urlString } from "@hexclave/shared/dist/utils/urls";

type SourceType = "subscription" | "one_time" | "item_quantity_change" | "other";

type TransactionTypeTone = "blue" | "cyan" | "purple" | "green" | "orange" | "red";

type TransactionTypeDisplay = {
  label: string,
  Icon: PhosphorIcon,
  tone: TransactionTypeTone,
};

type MoneyTransferEntry = Extract<TransactionEntry, { type: "money_transfer" }>;
type ProductGrantEntry = Extract<TransactionEntry, { type: "product_grant" }>;
type ItemQuantityChangeEntry = Extract<TransactionEntry, { type: "item_quantity_change" }>;

export type RefundTarget = {
  type: "subscription" | "one-time-purchase",
  id: string,
  invoiceId?: string,
};

export type TransactionRowActionKind = "refund" | "cancel" | "revoke";

/**
 * One entry in a transaction row's action menu. Unavailable actions are still
 * listed (disabled, with the reason as tooltip) so admins learn *why* a row
 * can't be refunded instead of hunting for a missing button.
 */
export type TransactionRowAction =
  | { kind: TransactionRowActionKind, available: true, target: RefundTarget }
  | { kind: TransactionRowActionKind, available: false, reason: string };

export const TRANSACTION_ROW_ACTION_LABELS: ReadonlyMap<TransactionRowActionKind, string> = new Map([
  ["refund", "Refund"],
  ["cancel", "Cancel subscription"],
  ["revoke", "Revoke access"],
]);

export type TransactionStatusBadge = {
  label: string,
  color: "orange" | "purple" | "blue",
};

export type TransactionAmountTone = "inflow" | "outflow" | "empty";

export type TransactionSummary = {
  sourceType: SourceType,
  displayType: TransactionTypeDisplay,
  customerType: string | null,
  customerId: string | null,
  detail: string,
  amountDisplay: string,
  amountTone: TransactionAmountTone,
  refundTarget: RefundTarget | null,
  refunded: boolean,
  chargedAmountUsd: string | null,
  productDisplayName: string | null,
  status: TransactionStatusBadge | null,
};

const REFUND_UNAVAILABLE_BY_TYPE = new Map<TransactionType, string>([
  ["chargeback", "Chargebacks are issued by the card network, not from here."],
  ["subscription-cancellation", "This is a cancellation, not a payment."],
  ["manual-item-quantity-change", "Item quantity changes aren’t payments, so they can’t be refunded."],
  ["product-change", "Product changes can’t be refunded from here."],
]);

function isMoneyTransferEntry(entry: TransactionEntry): entry is MoneyTransferEntry {
  return entry.type === "money_transfer";
}

function isProductGrantEntry(entry: TransactionEntry): entry is ProductGrantEntry {
  return entry.type === "product_grant";
}

function isItemQuantityChangeEntry(entry: TransactionEntry): entry is ItemQuantityChangeEntry {
  return entry.type === "item_quantity_change";
}

export function getRelatedSubscriptionId(transaction: Transaction): string | null {
  const target = getRefundTarget(transaction);
  if (target?.type === "subscription") {
    return target.id;
  }
  return getTransactionFamilyId(transaction);
}

export function getProductGrant(transaction: Transaction): ProductGrantEntry | null {
  return transaction.entries.find(isProductGrantEntry) ?? null;
}

/**
 * Price line for a grant, e.g. "19.00 USD · per month". Used on the
 * subscription page where the modal only shows amount + status.
 */
export function describeProductGrantPrice(grant: ProductGrantEntry): string | null {
  if (grant.price_id == null) {
    return null;
  }
  const price = new Map(Object.entries(grant.product.prices)).get(grant.price_id);
  if (price == null) {
    return grant.price_id;
  }
  const amounts = Object.entries(price).filter((entry): entry is [string, string] => (
    entry[0] !== "interval"
    && entry[0] !== "free_trial"
    && typeof entry[1] === "string"
  ));
  const amountText = amounts.length === 0
    ? grant.price_id
    : amounts.map(([code, amount]) => `${amount} ${code}`).join(", ");
  const interval = price.interval;
  if (interval == null) {
    return `${amountText} · one-time`;
  }
  const [count, unit] = interval;
  const cadence = count === 1 ? `per ${unit}` : `every ${count} ${unit}s`;
  return `${amountText} · ${cadence}`;
}

export function describeIncludedItems(grant: ProductGrantEntry): string | null {
  const items = Object.entries(grant.product.included_items);
  if (items.length === 0) {
    return null;
  }
  return items.map(([itemId, item]) => {
    const quantity = item.quantity;
    return quantity == null ? itemId : `${itemId} ×${quantity}`;
  }).join(", ");
}

/**
 * Detail pages are not in the sidebar. Customer is in the query string so the
 * page can load this customer's history (bounded) instead of scanning the tenancy.
 *
 * A subscription’s original purchase is the subscription — there is no
 * `/payments/subscriptions/…` route. Related renewals/refunds are other
 * transactions, linked from this page.
 */
export function transactionPageHref(projectId: string, transaction: Pick<Transaction, "id" | "customer_type" | "customer_id">): string {
  const params = new URLSearchParams({
    customer_type: transaction.customer_type,
    customer_id: transaction.customer_id,
  });
  return `${urlString`/projects/${projectId}/payments/transactions/${transaction.id}`}?${params.toString()}`;
}

export function parseCustomerTypeParam(value: string | null): Transaction["customer_type"] | null {
  if (value === "user" || value === "team" || value === "custom") {
    return value;
  }
  return null;
}

export function parsePaymentsEntityPath(pathname: string, kind: "transactions" | "subscriptions"): string | null {
  const parts = pathname.split("/").filter((part) => part !== "");
  const paymentsIdx = parts.indexOf("payments");
  if (paymentsIdx < 0) {
    return null;
  }
  if (parts[paymentsIdx + 1] !== kind) {
    return null;
  }
  if (paymentsIdx + 2 >= parts.length) {
    return null;
  }
  const id = parts[paymentsIdx + 2];
  if (id === "") {
    return null;
  }
  return decodeURIComponent(id);
}

function formatChargedAmount(charged: object): string {
  const parts = Object.entries(charged).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return parts.map(([code, amount]) => `${amount} ${code}`).join(", ");
}

export function describeTransactionEntry(entry: TransactionEntry): { label: string, detail: string } {
  switch (entry.type) {
    case "money_transfer": {
      return { label: "Money transfer", detail: formatChargedAmount(entry.charged_amount) };
    }
    case "product_grant": {
      const ref = entry.subscription_id != null
        ? `subscription ${entry.subscription_id}`
        : entry.one_time_purchase_id != null
          ? `one-time purchase ${entry.one_time_purchase_id}`
          : null;
      return {
        label: "Product grant",
        detail: `${entry.product.display_name} ×${entry.quantity}${ref != null ? ` · ${ref}` : ""}`,
      };
    }
    case "item_quantity_change": {
      return { label: "Item quantity change", detail: `${entry.item_id} ${entry.quantity > 0 ? "+" : ""}${entry.quantity}` };
    }
    case "product_revocation": {
      return { label: "Product revocation", detail: `×${entry.quantity} · adjusts ${entry.adjusted_transaction_id}` };
    }
    case "product_revocation_reversal": {
      return { label: "Revocation reversal", detail: `×${entry.quantity} · adjusts ${entry.adjusted_transaction_id}` };
    }
  }
}

export function describeTransactionEntryFields(entry: TransactionEntry): { label: string, value: string }[] {
  switch (entry.type) {
    case "money_transfer": {
      const fields = [
        { label: "Charged", value: formatChargedAmount(entry.charged_amount) },
        { label: "Net", value: formatChargedAmount(entry.net_amount) },
      ];
      if (entry.adjusted_transaction_id != null) {
        fields.push({ label: "Adjusts", value: listedIdFromLedgerTxnId(entry.adjusted_transaction_id) });
      }
      return fields;
    }
    case "product_grant": {
      const fields = [
        { label: "Product", value: `${entry.product.display_name} ×${entry.quantity}` },
      ];
      if (entry.product_id != null) {
        fields.push({ label: "Product ID", value: entry.product_id });
      }
      const price = describeProductGrantPrice(entry);
      if (price != null) {
        fields.push({ label: "Price", value: price });
      }
      if (entry.subscription_id != null) {
        fields.push({ label: "Subscription ID", value: entry.subscription_id });
      }
      if (entry.one_time_purchase_id != null) {
        fields.push({ label: "One-time purchase ID", value: entry.one_time_purchase_id });
      }
      const included = describeIncludedItems(entry);
      if (included != null) {
        fields.push({ label: "Included items", value: included });
      }
      return fields;
    }
    case "item_quantity_change": {
      const fields = [
        { label: "Item", value: entry.item_id },
        { label: "Quantity", value: entry.quantity > 0 ? `+${entry.quantity}` : `${entry.quantity}` },
      ];
      if (entry.adjusted_transaction_id != null) {
        fields.push({ label: "Adjusts", value: listedIdFromLedgerTxnId(entry.adjusted_transaction_id) });
      }
      return fields;
    }
    case "product_revocation":
    case "product_revocation_reversal": {
      return [
        { label: "Quantity", value: `×${entry.quantity}` },
        { label: "Adjusts", value: listedIdFromLedgerTxnId(entry.adjusted_transaction_id) },
      ];
    }
  }
}

export function getRefundTarget(transaction: Transaction): RefundTarget | null {
  if (transaction.type === "subscription-renewal") {
    if (transaction.renewal_target_subscription_id == null) {
      return null;
    }
    return {
      type: "subscription",
      id: transaction.renewal_target_subscription_id,
      // Listed renewal id is the invoice id (sourceId from sub-renewal:<invoiceId>).
      invoiceId: transaction.id,
    };
  }
  if (transaction.type !== "purchase") {
    return null;
  }
  const productGrant = transaction.entries.find(isProductGrantEntry);
  if (productGrant?.subscription_id) {
    return { type: "subscription", id: productGrant.subscription_id };
  }
  if (productGrant?.one_time_purchase_id) {
    return { type: "one-time-purchase", id: productGrant.one_time_purchase_id };
  }
  return null;
}

export function getChargedAmountUsd(transaction: Transaction): string | null {
  const moneyTransferEntry = transaction.entries.find(isMoneyTransferEntry);
  return moneyTransferEntry?.charged_amount.USD ?? null;
}

function deriveSourceType(transaction: Transaction): SourceType {
  if (transaction.entries.some(isItemQuantityChangeEntry)) {
    return "item_quantity_change";
  }
  const productGrant = transaction.entries.find(isProductGrantEntry);
  if (productGrant?.subscription_id) {
    return "subscription";
  }
  if (productGrant?.one_time_purchase_id) {
    return "one_time";
  }
  if (productGrant) {
    return "other";
  }
  return "other";
}

export function formatTransactionTypeLabel(transactionType: TransactionType | null): TransactionTypeDisplay {
  switch (transactionType) {
    case "purchase": {
      return { label: "Purchase", Icon: ShoppingCartIcon, tone: "blue" };
    }
    case "subscription-renewal": {
      return { label: "Renewal", Icon: ArrowClockwiseIcon, tone: "cyan" };
    }
    case "subscription-cancellation": {
      return { label: "Cancellation", Icon: ProhibitIcon, tone: "orange" };
    }
    case "chargeback": {
      return { label: "Chargeback", Icon: ArrowCounterClockwiseIcon, tone: "red" };
    }
    case "refund": {
      // Filter label for the API type. Individual rows use
      // `getTransactionDisplayType` so a $0 cancel isn't titled "Refund".
      return { label: "Refund / cancel", Icon: ReceiptXIcon, tone: "red" };
    }
    case "manual-item-quantity-change": {
      return { label: "Item change", Icon: GearIcon, tone: "purple" };
    }
    case "product-change": {
      return { label: "Product change", Icon: ShuffleIcon, tone: "purple" };
    }
    default: {
      return { label: "—", Icon: QuestionIcon, tone: "purple" };
    }
  }
}

function refundRowReturnedMoney(transaction: Transaction): boolean {
  return transaction.entries.some(isMoneyTransferEntry);
}

function refundRowRevokedAccess(transaction: Transaction): boolean {
  return transaction.entries.some((entry) => entry.type === "product_revocation");
}

/**
 * The admin refund API always persists `type: "refund"`, including $0
 * cancel/revoke. Source ids (`otp:…`, `sub-start:…`) are the only way to
 * tell a subscription cancel from a one-time revoke on those rows.
 */
function refundRowSourceKind(transaction: Transaction): "subscription" | "one-time" | "unknown" {
  const refs: string[] = [transaction.id];
  for (const entry of transaction.entries) {
    if (entry.type === "product_revocation") {
      refs.push(entry.adjusted_transaction_id);
    }
    if (isMoneyTransferEntry(entry) && entry.adjusted_transaction_id != null) {
      refs.push(entry.adjusted_transaction_id);
    }
  }
  if (refs.some((ref) => ref.startsWith("otp:") || ref.startsWith("refund:otp:"))) {
    return "one-time";
  }
  if (refs.some((ref) =>
    ref.startsWith("sub-start:")
    || ref.startsWith("sub-renewal:")
    || ref.startsWith("refund:sub-start:")
    || ref.startsWith("refund:sub-renewal:")
  )) {
    return "subscription";
  }
  return "unknown";
}

/**
 * What to show in the Type column. Differs from `formatTransactionTypeLabel`
 * for refund-typed rows: the ledger type is "refund" even when the admin
 * only canceled or revoked, and calling that a refund is a lie.
 */
export function getTransactionDisplayType(transaction: Transaction): TransactionTypeDisplay {
  if (transaction.type !== "refund") {
    return formatTransactionTypeLabel(transaction.type);
  }
  if (refundRowReturnedMoney(transaction)) {
    return { label: "Refund", Icon: ReceiptXIcon, tone: "red" };
  }
  if (refundRowSourceKind(transaction) === "one-time") {
    return { label: "Revoke", Icon: ArrowCounterClockwiseIcon, tone: "orange" };
  }
  return formatTransactionTypeLabel("subscription-cancellation");
}

function getProductDisplayName(entry: ProductGrantEntry): string {
  return entry.product.display_name;
}

export function describeDetail(transaction: Transaction): string {
  // The admin refund API always writes `type: "refund"`. Describe the
  // actual effect (money vs access) so a $0 cancel isn't a bare "Refund".
  if (transaction.type === "refund") {
    const returnedMoney = refundRowReturnedMoney(transaction);
    const revokedAccess = refundRowRevokedAccess(transaction);
    const kind = refundRowSourceKind(transaction);
    if (returnedMoney && revokedAccess) {
      return kind === "one-time" ? "Refund · access revoked" : "Refund · subscription canceled";
    }
    if (returnedMoney) {
      return "Refund";
    }
    if (revokedAccess) {
      return kind === "one-time" ? "Access revoked" : "Subscription canceled";
    }
    // No-money, no-revocation: `end_action="at-period-end"` (test mode, or
    // live with $0). The subscription stays active until the period expires.
    return "Cancels at period end";
  }
  if (transaction.type === "subscription-cancellation") {
    return "Subscription canceled";
  }
  const productGrant = transaction.entries.find(isProductGrantEntry);
  if (productGrant) {
    const name = getProductDisplayName(productGrant);
    const quantity = productGrant.quantity;
    return quantity > 1 ? `${name} (×${quantity})` : name;
  }
  const itemChange = transaction.entries.find(isItemQuantityChangeEntry);
  if (itemChange) {
    const delta = itemChange.quantity;
    const deltaLabel = delta > 0 ? `+${delta}` : `${delta}`;
    return `${itemChange.item_id} (${deltaLabel})`;
  }
  const sourceType = deriveSourceType(transaction);
  if (sourceType === "item_quantity_change") {
    return "Item quantity change";
  }
  return "—";
}

function formatAmountDisplay(transaction: Transaction, chargedAmountUsd: string | null): string {
  if (transaction.test_mode) {
    return "—";
  }
  if (chargedAmountUsd == null) {
    const moneyTransferEntry = transaction.entries.find(isMoneyTransferEntry);
    if (moneyTransferEntry) {
      return "Non-USD";
    }
    return "—";
  }
  const isReturn = transaction.type === "refund" || transaction.type === "chargeback";
  return isReturn ? `−$${chargedAmountUsd}` : `$${chargedAmountUsd}`;
}

function getAmountTone(transaction: Transaction, chargedAmountUsd: string | null): TransactionAmountTone {
  if (transaction.test_mode || chargedAmountUsd == null) {
    return "empty";
  }
  if (transaction.type === "refund" || transaction.type === "chargeback") {
    return "outflow";
  }
  return "inflow";
}

function getAdjustedEntryIndexes(transaction: Transaction): Set<number> {
  return new Set(transaction.adjusted_by.map((adjustment) => adjustment.entry_index));
}

export function getMoneyAlreadyReturned(transaction: Transaction): boolean {
  const adjustedIndexes = getAdjustedEntryIndexes(transaction);
  return transaction.entries.some((entry, index) => isMoneyTransferEntry(entry) && adjustedIndexes.has(index));
}

/**
 * True when this row's product grant was revoked. Renewal rows have no grant,
 * so they stay false even if the parent subscription was canceled — refunding
 * a renewal after cancel is a money-only action (no lifecycle section).
 */
export function getAccessAlreadyEnded(transaction: Transaction): boolean {
  const adjustedIndexes = getAdjustedEntryIndexes(transaction);
  return transaction.entries.some((entry, index) => isProductGrantEntry(entry) && adjustedIndexes.has(index));
}

function getStatusBadge(transaction: Transaction): TransactionStatusBadge | null {
  if (getMoneyAlreadyReturned(transaction)) {
    return { label: "Refunded", color: "orange" };
  }
  const adjustedIndexes = getAdjustedEntryIndexes(transaction);
  const revokedGrant = transaction.entries.find((entry, index): entry is ProductGrantEntry => isProductGrantEntry(entry) && adjustedIndexes.has(index));
  if (revokedGrant != null) {
    return {
      label: revokedGrant.subscription_id != null ? "Canceled" : "Revoked",
      color: "orange",
    };
  }
  if (transaction.test_mode) {
    return { label: "Test", color: "purple" };
  }
  return null;
}

/**
 * Why a money refund isn't offered on this row. Returns null when a
 * charged USD amount exists and we have a refund target.
 *
 * Cancel/revoke can still be available when this returns a reason — test
 * mode has no money to return, but the same API can end the subscription.
 */
export function getRefundUnavailableReason(transaction: Transaction): string | null {
  if (transaction.type === "refund") {
    const display = getTransactionDisplayType(transaction);
    if (display.label === "Cancellation") {
      return "This is a cancellation, not a payment.";
    }
    if (display.label === "Revoke") {
      return "This is an access revocation, not a payment.";
    }
    return "This row is already a refund, not a payment.";
  }
  const typedReason = transaction.type == null ? null : REFUND_UNAVAILABLE_BY_TYPE.get(transaction.type);
  if (typedReason != null) {
    return typedReason;
  }
  if (transaction.type === "subscription-renewal" && transaction.renewal_target_subscription_id == null) {
    return "This renewal is from before refunds were supported on renewal rows. Refund the original purchase instead.";
  }
  const target = getRefundTarget(transaction);
  if (target == null) {
    if (transaction.type === "purchase") {
      return "This purchase isn’t linked to a subscription or one-time product, so it can’t be refunded from here.";
    }
    return "This transaction isn’t a payment, so it can’t be refunded.";
  }
  if (getChargedAmountUsd(transaction) == null) {
    return "There’s no money to refund (test mode or non-USD). Cancel or revoke access instead.";
  }
  return null;
}

function isPaymentRow(transaction: Transaction): boolean {
  return transaction.type === "purchase" || transaction.type === "subscription-renewal";
}

export function isPaymentRowAction(action: TransactionRowAction): boolean {
  return action.kind === "refund";
}

export function isLifecycleRowAction(action: TransactionRowAction): boolean {
  return action.kind === "cancel" || action.kind === "revoke";
}

/**
 * Actions this row can still perform. The table is a payment ledger; the
 * related subscription (or one-time grant) is a different object.
 *
 * - Refund is the payment action. It only appears on purchase/renewal rows.
 *   After a cancel, refund stays available (money can still move). The
 *   dialog is money-only then.
 * - Cancel/revoke are actions on the *related* subscription / grant, not on
 *   this charge. Cancel is only offered on the original purchase (the
 *   subscription root). Renewal invoices can refund this charge, and the
 *   refund form can opt into period-end cancel — they cannot cancel-now,
 *   because the refund API cannot end a subscription immediately against a
 *   renewal invoice.
 * - Cancel/revoke are disabled once this row's product grant has been
 *   revoked, so we don't ask the admin to pick a lifecycle fate that's
 *   already decided.
 */
export function getTransactionRowActions(transaction: Transaction): TransactionRowAction[] {
  const target = getRefundTarget(transaction);
  const chargedAmountUsd = getChargedAmountUsd(transaction);
  const accessAlreadyEnded = getAccessAlreadyEnded(transaction);
  const actions: TransactionRowAction[] = [];

  if (isPaymentRow(transaction)) {
    if (target != null && chargedAmountUsd != null) {
      actions.push({ kind: "refund", available: true, target });
    } else {
      actions.push({
        kind: "refund",
        available: false,
        reason: getRefundUnavailableReason(transaction) ?? throwErr("getRefundUnavailableReason must return a reason when a payment row can't be refunded", { transactionId: transaction.id }),
      });
    }
  }
  if (target?.type === "subscription" && target.invoiceId == null) {
    if (accessAlreadyEnded) {
      actions.push({ kind: "cancel", available: false, reason: "This subscription is already canceled." });
    } else {
      actions.push({ kind: "cancel", available: true, target });
    }
  }
  if (target?.type === "one-time-purchase") {
    if (accessAlreadyEnded) {
      actions.push({ kind: "revoke", available: false, reason: "Access is already revoked." });
    } else {
      actions.push({ kind: "revoke", available: true, target });
    }
  }
  return actions;
}

const LEDGER_TXN_ID_PREFIXES = ["otp:", "sub-start:", "sub-renewal:", "miqc:"] as const;

/**
 * Listed `transaction.id` strips the ledger prefix (`otp:`, `sub-start:`,
 * `sub-renewal:`). Refund rows keep the full ledger id (`refund:otp:…:uuid`).
 */
export function listedIdFromLedgerTxnId(ledgerTxnId: string): string {
  for (const prefix of LEDGER_TXN_ID_PREFIXES) {
    if (ledgerTxnId.startsWith(prefix)) {
      return ledgerTxnId.slice(prefix.length);
    }
  }
  return ledgerTxnId;
}

/**
 * Refund ledger ids are `refund:{sourceTxnId}:{uuid}`. `sourceTxnId` itself
 * may contain colons (`otp:…`, `sub-start:…`, `sub-renewal:…`).
 */
export function parseRefundSourceTxnId(transactionId: string): string | null {
  if (!transactionId.startsWith("refund:")) {
    return null;
  }
  const rest = transactionId.slice("refund:".length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon <= 0) {
    return null;
  }
  const sourceTxnId = rest.slice(0, lastColon);
  const uuid = rest.slice(lastColon + 1);
  if (sourceTxnId.length === 0 || uuid.length === 0) {
    return null;
  }
  return sourceTxnId;
}

export type RelatedTransactionRef = {
  listedId: string,
  relation: "original" | "follows",
};

/**
 * Direct ledger links on this row: the charge this refund/renewal came from,
 * and later refunds/cancels that adjusted this charge. Family members that
 * share a subscription (other renewals) are joined from a customer pool in
 * `collectRelatedTransactions`.
 */
export function getRelatedTransactionRefs(transaction: Transaction): RelatedTransactionRef[] {
  const refs: RelatedTransactionRef[] = [];
  const seen = new Set<string>();
  const add = (listedId: string, relation: RelatedTransactionRef["relation"]) => {
    if (listedId === "" || listedId === transaction.id || seen.has(listedId)) {
      return;
    }
    seen.add(listedId);
    refs.push({ listedId, relation });
  };

  const refundSource = parseRefundSourceTxnId(transaction.id);
  if (refundSource != null) {
    add(listedIdFromLedgerTxnId(refundSource), "original");
  }
  for (const entry of transaction.entries) {
    if (entry.adjusted_transaction_id != null) {
      add(listedIdFromLedgerTxnId(entry.adjusted_transaction_id), "original");
    }
  }
  if (transaction.type === "subscription-renewal" && transaction.renewal_target_subscription_id != null) {
    add(transaction.renewal_target_subscription_id, "original");
  }
  for (const adjustment of transaction.adjusted_by) {
    add(adjustment.transaction_id, "follows");
  }
  return refs;
}

export function getTransactionFamilyId(transaction: Transaction): string | null {
  if (transaction.renewal_target_subscription_id != null) {
    return transaction.renewal_target_subscription_id;
  }
  const grant = transaction.entries.find(isProductGrantEntry);
  if (grant?.subscription_id != null) {
    return grant.subscription_id;
  }
  const source = parseRefundSourceTxnId(transaction.id);
  if (source != null && source.startsWith("sub-start:")) {
    return listedIdFromLedgerTxnId(source);
  }
  // Cancels and some refunds revoke/adjust the original `sub-start:` grant.
  // One-time purchases use `otp:` here, so they stay off the subscription page.
  for (const entry of transaction.entries) {
    if (entry.adjusted_transaction_id != null && entry.adjusted_transaction_id.startsWith("sub-start:")) {
      return listedIdFromLedgerTxnId(entry.adjusted_transaction_id);
    }
  }
  return null;
}

function familyIdOf(transaction: Transaction, pool: ReadonlyMap<string, Transaction>): string | null {
  const direct = getTransactionFamilyId(transaction);
  if (direct != null) {
    return direct;
  }
  const source = parseRefundSourceTxnId(transaction.id);
  if (source == null) {
    return null;
  }
  const origin = pool.get(listedIdFromLedgerTxnId(source));
  if (origin == null) {
    return null;
  }
  return getTransactionFamilyId(origin) ?? origin.id;
}

function isInSubscriptionFamily(transaction: Transaction, familyId: string, pool: ReadonlyMap<string, Transaction>): boolean {
  if (transaction.id === familyId || transaction.renewal_target_subscription_id === familyId) {
    return true;
  }
  const grant = transaction.entries.find(isProductGrantEntry);
  if (grant?.subscription_id === familyId) {
    return true;
  }
  return familyIdOf(transaction, pool) === familyId;
}

export type RelatedTransactionMatch = {
  transaction: Transaction,
  relation: "original" | "follows" | "family",
  label: string,
};

export function relatedTransactionLabel(args: {
  current: Transaction,
  related: Transaction,
  relation: RelatedTransactionMatch["relation"],
}): string {
  if (args.relation === "original") {
    return args.current.type === "subscription-renewal" ? "Original purchase" : "Original payment";
  }
  if (args.relation === "follows") {
    const label = getTransactionDisplayType(args.related).label;
    if (label === "Refund") {
      return "Refund of this payment";
    }
    if (label === "Cancellation") {
      return "Canceled this subscription";
    }
    if (label === "Revoke") {
      return "Revoked this product";
    }
    return label;
  }
  return "Same subscription";
}

export function collectRelatedTransactions(
  current: Transaction,
  pool: ReadonlyMap<string, Transaction>,
): { matches: RelatedTransactionMatch[], unresolved: RelatedTransactionRef[] } {
  const matches: RelatedTransactionMatch[] = [];
  const seen = new Set<string>([current.id]);
  const unresolved: RelatedTransactionRef[] = [];

  const add = (transaction: Transaction, relation: RelatedTransactionMatch["relation"]) => {
    if (seen.has(transaction.id)) {
      return;
    }
    seen.add(transaction.id);
    matches.push({
      transaction,
      relation,
      label: relatedTransactionLabel({ current, related: transaction, relation }),
    });
  };

  for (const ref of getRelatedTransactionRefs(current)) {
    const found = pool.get(ref.listedId);
    if (found == null) {
      unresolved.push(ref);
      continue;
    }
    add(found, ref.relation);
  }

  const familyId = familyIdOf(current, pool);
  if (familyId != null) {
    for (const candidate of pool.values()) {
      if (isInSubscriptionFamily(candidate, familyId, pool)) {
        add(candidate, "family");
      }
    }
  }

  matches.sort((a, b) => {
    const rank = (relation: RelatedTransactionMatch["relation"]) => relation === "original" ? 0 : relation === "follows" ? 1 : 2;
    const byRelation = rank(a.relation) - rank(b.relation);
    if (byRelation !== 0) {
      return byRelation;
    }
    return b.transaction.created_at_millis - a.transaction.created_at_millis;
  });
  return { matches, unresolved };
}

export function getTransactionSummary(transaction: Transaction): TransactionSummary {
  const sourceType = deriveSourceType(transaction);
  const refundTarget = getRefundTarget(transaction);
  const chargedAmountUsd = getChargedAmountUsd(transaction);
  const productGrant = transaction.entries.find(isProductGrantEntry);
  const refunded = getMoneyAlreadyReturned(transaction);

  return {
    sourceType,
    displayType: getTransactionDisplayType(transaction),
    customerType: transaction.customer_type,
    customerId: transaction.customer_id,
    detail: describeDetail(transaction),
    amountDisplay: formatAmountDisplay(transaction, chargedAmountUsd),
    amountTone: getAmountTone(transaction, chargedAmountUsd),
    refundTarget,
    refunded,
    chargedAmountUsd,
    productDisplayName: productGrant ? getProductDisplayName(productGrant) : null,
    status: getStatusBadge(transaction),
  };
}
