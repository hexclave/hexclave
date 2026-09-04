import { buildCreatedFieldsAuditMetadata, recordAuditEvent } from "@/lib/audit-log";
import { deleteManagedEmailProvider } from "@/lib/managed-email-onboarding";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const POST = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
      adminUser: adaptSchema.optional(),
    }).defined(),
    body: yupObject({
      resend_domain_id: yupString().defined(),
    }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      status: yupString().oneOf(["deleted"]).defined(),
    }).defined(),
  }),
  handler: async ({ auth, body }) => {
    const result = await deleteManagedEmailProvider({
      tenancy: auth.tenancy,
      resendDomainId: body.resend_domain_id,
    });

    const metadata = buildCreatedFieldsAuditMetadata({
      source: "emails.managed_onboarding.delete",
      fields: {
        domain_id: body.resend_domain_id,
      },
    }) ?? {
        source: "emails.managed_onboarding.delete",
        domain_id: body.resend_domain_id,
      };
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "email.managed_domain.deleted",
      metadata,
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        status: result.status,
      },
    };
  },
});
