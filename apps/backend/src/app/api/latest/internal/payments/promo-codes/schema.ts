import { yupArray, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const promoCodeStatusSchema = yupString().oneOf(["active", "scheduled", "paused", "expired", "ended"]);

// Keep blank strings (yup.string() casts "" to undefined and 400s as SCHEMA_ERROR).
// yupString() so OpenAPI emits string items instead of mixed→object.
export const promoCodeNameInputSchema = yupString()
  .transform((_value, originalValue) => originalValue)
  .test(
    "promo-code-name-is-string",
    "must be a string",
    (value) => typeof value === "string",
  )
  .defined()
  .meta({ openapiField: { description: "Promo code name as typed by the customer.", exampleValue: "SAVE10" } });
export const promoCodeNamesRequestSchema = yupArray(promoCodeNameInputSchema);

export const serializedPromoCodeSchema = yupObject({
  id: yupString().uuid().defined(),
  code_name: yupString().defined(),
  status: promoCodeStatusSchema.defined(),
  status_detail: yupString().nullable().defined(),
  discount_type: yupString().oneOf(["percent", "amount"]).defined(),
  discount_amount: yupNumber().defined(),
  discount_label: yupString().defined(),
  products_label: yupString().defined(),
  applicable_product_ids: yupArray(yupString().defined()).nullable().defined(),
  num_redemptions: yupNumber().integer().defined(),
  max_redemptions: yupNumber().integer().nullable().defined(),
  availability: yupString().defined(),
  availability_type: yupString().oneOf(["always", "between_dates"]).defined(),
  starts_at_millis: yupNumber().nullable().defined(),
  ends_at_millis: yupNumber().nullable().defined(),
  paused_at_millis: yupNumber().nullable().defined(),
  ended_at_millis: yupNumber().nullable().defined(),
  subscription_behavior: yupString().oneOf(["first_payment", "fixed_duration", "forever"]).defined(),
  subscription_discount_duration_months: yupNumber().integer().nullable().defined(),
  has_active_subscription_redemptions: yupBoolean().defined(),
});
