import { buildCreatedFieldsAuditMetadata, buildUpdatedFieldsAuditMetadata, recordAuditEvent } from "@/lib/audit-log";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { internalEmailThemesCudHandlers } from "../cud";

export const GET = internalEmailThemesCudHandlers.readHandler;

export const PATCH = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: yupString().oneOf(["admin"]).defined(),
      tenancy: adaptSchema.defined(),
      adminUser: adaptSchema.optional(),
    }).defined(),
    params: yupObject({
      id: yupString().defined(),
    }).defined(),
    body: yupObject({
      tsx_source: yupString().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      display_name: yupString().defined(),
    }).defined(),
  }),
  async handler({ auth, params: { id }, body }) {
    const result = await internalEmailThemesCudHandlers.adminUpdate({
      tenancy: auth.tenancy,
      allowedErrorTypes: [StatusError],
      id,
      data: [{
        tsx_source: body.tsx_source,
      }],
    });

    const updated = result.items.find((t) => t.id === id);
    if (!updated) {
      throw new HexclaveAssertionError("Theme was updated but could not be found afterwards", { id });
    }

    // Never persist TSX source.
    const metadata = buildUpdatedFieldsAuditMetadata({
      source: "email_themes.update",
      patch: { tsx_source_updated: true },
      beforeRoot: { tsx_source_updated: false },
      afterRoot: { tsx_source_updated: true },
    }) ?? {
        source: "email_themes.update",
      };
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "email.theme.updated",
      metadata: {
        ...metadata,
        theme_id: id,
        display_name: updated.display_name,
      },
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        display_name: updated.display_name,
      },
    };
  },
});

export const DELETE = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: yupString().oneOf(["admin"]).defined(),
      tenancy: adaptSchema.defined(),
      adminUser: adaptSchema.optional(),
    }).defined(),
    params: yupObject({
      id: yupString().uuid().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({}).defined(),
  }),
  async handler({ auth, params: { id } }) {
    const existingTheme = auth.tenancy.config.emails.themes[id];
    await internalEmailThemesCudHandlers.adminDelete({
      tenancy: auth.tenancy,
      allowedErrorTypes: [StatusError],
      id,
      data: [],
    });

    const metadata = buildCreatedFieldsAuditMetadata({
      source: "email_themes.delete",
      fields: {
        theme_id: id,
        display_name: existingTheme.displayName,
      },
    }) ?? {
        source: "email_themes.delete",
        theme_id: id,
      };
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "email.theme.deleted",
      metadata,
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {},
    };
  },
});
