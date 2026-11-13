import { SubscriptionStatus } from "@/generated/prisma/client";
import { assertFreeTrialAllowedForPurchase, getClientSecretFromStripeSubscription, getEffectiveFreeTrial, getStripeTrialPeriodDays, validatePurchaseSession } from "@/lib/payments";
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
    const { data, id: codeId } = await purchaseUrlVerificationCodeHandler.validateCode(full_code);
    const tenancy = await getTenancy(data.tenancyId);
    if (!tenancy) {
      throw new HexclaveAssertionError("No tenancy found from purchase code data tenancy id. This should never happen.");
    }
    if (tenancy.config.payments.blockNewPurchases) {
      throw new KnownErrors.NewPurchasesBlocked();
    }
    if (data.stripeAccountId == null || data.stripeCustomerId == null) {
      throw new StatusError(400, "This purchase link is no longer valid. Please request a new one and try again.");
    }
    const stripe = await getStripeForAccount({ accountId: data.stripeAccountId });
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
    if (!selectedPrice.interval && unitAmountStripeUnits > 0 && unitAmountStripeUnits < minOneTimeStripeUnits) {
      throw new StatusError(400, `One-time prices must be at least $${stripeOneTimeMin.toFixed(2)} (Stripe minimum)`);
    }

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
        // Reject purchases whose conflicting Stripe sub is winding down
        // (canceled-at-period-end but still paid through). The branches below
        // reuse that same Stripe sub — either re-pricing it in place
        // (`default_incomplete`, paid later via Elements) or canceling it
        // immediately for a one-time replacement — and neither is safe here:
        //   - We can't clear `cancel_at_period_end` at session creation:
        //     that runs before payment and `default_incomplete` has no
        //     rollback, so a declined card would silently reactivate an
        //     explicitly-canceled sub while leaving it re-priced.
        //   - We can't leave the flag set either: Stripe would still end the
        //     sub at the period boundary AFTER the customer paid the re-price
        //     invoice — they'd pay and lose the product anyway.
        // Future fix (deliberately deferred, see PR #1773): clear
        // `cancel_at_period_end` from the `invoice.paid` webhook once the
        // re-price invoice is actually paid. Pending-cancel subs generate no
        // renewal invoices, so a paid invoice with `invoice.created` after
        // the sub's `canceledAt` can only be the re-purchase (and a
        // late-delivered `invoice.paid` for the original creation invoice
        // predates the cancel, so it can't undo it). Until then, wind-down
        // replacements only work for non-Stripe subs (test mode / free
        // plans), which are fully ended and re-created below instead of
        // reused.
        if (conflicting.status === "canceled" || conflicting.cancelAtPeriodEnd) {
          throw new StatusError(400, "The current subscription is already canceled and remains active until the end of the billing period. This product can be purchased after the current subscription ends.");
        }
        const existingStripeSub = await stripe.subscriptions.retrieve(conflicting.stripeSubscriptionId);
        const existingItem = existingStripeSub.items.data[0];
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
          const updated = await stripe.subscriptions.update(conflicting.stripeSubscriptionId, {
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
            },
            ...(applicationFeePercent !== undefined ? { application_fee_percent: applicationFeePercent } : {}),
          });
          if (isFreePrice) {
            // Stripe activates $0 subs synchronously (status=active, invoice=paid)
            // and produces no PaymentIntent / confirmation_secret, so we have
            // nothing to hand to Stripe Elements. The DB row is written when
            // the `invoice.paid` webhook lands, exactly like paid purchases
            // after card confirmation.
            await purchaseUrlVerificationCodeHandler.revokeCode({ tenancy, id: codeId });
            return { statusCode: 200, bodyType: "json", body: {} };
          }
          // Extract the client secret BEFORE revoking the code: if Stripe
          // returns a malformed sub (no secret), we throw 500 here and the
          // customer can retry with the same code. Revoking first would burn
          // the code on every transient Stripe anomaly.
          // Conflict updates never start a new trial (see comment above).
          const clientSecretUpdated = getClientSecretFromStripeSubscription(updated, false);
          const stripeIntentType: "payment" | "setup" = clientSecretUpdated.type;
          await purchaseUrlVerificationCodeHandler.revokeCode({ tenancy, id: codeId });
          return {
            statusCode: 200,
            bodyType: "json",
            body: {
              client_secret: clientSecretUpdated.clientSecret,
              stripe_intent_type: stripeIntentType,
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
      const amountCents = unitAmountStripeUnits * Math.max(1, quantity);
      const applicationFeeAmount = computeApplicationFeeAmount({
        amountStripeUnits: amountCents,
        projectId: tenancy.project.id,
      });
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: "usd",
        customer: data.stripeCustomerId,
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
        },
        ...(applicationFeeAmount > 0 ? { application_fee_amount: applicationFeeAmount } : {}),
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
    const created = await stripe.subscriptions.create({
      customer: data.stripeCustomerId,
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
      },
      ...(trialPeriodDays !== undefined ? { trial_period_days: trialPeriodDays } : {}),
      ...(applicationFeePercent !== undefined ? { application_fee_percent: applicationFeePercent } : {}),
    });
    if (isFreePrice) {
      // Free+$0 freeTrial is rejected above. Stripe activates remaining $0
      // subs synchronously (status=active, invoice=paid) with no PaymentIntent
      // / confirmation_secret, so we have nothing to hand to Stripe Elements.
      // The DB row is written when the `invoice.paid` webhook lands.
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
    const clientSecretResult = getClientSecretFromStripeSubscription(created, shouldExpectSetupIntent);
    const stripeIntentType: "payment" | "setup" = clientSecretResult.type;
    await purchaseUrlVerificationCodeHandler.revokeCode({ tenancy, id: codeId });
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        client_secret: clientSecretResult.clientSecret,
        stripe_intent_type: stripeIntentType,
      },
    };
  }
});
