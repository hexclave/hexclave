import { catalogProductNames, serializePromoCode, toPromoCodeRow } from "@/lib/payments/promo-code-api";
import { canResumePromoCode } from "@/lib/payments/promo-codes";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, adminAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
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
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: serializedPromoCodeSchema,
  }),
  handler: async ({ auth, params }) => {
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
    if (!canResumePromoCode(row)) {
      throw new KnownErrors.PromoCodeCannotResume();
    }
    const updated = await prisma.promoCode.update({
      where: {
        tenancyId_id: {
          tenancyId: auth.tenancy.id,
          id: promo.id,
        },
      },
      data: { pausedAt: null },
    });
    return {
      statusCode: 200,
      bodyType: "json",
      body: serializePromoCode({
        promo: toPromoCodeRow(updated),
        productNames: catalogProductNames(auth.tenancy.config.payments.products),
        hasActiveSubscriptionRedemptions: false,
      }),
    };
  },
});
