import { promoCodeNamesRequestSchema } from "@/app/api/latest/internal/payments/promo-codes/schema";
import { CustomerType, SubscriptionStatus } from "@/generated/prisma/client";
import { assertFreeTrialAllowedForPurchase, getEffectiveFreeTrial, getStripeTrialPeriodDays, grantProductToCustomer, validatePurchaseSession } from "@/lib/payments";
import { assertPromoCodesCapability, createCheckoutPaymentIntent, createCheckoutSubscription, grantProductAndSucceedPromo, inPlaceSubscriptionDiscountFields, inPlaceSubscriptionSnapshot, listLiveHexclaveRedemptions, markHexclaveDiscountsRemoved, parsePromoCodeNames, promoCodeProjectPolicy, succeedPendingRedemptions, subscriptionDiscountParams, updateCheckoutSubscription, validateAppliedPromoCodes } from "@/lib/payments/promo-code-checkout";
import { bulldozerWriteSubscription } from "@/lib/payments/bulldozer-dual-write";
import { computeApplicationFeeAmount, getApplicationFeePercentOrUndefined } from "@/lib/payments/platform-fees";
import { upsertProductVersion } from "@/lib/product-versions";
import { getStripeForAccount } from "@/lib/stripe";
import { getTenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { getStripeOneTimeMinAmount } from "@hexclave/shared/dist/payments/stripe-limits";
import { moneyAmountSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { SUPPORTED_CURRENCIES, type MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import { moneyAmountToStripeUnits } from "@hexclave/shared/dist/utils/currencies";
import { HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { typedToUppercase } from "@hexclave/shared/dist/utils/strings";
import { purchaseUrlVerificationCodeHandler } from "../verification-code-handler";

const USD_CURRENCY = SUPPORTED_CURRENCIES.find((currency) => currency.code === "USD")
  ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");

export const POST = createSmartRouteHandler({
  metadata: {
    hidden: false,
    summary: "Create Purchase Session",
    description: "Creates a purchase session for completing a purchase.",
    tags: ["Payments"],
  },
  request: yupObject({
    body: yupObject({
      full_code: yupString().defined().meta({
        openapiField: {
          description: "The verification code, given as a query parameter in the purchase URL",
          exampleValue: "proj_abc123_def456ghi789"
        }
      }),
      price_id: yupString().defined().meta({
        openapiField: {
          description: "The Hexclave price ID to purchase",
          exampleValue: "price_1234567890abcdef"
        }
      }),
      quantity: yupNumber().integer().min(1).default(1).meta({
        openapiField: {
          description: "The quantity to purchase",
          exampleValue: 1
        }
      }),
      promo_codes: promoCodeNamesRequestSchema.default([]),
    }),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      client_secret: yupString().optional().meta({
        openapiField: {
          description: "Stripe client secret used by the browser to confirm payment or setup via Stripe Elements. Omitted when no confirmation step is required from the customer.",
          exampleValue: "1234567890abcdef_secret_xyz123",
        },
      }),
      stripe_intent_type: yupString().oneOf(["payment", "setup"]).optional().meta({
        openapiField: {
          description: "Whether client_secret is a PaymentIntent (immediate charge) or SetupIntent (e.g. free trial card collection). Omitted when client_secret is omitted.",
          exampleValue: "payment",
        },
      }),
    }),
  }),
  async handler({ body }) {
    const { full_code, price_id, quantity } = body;
    const promoCodes = parsePromoCodeNames(body.promo_codes);
    const { data, id: codeId } = await purchaseUrlVerificationCodeHandler.validateCode(full_code);
    if (promoCodes.length > 0 && data.allowPromoCodes !== true) {
      throw new KnownErrors.PromoCodeInvalid("Promo codes are not enabled for this checkout.");
    }
    const tenancy = await getTenancy(data.tenancyId);
    if (!tenancy) {
      throw new HexclaveAssertionError("No tenancy found from purchase code data tenancy id. This should never happen.");
    }
    if (tenancy.config.payments.blockNewPurchases) {
      throw new KnownErrors.NewPurchasesBlocked();
    }
    const promoPolicy = promoCodeProjectPolicy(tenancy.config.payments);
    assertPromoCodesCapability(promoPolicy, {
      wantsPromoCodes: promoCodes.length > 0,
      wantsStacking: promoCodes.length > 1,
    });
    const stripeAccountId = data.stripeAccountId;
    const stripeCustomerId = data.stripeCustomerId;
    if (stripeAccountId == null || stripeCustomerId == null) {
      throw new StatusError(400, "This purchase link is no longer valid. Please request a new one and try again.");
    }
    const stripe = await getStripeForAccount({ accountId: stripeAccountId });
    const prisma = await getPrismaClientForTenancy(tenancy);
    const { selectedPrice, conflictingSubscriptions } = await validatePurchaseSession({
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
      throw new HexclaveAssertionError("Price not resolved for purchase session");
    }

    // Validate up-front so a malformed config returns 400 instead of letting
    // moneyAmountToStripeUnits throw a yup ValidationError that becomes a 500.
    // Also never use `Number(USD) * 100` — e.g. 79.99 → 7998.999999999999 and
    // Stripe rejects with parameter_invalid_integer.
    if (selectedPrice.USD == null || !moneyAmountSchema(USD_CURRENCY).defined().isValidSync(selectedPrice.USD)) {
      throw new StatusError(400, `Price amount must be a finite, non-negative number (got ${JSON.stringify(selectedPrice.USD)})`);
    }
    const unitAmountStripeUnits = moneyAmountToStripeUnits(selectedPrice.USD as MoneyAmount, USD_CURRENCY);
    // TODO(default-plans): when default/free plans become first-class, route
    // these directly via an ensureDefaultPlan-style grant instead of forcing
    // callers to configure an interval just to make Stripe happy.
    const isFreePrice = unitAmountStripeUnits === 0;
    if (isFreePrice && !selectedPrice.interval) {
      throw new StatusError(400, "Free products must have a billing interval");
    }
    // Mirror Stripe's per-currency one-time minimum (shared with the dashboard
    // UI via stack-shared/payments/stripe-limits so the two can't drift apart)
    // and return a clean 400 instead of a raw Stripe error at
    // PaymentIntent.create time. Recurring sub items don't have this minimum
    // (handled above for the $0 case).
    const stripeOneTimeMin = getStripeOneTimeMinAmount('USD');
    const minOneTimeStripeUnits = moneyAmountToStripeUnits(
      stripeOneTimeMin.toFixed(USD_CURRENCY.decimals) as MoneyAmount,
      USD_CURRENCY,
    );
    const originalStripeUnits = unitAmountStripeUnits * Math.max(1, quantity);
    // Stripe's one-time floor is on the charge, not the catalog unit. 2×$0.30
    // is a valid $0.60 PaymentIntent; rejecting on the $0.30 unit was wrong.
    if (!selectedPrice.interval && originalStripeUnits > 0 && originalStripeUnits < minOneTimeStripeUnits) {
      throw new StatusError(400, `One-time purchases must total at least $${stripeOneTimeMin.toFixed(2)}`);
    }
    const promoValidation = await validateAppliedPromoCodes({
      prisma,
      tenancyId: tenancy.id,
      codeNames: promoCodes,
      productId: data.productId ?? null,
      originalStripeUnits,
      allowStacking: promoPolicy.allowStackingPromoCodes && data.allowStackingPromoCodes === true,
      isOneTime: selectedPrice.interval == null,
    });
    const appliedPromos = promoValidation.applied.map((entry) => entry.promo);
    const customerType = typedToUppercase(data.product.customerType) as CustomerType;

    const productVersionId = await upsertProductVersion({
      prisma,
      tenancyId: tenancy.id,
      productId: data.productId ?? null,
      productJson: data.product,
    });

    // Price-level freeTrial preferred; product-level is transitional fallback
    // while product-level freeTrial is being deprecated.
    const effectiveFreeTrial = getEffectiveFreeTrial(data.product, selectedPrice);
    assertFreeTrialAllowedForPurchase(selectedPrice, effectiveFreeTrial);
    const trialPeriodDays = effectiveFreeTrial != null ? getStripeTrialPeriodDays(effectiveFreeTrial) : undefined;
    const shouldExpectSetupIntent = effectiveFreeTrial != null;

    if (conflictingSubscriptions.length > 0) {
      const conflicting = conflictingSubscriptions[0];
      if (conflicting.stripeSubscriptionId) {
        const conflictingStripeSubscriptionId = conflicting.stripeSubscriptionId;
        const existingStripeSub = await stripe.subscriptions.retrieve(conflictingStripeSubscriptionId, { expand: ["discounts"] });
        const existingItem = existingStripeSub.items.data[0];
        const previousSnapshot = inPlaceSubscriptionSnapshot(existingStripeSub);
        const product = await stripe.products.create({ name: data.product.displayName ?? "Subscription" });
        if (selectedPrice.interval) {
          const applicationFeePercent = getApplicationFeePercentOrUndefined(tenancy.project.id);
          // TODO(default-plans): $0 subs currently piggyback on the Stripe
          // subscription lifecycle. Once default plans land, free subs should be
          // granted directly (Prisma insert + bulldozer write, mirroring
          // ensureFreePlanForBillingTeam) and skip Stripe entirely.
          //
          // Do not attach trial_period_days on in-place subscription updates
          // (plan switch / conflict replace): re-trialing an existing customer
          // is usually wrong. Trials only apply when creating a new Stripe sub.
          const liveHexclave = await listLiveHexclaveRedemptions({
            prisma,
            tenancyId: tenancy.id,
            stripeSubscriptionId: conflictingStripeSubscriptionId,
          });
          const promoAttach = subscriptionDiscountParams({
            promos: appliedPromos,
            hasFreeTrial: false,
          });
          // Keep merchant coupons as `{ discount: id }`. `discounts: []` is
          // only emitted when the expanded walk left nothing remaining.
          const discountFields = inPlaceSubscriptionDiscountFields({
            promoAttach,
            subscriptionDiscounts: existingStripeSub.discounts,
            hexclaveCouponIds: new Set(liveHexclave.map((row) => row.stripeCouponId)),
          });
          const cardCollection = isFreePrice
            ? { type: "none" as const }
            : promoValidation.netStripeUnits === 0
              ? { type: "setup_intent" as const, customerId: stripeCustomerId }
              : { type: "client_secret" as const, shouldExpectSetupIntent: false };
          const updated = await updateCheckoutSubscription({
            prisma,
            tenancyId: tenancy.id,
            customerId: data.customerId,
            customerType,
            promos: appliedPromos,
            purchaseKind: "subscription",
            stripe,
            subscriptionId: conflictingStripeSubscriptionId,
            previousSnapshot,
            cardCollection,
            params: {
              payment_behavior: 'default_incomplete',
              payment_settings: { save_default_payment_method: 'on_subscription' },
              // Expand nested objects so we get client_secret fields (otherwise
              // Stripe returns id strings for pending_setup_intent / latest_invoice).
              expand: ['latest_invoice.confirmation_secret', 'pending_setup_intent'],
              items: [{
                id: existingItem.id,
                price_data: {
                  currency: "usd",
                  unit_amount: unitAmountStripeUnits,
                  product: product.id,
                  recurring: {
                    interval_count: selectedPrice.interval![0],
                    interval: selectedPrice.interval![1],
                  },
                },
                quantity,
              }],
              metadata: {
                productId: data.productId ?? null,
                productVersionId,
                priceId: price_id,
                tenancyId: tenancy.id,
                ...promoAttach.metadata,
              },
              ...discountFields,
              ...(applicationFeePercent !== undefined ? { application_fee_percent: applicationFeePercent } : {}),
            },
          });
          const redemptionIds = updated.redemptionIds;
          await markHexclaveDiscountsRemoved({
            prisma,
            tenancyId: tenancy.id,
            redemptionIds: liveHexclave.map((row) => row.id),
          });
          if (isFreePrice) {
            // Stripe activates $0 subs synchronously (status=active, invoice=paid)
            // and produces no PaymentIntent / confirmation_secret, so we have
            // nothing to hand to Stripe Elements. The DB row is written when
            // the `invoice.paid` webhook lands, exactly like paid purchases
            // after card confirmation.
            if (redemptionIds.length > 0) {
              await succeedPendingRedemptions({
                prisma,
                tenancyId: tenancy.id,
                redemptionIds,
                stripeSubscriptionId: updated.subscription.id,
              });
            }
            await purchaseUrlVerificationCodeHandler.revokeCode({ tenancy, id: codeId });
            return { statusCode: 200, bodyType: "json", body: {} };
          }
          await purchaseUrlVerificationCodeHandler.revokeCode({ tenancy, id: codeId });
          if (updated.setupClientSecret != null) {
            return {
              statusCode: 200,
              bodyType: "json",
              body: {
                client_secret: updated.setupClientSecret,
                stripe_intent_type: "setup" as const,
              },
            };
          }
          if (updated.paymentClientSecret == null) {
            throw new HexclaveAssertionError("No PaymentIntent client secret returned from Stripe for subscription");
          }
          return {
            statusCode: 200,
            bodyType: "json",
            body: {
              client_secret: updated.paymentClientSecret,
              stripe_intent_type: "payment" as const,
            },
          };
        } else {
          await stripe.subscriptions.cancel(conflicting.stripeSubscriptionId);
        }
      } else if (conflicting.id) {
        const updatedConflicting = await prisma.subscription.update({
          where: {
            tenancyId_id: {
              tenancyId: tenancy.id,
              id: conflicting.id,
            },
          },
          data: {
            status: SubscriptionStatus.canceled,
            cancelAtPeriodEnd: true,
            canceledAt: new Date(),
            endedAt: new Date(),
          },
        });
        await bulldozerWriteSubscription(updatedConflicting);
      }
    }
    // One-time payment path after conflicts handled
    if (!selectedPrice.interval) {
      const amountCents = promoValidation.netStripeUnits;
      if (amountCents === 0) {
        await grantProductAndSucceedPromo({
          prisma,
          tenancyId: tenancy.id,
          customerId: data.customerId,
          customerType,
          promos: appliedPromos,
          purchaseKind: "one_time",
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
              creationSource: "PURCHASE_PAGE",
            });
            if (granted.type !== "one_time" || granted.purchaseId == null) {
              throw new HexclaveAssertionError("Expected a one-time purchase id after a $0 promo grant");
            }
            return { oneTimePurchaseId: granted.purchaseId };
          },
        });
        await purchaseUrlVerificationCodeHandler.revokeCode({ tenancy, id: codeId });
        return { statusCode: 200, bodyType: "json", body: {} };
      }
      const applicationFeeAmount = computeApplicationFeeAmount({
        amountStripeUnits: amountCents,
        projectId: tenancy.project.id,
      });
      const { paymentIntent } = await createCheckoutPaymentIntent({
        prisma,
        tenancyId: tenancy.id,
        customerId: data.customerId,
        customerType,
        promos: appliedPromos,
        purchaseKind: "one_time",
        stripe,
        params: {
          amount: amountCents,
          currency: "usd",
          customer: stripeCustomerId,
          automatic_payment_methods: { enabled: true },
          metadata: {
            productId: data.productId || "",
            productVersionId,
            customerId: data.customerId,
            customerType: data.product.customerType,
            purchaseQuantity: String(quantity),
            purchaseKind: "ONE_TIME",
            tenancyId: data.tenancyId,
            priceId: price_id,
            promoCodeIds: appliedPromos.map((promo) => promo.id).join(","),
          },
          ...(applicationFeeAmount > 0 ? { application_fee_amount: applicationFeeAmount } : {}),
        },
      });
      const clientSecret = paymentIntent.client_secret;
      if (typeof clientSecret !== "string") {
        throwErr(500, "No client secret returned from Stripe for payment intent");
      }
      await purchaseUrlVerificationCodeHandler.revokeCode({ tenancy, id: codeId });
      return {
        statusCode: 200,
        bodyType: "json",
        body: {
          client_secret: clientSecret,
          stripe_intent_type: "payment" as const,
        },
      };
    }

    const product = await stripe.products.create({
      name: data.product.displayName ?? "Subscription",
    });
    const applicationFeePercent = getApplicationFeePercentOrUndefined(tenancy.project.id);
    // TODO(default-plans): $0 subs currently piggyback on the Stripe
    // subscription lifecycle. Once default plans land, free subs should be
    // granted directly (Prisma insert + bulldozer write, mirroring
    // ensureFreePlanForBillingTeam) and skip Stripe entirely.
    //
    // Note on $0 subs: Stripe auto-activates them on create (status="active",
    // invoice="paid") regardless of `default_incomplete` so we keep the same
    // call shape and only diverge in how we read the response below.
    //
    // Free trials: pass trial_period_days so the first invoice is $0 and
    // Stripe attaches pending_setup_intent for card collection instead of a
    // PaymentIntent. Charge happens automatically when the trial ends.
    const promoAttach = subscriptionDiscountParams({
      promos: appliedPromos,
      hasFreeTrial: trialPeriodDays !== undefined,
    });
    const needsPromoZeroCardSetup = !isFreePrice && !shouldExpectSetupIntent && promoValidation.netStripeUnits === 0;
    const cardCollection = isFreePrice
      ? { type: "none" as const }
      : needsPromoZeroCardSetup
        ? { type: "setup_intent" as const, customerId: stripeCustomerId }
        : { type: "client_secret" as const, shouldExpectSetupIntent };
    const created = await createCheckoutSubscription({
      prisma,
      tenancyId: tenancy.id,
      customerId: data.customerId,
      customerType,
      promos: appliedPromos,
      purchaseKind: "subscription",
      stripe,
      cardCollection,
      params: {
        customer: stripeCustomerId,
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        // Expand nested objects so we get client_secret fields (otherwise
        // Stripe returns id strings for pending_setup_intent / latest_invoice).
        expand: ['latest_invoice.confirmation_secret', 'pending_setup_intent'],
        items: [{
          price_data: {
            currency: "usd",
            unit_amount: unitAmountStripeUnits,
            product: product.id,
            recurring: {
              interval_count: selectedPrice.interval![0],
              interval: selectedPrice.interval![1],
            },
          },
          quantity,
        }],
        metadata: {
          productId: data.productId ?? null,
          productVersionId,
          priceId: price_id,
          tenancyId: tenancy.id,
          ...promoAttach.metadata,
        },
        ...(promoAttach.discounts != null ? { discounts: promoAttach.discounts } : {}),
        ...(trialPeriodDays !== undefined ? { trial_period_days: trialPeriodDays } : {}),
        ...(applicationFeePercent !== undefined ? { application_fee_percent: applicationFeePercent } : {}),
      },
    });
    const redemptionIds = created.redemptionIds;
    if (isFreePrice) {
      // Free+$0 freeTrial is rejected above. Stripe activates remaining $0
      // subs synchronously (status=active, invoice=paid) with no PaymentIntent
      // / confirmation_secret, so we have nothing to hand to Stripe Elements.
      // The DB row is written when the `invoice.paid` webhook lands.
      if (redemptionIds.length > 0) {
        await succeedPendingRedemptions({
          prisma,
          tenancyId: tenancy.id,
          redemptionIds,
          stripeSubscriptionId: created.subscription.id,
        });
      }
      await purchaseUrlVerificationCodeHandler.revokeCode({ tenancy, id: codeId });
      return {
        statusCode: 200,
        bodyType: "json",
        body: {},
      };
    }
    // Extract the client secret BEFORE revoking the code: if Stripe returns a
    // malformed sub (no secret), we throw 500 here and the customer can retry
    // with the same code. Revoking first would burn the code on every
    // transient Stripe anomaly.
    await purchaseUrlVerificationCodeHandler.revokeCode({ tenancy, id: codeId });
    if (created.setupClientSecret != null) {
      return {
        statusCode: 200,
        bodyType: "json",
        body: {
          client_secret: created.setupClientSecret,
          stripe_intent_type: "setup" as const,
        },
      };
    }
    if (created.paymentClientSecret == null) {
      throw new HexclaveAssertionError("No PaymentIntent client secret returned from Stripe for subscription");
    }
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        client_secret: created.paymentClientSecret,
        stripe_intent_type: "payment" as const,
      },
    };
  }
});
