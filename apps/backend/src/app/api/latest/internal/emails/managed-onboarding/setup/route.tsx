import { buildCreatedFieldsAuditMetadata, recordAuditEvent } from "@/lib/audit-log";
import { setupManagedEmailProvider } from "@/lib/managed-email-onboarding";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupArray, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

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
      subdomain: yupString().defined(),
      sender_local_part: yupString().defined(),
    }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      domain_id: yupString().defined(),
      subdomain: yupString().defined(),
      sender_local_part: yupString().defined(),
      name_server_records: yupArray(yupString().defined()).defined(),
      status: yupString().oneOf(["pending_dns", "pending_verification", "verified", "applied", "failed"]).defined(),
    }).defined(),
  }),
  handler: async ({ auth, body }) => {
    const setupResult = await setupManagedEmailProvider({
      subdomain: body.subdomain,
      senderLocalPart: body.sender_local_part,
      tenancy: auth.tenancy,
    });

    // Dashboard-only via recordAuditEvent. Never persist provider secrets.
    const metadata = buildCreatedFieldsAuditMetadata({
      source: "emails.managed_onboarding.setup",
      fields: {
        domain_id: setupResult.domainId,
        subdomain: setupResult.subdomain,
        sender_local_part: setupResult.senderLocalPart,
        status: setupResult.status,
      },
    }) ?? {
        source: "emails.managed_onboarding.setup",
        domain_id: setupResult.domainId,
      };
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "email.managed_domain.setup_started",
      metadata,
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        domain_id: setupResult.domainId,
        subdomain: setupResult.subdomain,
        sender_local_part: setupResult.senderLocalPart,
        name_server_records: setupResult.nameServerRecords,
        status: setupResult.status,
      },
    };
  },
});
