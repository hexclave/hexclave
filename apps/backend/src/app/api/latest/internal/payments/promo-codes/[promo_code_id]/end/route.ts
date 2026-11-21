import { catalogProductNames, serializePromoCode, toPromoCodeRow } from "@/lib/payments/promo-code-api";
import { promoCodeIdsMetadataWithout, remainingDiscountsAfterRemovingCoupon } from "@/lib/payments/promo-code-checkout";
import { canEndPromoCode } from "@/lib/payments/promo-codes";
import { getStripeForAccount } from "@/lib/stripe";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, adminAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { serializedPromoCodeSchema } from "../../schema";

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      project: adaptSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      promo_code_id: yupString().uuid().defined(),
    }),
    body: yupObject({
      existing_subscription_discounts: yupString().oneOf(["keep", "end_after_period"]).optional(),
    }),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: serializedPromoCodeSchema,
  }),
  handler: async ({ auth, params, body }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const promo = await prisma.promoCode.findUnique({
      where: {
        tenancyId_id: {
          tenancyId: auth.tenancy.id,
          id: params.promo_code_id,
        },
      },
    });
    if (promo == null) {
      throw new KnownErrors.PromoCodeNotFound(params.promo_code_id);
    }
    const row = toPromoCodeRow(promo);
    if (!canEndPromoCode(row)) {
      throw new KnownErrors.PromoCodeAlreadyEnded();
    }

    const liveRedemptions = await prisma.promoCodeRedemption.findMany({
      where: {
        tenancyId: auth.tenancy.id,
        promoCodeId: promo.id,
        status: "succeeded",
        subscriptionDiscountRemovedAt: null,
        stripeSubscriptionId: { not: null },
        promoCode: {
          subscriptionBehavior: { in: ["forever", "fixed_duration"] },
        },
      },
    });

    if (liveRedemptions.length > 0 && body.existing_subscription_discounts == null) {
      throw new KnownErrors.PromoCodeInvalid("Choose what should happen to existing subscription discounts.");
    }

    if (body.existing_subscription_discounts === "end_after_period") {
      const stripe = await getStripeForAccount({ tenancy: auth.tenancy });
      const removedAt = new Date();
      for (const redemption of liveRedemptions) {
        const subscriptionId = redemption.stripeSubscriptionId ?? throwErr("Live subscription redemption is missing stripeSubscriptionId");
        const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["discounts"] });
        // Canceled / incomplete_expired subs already dropped the discount.
        // Updating them 400s and would abort End promo for every other customer.
        if (subscription.status !== "canceled" && subscription.status !== "incomplete_expired") {
          // Stripe replaces the whole discounts array. Keep every other
          // discount by id (merchant coupons and stacked Hexclave coupons)
          // so ending this promo does not restart or wipe them. `remaining`
          // is `[]` only when this coupon was the last one on the sub.
          const remaining = remainingDiscountsAfterRemovingCoupon({
            subscriptionDiscounts: subscription.discounts,
            couponIdToRemove: promo.stripeCouponId,
          });
          await stripe.subscriptions.update(subscriptionId, {
            discounts: remaining,
            proration_behavior: "none",
            metadata: {
              ...subscription.metadata,
              promoCodeIds: promoCodeIdsMetadataWithout(
                Object.hasOwn(subscription.metadata, "promoCodeIds") ? subscription.metadata.promoCodeIds : undefined,
                promo.id,
              ),
            },
          });
        }
        await prisma.promoCodeRedemption.update({
          where: {
            tenancyId_id: {
              tenancyId: auth.tenancy.id,
              id: redemption.id,
            },
          },
          data: { subscriptionDiscountRemovedAt: removedAt },
        });
      }
    }

    const updated = await prisma.promoCode.update({
      where: {
        tenancyId_id: {
          tenancyId: auth.tenancy.id,
          id: promo.id,
        },
      },
      data: { endedAt: new Date() },
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: serializePromoCode({
        promo: toPromoCodeRow(updated),
        productNames: catalogProductNames(auth.tenancy.config.payments.products),
        hasActiveSubscriptionRedemptions: body.existing_subscription_discounts !== "end_after_period" && liveRedemptions.length > 0,
      }),
    };
  },
});
