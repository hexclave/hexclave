import { VerificationCodeType } from "@/generated/prisma/client";
import { markProjectUserForExternalDbSync, withExternalDbSyncUpdate } from "@/lib/external-db-sync";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createVerificationCodeHandler } from "@/route-handlers/verification-code-handler";
import { phoneNumberSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

/**
 * Verifies a phone contact channel with a code sent via SMS. This is the phone counterpart of the email verification
 * in `contact-channels/verify`; instead of a link, the user enters a 6-character code, which is concatenated with the
 * nonce returned by `send-sms-verification-code` (same format as the OTP sign-in codes).
 */
export const phoneNumberVerificationCodeHandler = createVerificationCodeHandler({
  metadata: {
    post: {
      summary: "Verify a phone number",
      description: "Verify a phone number contact channel of a user with the code that was sent to it via SMS",
      tags: ["Contact Channels"],
    },
    check: {
      summary: "Check phone number verification code",
      description: "Check if a phone number verification code is valid without using it",
      tags: ["Contact Channels"],
    },
    codeDescription: `A 45-character verification code, formed by concatenating the 6-character code sent via SMS with the nonce received when the code was sent`,
  },
  type: VerificationCodeType.PHONE_NUMBER_VERIFICATION,
  data: yupObject({
    user_id: yupString().defined(),
    // Duplicated from the method, as `data` has a GIN index that we use for rate-limiting (see `createRateLimitedSmsCode`)
    phone_number: phoneNumberSchema.defined(),
  }).defined(),
  method: yupObject({
    phone_number: phoneNumberSchema.defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["success"]).defined(),
  }),
  async handler(tenancy, { phone_number: phoneNumber }, data) {
    const uniqueKeys = {
      tenancyId_projectUserId_type_value: {
        tenancyId: tenancy.id,
        projectUserId: data.user_id,
        type: "PHONE",
        value: phoneNumber,
      },
    } as const;

    const prisma = await getPrismaClientForTenancy(tenancy);

    const contactChannel = await prisma.contactChannel.findUnique({
      where: uniqueKeys,
    });

    // This happens if the code is sent but the contact channel is deleted before the user enters it.
    if (!contactChannel) {
      throw new StatusError(400, "Contact channel not found. Was your contact channel deleted?");
    }

    await prisma.contactChannel.update({
      where: uniqueKeys,
      data: withExternalDbSyncUpdate({
        isVerified: true,
      }),
    });

    await markProjectUserForExternalDbSync(prisma, {
      tenancyId: tenancy.id,
      projectUserId: data.user_id,
    });

    return {
      statusCode: 200,
      bodyType: "success",
    };
  },
});
