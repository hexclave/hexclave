import { promoCodeNamesRequestSchema } from "@/app/api/latest/internal/payments/promo-codes/schema";
import { ensureClientCanAccessCustomer, isActiveSubscription } from "@/lib/payments";
import { getSubscriptionMapForCustomer } from "@/lib/payments/customer-data";
import { validatePromoCodesAgainstProduct } from "@/lib/payments/promo-code-validate";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, clientOrHigherAuthTypeSchema, moneyAmountSchema, yupArray, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { SUPPORTED_CURRENCIES } from "@hexclave/shared/dist/utils/currency-constants";
import { stripeUnitsToMoneyAmount } from "@hexclave/shared/dist/utils/currencies";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { getOrUndefined } from "@hexclave/shared/dist/utils/objects";

const USD_CURRENCY = SUPPORTED_CURRENCIES.find((currency) => currency.code === "USD")
  ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");

export const POST = createSmartRouteHandler({
  metadata: {
    hidden: true,
    summary: "Validate promo codes for a plan switch",
    description: "Validates promo codes against a product without redeeming them. Used by Hexclave's hosted Change-plan UI.",
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema.defined(),
      project: adaptSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      customer_type: yupString().oneOf(["user", "team"]).defined(),
      customer_id: yupString().defined(),
    }).defined(),
    body: yupObject({
      product_id: yupString().defined(),
      price_id: yupString().optional(),
      quantity: yupNumber().integer().min(1).optional(),
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
  handler: async ({ auth, params, body }, fullReq) => {
    if (auth.type === "client") {
      await ensureClientCanAccessCustomer({
        customerType: params.customer_type,
        customerId: params.customer_id,
        user: fullReq.auth?.user,
        tenancy: auth.tenancy,
        forbiddenMessage: "Clients can only validate promo codes for their own subscriptions.",
      });
    }
    const product = getOrUndefined(auth.tenancy.config.payments.products, body.product_id);
    if (product == null || (auth.type === "client" && product.serverOnly === true)) {
      throw new StatusError(400, "Product not found.");
    }
    if (product.customerType !== params.customer_type) {
      throw new StatusError(400, "Product customer type does not match.");
    }
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const subMap = await getSubscriptionMapForCustomer({
      prisma,
      tenancyId: auth.tenancy.id,
      customerType: params.customer_type,
      customerId: params.customer_id,
    });
    const sourceSub = Object.values(subMap).find((subscription) => (
      isActiveSubscription(subscription)
      && subscription.productId != null
      && subscription.productId !== body.product_id
      // Switch requires a real product line (`!fromProduct.productLineId` 400s).
      // Without that guard, `undefined === undefined` would treat every other
      // no-line subscription as a same-line source and inherit its quantity.
      && product.productLineId != null
      && getOrUndefined(auth.tenancy.config.payments.products, subscription.productId)?.productLineId === product.productLineId
    )) ?? null;
    const result = await validatePromoCodesAgainstProduct({
      prisma,
      tenancyId: auth.tenancy.id,
      payments: auth.tenancy.config.payments,
      productId: body.product_id,
      priceId: body.price_id,
      quantity: body.quantity,
      sourceQuantity: sourceSub?.quantity,
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
