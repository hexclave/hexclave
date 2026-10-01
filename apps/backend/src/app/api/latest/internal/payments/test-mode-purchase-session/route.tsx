import { promoCodeNamesRequestSchema } from "@/app/api/latest/internal/payments/promo-codes/schema";
import { purchaseUrlVerificationCodeHandler } from "@/app/api/latest/payments/purchases/verification-code-handler";
import { grantProductToCustomer, validatePurchaseSession } from "@/lib/payments";
import { parsePromoCodeNames, grantProductAndSucceedPromo, validateAppliedPromoCodes, assertPromoCodesCapability, promoCodeProjectPolicy } from "@/lib/payments/promo-code-checkout";
import { getTenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { moneyAmountSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { SUPPORTED_CURRENCIES, type MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import { moneyAmountToStripeUnits } from "@hexclave/shared/dist/utils/currencies";
import { HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { typedToUppercase } from "@hexclave/shared/dist/utils/strings";
import { CustomerType } from "@/generated/prisma/client";

const USD_CURRENCY = SUPPORTED_CURRENCIES.find((currency) => currency.code === "USD")
  ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");

export const POST = createSmartRouteHandler({
  metadata: {
    hidden: true,
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
    bodyType: yupString().oneOf(["success"]).defined(),
  }),
  handler: async ({ body }) => {
    const { full_code, price_id, quantity } = body;
    const promoCodes = parsePromoCodeNames(body.promo_codes);
    const { data, id: codeId } = await purchaseUrlVerificationCodeHandler.validateCode(full_code);
    if (promoCodes.length > 0 && data.allowPromoCodes !== true) {
      throw new KnownErrors.PromoCodeInvalid("Promo codes are not enabled for this checkout.");
    }

    const tenancy = await getTenancy(data.tenancyId);
    if (!tenancy) {
      throw new HexclaveAssertionError("Tenancy not found for test mode purchase session");
    }
    if (tenancy.config.payments.blockNewPurchases) {
      throw new KnownErrors.NewPurchasesBlocked();
    }
    const promoPolicy = promoCodeProjectPolicy(tenancy.config.payments);
    assertPromoCodesCapability(promoPolicy, {
      wantsPromoCodes: promoCodes.length > 0,
      wantsStacking: promoCodes.length > 1,
    });
    if (tenancy.config.payments.testMode !== true) {
      throw new StatusError(403, "Test mode is not enabled for this project");
    }
    const prisma = await getPrismaClientForTenancy(tenancy);

    // Test mode does not simulate free trials (no Stripe trialing / SetupIntent /
    // deferred charge). Configured freeTrial is ignored; the dashboard warns.
    const { selectedPrice } = await validatePurchaseSession({
      prisma,
      tenancyId: tenancy.id,
      customerType: data.product.customerType,
      customerId: data.customerId,
      product: data.product,
      productId: data.productId,
      priceId: price_id,
      quantity,
    });
    if (!selectedPrice) {
      throw new HexclaveAssertionError("Price not resolved for test mode purchase session");
    }
    if (selectedPrice.USD == null || !moneyAmountSchema(USD_CURRENCY).defined().isValidSync(selectedPrice.USD)) {
      throw new StatusError(400, `Price amount must be a finite, non-negative number (got ${JSON.stringify(selectedPrice.USD)})`);
    }
    const unitAmountStripeUnits = moneyAmountToStripeUnits(selectedPrice.USD as MoneyAmount, USD_CURRENCY);
    const promoValidation = await validateAppliedPromoCodes({
      prisma,
      tenancyId: tenancy.id,
      codeNames: promoCodes,
      productId: data.productId ?? null,
      originalStripeUnits: unitAmountStripeUnits * Math.max(1, quantity),
      allowStacking: promoPolicy.allowStackingPromoCodes && data.allowStackingPromoCodes === true,
      isOneTime: selectedPrice.interval == null,
    });
    const appliedPromos = promoValidation.applied.map((entry) => entry.promo);

    await grantProductAndSucceedPromo({
      prisma,
      tenancyId: tenancy.id,
      customerId: data.customerId,
      customerType: typedToUppercase(data.product.customerType) as CustomerType,
      promos: appliedPromos,
      purchaseKind: selectedPrice.interval == null ? "one_time" : "subscription",
      grant: async () => {
        const granted = await grantProductToCustomer({
          prisma,
          tenancy,
          customerType: data.product.customerType,
          customerId: data.customerId,
          product: data.product,
          productId: data.productId,
          priceId: price_id,
          quantity,
          creationSource: "TEST_MODE",
        });
        return {
          oneTimePurchaseId: granted.type === "one_time" ? granted.purchaseId ?? undefined : undefined,
          subscriptionId: granted.type === "subscription" ? granted.subscriptionId : undefined,
        };
      },
    });
    await purchaseUrlVerificationCodeHandler.revokeCode({
      tenancy,
      id: codeId,
    });

    return {
      statusCode: 200,
      bodyType: "success",
    };
  },
});
