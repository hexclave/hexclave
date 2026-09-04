import { buildCreatedFieldsAuditMetadata, recordAuditEvent } from "@/lib/audit-log";
import { overrideEnvironmentConfigOverride } from "@/lib/config";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { defaultNewTemplateSource } from "@hexclave/shared/dist/helpers/emails";
import { KnownErrors } from "@hexclave/shared/dist/known-errors";
import { adaptSchema, templateThemeIdSchema, yupArray, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { filterUndefined, typedEntries } from "@hexclave/shared/dist/utils/objects";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";

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
      templates: yupArray(yupObject({
        id: yupString().uuid().defined(),
        display_name: yupString().defined(),
        tsx_source: yupString().defined(),
        theme_id: templateThemeIdSchema,
      })).defined(),
    }).defined(),
  }),
  async handler({ auth: { tenancy } }) {
    const templates = typedEntries(tenancy.config.emails.templates).map(([id, template]) => filterUndefined({
      id,
      display_name: template.displayName,
      tsx_source: template.tsxSource,
      theme_id: template.themeId,
    }));
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        templates,
      },
    };
  },
});

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
    const { tenancy } = auth;
    if (tenancy.config.emails.server.isShared) {
      throw new KnownErrors.RequiresCustomEmailServer();
    }

    const id = generateUuid();

    await overrideEnvironmentConfigOverride({
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      environmentConfigOverrideOverride: {
        [`emails.templates.${id}`]: {
          displayName: body.display_name,
          tsxSource: defaultNewTemplateSource,
          themeId: null,
        },
      },
    });

    // Dashboard-only via recordAuditEvent. Never persist TSX source.
    const metadata = buildCreatedFieldsAuditMetadata({
      source: "email_templates.create",
      fields: {
        template_id: id,
        display_name: body.display_name,
      },
    }) ?? {
        source: "email_templates.create",
        template_id: id,
      };
    await recordAuditEvent({
      tenancy,
      auth,
      action: "email.template.created",
      metadata,
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: { id },
    };
  },
});
