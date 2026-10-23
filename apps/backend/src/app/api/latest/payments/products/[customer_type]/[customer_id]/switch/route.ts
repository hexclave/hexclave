import { assertFreeTrialAllowedForPurchase, ensureClientCanAccessCustomer, ensureCustomerExists, getDefaultCardPaymentMethodSummary, getEffectiveFreeTrial, getStripeCustomerForCustomerOrNull, getStripeTrialPeriodDays, grantProductToCustomer, isActiveSubscription, isAddOnProduct } from "@/lib/payments";
import { assertPromoCodesCapability, createSwitchSubscription, grantProductAndSucceedPromo, inPlaceSubscriptionDiscountFields, inPlaceSubscriptionSnapshot, listLiveHexclaveRedemptions, markHexclaveDiscountsRemoved, parsePromoCodeNames, promoCodeProjectPolicy, succeedPendingRedemptions, subscriptionDiscountParams, updateSwitchSubscription, validateAppliedPromoCodes } from "@/lib/payments/promo-code-checkout";
import { bulldozerWriteSubscription } from "@/lib/payments/bulldozer-dual-write";
import { getOwnedProductsForCustomer, getSubscriptionMapForCustomer } from "@/lib/payments/customer-data";
import { getApplicationFeePercentOrUndefined } from "@/lib/payments/platform-fees";
import { upsertProductVersion } from "@/lib/product-versions";
import { getStripeForAccount, sanitizeStripePeriodDates } from "@/lib/stripe";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { promoCodeNamesRequestSchema } from "@/app/api/latest/internal/payments/promo-codes/schema";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, moneyAmountSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { SUPPORTED_CURRENCIES, type MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import { moneyAmountToStripeUnits } from "@hexclave/shared/dist/utils/currencies";
import { HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { getOrUndefined, typedEntries } from "@hexclave/shared/dist/utils/objects";
import { typedToUppercase } from "@hexclave/shared/dist/utils/strings";

const USD_CURRENCY = SUPPORTED_CURRENCIES.find((currency) => currency.code === "USD")
  ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");


export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Switch a customer's subscription product",
    hidden: true,
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
      from_product_id: yupString().defined(),
      to_product_id: yupString().defined(),
      price_id: yupString().optional(),
      quantity: yupNumber().integer().min(1).optional(),
      promo_codes: promoCodeNamesRequestSchema.optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      success: yupBoolean().oneOf([true]).defined(),
    }).defined(),
  }),
  handler: async ({ auth, params, body }, fullReq) => {
    if (auth.tenancy.config.payments.blockNewPurchases) {
      throw new KnownErrors.NewPurchasesBlocked();
    }
    if (auth.type === "client") {
      await ensureClientCanAccessCustomer({
        customerType: params.customer_type,
        customerId: params.customer_id,
        user: fullReq.auth?.user,
        tenancy: auth.tenancy,
        forbiddenMessage: "Clients can only manage their own subscriptions.",
      });
    }

    const products = auth.tenancy.config.payments.products;
    const fromProduct = getOrUndefined(products, body.from_product_id);
    const toProduct = getOrUndefined(products, body.to_product_id);
    if (!fromProduct || !toProduct) {
      throw new StatusError(400, "Product not found.");
    }
    if (fromProduct.customerType !== params.customer_type || toProduct.customerType !== params.customer_type) {
      throw new StatusError(400, "Product customer type does not match.");
    }
    if (!fromProduct.productLineId || fromProduct.productLineId !== toProduct.productLineId) {
      throw new StatusError(400, "Products must be in the same product line to switch.");
    }
    if (body.from_product_id === body.to_product_id) {
      throw new StatusError(400, "Product is already active.");
    }
    if (isAddOnProduct(toProduct)) {
      throw new StatusError(400, "Add-on products cannot be selected for plan switching.");
    }
    const fromPriceEntries = typedEntries(fromProduct.prices);
    const fromHasIntervalPrice = fromPriceEntries.some(([, price]) => price.interval);
    // A product with non-interval prices is a one-time purchase and can't be switched.
    // A product with no prices at all (e.g. auto-migrated from the legacy `include-by-default`
    // sentinel, or an intentionally free product) is treated as a free plan the customer may
    // upgrade away from.
    if (fromPriceEntries.length > 0 && !fromHasIntervalPrice) {
      throw new StatusError(400, "This subscription cannot be switched.");
    }

    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    await ensureCustomerExists({
      prisma,
      tenancyId: auth.tenancy.id,
      customerType: params.customer_type,
      customerId: params.customer_id,
    });

    // Fetch subscription map (used for both OTP guard and subscription lookup)
    const subMap = await getSubscriptionMapForCustomer({
      prisma,
      tenancyId: auth.tenancy.id,
      customerType: params.customer_type,
      customerId: params.customer_id,
    });

    // Block switching if a non-subscription (OTP) product exists in the same product line,
    // since OTPs can't be replaced. Subscription ownership is fine — that's what we're switching.
    if (fromProduct.productLineId) {
      const ownedProducts = await getOwnedProductsForCustomer({
        prisma,
        tenancyId: auth.tenancy.id,
        customerType: params.customer_type,
        customerId: params.customer_id,
      });
      // ownedProducts keys use '__null__' for inline products (null productId),
      // so we normalize subscription productIds to match.
      const activeSubProductIds = new Set(
        Object.values(subMap).filter(s => isActiveSubscription(s)).map(s => s.productId ?? "__null__")
      );
      const hasOtpInProductLine = Object.entries(ownedProducts).some(
        ([productId, p]) => productId !== body.from_product_id
          && p.productLineId === fromProduct.productLineId
          && p.quantity > 0
          && !activeSubProductIds.has(productId)
      );
      if (hasOtpInProductLine) {
        throw new StatusError(400, "Customer already has a one-time purchase in this product line");
      }
    }

    // Find the active subscription to switch from. Customers on a free plan (no prices, or
    // auto-migrated from the legacy `include-by-default` sentinel) won't have a subscription
    // row — in that case we fall through to the "create a new Stripe subscription" branch.
    const existingSub = Object.values(subMap).find(
      s => s.productId === body.from_product_id && isActiveSubscription(s)
    ) ?? null;
    // A price counts as "free" only if EVERY supported currency is either absent or zero.
    // Checking USD alone would misclassify a price that's only set in another supported
    // currency (e.g. EUR-only) as free, and would let the customer switch from it without
    // an existing subscription row — bypassing intended billing.
    const isPriceFree = (price: typeof fromPriceEntries[number][1]) =>
      SUPPORTED_CURRENCIES.every(c => {
        const amount = (price as Record<string, unknown>)[c.code];
        return amount == null || Number(amount) === 0;
      });
    const fromIsFreePlan = fromPriceEntries.length === 0
      || fromPriceEntries.every(([, p]) => isPriceFree(p));
    if (!existingSub && !fromIsFreePlan) {
      throw new StatusError(400, "This subscription cannot be switched.");
    }
    const testMode = auth.tenancy.config.payments.testMode === true;
    if (existingSub != null && existingSub.stripeSubscriptionId == null && !testMode) {
      throw new StatusError(400, "This subscription cannot be switched.");
    }
    // Free-plan fallthrough: if the customer claims to be switching "from" a free product
    // but actually holds a different active subscription in the same product line, reject —
    // otherwise the new paid subscription would coexist with the existing one.
    // (`fromProduct.productLineId` is guaranteed truthy here — the same-product-line check
    // ~80 lines above already throws when it isn't.)
    if (!existingSub && fromIsFreePlan) {
      const competingSub = Object.values(subMap).find(
        s => s.productId !== body.from_product_id
          && isActiveSubscription(s)
          && s.productId != null
          && getOrUndefined(products, s.productId)?.productLineId === fromProduct.productLineId
      );
      if (competingSub) {
        throw new StatusError(400, "Customer has an active subscription in this product line; switch from that product instead.");
      }
    }

    const priceEntries = typedEntries(toProduct.prices)
      .filter(([, price]) => price.interval);
    if (priceEntries.length === 0) {
      throw new StatusError(400, "Price not found for target product.");
    }
    const pricesMap = new Map(priceEntries);
    const selectedPriceId = body.price_id ?? priceEntries[0][0];
    const selectedPrice = pricesMap.get(selectedPriceId);
    if (!selectedPrice) {
      throw new StatusError(400, "Price not found for target product.");
    }
    if (!selectedPrice.interval) {
      throw new StatusError(400, "Price not found for target product.");
    }
    if (selectedPrice.USD == null || !moneyAmountSchema(USD_CURRENCY).defined().isValidSync(selectedPrice.USD)) {
      throw new StatusError(400, `Price amount must be a finite, non-negative number (got ${JSON.stringify(selectedPrice.USD)})`);
    }
    // Never `Number(USD) * 100` — e.g. 79.99 → 7998.999999999999 and Stripe
    // rejects with parameter_invalid_integer.
    const unitAmountStripeUnits = moneyAmountToStripeUnits(selectedPrice.USD as MoneyAmount, USD_CURRENCY);
    const selectedInterval = selectedPrice.interval;
    const quantity = body.quantity ?? existingSub?.quantity ?? 1;
    if (body.quantity !== undefined && quantity !== 1 && toProduct.stackable !== true) {
      throw new StatusError(400, "This product is not stackable; quantity must be 1");
    }

    const promoCodes = parsePromoCodeNames(body.promo_codes);
    const promoPolicy = promoCodeProjectPolicy(auth.tenancy.config.payments);
    assertPromoCodesCapability(promoPolicy, {
      wantsPromoCodes: promoCodes.length > 0,
      wantsStacking: promoCodes.length > 1,
    });
    const promoValidation = await validateAppliedPromoCodes({
      prisma,
      tenancyId: auth.tenancy.id,
      codeNames: promoCodes,
      productId: body.to_product_id,
      originalStripeUnits: unitAmountStripeUnits * quantity,
      allowStacking: promoPolicy.allowStackingPromoCodes,
      isOneTime: false,
    });
    const appliedPromos = promoValidation.applied.map((entry) => entry.promo);
    const customerType = typedToUppercase(params.customer_type);

    const succeedSwitchRedemptions = async (redemptionIds: string[], extra?: {
      stripeSubscriptionId?: string,
      subscriptionId?: string,
    }) => {
      if (redemptionIds.length === 0) return;
      await succeedPendingRedemptions({
        prisma,
        tenancyId: auth.tenancy.id,
        redemptionIds,
        stripeSubscriptionId: extra?.stripeSubscriptionId,
        subscriptionId: extra?.subscriptionId,
      });
    };

    if (testMode && (existingSub == null || existingSub.stripeSubscriptionId == null)) {
      await grantProductAndSucceedPromo({
        prisma,
        tenancyId: auth.tenancy.id,
        customerId: params.customer_id,
        customerType,
        promos: appliedPromos,
        purchaseKind: "subscription",
        grant: async () => {
          const granted = await grantProductToCustomer({
            prisma,
            tenancy: auth.tenancy,
            customerType: params.customer_type,
            customerId: params.customer_id,
            product: toProduct,
            productId: body.to_product_id,
            priceId: selectedPriceId,
            quantity,
            creationSource: "TEST_MODE",
          });
          return granted.type === "subscription" ? { subscriptionId: granted.subscriptionId } : {};
        },
      });
      return { statusCode: 200, bodyType: "json", body: { success: true } };
    }

    // For now, we don't allow switching out of a Stripe-backed subscription while the project is in test mode.
    if (testMode && existingSub != null && existingSub.stripeSubscriptionId != null) {
      throw new StatusError(
        400,
        "Cannot switch a live subscription while the project is in test mode. " +
        "Cancel the live subscription first, or disable test mode before switching.",
      );
    }

    const stripe = await getStripeForAccount({ tenancy: auth.tenancy });
    const stripeCustomer = await getStripeCustomerForCustomerOrNull({
      stripe,
      prisma,
      tenancyId: auth.tenancy.id,
      customerType: params.customer_type,
      customerId: params.customer_id,
    });
    if (!stripeCustomer) {
      throw new KnownErrors.DefaultPaymentMethodRequired(params.customer_type, params.customer_id);
    }
    const hydratedStripeCustomer = await stripe.customers.retrieve(stripeCustomer.id);
    if (hydratedStripeCustomer.deleted) {
      throw new StatusError(400, "Stripe customer was deleted unexpectedly.");
    }
    const defaultPaymentMethod = await getDefaultCardPaymentMethodSummary({
      stripe,
      stripeCustomer: hydratedStripeCustomer,
    });
    if (!defaultPaymentMethod) {
      throw new KnownErrors.DefaultPaymentMethodRequired(params.customer_type, params.customer_id);
    }
    const resolvedPaymentMethodId = defaultPaymentMethod.id;

    // Creates a new Stripe Product object each time — wasteful since these accumulate
    // in the Stripe account and are never reused. Should upsert by productId instead.
    const stripeProduct = await stripe.products.create({ name: toProduct.displayName || "Subscription" });

    const productVersionId = await upsertProductVersion({
      prisma,
      tenancyId: auth.tenancy.id,
      productId: body.to_product_id,
      productJson: toProduct,
    });

    if (existingSub?.stripeSubscriptionId) {
      const existingStripeSubscriptionId = existingSub.stripeSubscriptionId;
      const existingStripeSub = await stripe.subscriptions.retrieve(existingStripeSubscriptionId, { expand: ["discounts"] });
      if (existingStripeSub.items.data.length === 0) {
        throw new HexclaveAssertionError("Stripe subscription has no items", { subscriptionId: existingSub.id });
      }
      const existingItem = existingStripeSub.items.data[0];
      const previousSnapshot = inPlaceSubscriptionSnapshot(existingStripeSub);
      // Intentional: switching an existing (possibly pre-platform-fee)
      // subscription to a new plan attaches the 0.9% application fee from
      // this point forward. Subscriptions that never switch plans stay
      // fee-less until a separate migration applies fees retroactively.
      const applicationFeePercent = getApplicationFeePercentOrUndefined(auth.tenancy.project.id);
      // A forever coupon from the previous plan must not follow the customer
      // onto a product the merchant did not include on this promo. Replace
      // only Hexclave discounts in the same update as the plan change so a
      // declined card leaves the old plan and its Hexclave discounts intact.
      // Merchant coupons stay as `{ discount: id }`; never send discounts: []
      // unless that walk left no remaining discounts.
      const liveHexclave = await listLiveHexclaveRedemptions({
        prisma,
        tenancyId: auth.tenancy.id,
        stripeSubscriptionId: existingStripeSubscriptionId,
      });
      const promoAttach = subscriptionDiscountParams({
        promos: appliedPromos,
        hasFreeTrial: false,
      });
      const discountFields = inPlaceSubscriptionDiscountFields({
        promoAttach,
        subscriptionDiscounts: existingStripeSub.discounts,
        hexclaveCouponIds: new Set(liveHexclave.map((row) => row.stripeCouponId)),
      });
      const { subscription: updatedSubscription, redemptionIds } = await updateSwitchSubscription({
        prisma,
        tenancyId: auth.tenancy.id,
        customerId: params.customer_id,
        customerType,
        promos: appliedPromos,
        purchaseKind: "subscription",
        stripe,
        subscriptionId: existingStripeSubscriptionId,
        previousSnapshot,
        params: {
          payment_behavior: "error_if_incomplete",
          payment_settings: { save_default_payment_method: "on_subscription" },
          default_payment_method: resolvedPaymentMethodId,
          items: [{
            id: existingItem.id,
            price_data: {
              currency: "usd",
              unit_amount: unitAmountStripeUnits,
              product: stripeProduct.id,
              recurring: {
                interval_count: selectedInterval[0],
                interval: selectedInterval[1],
              },
            },
            quantity,
          }],
          metadata: {
            productId: body.to_product_id,
            productVersionId,
            priceId: selectedPriceId,
            tenancyId: auth.tenancy.id,
            ...promoAttach.metadata,
          },
          ...discountFields,
          ...(applicationFeePercent !== undefined ? { application_fee_percent: applicationFeePercent } : {}),
        },
      });
      await markHexclaveDiscountsRemoved({
        prisma,
        tenancyId: auth.tenancy.id,
        redemptionIds: liveHexclave.map((row) => row.id),
      });
      const sanitizedUpdateDates = sanitizeStripePeriodDates(
        existingItem.current_period_start,
        existingItem.current_period_end,
        { subscriptionId: existingStripeSubscriptionId, tenancyId: auth.tenancy.id }
      );

      await prisma.subscription.update({
        where: {
          tenancyId_id: {
            tenancyId: auth.tenancy.id,
            id: existingSub.id,
          },
        },
        data: {
          productId: body.to_product_id,
          product: toProduct,
          priceId: selectedPriceId,
          quantity,
          status: updatedSubscription.status,
          currentPeriodStart: sanitizedUpdateDates.start,
          currentPeriodEnd: sanitizedUpdateDates.end,
          cancelAtPeriodEnd: updatedSubscription.cancel_at_period_end,
        },
      });
      // dual write - prisma and bulldozer
      const updatedSub = await prisma.subscription.findUniqueOrThrow({
        where: { tenancyId_id: { tenancyId: auth.tenancy.id, id: existingSub.id } },
      });
      await bulldozerWriteSubscription(updatedSub);
      await succeedSwitchRedemptions(redemptionIds, {
        stripeSubscriptionId: existingStripeSubscriptionId,
        subscriptionId: existingSub.id,
      });
    } else {
      // No existing Stripe subscription — create a new one. This happens when
      // switching from a $0 product (which has no stripeSubscriptionId) to a paid one.
      // Apply free trial only on create (not on in-place updates above): re-trialing
      // an existing paid customer on switch is usually wrong. Price-level freeTrial
      // preferred; product-level is a transitional fallback.
      const applicationFeePercent = getApplicationFeePercentOrUndefined(auth.tenancy.project.id);
      const effectiveFreeTrial = getEffectiveFreeTrial(toProduct, selectedPrice);
      assertFreeTrialAllowedForPurchase(selectedPrice, effectiveFreeTrial);
      const trialPeriodDays = effectiveFreeTrial != null ? getStripeTrialPeriodDays(effectiveFreeTrial) : undefined;
      const promoAttach = subscriptionDiscountParams({
        promos: appliedPromos,
        hasFreeTrial: trialPeriodDays !== undefined,
      });
      const { subscription: createdSubscription, redemptionIds } = await createSwitchSubscription({
        prisma,
        tenancyId: auth.tenancy.id,
        customerId: params.customer_id,
        customerType,
        promos: appliedPromos,
        purchaseKind: "subscription",
        stripe,
        params: {
          customer: stripeCustomer.id,
          payment_behavior: "error_if_incomplete",
          payment_settings: { save_default_payment_method: "on_subscription" },
          ...resolvedPaymentMethodId ? { default_payment_method: resolvedPaymentMethodId } : {},
          items: [{
            price_data: {
              currency: "usd",
              unit_amount: unitAmountStripeUnits,
              product: stripeProduct.id,
              recurring: {
                interval_count: selectedInterval[0],
                interval: selectedInterval[1],
              },
            },
            quantity,
          }],
          metadata: {
            productId: body.to_product_id,
            productVersionId,
            priceId: selectedPriceId,
            tenancyId: auth.tenancy.id,
            ...promoAttach.metadata,
          },
          ...(promoAttach.discounts != null ? { discounts: promoAttach.discounts } : {}),
          ...(trialPeriodDays !== undefined ? { trial_period_days: trialPeriodDays } : {}),
          ...(applicationFeePercent !== undefined ? { application_fee_percent: applicationFeePercent } : {}),
        },
      });
      if (createdSubscription.items.data.length === 0) {
        throw new HexclaveAssertionError("Stripe subscription has no items", { stripeSubscriptionId: createdSubscription.id });
      }
      const createdItem = createdSubscription.items.data[0];
      const sanitizedCreateDates = sanitizeStripePeriodDates(
        createdItem.current_period_start,
        createdItem.current_period_end,
        { subscriptionId: createdSubscription.id, tenancyId: auth.tenancy.id }
      );

      await prisma.subscription.create({
        data: {
          tenancyId: auth.tenancy.id,
          customerId: params.customer_id,
          customerType: typedToUppercase(params.customer_type),
          productId: body.to_product_id,
          product: toProduct,
          priceId: selectedPriceId,
          quantity,
          stripeSubscriptionId: createdSubscription.id,
          status: createdSubscription.status,
          currentPeriodStart: sanitizedCreateDates.start,
          currentPeriodEnd: sanitizedCreateDates.end,
          cancelAtPeriodEnd: createdSubscription.cancel_at_period_end,
          creationSource: "PURCHASE_PAGE",
        },
      });
      // dual write - prisma and bulldozer
      const createdSub = await prisma.subscription.findUniqueOrThrow({
        where: { tenancyId_stripeSubscriptionId: { tenancyId: auth.tenancy.id, stripeSubscriptionId: createdSubscription.id } },
      });
      await bulldozerWriteSubscription(createdSub);
      await succeedSwitchRedemptions(redemptionIds, {
        stripeSubscriptionId: createdSubscription.id,
        subscriptionId: createdSub.id,
      });
    }

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        success: true,
      },
    };
  },
});
