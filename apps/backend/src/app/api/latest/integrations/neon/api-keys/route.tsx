import { buildCreatedFieldsAuditMetadata, recordAuditEvent } from "@/lib/audit-log";
import { createApiKeySet } from "@/lib/internal-api-keys";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { apiKeyCrudHandlers } from "./crud";


export const GET = apiKeyCrudHandlers.listHandler;

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
    body: yupObject({
      description: yupString().defined(),
      expires_at_millis: yupNumber().defined(),
      has_publishable_client_key: yupBoolean().defined(),
      has_secret_server_key: yupBoolean().defined(),
      has_super_secret_admin_key: yupBoolean().defined(),
    }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      id: yupString().defined(),
      description: yupString().defined(),
      expires_at_millis: yupNumber().defined(),
      manually_revoked_at_millis: yupNumber().optional(),
      created_at_millis: yupNumber().defined(),
      publishable_client_key: yupString().optional(),
      secret_server_key: yupString().optional(),
      super_secret_admin_key: yupString().optional(),
    }).defined(),
  }),
  handler: async ({ auth, body }) => {
    const set = await createApiKeySet({
      projectId: auth.project.id,
      ...body,
    });

    const metadata = buildCreatedFieldsAuditMetadata({
      source: "integrations.neon.api_keys.create",
      fields: {
        api_key_id: set.id,
        description: set.description,
        expires_at_millis: set.expires_at_millis,
        has_publishable_client_key: set.has_publishable_client_key,
        has_secret_server_key: set.has_secret_server_key,
        has_super_secret_admin_key: set.has_super_secret_admin_key,
      },
    }) ?? {
        source: "integrations.neon.api_keys.create",
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
