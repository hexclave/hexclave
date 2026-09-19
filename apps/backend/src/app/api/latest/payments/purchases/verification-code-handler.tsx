import { createVerificationCodeHandler } from "@/route-handlers/verification-code-handler";
import { VerificationCodeType } from "@/generated/prisma/client";
import { productSchema, yupBoolean, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const purchaseUrlVerificationCodeHandler = createVerificationCodeHandler({
  type: VerificationCodeType.PURCHASE_URL,
  method: yupObject({}),
  data: yupObject({
    tenancyId: yupString().defined(),
    customerId: yupString().defined(),
    productId: yupString(),
    product: productSchema,
    stripeCustomerId: yupString().optional(),
    stripeAccountId: yupString().optional(),
    chargesEnabled: yupBoolean().optional(),
    allowPromoCodes: yupBoolean().optional(),
    allowStackingPromoCodes: yupBoolean().optional(),
  }),
  // @ts-ignore TODO: fix this
  async handler(_, __, data) {
    return null;
  },
});
