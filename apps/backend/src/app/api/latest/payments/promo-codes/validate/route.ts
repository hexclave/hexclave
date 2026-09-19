import { promoCodeNamesRequestSchema } from "@/app/api/latest/internal/payments/promo-codes/schema";
import { validatePromoCodesAgainstProduct } from "@/lib/payments/promo-code-validate";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, moneyAmountSchema, serverOrHigherAuthTypeSchema, yupArray, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { SUPPORTED_CURRENCIES } from "@hexclave/shared/dist/utils/currency-constants";
import { stripeUnitsToMoneyAmount } from "@hexclave/shared/dist/utils/currencies";
import { throwErr } from "@hexclave/shared/dist/utils/errors";

const USD_CURRENCY = SUPPORTED_CURRENCIES.find((currency) => currency.code === "USD")
  ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");

export const POST = createSmartRouteHandler({
  metadata: {
    hidden: false,
    summary: "Validate promo codes",
    description: "Validates promo codes against a product price without redeeming them. Requires a server or admin key. Stacking is controlled by project configuration.",
    tags: ["Payments"],
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema.defined(),
      project: adaptSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    body: yupObject({
      product_id: yupString().defined(),
      price_id: yupString().optional(),
      quantity: yupNumber().integer().min(1).default(1),
      promo_codes: promoCodeNamesRequestSchema.default([]),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      original_amount: moneyAmountSchema(USD_CURRENCY).defined(),
      net_amount: moneyAmountSchema(USD_CURRENCY).defined(),
      recurring_amount: moneyAmountSchema(USD_CURRENCY).defined(),
      applied_code_names: yupArray(yupString().defined()).defined(),
    }),
  }),
  handler: async ({ auth, body }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const result = await validatePromoCodesAgainstProduct({
      prisma,
      tenancyId: auth.tenancy.id,
      payments: auth.tenancy.config.payments,
      productId: body.product_id,
      priceId: body.price_id,
      quantity: body.quantity,
      promoCodes: body.promo_codes,
    });
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        original_amount: stripeUnitsToMoneyAmount(result.originalStripeUnits, USD_CURRENCY),
        net_amount: stripeUnitsToMoneyAmount(result.netStripeUnits, USD_CURRENCY),
        recurring_amount: stripeUnitsToMoneyAmount(result.recurringStripeUnits, USD_CURRENCY),
        applied_code_names: result.applied.map((entry) => entry.promo.codeName),
      },
    };
  },
});
