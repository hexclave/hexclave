import { Prisma } from "@/generated/prisma/client";
import { catalogProductNames, serializePromoCode, toPromoCodeRow } from "@/lib/payments/promo-code-api";
import {
  derivePromoCodeStatus,
  MAX_PROMO_AMOUNT_DISCOUNT_USD,
  stripeCouponCreateParamsFromPromo,
  stripeCouponIdempotencyKey,
  validateCreatePromoCodeInput,
  mapStripeCouponCreateError,
  type PromoCodeStatus,
} from "@/lib/payments/promo-codes";
import { getStripeForAccount } from "@/lib/stripe";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, adminAuthTypeSchema, yupArray, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { promoCodeStatusSchema, serializedPromoCodeSchema } from "./schema";

const PAGE_SIZE = 25;

async function activeSubscriptionRedemptionIds(options: {
  prisma: Awaited<ReturnType<typeof getPrismaClientForTenancy>>,
  tenancyId: string,
  promoCodeIds: string[],
}): Promise<Set<string>> {
  if (options.promoCodeIds.length === 0) return new Set();
  const rows = await options.prisma.promoCodeRedemption.findMany({
    where: {
      tenancyId: options.tenancyId,
      promoCodeId: { in: options.promoCodeIds },
      status: "succeeded",
      subscriptionDiscountRemovedAt: null,
      stripeSubscriptionId: { not: null },
      promoCode: {
        subscriptionBehavior: { in: ["forever", "fixed_duration"] },
      },
    },
    select: { promoCodeId: true },
  });
  return new Set(rows.map((row) => row.promoCodeId));
}

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      project: adaptSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    query: yupObject({
      cursor: yupString().optional(),
      query: yupString().optional(),
      status: yupString().oneOf(["all", "active", "scheduled", "paused", "expired", "ended"]).optional(),
    }).optional(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      promo_codes: yupArray(serializedPromoCodeSchema).defined(),
      next_cursor: yupString().nullable().defined(),
    }),
  }),
  handler: async ({ auth, query }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const search = query.query?.trim() ?? "";
    const statusFilter = (query.status ?? "all") as "all" | PromoCodeStatus;
    const offset = query.cursor != null && query.cursor.length > 0 ? Number(query.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new KnownErrors.PromoCodeInvalid("Invalid list cursor.");
    }

    const rows = await prisma.promoCode.findMany({
      where: {
        tenancyId: auth.tenancy.id,
        ...(search.length > 0 ? { codeName: { contains: search.toUpperCase() } } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    const now = new Date();
    const matched = rows.filter((row) => {
      if (statusFilter === "all") return true;
      return derivePromoCodeStatus(toPromoCodeRow(row), now) === statusFilter;
    });
    const page = matched.slice(offset, offset + PAGE_SIZE);
    const activeIds = await activeSubscriptionRedemptionIds({
      prisma,
      tenancyId: auth.tenancy.id,
      promoCodeIds: page.map((row) => row.id),
    });
    const productNames = catalogProductNames(auth.tenancy.config.payments.products);
    const nextOffset = offset + page.length;
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        promo_codes: page.map((row) => serializePromoCode({
          promo: toPromoCodeRow(row),
          productNames,
          hasActiveSubscriptionRedemptions: activeIds.has(row.id),
          now,
        })),
        next_cursor: nextOffset < matched.length ? String(nextOffset) : null,
      },
    };
  },
});

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      project: adaptSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    body: yupObject({
      code_name: yupString().defined(),
      discount_type: yupString().oneOf(["percent", "amount"]).defined(),
      discount_amount: yupNumber().max(MAX_PROMO_AMOUNT_DISCOUNT_USD).defined(),
      applicable_product_ids: yupArray(yupString().defined()).nullable().defined(),
      max_redemptions: yupNumber().integer().nullable().defined(),
      subscription_behavior: yupString().oneOf(["first_payment", "fixed_duration", "forever"]).defined(),
      subscription_discount_duration_months: yupNumber().integer().nullable().defined(),
      availability_type: yupString().oneOf(["always", "between_dates"]).defined(),
      starts_at_millis: yupNumber().nullable().defined(),
      ends_at_millis: yupNumber().nullable().defined(),
    }),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: serializedPromoCodeSchema,
  }),
  handler: async ({ auth, body }) => {
    const input = validateCreatePromoCodeInput({
      codeName: body.code_name,
      discountType: body.discount_type,
      discountAmount: body.discount_amount,
      applicableProductIds: body.applicable_product_ids,
      maxRedemptions: body.max_redemptions,
      subscriptionBehavior: body.subscription_behavior,
      subscriptionDiscountDurationMonths: body.subscription_discount_duration_months,
      availabilityType: body.availability_type,
      startsAt: body.starts_at_millis != null ? new Date(body.starts_at_millis) : null,
      endsAt: body.ends_at_millis != null ? new Date(body.ends_at_millis) : null,
    });

    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const existing = await prisma.promoCode.findUnique({
      where: {
        tenancyId_codeName: {
          tenancyId: auth.tenancy.id,
          codeName: input.codeName,
        },
      },
    });
    if (existing != null) {
      throw new KnownErrors.PromoCodeCodeNameAlreadyExists(input.codeName);
    }

    const stripe = await getStripeForAccount({ tenancy: auth.tenancy });
    let coupon: { id: string };
    try {
      coupon = await stripe.coupons.create(
        stripeCouponCreateParamsFromPromo(auth.tenancy.id, input),
        { idempotencyKey: stripeCouponIdempotencyKey(auth.tenancy.id, input.codeName) },
      );
    } catch (error) {
      throw mapStripeCouponCreateError(error);
    }

    try {
      const created = await prisma.promoCode.create({
        data: {
          tenancyId: auth.tenancy.id,
          codeName: input.codeName,
          discountType: input.discountType,
          discountAmount: new Prisma.Decimal(input.discountAmount),
          currency: "USD",
          applicableProductIds: input.applicableProductIds === null ? Prisma.JsonNull : input.applicableProductIds,
          maxRedemptions: input.maxRedemptions,
          subscriptionBehavior: input.subscriptionBehavior,
          subscriptionDiscountDurationMonths: input.subscriptionDiscountDurationMonths,
          availabilityType: input.availabilityType,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          stripeCouponId: coupon.id,
        },
      });
      return {
        statusCode: 200,
        bodyType: "json",
        body: serializePromoCode({
          promo: toPromoCodeRow(created),
          productNames: catalogProductNames(auth.tenancy.config.payments.products),
          hasActiveSubscriptionRedemptions: false,
        }),
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new KnownErrors.PromoCodeCodeNameAlreadyExists(input.codeName);
      }
      throw error;
    }
  },
});
