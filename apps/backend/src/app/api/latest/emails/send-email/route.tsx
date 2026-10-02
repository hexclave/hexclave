import { getEmailDraft, themeModeToTemplateThemeId } from "@/lib/email-drafts";
import { createTemplateComponentFromHtml } from "@/lib/email-rendering";
import { EmailOutboxRecipient, sendEmailToMany } from "@/lib/emails";
import { getNotificationCategoryByName } from "@/lib/notification-categories";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, emailSchema, jsonSchema, serverOrHigherAuthTypeSchema, templateThemeIdSchema, yupArray, yupBoolean, yupNumber, yupObject, yupRecord, yupString, yupUnion } from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";

const bodyBase = yupObject({
  user_ids: yupArray(yupString().defined()).optional(),
  all_users: yupBoolean().oneOf([true]).optional(),
  emails: yupArray(emailSchema.defined()).optional().meta({
    openapiField: { description: "Send the email to arbitrary email addresses that don't have to belong to a user. Recipients have no associated user object and cannot unsubscribe, so this should only be used for transactional emails." }
  }),
  subject: yupString().optional(),
  notification_category_name: yupString().optional(),
  theme_id: templateThemeIdSchema.nullable().meta({
    openapiField: { description: "The theme to use for the email. If not specified, the default theme will be used." }
  }),
  is_high_priority: yupBoolean().optional().meta({
    openapiField: { description: "Marks the email as high priority so it jumps the queue." }
  }),
  scheduled_at_millis: yupNumber().optional().meta({
    openapiField: { description: "When to send the email. If not specified, the email will be sent immediately." }
  }),
  idempotency_key: yupString().max(256).optional().meta({
    openapiField: { description: "Stable request key used to deduplicate retries for each recipient." },
  }),
});

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Send email",
    description: "Send an email to a list of users (user_ids), all users (all_users), or arbitrary email addresses (emails). The content field should contain either {html} for HTML emails, {template_id, variables} for template-based emails, or {draft_id} for a draft email.",
    tags: ["Emails"],
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    body: yupUnion(
      bodyBase.concat(yupObject({
        html: yupString().defined(),
      })),
      bodyBase.concat(yupObject({
        template_id: yupString().uuid().defined(),
        variables: yupRecord(yupString(), jsonSchema.defined()).optional(),
      })),
      bodyBase.concat(yupObject({
        draft_id: yupString().defined(),
      })),
    ).defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      results: yupArray(yupObject({
        user_id: yupString().optional(),
        email: yupString().optional(),
      })).defined(),
    }).defined(),
  }),
  handler: async ({ body, auth }) => {
    if (!getEnvVariable("STACK_FREESTYLE_API_KEY")) {
      throw new StatusError(500, "STACK_FREESTYLE_API_KEY is not set");
    }
    const providedRecipientSelectors = [body.user_ids, body.all_users, body.emails].filter(selector => selector !== undefined);
    if (providedRecipientSelectors.length !== 1) {
      throw new KnownErrors.SchemaError("Exactly one of user_ids, all_users, or emails must be provided");
    }

    // We have this check in the email queue step as well, but to give the user a better error message already in the send-email endpoint we already do it here
    if (body.notification_category_name) {
      if (!getNotificationCategoryByName(body.notification_category_name)) {
        throwErr(400, "Notification category not found with given name");
      }
    }

    const isHighPriority = body.is_high_priority ?? false;

    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    let variables: Record<string, any> = "variables" in body ? body.variables ?? {} : {};

    let overrideSubject: string | undefined = undefined;
    if (body.subject) {
      overrideSubject = body.subject;
    }

    let overrideNotificationCategoryId: string | undefined = undefined;
    if (body.notification_category_name) {
      const category = getNotificationCategoryByName(body.notification_category_name);
      if (category) {
        overrideNotificationCategoryId = category.id;
      }
    }

    const templates = new Map(Object.entries(auth.tenancy.config.emails.templates));
    let tsxSource: string;
    let selectedThemeId: string | null | undefined = body.theme_id === false ? null : body.theme_id ?? undefined;  // null means empty theme, undefined means use default theme
    let createdWith;

    if ("template_id" in body) {
      const template = templates.get(body.template_id);
      if (!template) {
        throwErr(400, "No template found with given template_id");
      }
      tsxSource = template.tsxSource;
      createdWith = { type: "programmatic-call", templateId: body.template_id } as const;
    } else if ("html" in body) {
      tsxSource = createTemplateComponentFromHtml(body.html);
      createdWith = { type: "programmatic-call", templateId: null } as const;
    } else if ("draft_id" in body) {
      const draft = await getEmailDraft(prisma, auth.tenancy.id, body.draft_id) ?? throwErr(400, "No draft found with given draft_id");
      tsxSource = draft.tsxSource;
      createdWith = { type: "draft", draftId: draft.id } as const;

      if (body.theme_id === undefined) {
        const draftThemeId = themeModeToTemplateThemeId(draft.themeMode, draft.themeId);
        if (draftThemeId === false) {
          selectedThemeId = null;
        } else {
          selectedThemeId = draftThemeId ?? undefined;
        }
      }
    } else {
      throw new KnownErrors.SchemaError("Either template_id, html, or draft_id must be provided");
    }

    let recipients: EmailOutboxRecipient[];
    let results: { user_id?: string, email?: string }[];

    if (body.emails) {
      // Send to arbitrary email addresses that don't have to belong to a user. These have no associated user object,
      // so they can't unsubscribe and there's nothing to sanity-check against the project's users.
      recipients = body.emails.map(email => ({ type: "custom-emails", emails: [email] }));
      results = body.emails.map(email => ({ email }));
    } else {
      const requestedUserIds = body.all_users ? (await prisma.projectUser.findMany({
        where: {
          tenancyId: auth.tenancy.id,
        },
        select: {
          projectUserId: true,
        },
      })).map(user => user.projectUserId) : body.user_ids ?? throwErr("user_ids must be provided if all_users is false");

      // Sanity check that the user IDs are valid so the user gets an error here instead of only once the email is rendered.
      if (!body.all_users && body.user_ids) {
        const uniqueUserIds = [...new Set(body.user_ids)];
        const users = await prisma.projectUser.findMany({
          where: {
            tenancyId: auth.tenancy.id,
            projectUserId: { in: uniqueUserIds },
          },
          select: {
            projectUserId: true,
          },
        });
        if (users.length !== uniqueUserIds.length) {
          const foundUserIds = new Set(users.map(u => u.projectUserId));
          const missingUserId = uniqueUserIds.find(id => !foundUserIds.has(id));
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          throw new KnownErrors.UserIdDoesNotExist(missingUserId!);
        }
      }

      recipients = requestedUserIds.map(userId => ({ type: "user-primary-email", userId }));
      results = requestedUserIds.map(userId => ({ user_id: userId }));
    }

    const scheduledAt = body.scheduled_at_millis ? new Date(body.scheduled_at_millis) : new Date();

    await sendEmailToMany({
      createdWith: createdWith,
      tenancy: auth.tenancy,
      recipients: recipients,
      tsxSource: tsxSource,
      extraVariables: variables,
      themeId: selectedThemeId === null ? null : (selectedThemeId === undefined ? auth.tenancy.config.emails.selectedThemeId : selectedThemeId),
      isHighPriority: isHighPriority,
      shouldSkipDeliverabilityCheck: false,
      scheduledAt: scheduledAt,
      overrideSubject: overrideSubject,
      overrideNotificationCategoryId: overrideNotificationCategoryId,
      idempotencyKey: body.idempotency_key,
    });


    if (createdWith.type === "draft") {
      await prisma.emailDraft.update({
        where: {
          tenancyId_id: {
            tenancyId: auth.tenancy.id,
            id: createdWith.draftId,
          },
        },
        data: { sentAt: new Date() },
      });
    }

    return {
      statusCode: 200,
      bodyType: 'json',
      body: {
        results: results,
      },
    };
  },
});
