import { usersCrudHandlers } from "@/app/api/latest/users/crud";
import { recordAuditEvent, shouldRecordAdminAudit } from "@/lib/audit-log";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, contactChannelIdSchema, emailVerificationCallbackUrlSchema, userIdOrMeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { contactChannelVerificationCodeHandler } from "../../../verify/verification-code-handler";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Send contact channel verification code",
    description: "Send a code to the user's contact channel for verifying the contact channel.",
    tags: ["Contact Channels"],
  },
  request: yupObject({
    params: yupObject({
      user_id: userIdOrMeSchema.defined().meta({ openapiField: { description: "The user to send the verification code to.", exampleValue: 'me' } }),
      contact_channel_id: contactChannelIdSchema.defined().meta({ openapiField: { description: "The contact channel to send the verification code to.", exampleValue: 'b3d396b8-c574-4c80-97b3-50031675ceb2' } }),
    }).defined(),
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
      user: adaptSchema.optional(),
      adminUser: adaptSchema.optional(),
    }).defined(),
    body: yupObject({
      callback_url: emailVerificationCallbackUrlSchema.defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["success"]).defined(),
  }),
  async handler({ auth, body: { callback_url: callbackUrl }, params }) {
    let user;
    if (auth.type === "client") {
      const currentUserId = auth.user?.id || throwErr(new KnownErrors.CannotGetOwnUserWithoutUser());
      if (currentUserId !== params.user_id) {
        throw new StatusError(StatusError.BadRequest, "Can only send verification code for your own user");
      }
      user = auth.user || throwErr("User not found");
    } else {
      try {
        user = await usersCrudHandlers.adminRead({
          tenancy: auth.tenancy,
          user_id: params.user_id,
          allowedErrorTypes: [
            KnownErrors.UserNotFound,
          ],
        });
      } catch (e) {
        if (KnownErrors.UserNotFound.isInstance(e)) {
          throw new KnownErrors.UserIdDoesNotExist(params.user_id);
        }
        throw e;
      }
    }

    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    const contactChannel = await prisma.contactChannel.findUnique({
      where: {
        tenancyId_projectUserId_id: {
          tenancyId: auth.tenancy.id,
          projectUserId: user.id,
          id: params.contact_channel_id,
        },
        type: "EMAIL",
      },
    });

    if (!contactChannel) {
      throw new StatusError(StatusError.NotFound, "Contact channel not found");
    }

    if (contactChannel.isVerified) {
      throw new KnownErrors.EmailAlreadyVerified();
    }

    await contactChannelVerificationCodeHandler.sendCode({
      tenancy: auth.tenancy,
      data: {
        user_id: user.id,
      },
      method: {
        email: contactChannel.value,
      },
      callbackUrl,
    }, {
      user,
      shouldSkipDeliverabilityCheck: true,
    });

    if (shouldRecordAdminAudit(auth)) {
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "contact_channel.verification.sent",
        targetUserId: user.id,
        metadata: {
          source: "contact_channels.send_verification_code",
          contact_channel_id: contactChannel.id,
          type: "email",
        },
      });
    }

    return {
      statusCode: 200,
      bodyType: "success",
    };
  },
});
