import { templateThemeIdToThemeMode, themeModeToTemplateThemeId } from "@/lib/email-drafts";
import { buildCreatedFieldsAuditMetadata, buildUpdatedFieldsAuditMetadata, recordAuditEvent } from "@/lib/audit-log";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, templateThemeIdSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: yupString().oneOf(["admin"]).defined(),
      tenancy: yupObject({}).defined(),
    }).defined(),
    params: yupObject({ id: yupString().uuid().defined() }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      id: yupString().uuid().defined(),
      display_name: yupString().defined(),
      tsx_source: yupString().defined(),
      theme_id: templateThemeIdSchema,
      sent_at_millis: yupNumber().nullable().optional(),
    }).defined(),
  }),
  async handler({ auth: { tenancy }, params }) {
    const prisma = await getPrismaClientForTenancy(tenancy);
    const d = await prisma.emailDraft.findFirst({ where: { tenancyId: tenancy.id, id: params.id } });
    if (!d) {
      throw new StatusError(StatusError.NotFound, "No draft found with given id");
    }
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        id: d.id,
        display_name: d.displayName,
        tsx_source: d.tsxSource,
        theme_id: themeModeToTemplateThemeId(d.themeMode, d.themeId),
        sent_at_millis: d.sentAt ? d.sentAt.getTime() : null,
      },
    };
  },
});

export const PATCH = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: yupString().oneOf(["admin"]).defined(),
      tenancy: yupObject({}).defined(),
      adminUser: adaptSchema.optional(),
    }).defined(),
    params: yupObject({ id: yupString().uuid().defined() }).defined(),
    body: yupObject({
      display_name: yupString().optional(),
      theme_id: templateThemeIdSchema.optional(),
      tsx_source: yupString().optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ ok: yupString().oneOf(["ok"]).defined() }).defined(),
  }),
  async handler({ auth, params, body }) {
    const { tenancy } = auth;
    const prisma = await getPrismaClientForTenancy(tenancy);
    const existing = await prisma.emailDraft.findFirst({ where: { tenancyId: tenancy.id, id: params.id } });
    if (!existing) {
      throw new StatusError(StatusError.NotFound, "No draft found with given id");
    }
    const themeIdBefore = themeModeToTemplateThemeId(existing.themeMode, existing.themeId);
    const displayNameChanged = body.display_name !== undefined && body.display_name !== existing.displayName;
    const themeChanged = body.theme_id !== undefined && body.theme_id !== themeIdBefore;
    const sourceChanged = body.tsx_source !== undefined && body.tsx_source !== existing.tsxSource;
    const hasEffectiveChange = displayNameChanged || themeChanged || sourceChanged;

    await prisma.emailDraft.update({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: params.id } },
      data: {
        displayName: body.display_name,
        themeMode: templateThemeIdToThemeMode(body.theme_id),
        themeId: body.theme_id === false ? null : body.theme_id,
        tsxSource: body.tsx_source,
      },
    });

    // Dashboard-only via recordAuditEvent. Never persist TSX source.
    // The dashboard re-sends the current source on theme/name transitions; skip
    // a no-op PATCH so we don't mint a false `email.draft.updated` row.
    if (hasEffectiveChange) {
      const patch: Record<string, unknown> = {};
      const beforeRoot: Record<string, unknown> = {};
      const afterRoot: Record<string, unknown> = {};
      if (displayNameChanged) {
        patch.display_name = body.display_name;
        beforeRoot.display_name = existing.displayName;
        afterRoot.display_name = body.display_name;
      }
      if (themeChanged) {
        patch.theme_id = body.theme_id;
        beforeRoot.theme_id = themeIdBefore;
        afterRoot.theme_id = body.theme_id;
      }
      if (sourceChanged) {
        patch.tsx_source_updated = true;
        beforeRoot.tsx_source_updated = false;
        afterRoot.tsx_source_updated = true;
      }
      const metadata = buildUpdatedFieldsAuditMetadata({
        source: "email_drafts.update",
        patch,
        beforeRoot,
        afterRoot,
      }) ?? {
          source: "email_drafts.update",
        };
      await recordAuditEvent({
        tenancy,
        auth,
        action: "email.draft.updated",
        metadata: {
          ...metadata,
          draft_id: params.id,
        },
      });
    }

    return {
      statusCode: 200,
      bodyType: "json",
      body: { ok: "ok" },
    };
  },
});

export const DELETE = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: yupString().oneOf(["admin"]).defined(),
      tenancy: yupObject({}).defined(),
      adminUser: adaptSchema.optional(),
    }).defined(),
    params: yupObject({ id: yupString().uuid().defined() }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ ok: yupString().oneOf(["ok"]).defined() }).defined(),
  }),
  async handler({ auth, params }) {
    const { tenancy } = auth;
    const prisma = await getPrismaClientForTenancy(tenancy);
    const existing = await prisma.emailDraft.findFirst({ where: { tenancyId: tenancy.id, id: params.id } });
    if (!existing) {
      throw new StatusError(StatusError.NotFound, "No draft found with given id");
    }
    await prisma.emailDraft.delete({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: params.id } },
    });

    const metadata = buildCreatedFieldsAuditMetadata({
      source: "email_drafts.delete",
      fields: {
        draft_id: existing.id,
        display_name: existing.displayName,
      },
    }) ?? {
        source: "email_drafts.delete",
        draft_id: existing.id,
      };
    await recordAuditEvent({
      tenancy,
      auth,
      action: "email.draft.deleted",
      metadata,
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: { ok: "ok" },
    };
  },
});

