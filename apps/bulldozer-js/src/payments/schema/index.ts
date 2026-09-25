import { moneyAmountToStripeUnits, stripeUnitsToMoneyAmount } from "@hexclave/shared/dist/utils/currencies";
import { SUPPORTED_CURRENCIES, type MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import { nthDayIntervalMillis } from "@hexclave/shared/dist/utils/dates";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import {
  declareBulldozerDatabase,
  declareGroupByTable,
  declareLeftFoldTable,
  declareLeftJoinTable,
  declareTimeFoldTable,
  defineCompactTable,
  defineConcatTable,
  defineFilterTable,
  defineFlatMapTable,
  defineMapTable,
  defineMaterializeTable,
  defineSortTable,
  defineStoredTable,
} from "../../databases/bulldozer/index.js";
import type { PiledriverObject } from "../../databases/piledriver/index.js";
import type {
  CustomerType,
  DayInterval,
  IncludedItemConfig,
  ManualItemQuantityChangeRow,
  ManualTransactionRow,
  OneTimePurchaseRow,
  PaymentProvider,
  ProductSnapshot,
  SubscriptionInvoiceRow,
  SubscriptionRow,
  TransactionEntryData,
  TransactionRow,
} from "./types.js";

export type * from "./types.js";

type Migration = Parameters<typeof declareBulldozerDatabase>[1]["migrations"][number];
type InitTableStep = Extract<Migration[number], { type: "initTable" }>;
type Row = { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject };
type ItemGrant = { itemId: string, quantity: number, expiresWhen: "when-purchase-expires" | "when-repeated" | null, expiresAtMillis: number | null };
type OutstandingGrant = { txnId: string, entryIndex: number, itemId: string, quantity: number, expiresWhen: "when-purchase-expires" | "when-repeated" | null };
type RepeatSchedule = Record<string, { quantity: number, expiresWhen: "when-purchase-expires" | "when-repeated" | null, interval: DayInterval | null, anchorMillis: number, occurrencesElapsed: number, nextRepeatMillis: number | null }>;
type SubscriptionFoldState = {
  subscriptionId: string,
  tenancyId: string,
  customerId: string,
  customerType: CustomerType,
  productId: string | null,
  product: ProductSnapshot,
  productLineId: string | null,
  priceId: string | null,
  quantity: number,
  paymentProvider: PaymentProvider,
  endedAtMillis: number | null,
  productRevokedAtMillis: number | null,
  chargedAmount: Record<string, string>,
  startTxnId: string,
  startProductGrantEntryIndex: number,
  startItemChangeBaseIndex: number,
  itemRepeatSchedule: RepeatSchedule,
  outstandingGrants: OutstandingGrant[],
  repeatCount: number,
};
type OtpFoldState = {
  purchaseId: string,
  tenancyId: string,
  customerId: string,
  customerType: CustomerType,
  paymentProvider: PaymentProvider,
  revokedAtMillis: number | null,
  itemRepeatSchedule: RepeatSchedule,
  outstandingGrants: OutstandingGrant[],
  repeatCount: number,
};
export type ItemQuantityChangeEntry = {
  type: "item-quantity-change",
  index: number,
  txnId: string,
  txnEffectiveAtMillis: number,
  txnCreatedAtMillis: number,
  txnType: string,
  tenancyId: string,
  paymentProvider: PaymentProvider | null,
  customerType: CustomerType,
  customerId: string,
  quantity: number,
  itemId: string,
  expiresWhen: "when-purchase-expires" | "when-repeated" | number | null,
};
export type ItemCompactionAggregate = {
  type: "item-quantity-compaction-aggregate",
  txnEffectiveAtMillis: number,
  txnId: string,
  index: number,
  items: Record<string, { firstRow: ItemQuantityChangeEntry, quantity: number }>,
};
type ItemCompactionBoundary = {
  type: "item-quantity-compaction-boundary",
  txnEffectiveAtMillis: number,
  txnId: string,
  index: number,
  // The item this expiry belongs to; compaction windows are per-item, so a boundary only stops
  // merges of its own item.
  itemId: string,
};

const compareNumbers = (a: PiledriverObject, b: PiledriverObject) => Number(a) - Number(b);
const compareJson = (a: PiledriverObject, b: PiledriverObject) => stringCompare(JSON.stringify(a), JSON.stringify(b));
const table = (tableId: string, tableImplementation: InitTableStep["table"], inputTables: Record<string, string> = {}, debugMetadata?: InitTableStep["debugMetadata"]): InitTableStep => ({
  type: "initTable",
  tableId,
  table: tableImplementation,
  inputTables,
  debugMetadata,
});
const customerGroupKey = (row: { tenancyId: string, customerType: CustomerType, customerId: string }) => ({
  tenancyId: row.tenancyId,
  customerType: row.customerType,
  customerId: row.customerId,
});
const rowObject = <T>(rowData: PiledriverObject) => rowData as unknown as T;
const toPiledriverObject = (value: unknown): PiledriverObject => JSON.parse(JSON.stringify(value)) as PiledriverObject;
const tenancyGroupKey = (row: { tenancyId: string }) => ({ tenancyId: row.tenancyId });
// Recency key for the tenancy-wide list: newest-first ordering is (createdAtMillis, txnId).
// txnId is unique so it's a deterministic tiebreak for same-millisecond transactions, which
// keeps cursor paging stable.
const transactionRecencySortKey = (txn: TransactionRow): PiledriverObject => toPiledriverObject([txn.createdAtMillis, txn.txnId]);
const compareTransactionRecencyKeys = (a: PiledriverObject, b: PiledriverObject) => {
  const aKey = rowObject<[number, string]>(a);
  const bKey = rowObject<[number, string]>(b);
  return compareNumbers(aKey[0], bKey[0]) || stringCompare(aKey[1], bKey[1]);
};
const isObject = (value: PiledriverObject): value is Record<string, PiledriverObject> => typeof value === "object" && value !== null && !Array.isArray(value);
const paymentProvider = (creationSource: string): PaymentProvider => creationSource === "TEST_MODE" ? "test_mode" : "stripe";
export const normalizedRepeatInterval = (interval: DayInterval | "never" | null | undefined): DayInterval | null => {
  if (!Array.isArray(interval)) return null;
  const [count] = interval;
  // A zero/negative (or non-finite) repeat count means "doesn't repeat". Without
  // this, count<=0 yields a next-repeat time that never advances, which the
  // timefold rejects ("nextTriggerTime must move forward") — and that throw lands
  // in the once-per-second tick loop, retrying forever. Treat it as no-repeat
  // instead. (count>0 is also false for NaN, so this covers garbage values too.)
  if (!(count > 0)) return null;
  return interval;
};
const normalizedExpiresWhen = (item: IncludedItemConfig): "when-purchase-expires" | "when-repeated" | null =>
  item.expires === "when-purchase-expires" || item.expires === "when-repeated" ? item.expires : null;
const productLineId = (product: ProductSnapshot): string | null => product.productLineId ?? null;
const chargedAmount = (product: ProductSnapshot, priceId: string | null, quantity: number): Record<string, string> => {
  const price = priceId === null ? undefined : product.prices[priceId];
  const result: Record<string, string> = {};
  if (price === undefined) return result;
  for (const [currency, amount] of Object.entries(price)) {
    if (currency === "interval" || currency === "serverOnly" || currency === "freeTrial") continue;
    if (typeof amount !== "string" && typeof amount !== "number") continue;
    const currencyConfig = SUPPORTED_CURRENCIES.find(c => c.code === currency);
    if (currencyConfig === undefined) continue;
    // Scale in integer minor units. Float math like `19.99 * 3` yields
    // 59.97000000000001, which then fails moneyAmountSchema (too many decimals)
    // and 500s the transactions API. Prices are already validated money strings,
    // so the conversion is exact; a bad price or non-integer quantity throws.
    const minorUnits = moneyAmountToStripeUnits(String(amount) as MoneyAmount, currencyConfig);
    result[currency] = stripeUnitsToMoneyAmount(minorUnits * quantity, currencyConfig);
  }
  return result;
};
const USD_CURRENCY = SUPPORTED_CURRENCIES.find(c => c.code === "USD") ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");
// The charged amount for a subscription renewal is the invoice's actual total, not a
// recomputation from the current product price — this is what preserves proration, coupons,
// and the price locked in at renewal (a later product-version price change must not rewrite it).
// `amountTotal` is in Stripe minor units. Stripe charges are USD-only across the codebase (the
// refund path throws on non-USD; SubscriptionInvoice has no currency column), so we format it as
// USD. We fall back to the product-price computation only when the total is genuinely unknown
// (`null`): test-mode/API-granted subs have no Stripe invoice. A total of 0 (e.g. a 100%-off
// coupon) is a real charge of $0 and must NOT fall back.
const renewalChargedAmount = (invoice: SubscriptionInvoiceRow, sub: SubscriptionRow): Record<string, string> =>
  invoice.amountTotal !== null
    ? { USD: stripeUnitsToMoneyAmount(invoice.amountTotal, USD_CURRENCY) }
    : chargedAmount(sub.product, sub.priceId, sub.quantity);
const hasNonZeroChargedAmount = (charged: Record<string, string>): boolean =>
  Object.values(charged).some(amount => Number(amount) !== 0);
// True when this subscription should defer its first real charge to a later
// invoice (trial end), instead of booking catalog price on subscription-start.
// Prefer Stripe `trialing`; also honor configured freeTrial so an early write
// while status is still `incomplete` during SetupIntent confirmation does not
// invent a full-price start charge that would double-count at trial end.
// Precedence matches backend getEffectiveFreeTrial: price?.freeTrial ?? product.freeTrial.
// Explicit null is not an opt-out (config null means reset-to-default / absent).
const subscriptionHasFreeTrial = (row: SubscriptionRow): boolean => {
  if (row.status === "trialing") return true;
  const price = row.priceId === null ? undefined : row.product.prices[row.priceId];
  return (price?.freeTrial ?? row.product.freeTrial) != null;
};
// Book catalog-price money on sub-start only for normal paid Stripe starts.
// Skip: test mode, $0/free, free trials (first charge comes from the non-creation
// invoice when the trial converts — same path as renewals).
const shouldBookMoneyOnSubscriptionStart = (row: SubscriptionRow, charged: Record<string, string>): boolean =>
  paymentProvider(row.creationSource) !== "test_mode"
  && hasNonZeroChargedAmount(charged)
  && !subscriptionHasFreeTrial(row);
// The concrete millis at which a stamped (subscription/one-time-purchase) grant expires, so the
// ledger can rank grants by real expiry (soonest-first) instead of treating them all as permanent.
// `when-repeated` grants drop at the sooner of their next reset or the purchase end; `when-purchase-
// expires` grants drop at the purchase end; `null` never expires. This always matches the time of
// the id-referencing expire marker that actually removes the grant (or is a harmless over-estimate
// when no marker ever fires — e.g. an ongoing purchase — in which case the grant stays live anyway).
const grantExpiryMillis = (
  expiresWhen: "when-purchase-expires" | "when-repeated" | null,
  nextResetMillis: number | null,
  endMillis: number | null,
): number | null => {
  const candidates: number[] = [];
  if (expiresWhen === "when-repeated" && nextResetMillis !== null) candidates.push(nextResetMillis);
  if ((expiresWhen === "when-repeated" || expiresWhen === "when-purchase-expires") && endMillis !== null) candidates.push(endMillis);
  return candidates.length === 0 ? null : Math.min(...candidates);
};
const itemGrants = (product: ProductSnapshot, quantity: number, anchorMillis: number, endMillis: number | null): ItemGrant[] => Object.entries(product.includedItems).map(([itemId, item]) => {
  const expiresWhen = normalizedExpiresWhen(item);
  const interval = normalizedRepeatInterval(item.repeat);
  return {
    itemId,
    quantity: item.quantity * quantity,
    expiresWhen,
    expiresAtMillis: grantExpiryMillis(expiresWhen, interval === null ? null : nthDayIntervalMillis(anchorMillis, interval, 1), endMillis),
  };
});
const repeatSchedule = (product: ProductSnapshot, quantity: number, anchorMillis: number): RepeatSchedule => Object.fromEntries(
  Object.entries(product.includedItems).map(([itemId, item]) => {
    const interval = normalizedRepeatInterval(item.repeat);
    return [itemId, {
      quantity: item.quantity * quantity,
      expiresWhen: normalizedExpiresWhen(item),
      interval,
      anchorMillis,
      occurrencesElapsed: 0,
      nextRepeatMillis: interval === null ? null : nthDayIntervalMillis(anchorMillis, interval, 1),
    }];
  }),
);
const outstandingGrants = (product: ProductSnapshot, quantity: number, txnId: string, baseIndex: number): OutstandingGrant[] =>
  Object.entries(product.includedItems).map(([itemId, item], index) => ({
    txnId,
    entryIndex: baseIndex + index,
    itemId,
    quantity: item.quantity * quantity,
    expiresWhen: normalizedExpiresWhen(item),
  }));
const soonestNextMillis = (state: { itemRepeatSchedule: RepeatSchedule }, endMillis: number | null): number | null => {
  const candidates = Object.values(state.itemRepeatSchedule).flatMap(schedule => schedule.nextRepeatMillis === null ? [] : [schedule.nextRepeatMillis]);
  if (endMillis !== null) candidates.push(endMillis);
  return candidates.length === 0 ? null : Math.min(...candidates);
};
const dateFromMillis = (millis: number | null): Date | null => millis === null ? null : new Date(millis);
const dueItemEntries = (state: { itemRepeatSchedule: RepeatSchedule }, currentMillis: number) =>
  Object.entries(state.itemRepeatSchedule).filter(([, schedule]) => schedule.nextRepeatMillis !== null && schedule.nextRepeatMillis <= currentMillis);
// Advance each due item's schedule by one reset. We recompute the next boundary from the original
// anchor via nthDayIntervalMillis(anchor, interval, occurrencesElapsed + 1) rather than adding a
// fixed interval, so calendar boundaries never drift and month-end clamping preserves the anchor
// day-of-month. Only one reset is applied per tick even if the tick is far in the future; the
// timefold reschedules and catches up one boundary at a time (matching the prior behavior).
const advanceRepeatSchedule = (schedule: RepeatSchedule, currentMillis: number): RepeatSchedule =>
  Object.fromEntries(Object.entries(schedule).map(([itemId, entry]) => {
    if (!(entry.nextRepeatMillis !== null && entry.nextRepeatMillis <= currentMillis && entry.interval !== null)) return [itemId, entry];
    const occurrencesElapsed = entry.occurrencesElapsed + 1;
    return [itemId, { ...entry, occurrencesElapsed, nextRepeatMillis: nthDayIntervalMillis(entry.anchorMillis, entry.interval, occurrencesElapsed + 1) }];
  }));
const grantRefsToExpire = (grants: OutstandingGrant[], expiresWhen: "when-repeated" | "when-purchase-expires" | "both", dueItemIds?: Set<string>) =>
  grants
    .filter(grant => (expiresWhen === "both" ? grant.expiresWhen === "when-repeated" || grant.expiresWhen === "when-purchase-expires" : grant.expiresWhen === expiresWhen))
    .filter(grant => dueItemIds === undefined || dueItemIds.has(grant.itemId))
    .map(grant => ({ transactionId: grant.txnId, entryIndex: grant.entryIndex, itemId: grant.itemId, quantity: grant.quantity }));
// The most recent repeat boundary this schedule has already granted, used as the floor when
// fast-forwarding items that appear (or change interval) on a rewritten source row. Falls back to
// `fallbackMillis` (purchase creation) when nothing has repeated yet.
const processedThroughMillis = (schedule: RepeatSchedule, fallbackMillis: number): number => Math.max(
  fallbackMillis,
  ...Object.values(schedule).flatMap(entry => entry.interval !== null && entry.occurrencesElapsed > 0
    ? [nthDayIntervalMillis(entry.anchorMillis, entry.interval, entry.occurrencesElapsed)]
    : []),
);
// Advance a fresh schedule entry (anchored at purchase creation) past `floorMillis`. Every
// already-granted boundary is <= floorMillis, so starting strictly after it means an item added
// mid-life (a) doesn't replay grants for boundaries that predate it and (b) can't reuse an `igr:`
// transaction id that was already emitted at one of those boundaries.
const fastForwardScheduleEntry = (entry: RepeatSchedule[string], floorMillis: number): RepeatSchedule[string] => {
  if (entry.interval === null || entry.nextRepeatMillis === null) return entry;
  let occurrencesElapsed = entry.occurrencesElapsed;
  let nextRepeatMillis = entry.nextRepeatMillis;
  while (nextRepeatMillis <= floorMillis) {
    occurrencesElapsed += 1;
    nextRepeatMillis = nthDayIntervalMillis(entry.anchorMillis, entry.interval, occurrencesElapsed + 1);
  }
  return { ...entry, occurrencesElapsed, nextRepeatMillis };
};
const sameInterval = (a: DayInterval | null, b: DayInterval | null): boolean => JSON.stringify(a) === JSON.stringify(b);
// Fold a rewritten source row's schedule into the fold's existing one. Items whose interval is
// unchanged keep their repeat progress (anchor/occurrences/next boundary) and adopt the new
// quantity/expiry going forward; items that are new or changed interval start fresh, fast-forwarded
// past everything already granted; items no longer repeating stop. Items that dropped out entirely
// are kept as inert tombstones (nextRepeatMillis null) so their history still counts toward
// `processedThroughMillis` — otherwise a removed-then-readded item could re-emit an already-used
// `igr:` transaction timestamp.
const mergeRepeatSchedule = (oldSchedule: RepeatSchedule, freshSchedule: RepeatSchedule, floorMillis: number): RepeatSchedule => {
  const merged: RepeatSchedule = Object.fromEntries(
    Object.entries(freshSchedule).map(([itemId, freshEntry]) => {
      const oldEntry = itemId in oldSchedule ? oldSchedule[itemId] : undefined;
      if (oldEntry !== undefined && oldEntry.nextRepeatMillis !== null && sameInterval(oldEntry.interval, freshEntry.interval)) {
        return [itemId, { ...freshEntry, anchorMillis: oldEntry.anchorMillis, occurrencesElapsed: oldEntry.occurrencesElapsed, nextRepeatMillis: oldEntry.nextRepeatMillis }];
      }
      return [itemId, fastForwardScheduleEntry(freshEntry, floorMillis)];
    }),
  );
  for (const [itemId, oldEntry] of Object.entries(oldSchedule)) {
    if (!(itemId in merged) && oldEntry.occurrencesElapsed > 0) merged[itemId] = { ...oldEntry, nextRepeatMillis: null };
  }
  return merged;
};

function subscriptionInitialState(row: SubscriptionRow): SubscriptionFoldState {
  const provider = paymentProvider(row.creationSource);
  const charged = chargedAmount(row.product, row.priceId, row.quantity);
  const hasMoneyTransfer = shouldBookMoneyOnSubscriptionStart(row, charged);
  const startTxnId = `sub-start:${row.id}`;
  return {
    subscriptionId: row.id,
    tenancyId: row.tenancyId,
    customerId: row.customerId,
    customerType: row.customerType,
    productId: row.productId,
    product: row.product,
    productLineId: productLineId(row.product),
    priceId: row.priceId,
    quantity: row.quantity,
    paymentProvider: provider,
    endedAtMillis: row.endedAtMillis,
    productRevokedAtMillis: row.productRevokedAtMillis,
    chargedAmount: charged,
    startTxnId,
    // These indices must match the entry order in payments-txn-subscription-start:
    // [0] sub-start, [1] product-grant, [2] money-transfer (only if booked), then
    // item changes. If you reorder entries there, update these too.
    startProductGrantEntryIndex: 1,
    startItemChangeBaseIndex: hasMoneyTransfer ? 3 : 2,
    itemRepeatSchedule: repeatSchedule(row.product, row.quantity, row.createdAtMillis),
    outstandingGrants: outstandingGrants(row.product, row.quantity, startTxnId, hasMoneyTransfer ? 3 : 2),
    repeatCount: 0,
  };
}

function subscriptionStartEvent(row: SubscriptionRow) {
  const provider = paymentProvider(row.creationSource);
  const charged = chargedAmount(row.product, row.priceId, row.quantity);
  return {
    type: "subscription-start",
    subscriptionId: row.id,
    tenancyId: row.tenancyId,
    customerId: row.customerId,
    customerType: row.customerType,
    productId: row.productId,
    product: row.product,
    productLineId: productLineId(row.product),
    priceId: row.priceId,
    quantity: row.quantity,
    chargedAmount: charged,
    wasMoneyBookedOnStart: shouldBookMoneyOnSubscriptionStart(row, charged),
    itemGrants: itemGrants(row.product, row.quantity, row.createdAtMillis, row.endedAtMillis),
    paymentProvider: provider,
    effectiveAtMillis: row.createdAtMillis,
    createdAtMillis: row.createdAtMillis,
  };
}

function subscriptionEndEvent(state: SubscriptionFoldState) {
  return {
    type: "subscription-end",
    subscriptionId: state.subscriptionId,
    tenancyId: state.tenancyId,
    customerId: state.customerId,
    customerType: state.customerType,
    productId: state.productId,
    productLineId: state.productLineId,
    quantity: state.quantity,
    startProductGrantRef: { transactionId: state.startTxnId, entryIndex: state.startProductGrantEntryIndex },
    itemQuantityChangesToExpire: grantRefsToExpire(state.outstandingGrants, "both"),
    productRevokedAtMillis: state.productRevokedAtMillis,
    paymentProvider: state.paymentProvider,
    effectiveAtMillis: state.endedAtMillis,
    createdAtMillis: state.endedAtMillis,
  };
}

function subscriptionRepeatStep(state: SubscriptionFoldState, currentMillis: number): { state: SubscriptionFoldState, event: PiledriverObject } {
  const dueItems = dueItemEntries(state, currentMillis);
  const dueIds = new Set(dueItems.map(([itemId]) => itemId));
  const previousGrantsToExpire = grantRefsToExpire(state.outstandingGrants, "when-repeated", dueIds);
  const nextSchedule = advanceRepeatSchedule(state.itemRepeatSchedule, currentMillis);
  const itemRepeatGrants = dueItems.map(([itemId, schedule]) => ({ itemId, quantity: schedule.quantity, expiresWhen: schedule.expiresWhen, expiresAtMillis: grantExpiryMillis(schedule.expiresWhen, nextSchedule[itemId].nextRepeatMillis, state.endedAtMillis) }));
  const txnId = `igr:${state.subscriptionId}:${currentMillis}`;
  const nextOutstanding = [
    ...state.outstandingGrants.filter(grant => !(grant.expiresWhen === "when-repeated" && dueIds.has(grant.itemId))),
    ...dueItems.map(([itemId, schedule], index) => ({ txnId, entryIndex: previousGrantsToExpire.length + index, itemId, quantity: schedule.quantity, expiresWhen: schedule.expiresWhen })),
  ];
  return {
    state: { ...state, outstandingGrants: nextOutstanding, itemRepeatSchedule: nextSchedule, repeatCount: state.repeatCount + 1 },
    event: toPiledriverObject({
      type: "item-grant-repeat",
      sourceType: "subscription",
      sourceId: state.subscriptionId,
      tenancyId: state.tenancyId,
      customerId: state.customerId,
      customerType: state.customerType,
      itemGrants: itemRepeatGrants,
      previousGrantsToExpire,
      paymentProvider: state.paymentProvider,
      effectiveAtMillis: currentMillis,
      createdAtMillis: currentMillis,
    }),
  };
}

// Fold a rewritten subscription row into the existing fold state (Stripe webhooks re-upsert the
// row on every subscription/invoice event, so this runs often, usually with no meaningful change).
// Emitted transactions are immutable facts: everything that references them survives untouched
// (startTxnId, entry indices, outstandingGrants, repeatCount), while the fields that shape *future*
// events adopt the new row. Repeat progress is merged so past grants are neither replayed nor
// rederived against the new row data.
function subscriptionUpdatedState(state: SubscriptionFoldState, row: SubscriptionRow): SubscriptionFoldState {
  return {
    ...state,
    customerId: row.customerId,
    customerType: row.customerType,
    productId: row.productId,
    product: row.product,
    productLineId: productLineId(row.product),
    priceId: row.priceId,
    quantity: row.quantity,
    paymentProvider: paymentProvider(row.creationSource),
    endedAtMillis: row.endedAtMillis,
    productRevokedAtMillis: row.productRevokedAtMillis,
    chargedAmount: chargedAmount(row.product, row.priceId, row.quantity),
    itemRepeatSchedule: mergeRepeatSchedule(
      state.itemRepeatSchedule,
      repeatSchedule(row.product, row.quantity, row.createdAtMillis),
      processedThroughMillis(state.itemRepeatSchedule, row.createdAtMillis),
    ),
  };
}

function otpInitialState(row: OneTimePurchaseRow): OtpFoldState {
  const provider = paymentProvider(row.creationSource);
  const hasMoneyTransfer = provider !== "test_mode" && Object.keys(chargedAmount(row.product, row.priceId, row.quantity)).length > 0;
  const txnId = `otp:${row.id}`;
  return {
    purchaseId: row.id,
    tenancyId: row.tenancyId,
    customerId: row.customerId,
    customerType: row.customerType,
    paymentProvider: provider,
    revokedAtMillis: row.revokedAtMillis,
    itemRepeatSchedule: Object.fromEntries(Object.entries(repeatSchedule(row.product, row.quantity, row.createdAtMillis)).filter(([, schedule]) => schedule.interval !== null)),
    // Must match entry order in payments-txn-one-time-purchase: [0] product-grant,
    // [1] money-transfer (only if charged), then item changes.
    outstandingGrants: outstandingGrants(row.product, row.quantity, txnId, hasMoneyTransfer ? 2 : 1),
    repeatCount: 0,
  };
}

function otpRepeatStep(state: OtpFoldState, currentMillis: number): { state: OtpFoldState, event: PiledriverObject } {
  const dueItems = dueItemEntries(state, currentMillis);
  const dueIds = new Set(dueItems.map(([itemId]) => itemId));
  const previousGrantsToExpire = grantRefsToExpire(state.outstandingGrants, "when-repeated", dueIds);
  const nextSchedule = advanceRepeatSchedule(state.itemRepeatSchedule, currentMillis);
  const itemRepeatGrants = dueItems.map(([itemId, schedule]) => ({ itemId, quantity: schedule.quantity, expiresWhen: schedule.expiresWhen, expiresAtMillis: grantExpiryMillis(schedule.expiresWhen, nextSchedule[itemId].nextRepeatMillis, state.revokedAtMillis) }));
  const txnId = `igr:${state.purchaseId}:${currentMillis}`;
  const nextOutstanding = [
    ...state.outstandingGrants.filter(grant => !(grant.expiresWhen === "when-repeated" && dueIds.has(grant.itemId))),
    ...dueItems.map(([itemId, schedule], index) => ({ txnId, entryIndex: previousGrantsToExpire.length + index, itemId, quantity: schedule.quantity, expiresWhen: schedule.expiresWhen })),
  ];
  return {
    state: { ...state, outstandingGrants: nextOutstanding, itemRepeatSchedule: nextSchedule, repeatCount: state.repeatCount + 1 },
    event: toPiledriverObject({
      type: "item-grant-repeat",
      sourceType: "one_time_purchase",
      sourceId: state.purchaseId,
      tenancyId: state.tenancyId,
      customerId: state.customerId,
      customerType: state.customerType,
      itemGrants: itemRepeatGrants,
      previousGrantsToExpire,
      paymentProvider: state.paymentProvider,
      effectiveAtMillis: currentMillis,
      createdAtMillis: currentMillis,
    }),
  };
}

// One-time-purchase counterpart of `subscriptionUpdatedState`: refs to emitted transactions
// survive, future-facing fields (most importantly `revokedAtMillis`) adopt the new row, repeat
// progress is merged. Mirrors otpInitialState's interval filter so non-repeating items stay out.
function otpUpdatedState(state: OtpFoldState, row: OneTimePurchaseRow): OtpFoldState {
  const freshSchedule = Object.fromEntries(Object.entries(repeatSchedule(row.product, row.quantity, row.createdAtMillis)).filter(([, schedule]) => schedule.interval !== null));
  return {
    ...state,
    customerId: row.customerId,
    customerType: row.customerType,
    paymentProvider: paymentProvider(row.creationSource),
    revokedAtMillis: row.revokedAtMillis,
    itemRepeatSchedule: mergeRepeatSchedule(state.itemRepeatSchedule, freshSchedule, processedThroughMillis(state.itemRepeatSchedule, row.createdAtMillis)),
  };
}

const sortTxnRows = (rows: TransactionRow[]) => rows.sort((a, b) => a.effectiveAtMillis - b.effectiveAtMillis || stringCompare(a.txnId, b.txnId));
// A live grant in the item-quantities ledger. `q` is the granted amount minus any frozen debt baked
// in at arrival (see the fold reducer). `e` is the grant's expiry (null = never; sorted last). `id`
// is the granting entry's identity (`${txnId}:${entryIndex}`) so an expiry can drop the *specific*
// grant it belongs to; `id` is null for grants that can never be expired (permanent/compacted).
type LedgerGrant = { q: number, e: number | null, id: string | null };
// Per-item ledger state. `consumption` is the running total of covered removals, distributed over
// the grants soonest-expiring-first (never materialized — recomputed on demand), so a later,
// sooner-expiring grant automatically absorbs it (reassignment). `debt` is removals that had no
// grant to land on; it freezes onto the first grant(s) to arrive (baked into their `q`) and never
// reassigns. Balance = sum(grant.q) - consumption - debt.
type LedgerItemState = { grants: LedgerGrant[], consumption: number, debt: number };
type LedgerState = Record<string, LedgerItemState>;
const grantExpiry = (grant: LedgerGrant) => grant.e ?? Number.POSITIVE_INFINITY;
// Soonest-expiring first, with a stable id tiebreak so the soonest-first distribution is
// deterministic among grants that expire at the same instant.
const compareGrantsByExpiry = (a: LedgerGrant, b: LedgerGrant) => grantExpiry(a) - grantExpiry(b) || stringCompare(a.id ?? "", b.id ?? "");
const sumGrantQuantities = (grants: LedgerGrant[]) => grants.reduce((sum, grant) => sum + grant.q, 0);
const sumItemQuantity = (item: LedgerItemState) => sumGrantQuantities(item.grants) - item.consumption - item.debt;
const currentItemQuantities = (state: LedgerState) => Object.fromEntries(Object.keys(state).map(itemId => [itemId, sumItemQuantity(state[itemId])]));
const isCompactionBoundary = (value: PiledriverObject): value is ItemCompactionBoundary =>
  isObject(value) && value.type === "item-quantity-compaction-boundary";
const compactableEntryToAggregate = (entry: ItemQuantityChangeEntry): ItemCompactionAggregate => ({
  type: "item-quantity-compaction-aggregate",
  txnEffectiveAtMillis: entry.txnEffectiveAtMillis,
  txnId: entry.txnId,
  index: entry.index,
  items: {
    [entry.itemId]: { firstRow: entry, quantity: entry.quantity },
  },
});
const asCompactionAggregate = (value: PiledriverObject): ItemCompactionAggregate => {
  if (isObject(value) && value.type === "item-quantity-compaction-aggregate") return rowObject<ItemCompactionAggregate>(value);
  return compactableEntryToAggregate(rowObject<ItemQuantityChangeEntry>(value));
};
// The compact table merges rows in any order, so this merge has to be associative:
// merge(a, merge(b, c)) === merge(merge(a, b), c). Keep it that way (there's a test
// in index.test.ts) — quantities are summed and the header/firstRow come from `a`.
export const mergeCompactionAggregates = (a: ItemCompactionAggregate, b: ItemCompactionAggregate): ItemCompactionAggregate => {
  const items = new Map(Object.entries(a.items));
  for (const [itemId, item] of Object.entries(b.items)) {
    const existing = items.get(itemId);
    items.set(itemId, existing === undefined
      ? item
      : { firstRow: existing.firstRow, quantity: existing.quantity + item.quantity });
  }
  return { type: "item-quantity-compaction-aggregate", txnEffectiveAtMillis: a.txnEffectiveAtMillis, txnId: a.txnId, index: a.index, items: Object.fromEntries(items) };
};
// The item a compaction row belongs to: boundaries carry `itemId`; aggregates hold exactly one item
// (single-item at creation, and the compactor only merges same-item aggregates), so its sole key.
const compactionRowItemId = (value: PiledriverObject): string => {
  if (isCompactionBoundary(value)) return value.itemId;
  return Object.keys(rowObject<ItemCompactionAggregate>(value).items)[0] ?? throwErr("compaction aggregate has no item");
};
const compactionSortKey = (row: { rowIdentifier: string, rowData: PiledriverObject }) => {
  const data = rowObject<{ txnEffectiveAtMillis: number, txnId?: string, index?: number, type?: string }>(row.rowData);
  return {
    itemId: compactionRowItemId(row.rowData),
    txnEffectiveAtMillis: data.txnEffectiveAtMillis,
    boundaryOrder: data.type === "item-quantity-compaction-boundary" ? 0 : 1,
    txnId: data.txnId ?? row.rowIdentifier,
    index: data.index ?? 0,
    rowIdentifier: row.rowIdentifier,
  };
};
const compareCompactionSortKeys = (a: PiledriverObject, b: PiledriverObject) => {
  const left = rowObject<{ itemId: string, txnEffectiveAtMillis: number, boundaryOrder: number, txnId: string, index: number, rowIdentifier: string }>(a);
  const right = rowObject<{ itemId: string, txnEffectiveAtMillis: number, boundaryOrder: number, txnId: string, index: number, rowIdentifier: string }>(b);
  // itemId first so each item's compactable changes are contiguous (the compactor only merges
  // adjacent same-item aggregates); an interleaving other item would otherwise split them.
  return stringCompare(left.itemId, right.itemId)
    || left.txnEffectiveAtMillis - right.txnEffectiveAtMillis
    || left.boundaryOrder - right.boundaryOrder
    || stringCompare(left.txnId, right.txnId)
    || left.index - right.index
    || stringCompare(left.rowIdentifier, right.rowIdentifier);
};

// Ledger tie-order for equal-timestamp changes: apply non-expiry changes before expiry markers
// (so a removal at the expiry instant lands before the grant is dropped), then soonest-expiring
// grants first (so removals/debt hit the grant that will expire first), then positive before
// negative, then a stable id tiebreak.
const ledgerSortKey = (row: { rowIdentifier: string, rowData: PiledriverObject }) => {
  const data = rowObject<{ txnEffectiveAtMillis: number, quantity: number, expiresAtMillis: number | null, grantId?: string | null, expireGrantId?: string | null, txnId?: string }>(row.rowData);
  return {
    txnEffectiveAtMillis: data.txnEffectiveAtMillis,
    kind: (data.expireGrantId ?? null) !== null ? 1 : 0,
    expiresAtMillis: data.expiresAtMillis ?? null,
    sign: data.quantity < 0 ? 1 : 0,
    id: data.grantId ?? data.expireGrantId ?? data.txnId ?? row.rowIdentifier,
  };
};
const compareLedgerSortKeys = (a: PiledriverObject, b: PiledriverObject) => {
  const left = rowObject<{ txnEffectiveAtMillis: number, kind: number, expiresAtMillis: number | null, sign: number, id: string }>(a);
  const right = rowObject<{ txnEffectiveAtMillis: number, kind: number, expiresAtMillis: number | null, sign: number, id: string }>(b);
  return left.txnEffectiveAtMillis - right.txnEffectiveAtMillis
    || left.kind - right.kind
    || (left.expiresAtMillis ?? Number.POSITIVE_INFINITY) - (right.expiresAtMillis ?? Number.POSITIVE_INFINITY)
    || left.sign - right.sign
    || stringCompare(left.id, right.id);
};

export const splitItemQuantityChangeWithExpiry = (rowData: PiledriverObject): PiledriverObject[] => {
  const entry = rowObject<{ type: string, index: number, txnId: string, txnEffectiveAtMillis: number, customerType: CustomerType, customerId: string, tenancyId: string, itemId: string, quantity: number, expiresWhen?: number | string | null, stampedExpiresAtMillis?: number | null, adjustedTransactionId?: string, adjustedEntryIndex?: number }>(rowData);
  const base = { txnId: entry.txnId, customerType: entry.customerType, customerId: entry.customerId, tenancyId: entry.tenancyId, itemId: entry.itemId };
  // The id under which a grant entry is pushed into the ledger, and which an expiry references
  // to drop that exact grant. It matches the granting item-quantity-change entry's identity:
  // for absolute expiries that's this entry itself; for subscription/repeat expiries the
  // item-quantity-expire entry carries the granting entry's (adjustedTransactionId, index).
  const grantId = `${entry.txnId}:${entry.index}`;
  // An expiry drops the specific grant it belongs to (clamped to whatever remains of it). We
  // model it as an explicit expire marker carrying the target grant's id — NOT as a negative
  // change — so the ledger never applies it as a cross-grant, debt-creating deduction.
  if (entry.type === "item-quantity-expire") {
    return [toPiledriverObject({ ...base, txnEffectiveAtMillis: entry.txnEffectiveAtMillis, quantity: 0, expiresAtMillis: null, expireGrantId: `${entry.adjustedTransactionId}:${entry.adjustedEntryIndex}` })];
  }
  if (entry.type === "compacted-item-quantity-change") return [toPiledriverObject({ ...base, txnEffectiveAtMillis: entry.txnEffectiveAtMillis, quantity: entry.quantity, expiresAtMillis: null, grantId: null })];
  if (entry.type !== "item-quantity-change") return [];
  // A deduction applies immediately and permanently, and never needs an id (nothing expires it).
  if (entry.quantity < 0) {
    return [toPiledriverObject({ ...base, txnEffectiveAtMillis: entry.txnEffectiveAtMillis, quantity: entry.quantity, expiresAtMillis: null, grantId: null })];
  }
  // A subscription/one-time-purchase grant (`expiresWhen` is a string) carries its stamped
  // expiry so the ledger ranks it soonest-first; the id-referencing expire marker that actually
  // drops it is emitted separately from the transaction's item-quantity-expire entries.
  if (typeof entry.expiresWhen === "string") {
    return [toPiledriverObject({ ...base, txnEffectiveAtMillis: entry.txnEffectiveAtMillis, quantity: entry.quantity, expiresAtMillis: entry.stampedExpiresAtMillis ?? null, grantId })];
  }
  // A grant with no expiry applies permanently. It gets an id anyway (harmless — nothing expires it).
  if (typeof entry.expiresWhen !== "number") {
    return [toPiledriverObject({ ...base, txnEffectiveAtMillis: entry.txnEffectiveAtMillis, quantity: entry.quantity, expiresAtMillis: null, grantId })];
  }
  // A manual grant with an absolute expiry: grant row + a synthesized expire marker for it. If
  // the grant expires at or before the moment it's granted it's already expired — emit nothing.
  if (entry.expiresWhen <= entry.txnEffectiveAtMillis) return [];
  return [
    toPiledriverObject({ ...base, txnEffectiveAtMillis: entry.txnEffectiveAtMillis, quantity: entry.quantity, expiresAtMillis: entry.expiresWhen, grantId }),
    toPiledriverObject({ ...base, txnEffectiveAtMillis: entry.expiresWhen, quantity: 0, expiresAtMillis: null, expireGrantId: grantId }),
  ];
};

// Exclusive upper bound (for `range.lt`) that selects every item-quantities ledger row effective at
// or before `asOfMillis` in a reverse seek. txnEffectiveAtMillis is the primary sort component and is
// always a whole millisecond (Date.now(), Stripe/created timestamps, and reset boundaries are all
// integer ms), so "txn <= asOfMillis" is exactly "txn < asOfMillis + 1" — no row can land in the open
// interval (asOfMillis, asOfMillis + 1), which is why the secondary components can be left at their
// minimum. Reverse-scanning with this bound and limit 1 seeks straight to the current-state row via
// the sorted index (O(log n)), instead of skipping every future-dated row (e.g. grants with a
// far-future expiry, which each materialize a future-dated expire marker).
export const itemQuantitiesLedgerUpperBoundAsOf = (asOfMillis: number): PiledriverObject => toPiledriverObject({
  txnEffectiveAtMillis: asOfMillis + 1,
  kind: 0,
  expiresAtMillis: 0,
  sign: 0,
  id: "",
});

// Builds one compaction sub-pipeline for a single sign of non-expiring changes. Compaction must
// only ever merge changes of the *same* sign: a non-expiring deduction has to reach the ledger as a
// deduction so it consumes the soonest-expiring grant. If we merged it with permanent grants
// (opposite sign) it would silently net against them and never touch the expiring grant. Beyond
// that, it may only merge a *contiguous* run of same-sign changes: the `boundaries` input walls off
// every event that changes the live-grant set (grant arrivals, opposite-sign changes, expiries), so
// a merged change is never restamped across one. Without those walls, moving a change across a grant
// arrival flips the ledger's debt-vs-consumption split and permanently loses/gains units. The caller
// passes a per-sign boundary table (everything except this sign's own compactable arrivals).
const compactionSubPipelineSteps = (suffix: string, signedAggregatesTable: string, boundariesTable: string): { steps: InitTableStep[], output: string } => {
  const inputTable = `payments-entries-compaction-input-${suffix}`;
  const sortedTable = `${inputTable}-sorted`;
  const rawTable = `payments-entries-compacted-raw-${suffix}`;
  const aggregatesTable = `payments-entries-compacted-aggregates-${suffix}`;
  const output = `payments-entries-compacted-item-quantity-change-${suffix}`;
  return {
    output,
    steps: [
      table(inputTable, defineConcatTable(), { compactable: signedAggregatesTable, boundary: boundariesTable }),
      table(sortedTable, defineSortTable({ sortKeyExtractor: compactionSortKey, sortKeyComparator: compareCompactionSortKeys }), { input: inputTable }),
      table(rawTable, defineCompactTable({
        compactor: (left, right) => {
          // A boundary (an expiry of this item, or an arrival that isn't this sign's own compactable
          // change) stops the merge; different items never merge (the sort groups by item, so this
          // only happens at the edge between two items' windows).
          if (isCompactionBoundary(left) || isCompactionBoundary(right)) return [{ newRowData: left }, { newRowData: right }];
          if (compactionRowItemId(left) !== compactionRowItemId(right)) return [{ newRowData: left }, { newRowData: right }];
          return [{ newRowData: toPiledriverObject(mergeCompactionAggregates(asCompactionAggregate(left), asCompactionAggregate(right))) }];
        },
      }), { input: sortedTable }),
      table(aggregatesTable, defineFilterTable(row => rowObject<{ type: string }>(row.rowData).type === "item-quantity-compaction-aggregate"), { input: rawTable }),
      table(output, defineFlatMapTable(row => {
        const aggregate = rowObject<ItemCompactionAggregate>(row.rowData);
        return Object.values(aggregate.items).map(item => toPiledriverObject({
          ...item.firstRow,
          type: "compacted-item-quantity-change",
          quantity: item.quantity,
          expiresWhen: null,
        }));
      }), { input: aggregatesTable }),
    ],
  };
};

export function createPaymentsSchema() {
  const positiveCompaction = compactionSubPipelineSteps("positive", "payments-entries-item-quantity-change-compactable-positive-aggregates", "payments-entries-compaction-boundaries-positive");
  const negativeCompaction = compactionSubPipelineSteps("negative", "payments-entries-item-quantity-change-compactable-negative-aggregates", "payments-entries-compaction-boundaries-negative");
  const migrations: Migration[] = [[
    table("payments-subscriptions", defineStoredTable()),
    table("payments-subscription-invoices", defineStoredTable()),
    table("payments-one-time-purchases", defineStoredTable()),
    table("payments-manual-item-quantity-changes", defineStoredTable()),
    table("payments-manual-transactions", defineStoredTable()),

    table("payments-subscriptions-with-invoices", declareLeftJoinTable({
      leftJoinKeyExtractor: async row => {
        const invoice = rowObject<SubscriptionInvoiceRow>(row.rowData);
        return { tenancyId: invoice.tenancyId, stripeSubscriptionId: invoice.stripeSubscriptionId };
      },
      rightJoinKeyExtractor: async row => {
        const subscription = rowObject<SubscriptionRow>(row.rowData);
        return { tenancyId: subscription.tenancyId, stripeSubscriptionId: subscription.stripeSubscriptionId };
      },
      joinKeyComparator: (a: any, b: any) => stringCompare(a.tenancyId, b.tenancyId) || stringCompare(a.stripeSubscriptionId ?? "", b.stripeSubscriptionId ?? "") || (a.stripeSubscriptionId === b.stripeSubscriptionId ? 0 : a.stripeSubscriptionId === null ? -1 : 1),
      joiner: async (left, right) => ({ leftRowData: left.rowData, rightRowData: right?.rowData ?? null }),
    }), { left: "payments-subscription-invoices", right: "payments-subscriptions" }),
    table("payments-renewal-invoice-rows", defineFilterTable(row => {
      // Creation invoices are excluded: paid non-trial starts already book
      // catalog money on subscription-start, so counting the creation invoice
      // would double-charge. Free trials book $0 at create and their first real
      // charge arrives later as a non-creation invoice (same path as renewals).
      const joined = rowObject<{ leftRowData: SubscriptionInvoiceRow, rightRowData: SubscriptionRow | null }>(row.rowData);
      return joined.rightRowData !== null && !joined.leftRowData.isSubscriptionCreationInvoice;
    }), { input: "payments-subscriptions-with-invoices" }),
    table("payments-subscription-renewal-events", defineMapTable(row => {
      const joined = rowObject<{ leftRowData: SubscriptionInvoiceRow, rightRowData: SubscriptionRow }>(row.rowData);
      const sub = joined.rightRowData;
      const invoice = joined.leftRowData;
      return toPiledriverObject({
        subscriptionId: sub.id,
        tenancyId: sub.tenancyId,
        customerId: sub.customerId,
        customerType: sub.customerType,
        invoiceId: invoice.id,
        chargedAmount: renewalChargedAmount(invoice, sub),
        paymentProvider: paymentProvider(sub.creationSource),
        effectiveAtMillis: invoice.createdAtMillis,
        createdAtMillis: invoice.createdAtMillis,
      });
    }), { input: "payments-renewal-invoice-rows" }),
    table("payments-cancel-pending-subscriptions", defineFilterTable(row => {
      const sub = rowObject<SubscriptionRow>(row.rowData);
      return sub.cancelAtPeriodEnd && (sub.status === "active" || sub.status === "trialing");
    }), { input: "payments-subscriptions" }),
    table("payments-subscription-cancel-events", defineMapTable(row => {
      const sub = rowObject<SubscriptionRow>(row.rowData);
      return toPiledriverObject({
        subscriptionId: sub.id,
        tenancyId: sub.tenancyId,
        customerId: sub.customerId,
        customerType: sub.customerType,
        changeType: "cancel",
        paymentProvider: paymentProvider(sub.creationSource),
        effectiveAtMillis: sub.canceledAtMillis ?? sub.createdAtMillis,
        createdAtMillis: sub.createdAtMillis,
      });
    }), { input: "payments-cancel-pending-subscriptions" }),
    table("payments-subscription-timefold", declareTimeFoldTable({
      initialState: {},
      reducer: async (_state, row, triggerTime) => {
        if (triggerTime === null) {
          const sub = rowObject<SubscriptionRow>(row.rowData);
          const initial = subscriptionInitialState(sub);
          const hasRepeat = Object.values(initial.itemRepeatSchedule).some(schedule => schedule.nextRepeatMillis !== null);
          const immediateEnd = initial.endedAtMillis !== null && !hasRepeat && initial.endedAtMillis < sub.currentPeriodEndMillis;
          const events = immediateEnd ? [subscriptionStartEvent(sub), subscriptionEndEvent(initial)] : [subscriptionStartEvent(sub)];
          return { newState: toPiledriverObject(initial), newRowData: toPiledriverObject(events), nextTriggerTime: immediateEnd ? null : dateFromMillis(soonestNextMillis(initial, initial.endedAtMillis)) };
        }
        const state = rowObject<SubscriptionFoldState>(_state);
        const currentMillis = triggerTime.getTime();
        if (state.endedAtMillis !== null && state.endedAtMillis <= currentMillis) {
          return { newState: _state, newRowData: toPiledriverObject([subscriptionEndEvent(state)]), nextTriggerTime: null };
        }
        const repeat = subscriptionRepeatStep(state, currentMillis);
        return { newState: toPiledriverObject(repeat.state), newRowData: toPiledriverObject([repeat.event]), nextTriggerTime: dateFromMillis(soonestNextMillis(repeat.state, repeat.state.endedAtMillis)) };
      },
      // Stripe webhooks re-upsert the subscription row on every subscription/invoice event (incl.
      // every renewal), so a row rewrite must fold into the existing state instead of resetting
      // it — resetting deletes every emitted item-grant-repeat transaction until the next tick
      // re-derives them (transiently wrong balances) and re-derives history against the *new* row
      // (a quantity change would retroactively rewrite all past grants).
      onSourceRowChanged: async (_state, row, previous) => {
        const state = rowObject<SubscriptionFoldState>(_state);
        // A quiet fold (no queued trigger) with an end date has already emitted subscription-end
        // (via the timed end step or the immediate-end shortcut). Re-arming it would append a
        // duplicate end event, so the fold stays sealed regardless of the rewrite.
        if (state.endedAtMillis !== null && previous.nextTriggerTime === null) {
          return { newState: _state, nextTriggerTime: null };
        }
        const sub = rowObject<SubscriptionRow>(row.rowData);
        const updated = subscriptionUpdatedState(state, sub);
        // Mirror the initial reducer's immediate-end shortcut for ends introduced by a rewrite:
        // plan switching ends the replaced subscription by rewriting its row and expects the
        // revocation to be visible in the same write (e.g. the switch endpoint's one-time-purchase
        // guard reads owned products right after) — waiting for the next tick would leave the old
        // product transiently granted.
        const hasRepeat = Object.values(updated.itemRepeatSchedule).some(schedule => schedule.nextRepeatMillis !== null);
        if (updated.endedAtMillis !== null && !hasRepeat && updated.endedAtMillis < sub.currentPeriodEndMillis) {
          return { newState: toPiledriverObject(updated), nextTriggerTime: null, appendRowData: toPiledriverObject([subscriptionEndEvent(updated)]) };
        }
        return { newState: toPiledriverObject(updated), nextTriggerTime: dateFromMillis(soonestNextMillis(updated, updated.endedAtMillis)) };
      },
    }), { input: "payments-subscriptions" }),
    table("payments-subscription-timefold-events", defineFlatMapTable(row => Array.isArray(row.rowData) ? row.rowData : []), { input: "payments-subscription-timefold" }),
    table("payments-subscription-start-events", defineFilterTable(row => isObject(row.rowData) && row.rowData.type === "subscription-start"), { input: "payments-subscription-timefold-events" }),
    table("payments-subscription-end-events", defineFilterTable(row => isObject(row.rowData) && row.rowData.type === "subscription-end"), { input: "payments-subscription-timefold-events" }),
    table("payments-item-grant-repeat-from-subscriptions", defineFilterTable(row => isObject(row.rowData) && row.rowData.type === "item-grant-repeat"), { input: "payments-subscription-timefold-events" }),

    table("payments-one-time-purchase-events", defineMapTable(row => {
      const purchase = rowObject<OneTimePurchaseRow>(row.rowData);
      return toPiledriverObject({
        purchaseId: purchase.id,
        tenancyId: purchase.tenancyId,
        customerId: purchase.customerId,
        customerType: purchase.customerType,
        productId: purchase.productId,
        product: purchase.product,
        productLineId: productLineId(purchase.product),
        priceId: purchase.priceId,
        quantity: purchase.quantity,
        chargedAmount: chargedAmount(purchase.product, purchase.priceId, purchase.quantity),
        itemGrants: itemGrants(purchase.product, purchase.quantity, purchase.createdAtMillis, purchase.revokedAtMillis),
        paymentProvider: paymentProvider(purchase.creationSource),
        effectiveAtMillis: purchase.createdAtMillis,
        createdAtMillis: purchase.createdAtMillis,
      });
    }), { input: "payments-one-time-purchases" }),
    table("payments-otp-timefold", declareTimeFoldTable({
      initialState: {},
      reducer: async (_state, row, triggerTime) => {
        if (triggerTime === null) {
          const purchase = rowObject<OneTimePurchaseRow>(row.rowData);
          const initial = otpInitialState(purchase);
          const next = soonestNextMillis(initial, null);
          const cappedNext = initial.revokedAtMillis !== null && next !== null && next > initial.revokedAtMillis ? null : next;
          return { newState: toPiledriverObject(initial), newRowData: [], nextTriggerTime: dateFromMillis(cappedNext) };
        }
        const state = rowObject<OtpFoldState>(_state);
        const repeat = otpRepeatStep(state, triggerTime.getTime());
        const next = soonestNextMillis(repeat.state, null);
        const cappedNext = repeat.state.revokedAtMillis !== null && next !== null && next > repeat.state.revokedAtMillis ? null : next;
        return { newState: toPiledriverObject(repeat.state), newRowData: toPiledriverObject([repeat.event]), nextTriggerTime: dateFromMillis(cappedNext) };
      },
      // Same reasoning as the subscription timefold: purchase rows are re-upserted by webhooks
      // (and revocation/refund updates), so fold the rewrite into the existing state instead of
      // resetting emitted grants. No sealed-fold guard is needed — this fold emits no end event,
      // and the revocation cap below keeps a revoked purchase dormant.
      onSourceRowChanged: async (_state, row) => {
        const state = rowObject<OtpFoldState>(_state);
        const updated = otpUpdatedState(state, rowObject<OneTimePurchaseRow>(row.rowData));
        const next = soonestNextMillis(updated, null);
        const cappedNext = updated.revokedAtMillis !== null && next !== null && next > updated.revokedAtMillis ? null : next;
        return { newState: toPiledriverObject(updated), nextTriggerTime: dateFromMillis(cappedNext) };
      },
    }), { input: "payments-one-time-purchases" }),
    table("payments-otp-timefold-events", defineFlatMapTable(row => Array.isArray(row.rowData) ? row.rowData : []), { input: "payments-otp-timefold" }),
    table("payments-item-grant-repeat-from-otps", defineFilterTable(row => isObject(row.rowData) && row.rowData.type === "item-grant-repeat"), { input: "payments-otp-timefold-events" }),
    table("payments-item-grant-repeat-events", defineConcatTable(), { subscription: "payments-item-grant-repeat-from-subscriptions", otp: "payments-item-grant-repeat-from-otps" }),
    table("payments-manual-item-quantity-change-events", defineMapTable(row => {
      const change = rowObject<ManualItemQuantityChangeRow>(row.rowData);
      return toPiledriverObject({
        changeId: change.id,
        tenancyId: change.tenancyId,
        customerId: change.customerId,
        customerType: change.customerType,
        itemId: change.itemId,
        quantity: change.quantity,
        expiresAtMillis: change.expiresAtMillis,
        effectiveAtMillis: change.createdAtMillis,
        createdAtMillis: change.createdAtMillis,
      });
    }), { input: "payments-manual-item-quantity-changes" }),

    table("payments-txn-subscription-renewal", defineMapTable(row => {
      const event = rowObject<{ subscriptionId: string, invoiceId: string, tenancyId: string, effectiveAtMillis: number, customerType: CustomerType, customerId: string, chargedAmount: Record<string, string>, paymentProvider: PaymentProvider, createdAtMillis: number }>(row.rowData);
      return toPiledriverObject({
        txnId: `sub-renewal:${event.invoiceId}`,
        tenancyId: event.tenancyId,
        effectiveAtMillis: event.effectiveAtMillis,
        type: "subscription-renewal",
        entries: [{ type: "money-transfer", customerType: event.customerType, customerId: event.customerId, chargedAmount: event.chargedAmount }],
        customerType: event.customerType,
        customerId: event.customerId,
        paymentProvider: event.paymentProvider,
        createdAtMillis: event.createdAtMillis,
        renewalTargetSubscriptionId: event.subscriptionId,
      });
    }), { input: "payments-subscription-renewal-events" }),
    table("payments-txn-subscription-cancel", defineMapTable(row => {
      const event = rowObject<{ subscriptionId: string, tenancyId: string, effectiveAtMillis: number, customerType: CustomerType, customerId: string, changeType: "cancel", paymentProvider: PaymentProvider, createdAtMillis: number }>(row.rowData);
      return toPiledriverObject({
        txnId: `sub-cancel:${event.subscriptionId}`,
        tenancyId: event.tenancyId,
        effectiveAtMillis: event.effectiveAtMillis,
        type: "subscription-cancel",
        entries: [{ type: "active-subscription-change", customerType: event.customerType, customerId: event.customerId, subscriptionId: event.subscriptionId, changeType: event.changeType }],
        customerType: event.customerType,
        customerId: event.customerId,
        paymentProvider: event.paymentProvider,
        createdAtMillis: event.createdAtMillis,
        renewalTargetSubscriptionId: null,
      });
    }), { input: "payments-subscription-cancel-events" }),
    table("payments-txn-subscription-start", defineMapTable(row => {
      const event = rowObject<{ subscriptionId: string, tenancyId: string, effectiveAtMillis: number, customerType: CustomerType, customerId: string, productId: string | null, product: ProductSnapshot, productLineId: string | null, priceId: string | null, quantity: number, chargedAmount: Record<string, string>, wasMoneyBookedOnStart: boolean, itemGrants: ItemGrant[], paymentProvider: PaymentProvider, createdAtMillis: number }>(row.rowData);
      // subscriptionInitialState hardcodes these entry indices, so keep the order:
      // [0] sub-start, [1] product-grant, optional money-transfer before item changes.
      // Free trials / $0 / test mode omit money-transfer; the first real Stripe
      // charge after a trial lands as a non-creation invoice → subscription-renewal.
      //
      // wasMoneyBookedOnStart is only consumed here (derived start-event → txn).
      // It is not a stored-row field and does not need a bulldozer migration batch:
      // start events are recomputed from SubscriptionRow; the flag just avoids
      // re-deriving status/test-mode/$0/trial checks in this mapper.
      const entries: TransactionEntryData[] = [
        { type: "active-subscription-start", customerType: event.customerType, customerId: event.customerId, subscriptionId: event.subscriptionId },
        { type: "product-grant", customerType: event.customerType, customerId: event.customerId, productId: event.productId, priceId: event.priceId, product: event.product, productLineId: event.productLineId, quantity: event.quantity, subscriptionId: event.subscriptionId },
      ];
      if (event.wasMoneyBookedOnStart) entries.push({ type: "money-transfer", customerType: event.customerType, customerId: event.customerId, chargedAmount: event.chargedAmount });
      entries.push(...event.itemGrants.map(grant => ({ type: "item-quantity-change" as const, customerType: event.customerType, customerId: event.customerId, itemId: grant.itemId, quantity: grant.quantity, expiresWhen: grant.expiresWhen, stampedExpiresAtMillis: grant.expiresAtMillis })));
      return toPiledriverObject({ txnId: `sub-start:${event.subscriptionId}`, tenancyId: event.tenancyId, effectiveAtMillis: event.effectiveAtMillis, type: "subscription-start", entries, customerType: event.customerType, customerId: event.customerId, paymentProvider: event.paymentProvider, createdAtMillis: event.createdAtMillis, renewalTargetSubscriptionId: null });
    }), { input: "payments-subscription-start-events" }),
    table("payments-subscription-end-events-natural", defineFilterTable(row => rowObject<{ productRevokedAtMillis: number | null }>(row.rowData).productRevokedAtMillis === null), { input: "payments-subscription-end-events" }),
    table("payments-txn-subscription-end", defineMapTable(row => {
      const event = rowObject<{ subscriptionId: string, tenancyId: string, effectiveAtMillis: number, customerType: CustomerType, customerId: string, quantity: number, productId: string | null, productLineId: string | null, startProductGrantRef: { transactionId: string, entryIndex: number }, itemQuantityChangesToExpire: Array<{ transactionId: string, entryIndex: number, itemId: string, quantity: number }>, paymentProvider: PaymentProvider, createdAtMillis: number }>(row.rowData);
      const entries: TransactionEntryData[] = [
        { type: "active-subscription-end", customerType: event.customerType, customerId: event.customerId, subscriptionId: event.subscriptionId },
        { type: "product-revocation", customerType: event.customerType, customerId: event.customerId, adjustedTransactionId: event.startProductGrantRef.transactionId, adjustedEntryIndex: event.startProductGrantRef.entryIndex, quantity: event.quantity, productId: event.productId, productLineId: event.productLineId },
        ...event.itemQuantityChangesToExpire.map(entry => ({ type: "item-quantity-expire" as const, customerType: event.customerType, customerId: event.customerId, adjustedTransactionId: entry.transactionId, adjustedEntryIndex: entry.entryIndex, quantity: entry.quantity, itemId: entry.itemId })),
      ];
      return toPiledriverObject({ txnId: `sub-end:${event.subscriptionId}`, tenancyId: event.tenancyId, effectiveAtMillis: event.effectiveAtMillis, type: "subscription-end", entries, customerType: event.customerType, customerId: event.customerId, paymentProvider: event.paymentProvider, createdAtMillis: event.createdAtMillis, renewalTargetSubscriptionId: null });
    }), { input: "payments-subscription-end-events-natural" }),
    table("payments-txn-item-grant-repeat", defineMapTable(row => {
      const event = rowObject<{ sourceId: string, tenancyId: string, effectiveAtMillis: number, customerType: CustomerType, customerId: string, previousGrantsToExpire: Array<{ transactionId: string, entryIndex: number, itemId: string, quantity: number }>, itemGrants: ItemGrant[], paymentProvider: PaymentProvider, createdAtMillis: number }>(row.rowData);
      const entries: TransactionEntryData[] = [
        ...event.previousGrantsToExpire.map(entry => ({ type: "item-quantity-expire" as const, customerType: event.customerType, customerId: event.customerId, adjustedTransactionId: entry.transactionId, adjustedEntryIndex: entry.entryIndex, quantity: entry.quantity, itemId: entry.itemId })),
        ...event.itemGrants.map(grant => ({ type: "item-quantity-change" as const, customerType: event.customerType, customerId: event.customerId, itemId: grant.itemId, quantity: grant.quantity, expiresWhen: grant.expiresWhen, stampedExpiresAtMillis: grant.expiresAtMillis })),
      ];
      return toPiledriverObject({ txnId: `igr:${event.sourceId}:${event.effectiveAtMillis}`, tenancyId: event.tenancyId, effectiveAtMillis: event.effectiveAtMillis, type: "item-grant-repeat", entries, customerType: event.customerType, customerId: event.customerId, paymentProvider: event.paymentProvider, createdAtMillis: event.createdAtMillis, renewalTargetSubscriptionId: null });
    }), { input: "payments-item-grant-repeat-events" }),
    table("payments-txn-one-time-purchase", defineMapTable(row => {
      const event = rowObject<{ purchaseId: string, tenancyId: string, effectiveAtMillis: number, customerType: CustomerType, customerId: string, productId: string | null, priceId: string | null, product: ProductSnapshot, productLineId: string | null, quantity: number, chargedAmount: Record<string, string>, itemGrants: ItemGrant[], paymentProvider: PaymentProvider, createdAtMillis: number }>(row.rowData);
      // otpInitialState hardcodes these entry indices, so keep the order:
      // [0] product-grant, optional money-transfer before item changes.
      const entries: TransactionEntryData[] = [{ type: "product-grant", customerType: event.customerType, customerId: event.customerId, productId: event.productId, priceId: event.priceId, product: event.product, productLineId: event.productLineId, quantity: event.quantity, oneTimePurchaseId: event.purchaseId }];
      if (event.paymentProvider !== "test_mode" && Object.keys(event.chargedAmount).length > 0) entries.push({ type: "money-transfer", customerType: event.customerType, customerId: event.customerId, chargedAmount: event.chargedAmount });
      entries.push(...event.itemGrants.map(grant => ({ type: "item-quantity-change" as const, customerType: event.customerType, customerId: event.customerId, itemId: grant.itemId, quantity: grant.quantity, expiresWhen: grant.expiresWhen, stampedExpiresAtMillis: grant.expiresAtMillis })));
      return toPiledriverObject({ txnId: `otp:${event.purchaseId}`, tenancyId: event.tenancyId, effectiveAtMillis: event.effectiveAtMillis, type: "one-time-purchase", entries, customerType: event.customerType, customerId: event.customerId, paymentProvider: event.paymentProvider, createdAtMillis: event.createdAtMillis, renewalTargetSubscriptionId: null });
    }), { input: "payments-one-time-purchase-events" }),
    table("payments-txn-manual-item-quantity-change", defineMapTable(row => {
      const event = rowObject<{ changeId: string, tenancyId: string, effectiveAtMillis: number, customerType: CustomerType, customerId: string, itemId: string, quantity: number, expiresAtMillis: number | null, createdAtMillis: number }>(row.rowData);
      return toPiledriverObject({ txnId: `miqc:${event.changeId}`, tenancyId: event.tenancyId, effectiveAtMillis: event.effectiveAtMillis, type: "manual-item-quantity-change", entries: [{ type: "item-quantity-change", customerType: event.customerType, customerId: event.customerId, itemId: event.itemId, quantity: event.quantity, expiresWhen: event.expiresAtMillis }], customerType: event.customerType, customerId: event.customerId, paymentProvider: null, createdAtMillis: event.createdAtMillis, renewalTargetSubscriptionId: null });
    }), { input: "payments-manual-item-quantity-change-events" }),
    table("payments-txn-refund", defineFilterTable(row => rowObject<ManualTransactionRow>(row.rowData).type === "refund"), { input: "payments-manual-transactions" }),
    table("payments-transactions", defineConcatTable(), {
      renewal: "payments-txn-subscription-renewal",
      cancel: "payments-txn-subscription-cancel",
      start: "payments-txn-subscription-start",
      end: "payments-txn-subscription-end",
      repeat: "payments-txn-item-grant-repeat",
      otp: "payments-txn-one-time-purchase",
      manual: "payments-txn-manual-item-quantity-change",
      refund: "payments-txn-refund",
    }),
    table("payments-transactions-by-customer", declareGroupByTable({
      groupKeyExtractor: async row => customerGroupKey(rowObject<TransactionRow>(row.rowData)),
      groupKeyComparator: compareJson,
    }), { input: "payments-transactions" }),
    // Tenancy-wide date index: lets listTransactions read one page (~limit rows) in
    // newest-first order instead of scanning the whole tenancy. Mirrors the old SQL server's
    // ORDER BY createdAt DESC, txnId DESC + LIMIT.
    table("payments-transactions-by-tenancy", declareGroupByTable({
      groupKeyExtractor: async row => tenancyGroupKey(rowObject<TransactionRow>(row.rowData)),
      groupKeyComparator: compareJson,
    }), { input: "payments-transactions" }),
    table("payments-transactions-by-tenancy-sorted", defineSortTable({
      sortKeyExtractor: row => transactionRecencySortKey(rowObject<TransactionRow>(row.rowData)),
      sortKeyComparator: compareTransactionRecencyKeys,
    }), { input: "payments-transactions-by-tenancy" }),

    table("payments-transaction-entries", defineFlatMapTable(row => rowObject<TransactionRow>(row.rowData).entries.map((entry, index) => ({
      ...entry,
      index,
      txnId: rowObject<TransactionRow>(row.rowData).txnId,
      txnEffectiveAtMillis: rowObject<TransactionRow>(row.rowData).effectiveAtMillis,
      txnCreatedAtMillis: rowObject<TransactionRow>(row.rowData).createdAtMillis,
      txnType: rowObject<TransactionRow>(row.rowData).type,
      tenancyId: rowObject<TransactionRow>(row.rowData).tenancyId,
      paymentProvider: rowObject<TransactionRow>(row.rowData).paymentProvider,
    }))), { input: "payments-transactions-by-customer" }),
    table("payments-entries-item-quantity-change-all", defineFilterTable(row => rowObject<{ type: string }>(row.rowData).type === "item-quantity-change"), { input: "payments-transaction-entries" }),
    table("payments-entries-item-quantity-change-compactable", defineFilterTable(row => rowObject<{ expiresWhen: unknown }>(row.rowData).expiresWhen === null), { input: "payments-entries-item-quantity-change-all" }),
    table("payments-entries-item-quantity-change-non-compactable", defineFilterTable(row => rowObject<{ expiresWhen: unknown }>(row.rowData).expiresWhen !== null), { input: "payments-entries-item-quantity-change-all" }),
    // Split compactable (non-expiring) changes by sign and compact each sign on its own — see the
    // note on compactionSubPipelineSteps. A zero-quantity non-expiring change is a no-op and is
    // dropped by both filters.
    table("payments-entries-item-quantity-change-compactable-positive", defineFilterTable(row => rowObject<{ quantity: number }>(row.rowData).quantity > 0), { input: "payments-entries-item-quantity-change-compactable" }),
    table("payments-entries-item-quantity-change-compactable-negative", defineFilterTable(row => rowObject<{ quantity: number }>(row.rowData).quantity < 0), { input: "payments-entries-item-quantity-change-compactable" }),
    table("payments-entries-item-quantity-change-compactable-positive-aggregates", defineMapTable(row => toPiledriverObject(compactableEntryToAggregate(rowObject<ItemQuantityChangeEntry>(row.rowData)))), { input: "payments-entries-item-quantity-change-compactable-positive" }),
    table("payments-entries-item-quantity-change-compactable-negative-aggregates", defineMapTable(row => toPiledriverObject(compactableEntryToAggregate(rowObject<ItemQuantityChangeEntry>(row.rowData)))), { input: "payments-entries-item-quantity-change-compactable-negative" }),
    table("payments-entries-item-quantity-expire", defineFilterTable(row => rowObject<{ type: string }>(row.rowData).type === "item-quantity-expire"), { input: "payments-transaction-entries" }),
    // Compaction boundaries mark, per item, the instants across which non-expiring changes of a
    // given sign must NOT be merged, because merging (which restamps the merged change at the
    // earliest member's time) would move it across an event that changes the live-grant set, and the
    // ledger's debt-vs-consumption split depends on that set at each change's instant. They come from
    // three sources: expiry markers (a grant of this item dropping), manual absolute-expiry grants
    // (whose expiry marker is synthesized later in the split, so we derive the boundary here from the
    // grant's own absolute expiry time), and — crucially — every change ARRIVAL that isn't of the
    // pipeline's own compactable sign (see payments-entries-change-arrival-boundaries below).
    table("payments-entries-expire-marker-boundaries", defineMapTable(row => {
      const entry = rowObject<{ txnEffectiveAtMillis: number, txnId: string, index: number, itemId: string }>(row.rowData);
      return toPiledriverObject({
        type: "item-quantity-compaction-boundary",
        txnEffectiveAtMillis: entry.txnEffectiveAtMillis,
        txnId: entry.txnId,
        index: entry.index,
        itemId: entry.itemId,
      });
    }), { input: "payments-entries-item-quantity-expire" }),
    table("payments-entries-absolute-expiry-boundaries", defineFlatMapTable(row => {
      const entry = rowObject<{ txnEffectiveAtMillis: number, txnId: string, index: number, itemId: string, quantity: number, expiresWhen?: number | string | null }>(row.rowData);
      // Only manual grants with a real, still-future absolute expiry create a boundary at that time.
      if (typeof entry.expiresWhen !== "number" || entry.quantity <= 0 || entry.expiresWhen <= entry.txnEffectiveAtMillis) return [];
      return [toPiledriverObject({
        type: "item-quantity-compaction-boundary",
        txnEffectiveAtMillis: entry.expiresWhen,
        txnId: entry.txnId,
        index: entry.index,
        itemId: entry.itemId,
      })];
    }), { input: "payments-entries-item-quantity-change-non-compactable" }),
    // A boundary at every item-quantity-change ARRIVAL, tagged with its sign and whether it's
    // compactable (`expiresWhen === null`, matching the compactable filter above). Each sign's
    // pipeline then treats every arrival EXCEPT its own compactable changes as a wall, so it only
    // ever merges a maximal run of same-sign non-expiring changes with nothing between them that
    // touches the live-grant set (no grant arrival, no removal, no expiry).
    table("payments-entries-change-arrival-boundaries", defineMapTable(row => {
      const entry = rowObject<{ txnEffectiveAtMillis: number, txnId: string, index: number, itemId: string, quantity: number, expiresWhen?: number | string | null }>(row.rowData);
      return toPiledriverObject({
        type: "item-quantity-compaction-boundary",
        txnEffectiveAtMillis: entry.txnEffectiveAtMillis,
        txnId: entry.txnId,
        index: entry.index,
        itemId: entry.itemId,
        sign: entry.quantity < 0 ? -1 : 1,
        compactable: entry.expiresWhen === null,
      });
    }), { input: "payments-entries-item-quantity-change-all" }),
    // For the positive pipeline, every arrival except positive-compactable grants is a wall (i.e.
    // all removals plus expiring grant arrivals). The expiring-grant case matters even though it's
    // the same sign: with pre-existing debt, merging two permanent grants across an expiring grant
    // changes which grant absorbs the debt, and the expiring grant then leaks it at its expiry.
    table("payments-entries-arrival-boundaries-for-positive", defineFilterTable(row => {
      const boundary = rowObject<{ sign: number, compactable: boolean }>(row.rowData);
      return !(boundary.sign > 0 && boundary.compactable);
    }), { input: "payments-entries-change-arrival-boundaries" }),
    // For the negative pipeline, every arrival except negative-compactable removals is a wall (i.e.
    // all grant arrivals, permanent or expiring, plus any expiring removal).
    table("payments-entries-arrival-boundaries-for-negative", defineFilterTable(row => {
      const boundary = rowObject<{ sign: number, compactable: boolean }>(row.rowData);
      return !(boundary.sign < 0 && boundary.compactable);
    }), { input: "payments-entries-change-arrival-boundaries" }),
    table("payments-entries-compaction-boundaries-positive", defineConcatTable(), {
      markers: "payments-entries-expire-marker-boundaries",
      absolute: "payments-entries-absolute-expiry-boundaries",
      arrivals: "payments-entries-arrival-boundaries-for-positive",
    }),
    table("payments-entries-compaction-boundaries-negative", defineConcatTable(), {
      markers: "payments-entries-expire-marker-boundaries",
      absolute: "payments-entries-absolute-expiry-boundaries",
      arrivals: "payments-entries-arrival-boundaries-for-negative",
    }),
    ...positiveCompaction.steps,
    ...negativeCompaction.steps,
    table("payments-entries-compacted-item-quantity-change", defineConcatTable(), {
      positive: positiveCompaction.output,
      negative: negativeCompaction.output,
    }),
    table("payments-entries-passthrough-non-item-quantity-change", defineFilterTable(row => rowObject<{ type: string }>(row.rowData).type !== "item-quantity-change"), { input: "payments-transaction-entries" }),
    table("payments-compacted-transaction-entries", defineConcatTable(), {
      passthrough: "payments-entries-passthrough-non-item-quantity-change",
      compacted: "payments-entries-compacted-item-quantity-change",
      nonCompactable: "payments-entries-item-quantity-change-non-compactable",
    }),
    table("payments-entries-product-grant", defineFilterTable(row => rowObject<{ type: string }>(row.rowData).type === "product-grant"), { input: "payments-compacted-transaction-entries" }),
    table("payments-entries-product-revocation", defineFilterTable(row => rowObject<{ type: string }>(row.rowData).type === "product-revocation"), { input: "payments-compacted-transaction-entries" }),

    table("payments-product-entries", defineFilterTable(row => {
      const entry = rowObject<{ type: string }>(row.rowData);
      return entry.type === "product-grant" || entry.type === "product-revocation";
    }), { input: "payments-compacted-transaction-entries" }),
    // Sorts only by time, no tiebreak. A grant and revocation for the same product on
    // the exact same millisecond have undefined order, which can change the owned count.
    // Not reachable today; add a tiebreak (e.g. revocations first) if it ever is.
    table("payments-product-entries-sorted", defineSortTable({
      sortKeyExtractor: row => rowObject<{ txnEffectiveAtMillis: number }>(row.rowData).txnEffectiveAtMillis,
      sortKeyComparator: compareNumbers,
    }), { input: "payments-product-entries" }),
    table("payments-owned-products", declareLeftFoldTable({
      initialState: {},
      reducer: async (state, row) => {
        const current = rowObject<Record<string, { quantity: number, product: ProductSnapshot | null, productLineId: string | null }>>(state);
        const entry = rowObject<{ type: "product-grant" | "product-revocation", productId: string | null, product?: ProductSnapshot, productLineId: string | null, quantity: number, txnEffectiveAtMillis: number, txnId: string, customerType: CustomerType, customerId: string, tenancyId: string }>(row.rowData);
        // Entries with no productId share one bucket. Assumes no real product id is
        // literally "__null__", or it'd collide with this bucket.
        const key = entry.productId ?? "__null__";
        const old = current[key] ?? { quantity: 0, product: null, productLineId: null };
        const nextQuantity = Math.max(0, old.quantity + (entry.type === "product-grant" ? entry.quantity : -entry.quantity));
        const next = { ...current, [key]: { quantity: nextQuantity, product: entry.type === "product-grant" ? entry.product ?? null : old.product, productLineId: entry.type === "product-grant" ? entry.productLineId : old.productLineId } };
        return { newState: toPiledriverObject(next), newRowData: toPiledriverObject({ txnEffectiveAtMillis: entry.txnEffectiveAtMillis, txnId: entry.txnId, ownedProducts: next, customerType: entry.customerType, customerId: entry.customerId, tenancyId: entry.tenancyId }) };
      },
    }), { input: "payments-product-entries-sorted" }),

    table("payments-split-item-changes-with-expiry", defineFlatMapTable(row => splitItemQuantityChangeWithExpiry(row.rowData)), { input: "payments-compacted-transaction-entries" }),
    table("payments-changes-sorted-for-ledger", defineSortTable({
      sortKeyExtractor: ledgerSortKey,
      sortKeyComparator: compareLedgerSortKeys,
    }), { input: "payments-split-item-changes-with-expiry" }),
    table("payments-item-quantities", declareLeftFoldTable({
      initialState: {},
      reducer: async (state, row) => {
        const current = rowObject<LedgerState>(state);
        const change = rowObject<{ txnId: string, txnEffectiveAtMillis: number, customerType: CustomerType, customerId: string, tenancyId: string, itemId: string, quantity: number, expiresAtMillis: number | null, grantId?: string | null, expireGrantId?: string | null }>(row.rowData);
        const oldItem = current[change.itemId] ?? { grants: [], consumption: 0, debt: 0 };
        let nextItem = oldItem;
        if (change.expireGrantId != null) {
          // Expiry: drop the one grant it belongs to. The consumption that had landed on it settles
          // with it — under the soonest-first distribution that grant absorbed `alloc`, so we drop
          // `alloc` from the running consumption too. Everything left keeps re-distributing over the
          // remaining grants. A grant already gone (never existed / earlier duplicate) is a no-op.
          const target = oldItem.grants.find(grant => grant.id === change.expireGrantId);
          if (target !== undefined) {
            const consumedBefore = sumGrantQuantities(oldItem.grants.filter(grant => grant !== target && compareGrantsByExpiry(grant, target) < 0));
            const alloc = Math.max(0, Math.min(target.q, oldItem.consumption - consumedBefore));
            nextItem = { grants: oldItem.grants.filter(grant => grant !== target), consumption: oldItem.consumption - alloc, debt: oldItem.debt };
          }
        } else if (change.quantity > 0) {
          // Grant: pay down any frozen debt right here (baked into this grant's quantity so it never
          // reassigns — "debt applies to the first grant that comes in"). Keep the grant if it has
          // anything left or an id an expiry marker will later target.
          const baked = Math.min(change.quantity, oldItem.debt);
          const q = change.quantity - baked;
          const grantId = change.grantId ?? null;
          const grant = { q, e: change.expiresAtMillis, id: grantId };
          nextItem = { grants: q > 0 || grantId !== null ? [...oldItem.grants, grant] : oldItem.grants, consumption: oldItem.consumption, debt: oldItem.debt - baked };
        } else if (change.quantity < 0) {
          // Removal: as much as the grants can currently cover joins the reassigning consumption
          // total; the overflow becomes frozen debt. (Invariant: debt only grows once grants are
          // fully consumed, i.e. sum(q) - consumption == 0.)
          const amount = -change.quantity;
          const covered = Math.max(0, Math.min(amount, sumGrantQuantities(oldItem.grants) - oldItem.consumption));
          nextItem = { grants: oldItem.grants, consumption: oldItem.consumption + covered, debt: oldItem.debt + (amount - covered) };
        }
        const next = { ...current, [change.itemId]: nextItem };
        return { newState: toPiledriverObject(next), newRowData: toPiledriverObject({ txnEffectiveAtMillis: change.txnEffectiveAtMillis, txnId: change.txnId, itemQuantities: currentItemQuantities(next), customerType: change.customerType, customerId: change.customerId, tenancyId: change.tenancyId }) };
      },
    }), { input: "payments-changes-sorted-for-ledger" }),

    table("payments-subscriptions-by-customer", declareGroupByTable({
      groupKeyExtractor: async row => customerGroupKey(rowObject<SubscriptionRow>(row.rowData)),
      groupKeyComparator: compareJson,
    }), { input: "payments-subscriptions" }),
    table("payments-subscriptions-sorted", defineSortTable({
      sortKeyExtractor: row => rowObject<SubscriptionRow>(row.rowData).createdAtMillis,
      sortKeyComparator: compareNumbers,
    }), { input: "payments-subscriptions-by-customer" }),
    table("payments-subscription-map-by-customer", declareLeftFoldTable({
      initialState: {},
      reducer: async (state, row) => {
        const sub = rowObject<SubscriptionRow>(row.rowData);
        const next = { ...rowObject<Record<string, SubscriptionRow>>(state), [sub.id]: sub };
        return { newState: toPiledriverObject(next), newRowData: toPiledriverObject({ subscriptions: next, tenancyId: sub.tenancyId, customerType: sub.customerType, customerId: sub.customerId }) };
      },
    }), { input: "payments-subscriptions-sorted" }),
  ], [
    // Identifier-ordered view for keyset pagination (manual-txn export). Stored tables
    // keep a null sort key so Range stays sort-key everywhere; page this table instead.
    table("payments-manual-transactions-sorted", defineSortTable({
      sortKeyExtractor: (row) => row.rowIdentifier,
      sortKeyComparator: (a, b) => stringCompare(String(a), String(b)),
    }), { input: "payments-manual-transactions" }),
  ], [
    // GroupBy and Sort intentionally retain no row payloads. These explicit read models preserve
    // the transaction query paths that need listRowsInGroup without materializing every index.
    table("payments-transactions-by-customer-materialized", defineMaterializeTable(), {
      input: "payments-transactions-by-customer",
    }),
    table("payments-transactions-by-tenancy-sorted-materialized", defineMaterializeTable(), {
      input: "payments-transactions-by-tenancy-sorted",
    }),
    table("payments-manual-transactions-sorted-materialized", defineMaterializeTable(), {
      input: "payments-manual-transactions-sorted",
    }),
  ]];

  // Flatten all migration batches for the id map (ids only use "-").
  const tableIds = Object.fromEntries(migrations.flatMap((batch) => batch).map(step => [step.tableId.replaceAll("-", "_"), step.tableId]));
  return {
    migrations,
    tableIds,
    subscriptions: "payments-subscriptions",
    subscriptionInvoices: "payments-subscription-invoices",
    oneTimePurchases: "payments-one-time-purchases",
    manualItemQuantityChanges: "payments-manual-item-quantity-changes",
    manualTransactions: "payments-manual-transactions",
    manualTransactionsSorted: "payments-manual-transactions-sorted-materialized",
    subscriptionRenewalEvents: "payments-subscription-renewal-events",
    subscriptionCancelEvents: "payments-subscription-cancel-events",
    subscriptionStartEvents: "payments-subscription-start-events",
    subscriptionEndEvents: "payments-subscription-end-events",
    itemGrantRepeatEvents: "payments-item-grant-repeat-events",
    oneTimePurchaseEvents: "payments-one-time-purchase-events",
    manualItemQuantityChangeEvents: "payments-manual-item-quantity-change-events",
    transactions: "payments-transactions-by-customer-materialized",
    transactionsByTenancy: "payments-transactions-by-tenancy-sorted-materialized",
    transactionEntries: "payments-transaction-entries",
    compactedTransactionEntries: "payments-compacted-transaction-entries",
    productGrantEntries: "payments-entries-product-grant",
    productRevocationEntries: "payments-entries-product-revocation",
    itemQuantityExpireEntries: "payments-entries-item-quantity-expire",
    allItemQuantityChangeEntries: "payments-entries-item-quantity-change-all",
    compactableItemQuantityChangeEntries: "payments-entries-item-quantity-change-compactable",
    nonCompactableItemQuantityChangeEntries: "payments-entries-item-quantity-change-non-compactable",
    compactedItemQuantityChangeEntries: "payments-entries-compacted-item-quantity-change",
    ownedProducts: "payments-owned-products",
    splitChanges: "payments-split-item-changes-with-expiry",
    itemQuantities: "payments-item-quantities",
    subscriptionMapByCustomer: "payments-subscription-map-by-customer",
    _allTables: migrations.flatMap((batch) => batch),
  };
}

export type PaymentsSchema = ReturnType<typeof createPaymentsSchema>;
