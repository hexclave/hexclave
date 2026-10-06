import type { InferType } from "yup";
import {
  customerTypeSchema,
  inlineProductSchema,
  moneyAmountSchema,
  yupArray,
  yupBoolean,
  yupNumber,
  yupObject,
  yupString,
  yupUnion,
} from "../../schema-fields";
import { SUPPORTED_CURRENCIES } from "../../utils/currency-constants";
import { throwErr } from "../../utils/errors";
import { typedFromEntries } from "../../utils/objects";


const USD_CURRENCY = SUPPORTED_CURRENCIES.find((currency) => currency.code === "USD") ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");

const chargedAmountSchema = yupObject({
  ...typedFromEntries(SUPPORTED_CURRENCIES.map((currency) => [currency.code, moneyAmountSchema(currency).optional()])),
}).noUnknown(true).test("at-least-one-currency", "charged_amount must include at least one currency amount", (value) => {
  return Object.values(value).some((amount) => typeof amount === "string");
}).defined();

const netAmountSchema = yupObject({
  USD: moneyAmountSchema(USD_CURRENCY).defined(),
}).noUnknown(true).defined();

const transactionEntryMoneyTransferSchema = yupObject({
  type: yupString().oneOf(["money_transfer"]).defined(),
  adjusted_transaction_id: yupString().nullable().defined(),
  adjusted_entry_index: yupNumber().integer().min(0).nullable().defined(),
  customer_type: customerTypeSchema.defined(),
  customer_id: yupString().defined(),
  charged_amount: chargedAmountSchema,
  net_amount: netAmountSchema,
}).defined();

const transactionEntryItemQuantityChangeSchema = yupObject({
  type: yupString().oneOf(["item_quantity_change"]).defined(),
  adjusted_transaction_id: yupString().nullable().defined(),
  adjusted_entry_index: yupNumber().integer().min(0).nullable().defined(),
  customer_type: customerTypeSchema.defined(),
  customer_id: yupString().defined(),
  item_id: yupString().defined(),
  quantity: yupNumber().defined(),
}).defined();

const transactionEntryProductGrantSchema = yupObject({
  type: yupString().oneOf(["product_grant"]).defined(),
  adjusted_transaction_id: yupString().nullable().defined(),
  adjusted_entry_index: yupNumber().integer().min(0).nullable().defined(),
  customer_type: customerTypeSchema.defined(),
  customer_id: yupString().defined(),
  product_id: yupString().nullable().defined(),
  product: inlineProductSchema.defined(),
  price_id: yupString().nullable().defined(),
  quantity: yupNumber().defined(),
  subscription_id: yupString().optional(),
  one_time_purchase_id: yupString().optional(),
}).test(
  "exclusive-reference",
  "subscription_id and one_time_purchase_id cannot both be set",
  (value, context) => {
    if (value.subscription_id != null && value.one_time_purchase_id != null) {
      return context.createError({
        message: "subscription_id and one_time_purchase_id cannot both be set",
      });
    }
    return true;
  },
).defined();

const transactionEntryProductRevocationSchema = yupObject({
  type: yupString().oneOf(["product_revocation"]).defined(),
  adjusted_transaction_id: yupString().defined(),
  adjusted_entry_index: yupNumber().integer().min(0).defined(),
  quantity: yupNumber().defined(),
}).defined();

const transactionEntryProductRevocationReversalSchema = yupObject({
  type: yupString().oneOf(["product_revocation_reversal"]).defined(),
  adjusted_transaction_id: yupString().defined(),
  adjusted_entry_index: yupNumber().integer().min(0).defined(),
  quantity: yupNumber().defined(),
}).defined();

export const transactionEntrySchema = yupUnion(
  transactionEntryMoneyTransferSchema,
  transactionEntryItemQuantityChangeSchema,
  transactionEntryProductGrantSchema,
  transactionEntryProductRevocationSchema,
  transactionEntryProductRevocationReversalSchema,
).defined();

export type TransactionEntry = InferType<typeof transactionEntrySchema>;

export const TRANSACTION_TYPES = [
  "purchase",
  "subscription-cancellation",
  "subscription-renewal",
  "manual-item-quantity-change",
  "refund",
  "chargeback", // todo
  "product-change", // todo
] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const transactionSchema = yupObject({
  id: yupString().defined(),
  created_at_millis: yupNumber().defined(),
  effective_at_millis: yupNumber().defined(),
  type: yupString().oneOf(TRANSACTION_TYPES).nullable().defined(),
  // Customer is exposed at the transaction level (not only per-entry) so
  // consumers can attribute every row — including refund rows whose surviving
  // entries (`product_revocation`, or none at all) carry no customer fields.
  customer_type: customerTypeSchema.defined(),
  customer_id: yupString().defined(),
  // Populated only for subscription-renewal rows (Hexclave subscription id to
  // pass as refund `id` alongside this row's invoice id). Null elsewhere /
  // when missing on older materialized index rows.
  renewal_target_subscription_id: yupString().nullable().optional(),
  entries: yupArray(transactionEntrySchema).defined(),
  adjusted_by: yupArray(
    yupObject({
      transaction_id: yupString().defined(),
      entry_index: yupNumber().integer().min(0).defined(),
    }).defined(),
  ).defined(),
  test_mode: yupBoolean().defined(),
}).defined();

export type Transaction = InferType<typeof transactionSchema>;
