import { buildCreatedFieldsAuditMetadata, recordAuditEvent } from "@/lib/audit-log";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, yupArray, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";
import { internalEmailThemesCudHandlers } from "./cud";


export const POST = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: yupString().oneOf(["admin"]).defined(),
      tenancy: adaptSchema.defined(),
      adminUser: adaptSchema.optional(),
    }).defined(),
    body: yupObject({
      display_name: yupString().defined(),
    }),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      id: yupString().defined(),
    }).defined(),
  }),
  async handler({ body, auth }) {
    const id = generateUuid();
    await internalEmailThemesCudHandlers.adminCreate({
      tenancy: auth.tenancy,
      allowedErrorTypes: [StatusError],
      data: {
        id,
        display_name: body.display_name,
      },
    });

    // CUD adminCreate is programmatic so it cannot audit; record here on the HTTP path.
    // Never persist TSX source.
    const metadata = buildCreatedFieldsAuditMetadata({
      source: "email_themes.create",
      fields: {
        theme_id: id,
        display_name: body.display_name,
      },
    }) ?? {
        source: "email_themes.create",
        theme_id: id,
      };
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "email.theme.created",
      metadata,
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: { id },
    };
  },
});

export const GET = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: yupString().oneOf(["admin"]).defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      themes: yupArray(yupObject({
        id: yupString().uuid().defined(),
        display_name: yupString().defined(),
      })).defined(),
    }).defined(),
  }),
  async handler({ auth: { tenancy } }) {
    const result = await internalEmailThemesCudHandlers.adminList({
      tenancy,
      allowedErrorTypes: [StatusError],
    });
    const themes = result.items.map(({ id, display_name }) => ({
      id,
      display_name,
    }));
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        themes,
      },
    };
  },
});
