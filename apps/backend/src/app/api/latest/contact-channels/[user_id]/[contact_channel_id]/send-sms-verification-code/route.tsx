import { usersCrudHandlers } from "@/app/api/latest/users/crud";
import { createRateLimitedSmsCode, isSmsProviderConfigured, sendSms } from "@/lib/sms";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, contactChannelIdSchema, userIdOrMeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { phoneNumberVerificationCodeHandler } from "../../../verify-phone-number/verification-code-handler";

// SMS codes are short-lived, unlike email verification links
const SMS_VERIFICATION_CODE_EXPIRY_MS = 1000 * 60 * 10;

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Send phone number verification code",
    description: "Send a code via SMS to the user's phone number contact channel for verifying it. The code must then be submitted to `/contact-channels/verify-phone-number`, concatenated with the returned nonce.",
    tags: ["Contact Channels"],
  },
  request: yupObject({
    params: yupObject({
      user_id: userIdOrMeSchema.defined().meta({ openapiField: { description: "The user to send the verification code to.", exampleValue: 'me' } }),
      contact_channel_id: contactChannelIdSchema.defined().meta({ openapiField: { description: "The phone number contact channel to send the verification code to.", exampleValue: 'b3d396b8-c574-4c80-97b3-50031675ceb2' } }),
    }).defined(),
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
      user: adaptSchema.optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      nonce: yupString().defined().meta({ openapiField: { description: "A token that must be stored temporarily and provided when verifying the 6-character code", exampleValue: "u3h6gn4w24pqc8ya679inrhjwh1rybth6a7thurqhnpf2" } }),
    }).defined(),
  }),
  async handler({ auth, params }) {
    let userId;
    if (auth.type === "client") {
      const currentUserId = auth.user?.id || throwErr(new KnownErrors.CannotGetOwnUserWithoutUser());
      if (currentUserId !== params.user_id) {
        throw new StatusError(StatusError.BadRequest, "Can only send verification code for your own user");
      }
      userId = currentUserId;
    } else {
      try {
        userId = (await usersCrudHandlers.adminRead({
          tenancy: auth.tenancy,
          user_id: params.user_id,
          allowedErrorTypes: [
            KnownErrors.UserNotFound,
          ],
        })).id;
      } catch (e) {
        if (KnownErrors.UserNotFound.isInstance(e)) {
          throw new KnownErrors.UserIdDoesNotExist(params.user_id);
        }
        throw e;
      }
    }

    if (!isSmsProviderConfigured(auth.tenancy)) {
      throw new StatusError(StatusError.BadRequest, "No SMS provider is configured for this project. Configure one in the project settings to send SMS.");
    }

    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    const contactChannel = await prisma.contactChannel.findUnique({
      where: {
        tenancyId_projectUserId_id: {
          tenancyId: auth.tenancy.id,
          projectUserId: userId,
          id: params.contact_channel_id,
        },
        type: "PHONE",
      },
    });

    if (!contactChannel) {
      throw new StatusError(StatusError.NotFound, "Phone number contact channel not found");
    }

    if (contactChannel.isVerified) {
      throw new StatusError(StatusError.BadRequest, "This phone number is already verified");
    }

    const codeObj = await createRateLimitedSmsCode(auth.tenancy, { phoneNumber: contactChannel.value, userId }, async (transaction) => await phoneNumberVerificationCodeHandler.createCode({
      transaction,
      tenancy: auth.tenancy,
      data: {
        user_id: userId,
        phone_number: contactChannel.value,
      },
      method: {
        phone_number: contactChannel.value,
      },
      expiresInMs: SMS_VERIFICATION_CODE_EXPIRY_MS,
      callbackUrl: undefined,
    }));

    await sendSms(auth.tenancy, {
      to: contactChannel.value,
      body: `${codeObj.code.slice(0, 6).toUpperCase()} is your ${auth.tenancy.project.display_name} verification code.`,
      purpose: "phone_number_verification",
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: { nonce: codeObj.code.slice(6) },
    };
  },
});
