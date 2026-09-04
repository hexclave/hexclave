import { buildCreatedFieldsAuditMetadata, recordAuditEvent } from "@/lib/audit-log";
import { createApiKeySet } from "@/lib/internal-api-keys";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { internalApiKeysCreateInputSchema, internalApiKeysCreateOutputSchema } from "@hexclave/shared/dist/interface/crud/internal-api-keys";
import { adaptSchema, adminAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { internalApiKeyCrudHandlers } from "./crud";

export const GET = internalApiKeyCrudHandlers.listHandler;

export const POST = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema,
      project: adaptSchema.defined(),
      tenancy: adaptSchema.defined(),
      adminUser: adaptSchema.optional(),
    }).defined(),
    body: internalApiKeysCreateInputSchema.defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: internalApiKeysCreateOutputSchema.defined(),
  }),
  handler: async ({ auth, body }) => {
    const set = await createApiKeySet({
      projectId: auth.project.id,
      ...body,
    });

    // Full key material is returned to the caller once; audit only records
    // which key kinds were minted plus non-secret description/expiry.
    const metadata = buildCreatedFieldsAuditMetadata({
      source: "api_keys.create",
      fields: {
        api_key_id: set.id,
        description: set.description,
        expires_at_millis: set.expires_at_millis,
        has_publishable_client_key: set.has_publishable_client_key,
        has_secret_server_key: set.has_secret_server_key,
        has_super_secret_admin_key: set.has_super_secret_admin_key,
      },
    }) ?? {
        source: "api_keys.create",
        api_key_id: set.id,
      };
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "project_api_key.created",
      metadata,
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        id: set.id,
        description: set.description,
        publishable_client_key: set.publishable_client_key,
        secret_server_key: set.secret_server_key,
        super_secret_admin_key: set.super_secret_admin_key,
        created_at_millis: set.created_at_millis,
        expires_at_millis: set.expires_at_millis,
        manually_revoked_at_millis: set.manually_revoked_at_millis,
      },
    } as const;
  },
});
