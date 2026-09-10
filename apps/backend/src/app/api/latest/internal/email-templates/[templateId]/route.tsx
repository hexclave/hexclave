import { buildCreatedFieldsAuditMetadata, buildUpdatedFieldsAuditMetadata, recordAuditEvent } from "@/lib/audit-log";
import { overrideEnvironmentConfigOverride } from "@/lib/config";
import { getActiveEmailTheme, renderEmailWithTemplate } from "@/lib/email-rendering";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared/dist/known-errors";
import { adaptSchema, templateThemeIdSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";


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
      templateId: yupString().uuid().defined(),
    }).defined(),
    body: yupObject({
      tsx_source: yupString().defined(),
      theme_id: templateThemeIdSchema.nullable(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      rendered_html: yupString().defined(),
    }).defined(),
  }),
  async handler({ auth, params: { templateId }, body }) {
    const { tenancy } = auth;
    if (tenancy.config.emails.server.isShared) {
      throw new KnownErrors.RequiresCustomEmailServer();
    }
    const templateList = tenancy.config.emails.templates;
    if (!Object.keys(templateList).includes(templateId)) {
      throw new StatusError(StatusError.NotFound, "No template found with given id");
    }

    // Note: theme_id validation is handled by templateThemeIdSchema in the request schema

    const theme = getActiveEmailTheme(tenancy);
    const result = await renderEmailWithTemplate(body.tsx_source, theme.tsxSource, {
      variables: { projectDisplayName: tenancy.project.display_name },
      previewMode: true,
      themeProps: {
        projectLogos: {
          logoUrl: tenancy.project.logo_url ?? undefined,
          logoFullUrl: tenancy.project.logo_full_url ?? undefined,
          logoDarkModeUrl: tenancy.project.logo_dark_mode_url ?? undefined,
          logoFullDarkModeUrl: tenancy.project.logo_full_dark_mode_url ?? undefined,
        },
      },
    });
    if (result.status === "error") {
      throw new KnownErrors.EmailRenderingError(result.error);
    }
    if (result.data.subject === undefined) {
      throw new KnownErrors.EmailRenderingError("Subject is required, import it from @hexclave/emails (or the legacy @stackframe/emails)");
    }
    if (result.data.notificationCategory === undefined) {
      throw new KnownErrors.EmailRenderingError("NotificationCategory is required, import it from @hexclave/emails (or the legacy @stackframe/emails)");
    }

    const configOverride: Record<string, any> = {
      [`emails.templates.${templateId}.tsxSource`]: body.tsx_source,
    };

    if (body.theme_id !== undefined) {
      configOverride[`emails.templates.${templateId}.themeId`] = body.theme_id;
    }

    await overrideEnvironmentConfigOverride({
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      environmentConfigOverrideOverride: configOverride,
    });

    // Dashboard-only via recordAuditEvent. Never persist TSX source.
    const existingTemplate = templateList[templateId];
    const themeIdAfter = body.theme_id !== undefined ? body.theme_id : (existingTemplate.themeId ?? null);
    const metadata = buildUpdatedFieldsAuditMetadata({
      source: "email_templates.update",
      patch: {
        tsx_source_updated: true,
        ...(body.theme_id !== undefined ? { theme_id: themeIdAfter } : {}),
      },
      beforeRoot: {
        tsx_source_updated: false,
        theme_id: existingTemplate.themeId ?? null,
      },
      afterRoot: {
        tsx_source_updated: true,
        theme_id: themeIdAfter,
      },
    }) ?? {
        source: "email_templates.update",
      };
    await recordAuditEvent({
      tenancy,
      auth,
      action: "email.template.updated",
      metadata: {
        ...metadata,
        template_id: templateId,
        display_name: existingTemplate.displayName,
      },
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        rendered_html: result.data.html,
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
      templateId: yupString().uuid().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({}).defined(),
  }),
  async handler({ auth, params: { templateId } }) {
    const { tenancy } = auth;
    if (tenancy.config.emails.server.isShared) {
      throw new KnownErrors.RequiresCustomEmailServer();
    }
    const templateList = tenancy.config.emails.templates;
    if (!Object.keys(templateList).includes(templateId)) {
      throw new StatusError(StatusError.NotFound, "No template found with given id");
    }
    const existingTemplate = templateList[templateId];

    await overrideEnvironmentConfigOverride({
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      environmentConfigOverrideOverride: {
        // null means delete this key, but the override map type does not model null-valued deletes.
        [`emails.templates.${templateId}`]: null as any,
      },
    });

    const metadata = buildCreatedFieldsAuditMetadata({
      source: "email_templates.delete",
      fields: {
        template_id: templateId,
        display_name: existingTemplate.displayName,
      },
    }) ?? {
        source: "email_templates.delete",
        template_id: templateId,
      };
    await recordAuditEvent({
      tenancy,
      auth,
      action: "email.template.deleted",
      metadata,
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {},
    };
  },
});
