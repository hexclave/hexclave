import { assertPromoCodesCapability, parsePromoCodeNames, promoCodeProjectPolicy, validateAppliedPromoCodes } from "@/lib/payments/promo-code-checkout";
import type { PrismaClientTransaction } from "@/prisma-client";
import { moneyAmountSchema } from "@hexclave/shared/dist/schema-fields";
import { SUPPORTED_CURRENCIES, type MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import { moneyAmountToStripeUnits } from "@hexclave/shared/dist/utils/currencies";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { getOrUndefined, typedEntries } from "@hexclave/shared/dist/utils/objects";
import type { CompleteConfig } from "@hexclave/shared/dist/config/schema";

const USD_CURRENCY = SUPPORTED_CURRENCIES.find((currency) => currency.code === "USD")
  ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");

/**
 * Same stackable rule as plan switch: an inherited `sourceQuantity` from an
 * existing same-line subscription is not a new multi-qty purchase. Only an
 * explicit request is rejected when the product is not stackable. The
 * inherited quantity is still used for the discounted-amount preview.
 */
export function resolvePromoValidationQuantity(options: {
  requestedQuantity: number | undefined,
  sourceQuantity: number | undefined,
  stackable: boolean | undefined,
}): number {
  if (options.requestedQuantity != null && options.requestedQuantity !== 1 && options.stackable !== true) {
    throw new StatusError(400, "This product is not stackable; quantity must be 1");
  }
  return options.requestedQuantity ?? options.sourceQuantity ?? 1;
}

export async function validatePromoCodesAgainstProduct(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  payments: CompleteConfig["payments"],
  productId: string,
  priceId?: string,
  quantity?: number,
  sourceQuantity?: number,
  promoCodes: string[] | undefined,
}) {
  const product = getOrUndefined(options.payments.products, options.productId);
  if (!product) {
    throw new StatusError(400, "Product not found.");
  }
  const quantity = resolvePromoValidationQuantity({
    requestedQuantity: options.quantity,
    sourceQuantity: options.sourceQuantity,
    stackable: product.stackable,
  });
  const priceEntries = typedEntries(product.prices);
  if (priceEntries.length === 0) {
    throw new StatusError(400, "Price not found for product.");
  }
  const selectedPriceId = options.priceId ?? priceEntries[0][0];
  const selectedPrice = new Map(priceEntries).get(selectedPriceId);
  if (!selectedPrice) {
    throw new StatusError(400, "Price not found for product.");
  }
  if (selectedPrice.USD == null || !moneyAmountSchema(USD_CURRENCY).defined().isValidSync(selectedPrice.USD)) {
    throw new StatusError(400, `Price amount must be a finite, non-negative number (got ${JSON.stringify(selectedPrice.USD)})`);
  }

  const promoCodes = parsePromoCodeNames(options.promoCodes);
  const promoPolicy = promoCodeProjectPolicy(options.payments);
  assertPromoCodesCapability(promoPolicy, {
    wantsPromoCodes: promoCodes.length > 0,
    wantsStacking: promoCodes.length > 1,
  });

  const unitAmountStripeUnits = moneyAmountToStripeUnits(selectedPrice.USD as MoneyAmount, USD_CURRENCY);
  const originalStripeUnits = unitAmountStripeUnits * Math.max(1, quantity);
  return await validateAppliedPromoCodes({
    prisma: options.prisma,
    tenancyId: options.tenancyId,
    codeNames: promoCodes,
    productId: options.productId,
    originalStripeUnits,
    allowStacking: promoPolicy.allowStackingPromoCodes,
    isOneTime: selectedPrice.interval == null,
  });
}

import.meta.vitest?.describe("resolvePromoValidationQuantity", (test) => {
  test("inherits source quantity without treating it as a new stackable purchase", ({ expect }) => {
    expect(resolvePromoValidationQuantity({
      requestedQuantity: undefined,
      sourceQuantity: 3,
      stackable: undefined,
    })).toBe(3);
    expect(resolvePromoValidationQuantity({
      requestedQuantity: 1,
      sourceQuantity: 3,
      stackable: undefined,
    })).toBe(1);
    expect(() => resolvePromoValidationQuantity({
      requestedQuantity: 2,
      sourceQuantity: 1,
      stackable: undefined,
    })).toThrowError(/not stackable/);
    expect(resolvePromoValidationQuantity({
      requestedQuantity: 2,
      sourceQuantity: 1,
      stackable: true,
    })).toBe(2);
  });
});
