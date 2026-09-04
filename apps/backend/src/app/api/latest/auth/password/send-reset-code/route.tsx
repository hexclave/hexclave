import { recordAuditEvent, shouldRecordAdminAudit } from "@/lib/audit-log";
import { getAuthContactChannelWithEmailNormalization } from "@/lib/contact-channel";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, emailSchema, urlSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { usersCrudHandlers } from "../../../users/crud";
import { resetPasswordVerificationCodeHandler } from "../reset/verification-code-handler";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Send reset password code",
    description: "Send a code to the user's email address for resetting the password.",
    tags: ["Password"],
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema,
      adminUser: adaptSchema.optional(),
    }).defined(),
    body: yupObject({
      email: emailSchema.defined(),
      callback_url: urlSchema.defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      success: yupString().oneOf(["maybe, only if user with e-mail exists"]).defined(),
    }).defined(),
  }),
  async handler({ auth, body: { email, callback_url: callbackUrl } }) {
    const { tenancy } = auth;
    if (!tenancy.config.auth.password.allowSignIn) {
      throw new KnownErrors.PasswordAuthenticationNotEnabled();
    }

    const prisma = await getPrismaClientForTenancy(tenancy);

    // TODO filter in the query
    const contactChannel = await getAuthContactChannelWithEmailNormalization(
      prisma,
      {
        tenancyId: tenancy.id,
        type: "EMAIL",
        value: email,
      },
    );

    if (!contactChannel) {
      await wait(2000 + Math.random() * 1000);
      return {
        statusCode: 200,
        bodyType: "json",
        body: {
          success: "maybe, only if user with e-mail exists",
        },
      };
    }
    const user = await usersCrudHandlers.adminRead({
      tenancy,
      user_id: contactChannel.projectUserId,
    });
    await resetPasswordVerificationCodeHandler.sendCode({
      tenancy,
      callbackUrl,
      method: {
        email,
      },
      data: {
        user_id: user.id,
      },
    }, {
      user,
    });

    // Client-initiated forgot-password is end-user self-service — only audit
    // when an admin/server actor triggers the reset from the dashboard/API.
    if (shouldRecordAdminAudit(auth)) {
      await recordAuditEvent({
        tenancy,
        auth,
        action: "user.password_reset.sent",
        targetUserId: user.id,
        metadata: {
          source: "auth.password.send_reset_code",
        },
      });
    }

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        success: "maybe, only if user with e-mail exists",
      },
    };
  },
});
