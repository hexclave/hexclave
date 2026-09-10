import { buildCreatedFieldsAuditMetadata, recordAuditEvent } from "@/lib/audit-log";
import { applyManagedEmailProvider } from "@/lib/managed-email-onboarding";
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
      domain_id: yupString().defined(),
    }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      status: yupString().oneOf(["applied"]).defined(),
    }).defined(),
  }),
  handler: async ({ auth, body }) => {
    const result = await applyManagedEmailProvider({
      tenancy: auth.tenancy,
      domainId: body.domain_id,
    });

    // Dashboard-only via recordAuditEvent. Never persist the managed API key
    // that apply writes into email server config.
    const metadata = buildCreatedFieldsAuditMetadata({
      source: "emails.managed_onboarding.apply",
      fields: {
        domain_id: body.domain_id,
        provider: "managed",
      },
    }) ?? {
        source: "emails.managed_onboarding.apply",
        domain_id: body.domain_id,
      };
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "email.managed_domain.applied",
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
