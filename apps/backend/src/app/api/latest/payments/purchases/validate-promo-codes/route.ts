import { promoCodeNamesRequestSchema } from "@/app/api/latest/internal/payments/promo-codes/schema";
import { validateAppliedPromoCodes, parsePromoCodeNames, assertPromoCodesCapability, promoCodeProjectPolicy } from "@/lib/payments/promo-code-checkout";
import { validatePurchaseSession } from "@/lib/payments";
import { getTenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { getStripeOneTimeMinAmount } from "@hexclave/shared/dist/payments/stripe-limits";
import { moneyAmountSchema, yupArray, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { SUPPORTED_CURRENCIES, type MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import { moneyAmountToStripeUnits, stripeUnitsToMoneyAmount } from "@hexclave/shared/dist/utils/currencies";
import { HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { purchaseUrlVerificationCodeHandler } from "../verification-code-handler";

const USD_CURRENCY = SUPPORTED_CURRENCIES.find((currency) => currency.code === "USD")
  ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");

export const POST = createSmartRouteHandler({
  metadata: {
    hidden: false,
    summary: "Validate Promo Codes",
    description: "Validates promo codes for a purchase URL without redeeming them.",
    tags: ["Payments"],
  },
  request: yupObject({
    body: yupObject({
      full_code: yupString().defined(),
      price_id: yupString().defined(),
      quantity: yupNumber().integer().min(1).default(1),
      promo_codes: promoCodeNamesRequestSchema.default([]),
    }),
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
  handler: async ({ body }) => {
    const { data } = await purchaseUrlVerificationCodeHandler.validateCode(body.full_code);
    const tenancy = await getTenancy(data.tenancyId);
    if (!tenancy) {
      throw new HexclaveAssertionError("No tenancy found from purchase code data tenancy id.");
    }
    if (data.allowPromoCodes !== true) {
      throw new KnownErrors.PromoCodeInvalid("Promo codes are not enabled for this checkout.");
    }
    const promoPolicy = promoCodeProjectPolicy(tenancy.config.payments);
    const promoCodes = parsePromoCodeNames(body.promo_codes);
    assertPromoCodesCapability(promoPolicy, {
      wantsPromoCodes: promoCodes.length > 0,
      wantsStacking: promoCodes.length > 1,
    });
    const prisma = await getPrismaClientForTenancy(tenancy);
    const { selectedPrice } = await validatePurchaseSession({
      prisma,
      tenancyId: tenancy.id,
      customerType: data.product.customerType,
      customerId: data.customerId,
      product: data.product,
      productId: data.productId,
      priceId: body.price_id,
      quantity: body.quantity,
    });
    if (!selectedPrice) {
      throw new HexclaveAssertionError("Price not resolved for promo validation");
    }
    if (selectedPrice.USD == null || !moneyAmountSchema(USD_CURRENCY).defined().isValidSync(selectedPrice.USD)) {
      throw new StatusError(400, `Price amount must be a finite, non-negative number (got ${JSON.stringify(selectedPrice.USD)})`);
    }
    const unitAmountStripeUnits = moneyAmountToStripeUnits(selectedPrice.USD as MoneyAmount, USD_CURRENCY);
    const stripeOneTimeMin = getStripeOneTimeMinAmount("USD");
    const minOneTimeStripeUnits = moneyAmountToStripeUnits(
      stripeOneTimeMin.toFixed(USD_CURRENCY.decimals) as MoneyAmount,
      USD_CURRENCY,
    );
    const originalStripeUnits = unitAmountStripeUnits * Math.max(1, body.quantity);
    if (!selectedPrice.interval && originalStripeUnits > 0 && originalStripeUnits < minOneTimeStripeUnits) {
      throw new StatusError(400, `One-time purchases must total at least $${stripeOneTimeMin.toFixed(2)}`);
    }
    const result = await validateAppliedPromoCodes({
      prisma,
      tenancyId: tenancy.id,
      codeNames: promoCodes,
      productId: data.productId ?? null,
      originalStripeUnits,
      allowStacking: promoPolicy.allowStackingPromoCodes && data.allowStackingPromoCodes === true,
      isOneTime: selectedPrice.interval == null,
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
