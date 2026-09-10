import { recordAuditEvent } from "@/lib/audit-log";
import { sendEmailFromDefaultTemplate } from "@/lib/emails";
import { validateRedirectUrl } from "@/lib/redirect-urls";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, emailSchema, serverOrHigherAuthTypeSchema, urlSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Send an email to invite a user to a team",
    description: "The user receiving this email can join the team by clicking on the link in the email. If the user does not have an account yet, they will be prompted to create one.",
    tags: ["Teams"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
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
      success: yupBoolean().oneOf([true]).defined(),
    }).defined(),
  }),
  async handler({ auth, body }) {
    if (!validateRedirectUrl(body.callback_url, auth.tenancy)) {
      throw new KnownErrors.RedirectUrlNotWhitelisted(body.callback_url);
    }

    await sendEmailFromDefaultTemplate({
      email: body.email,
      tenancy: auth.tenancy,
      user: null,
      templateType: "sign_in_invitation",
      extraVariables: {
        signInInvitationLink: body.callback_url,
        teamDisplayName: auth.tenancy.project.display_name,
      },
      shouldSkipDeliverabilityCheck: true,
    });

    // Invitee may not exist yet — no target user. Email is PII; omit from metadata.
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "user.sign_in_invitation.sent",
      metadata: {
        source: "send_sign_in_invitation",
      },
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        success: true,
      },
    };
  },
});
