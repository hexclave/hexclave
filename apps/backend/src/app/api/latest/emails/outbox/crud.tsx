import { EmailOutbox, Prisma } from "@/generated/prisma/client";
import { serializeRecipient } from "@/lib/email-queue-step";
import { EmailOutboxRecipient } from "@/lib/emails";
import { globalPrismaClient, RawQuery, rawQueryAll } from "@/prisma-client";
import { createCrudHandlers } from "@/route-handlers/crud-handler";
import { KnownErrors } from "@hexclave/shared";
import { emailOutboxCrud, EmailOutboxCrud } from "@hexclave/shared/dist/interface/crud/email-outbox";
import { yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { Json } from "@hexclave/shared/dist/utils/json";
import { createLazyProxy } from "@hexclave/shared/dist/utils/proxies";

/**
 * Converts an API recipient (snake_case: user_id) to the DB format (camelCase: userId).
 * This is necessary because the API uses snake_case for consistency with other endpoints,
 * but the database and worker code use camelCase.
 */
function apiRecipientToDb(apiRecipient: EmailOutboxCrud["Server"]["Update"]["to"]): EmailOutboxRecipient {
  if (!apiRecipient) {
    throw new HexclaveAssertionError("Recipient is required");
  }
  switch (apiRecipient.type) {
    case "user-primary-email": {
      return { type: "user-primary-email", userId: apiRecipient.user_id };
    }
    case "user-custom-emails": {
      return { type: "user-custom-emails", userId: apiRecipient.user_id, emails: apiRecipient.emails };
    }
    case "custom-emails": {
      return { type: "custom-emails", emails: apiRecipient.emails };
    }
    default: {
      throw new HexclaveAssertionError("Unknown recipient type", { apiRecipient });
    }
  }
}

// States that can be edited
const EDITABLE_STATUSES = new Set([
  "PAUSED",
  "PREPARING",
  "RENDERING",
  "RENDER_ERROR",
  "SCHEDULED",
  "QUEUED",
  "SERVER_ERROR",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- complex discriminated union types require type assertions
function prismaModelToCrud(prismaModel: EmailOutbox): EmailOutboxCrud["Server"]["Read"] {
  const recipient = prismaModel.to as any;
  let to: EmailOutboxCrud["Server"]["Read"]["to"];
  if (recipient?.type === "user-primary-email") {
    to = { type: "user-primary-email", user_id: recipient.userId };
  } else if (recipient?.type === "user-custom-emails") {
    to = { type: "user-custom-emails", user_id: recipient.userId, emails: recipient.emails ?? [] };
  } else {
    to = { type: "custom-emails", emails: recipient?.emails ?? [] };
  }

  // Convert sendAttemptErrors from DB format (camelCase) to API format (snake_case)
  const sendAttemptErrors = prismaModel.sendAttemptErrors
    ? (prismaModel.sendAttemptErrors as Array<{
        attemptNumber: number,
        timestamp: string,
        externalMessage: string,
        externalDetails: Record<string, Json>,
        internalMessage: string,
        internalDetails: Record<string, Json>,
      }>).map(e => ({
        attempt_number: e.attemptNumber,
        timestamp: e.timestamp,
        external_message: e.externalMessage,
        external_details: e.externalDetails,
        internal_message: e.internalMessage,
        internal_details: e.internalDetails,
      }))
    : null;

  // Base fields present on all emails
  const base = {
    id: prismaModel.id,
    created_at_millis: prismaModel.createdAt.getTime(),
    updated_at_millis: prismaModel.updatedAt.getTime(),
    tsx_source: prismaModel.tsxSource,
    theme_id: prismaModel.themeId,
    to,
    variables: (prismaModel.extraRenderVariables ?? {}) as Record<string, any>,
    skip_deliverability_check: prismaModel.shouldSkipDeliverabilityCheck,
    scheduled_at_millis: prismaModel.scheduledAt.getTime(),
    // Source tracking for grouping emails by template/draft
    created_with: (prismaModel.createdWith === "DRAFT" ? "draft" : "programmatic-call") as "draft" | "programmatic-call",
    email_draft_id: prismaModel.emailDraftId,
    email_programmatic_call_template_id: prismaModel.emailProgrammaticCallTemplateId,
    send_retries: prismaModel.sendRetries,
    next_send_retry_at_millis: prismaModel.nextSendRetryAt?.getTime() ?? null,
    send_attempt_errors: sendAttemptErrors,
    // Default flags (overridden in specific statuses)
    is_paused: false,
    has_rendered: false,
    has_delivered: false,
  };

  const status = prismaModel.status;

  // Rendered fields (available after rendering completes successfully)
  const hasRendered = prismaModel.finishedRenderingAt && !prismaModel.renderErrorExternalMessage;
  const rendered = hasRendered ? {
    started_rendering_at_millis: prismaModel.startedRenderingAt!.getTime(),
    rendered_at_millis: prismaModel.finishedRenderingAt!.getTime(),
    subject: prismaModel.renderedSubject ?? "",
    html: prismaModel.renderedHtml,
    text: prismaModel.renderedText,
    is_transactional: prismaModel.renderedIsTransactional ?? false,
    is_high_priority: prismaModel.isHighPriority,
    notification_category_id: prismaModel.renderedNotificationCategoryId,
    has_rendered: true,
  } : null;

  // Build the response based on status
  // Note: We use 'as any' casts because the EmailOutboxCrud["Server"]["Read"] type
  // is a complex discriminated union that TypeScript has difficulty inferring from
  // the object spread patterns used here.

  switch (status) {
    case "PAUSED": {
      return {
        ...base,
        status: "paused",
        simple_status: "in-progress",
        is_paused: true,
      };
    }
    case "PREPARING": {
      return {
        ...base,
        status: "preparing",
        simple_status: "in-progress",
      };
    }
    case "RENDERING": {
      return {
        ...base,
        status: "rendering",
        simple_status: "in-progress",
        started_rendering_at_millis: prismaModel.startedRenderingAt!.getTime(),
      };
    }
    case "RENDER_ERROR": {
      return {
        ...base,
        status: "render-error",
        simple_status: "error",
        started_rendering_at_millis: prismaModel.startedRenderingAt!.getTime(),
        rendered_at_millis: prismaModel.finishedRenderingAt!.getTime(),
        render_error: prismaModel.renderErrorExternalMessage ?? "Unknown render error",
      };
    }
    case "SCHEDULED": {
      return {
        ...base,
        ...rendered!,
        status: "scheduled",
        simple_status: "in-progress",
      };
    }
    case "QUEUED": {
      return {
        ...base,
        ...rendered!,
        status: "queued",
        simple_status: "in-progress",
      };
    }
    case "SENDING": {
      return {
        ...base,
        ...rendered!,
        status: "sending",
        simple_status: "in-progress",
        started_sending_at_millis: prismaModel.startedSendingAt!.getTime(),
      };
    }
    case "SERVER_ERROR": {
      return {
        ...base,
        ...rendered!,
        status: "server-error",
        simple_status: "error",
        started_sending_at_millis: prismaModel.startedSendingAt!.getTime(),
        error_at_millis: prismaModel.finishedSendingAt!.getTime(),
        server_error: prismaModel.sendServerErrorExternalMessage ?? "Unknown send error",
      };
    }
    case "SKIPPED": {
      // SKIPPED can happen at any time (like PAUSED), so rendering/sending fields are optional
      return {
        ...base,
        // Include rendered fields if available
        ...(rendered ?? undefined),
        // Override has_rendered based on whether we actually have rendered content
        has_rendered: !!rendered,
        status: "skipped",
        simple_status: "ok",
        skipped_at_millis: prismaModel.updatedAt.getTime(),
        skipped_reason: prismaModel.skippedReason ?? "UNKNOWN",
        skipped_details: (prismaModel.skippedDetails ?? {}) as Record<string, any>,
        // Optional rendering fields
        started_rendering_at_millis: prismaModel.startedRenderingAt?.getTime(),
        // Note: rendered_at_millis is included in the spread above if rendered
        // Optional sending fields
        started_sending_at_millis: prismaModel.startedSendingAt?.getTime(),
      };
    }
    case "BOUNCED": {
      return {
        ...base,
        ...rendered!,
        status: "bounced",
        simple_status: "error",
        started_sending_at_millis: prismaModel.startedSendingAt!.getTime(),
        bounced_at_millis: prismaModel.bouncedAt!.getTime(),
      };
    }
    case "DELIVERY_DELAYED": {
      return {
        ...base,
        ...rendered!,
        status: "delivery-delayed",
        simple_status: "ok",
        started_sending_at_millis: prismaModel.startedSendingAt!.getTime(),
        delivery_delayed_at_millis: prismaModel.deliveryDelayedAt!.getTime(),
      };
    }
    case "SENT": {
      return {
        ...base,
        ...rendered!,
        status: "sent",
        simple_status: "ok",
        started_sending_at_millis: prismaModel.startedSendingAt!.getTime(),
        delivered_at_millis: prismaModel.canHaveDeliveryInfo ? prismaModel.deliveredAt!.getTime() : prismaModel.finishedSendingAt!.getTime(),
        has_delivered: true,
        can_have_delivery_info: prismaModel.canHaveDeliveryInfo ?? throwErr("Email outbox is in SENT status but canHaveDeliveryInfo is not set", { emailOutboxId: prismaModel.id }),
      };
    }
    case "OPENED": {
      return {
        ...base,
        ...rendered!,
        status: "opened",
        simple_status: "ok",
        started_sending_at_millis: prismaModel.startedSendingAt!.getTime(),
        delivered_at_millis: prismaModel.deliveredAt!.getTime(),
        opened_at_millis: prismaModel.openedAt!.getTime(),
        has_delivered: true,
        can_have_delivery_info: true,
      };
    }
    case "CLICKED": {
      return {
        ...base,
        ...rendered!,
        status: "clicked",
        simple_status: "ok",
        started_sending_at_millis: prismaModel.startedSendingAt!.getTime(),
        delivered_at_millis: prismaModel.deliveredAt!.getTime(),
        clicked_at_millis: prismaModel.clickedAt!.getTime(),
        has_delivered: true,
        can_have_delivery_info: true,
      };
    }
    case "MARKED_AS_SPAM": {
      return {
        ...base,
        ...rendered!,
        status: "marked-as-spam",
        simple_status: "ok",
        started_sending_at_millis: prismaModel.startedSendingAt!.getTime(),
        delivered_at_millis: prismaModel.deliveredAt!.getTime(),
        marked_as_spam_at_millis: prismaModel.markedAsSpamAt!.getTime(),
        has_delivered: true,
        can_have_delivery_info: true,
      };
    }
  }
  throw new HexclaveAssertionError(`Unknown email outbox status: ${status}`, { status });
}

const MAX_LIMIT = 100;

export const emailOutboxCrudHandlers = createLazyProxy(() => createCrudHandlers(emailOutboxCrud, {
  paramsSchema: yupObject({
    id: yupString().uuid().optional(),
  }),
  querySchema: yupObject({
    status: yupString().optional(),
    simple_status: yupString().optional(),
    user_id: yupString().optional().meta({ openapiField: { onlyShowInOperations: ['List'], description: "Filter for emails whose recipient is the given user ID." } }),
    limit: yupString().optional().meta({ openapiField: { onlyShowInOperations: ['List'], description: `The maximum number of items to return. Maximum allowed is ${MAX_LIMIT}` } }),
    cursor: yupString().uuid().optional().meta({ openapiField: { onlyShowInOperations: ['List'], description: "The cursor to start the result set from (email ID)" } }),
  }),
  onRead: async ({ auth, params }) => {
    if (!params.id) {
      throw new StatusError(400, "Email ID is required");
    }

    const email = await globalPrismaClient.emailOutbox.findUnique({
      where: {
        tenancyId_id: {
          tenancyId: auth.tenancy.id,
          id: params.id,
        },
      },
    });

    if (!email) {
      throw new StatusError(404, "Email not found");
    }

    return prismaModelToCrud(email);
  },
  onList: async ({ auth, query }) => {
    // Parse and validate limit
    const parsedLimit = query.limit ? parseInt(query.limit, 10) : MAX_LIMIT;
    if (isNaN(parsedLimit) || parsedLimit < 1) {
      throw new StatusError(400, "Invalid limit parameter");
    }
    if (parsedLimit > MAX_LIMIT) {
      throw new StatusError(400, `Limit cannot exceed ${MAX_LIMIT}`);
    }

    const where: Prisma.EmailOutboxWhereInput = {
      tenancyId: auth.tenancy.id,
    };

    // Convert API format (lowercase-with-dashes) to database format (UPPERCASE_WITH_UNDERSCORES)
    if (query.status) {
      where.status = query.status.toUpperCase().replace(/-/g, "_") as any;
    }
    if (query.simple_status) {
      where.simpleStatus = query.simple_status.toUpperCase().replace(/-/g, "_") as any;
    }
    if (query.user_id) {
      where.to = {
        path: ["userId"],
        equals: query.user_id,
      };
    }

    const emails = await globalPrismaClient.emailOutbox.findMany({
      where,
      orderBy: [
        { createdAt: "desc" },
        { id: "asc" },
      ],
      // +1 to check if there's a next page
      take: parsedLimit + 1,
      ...query.cursor ? {
        cursor: {
          tenancyId_id: {
            tenancyId: auth.tenancy.id,
            id: query.cursor,
          },
        },
      } : {},
    });

    const hasMore = emails.length > parsedLimit;
    const resultEmails = hasMore ? emails.slice(0, parsedLimit) : emails;
    const nextCursor = hasMore ? emails[parsedLimit].id : null;

    return {
      items: resultEmails.map(prismaModelToCrud),
      is_paginated: true,
      pagination: {
        next_cursor: nextCursor,
      },
    };
  },
  onUpdate: async ({ auth, params, data }) => {
    if (!params.id) {
      throw new StatusError(400, "Email ID is required");
    }

    // Build SET clause parts for the SQL update
    const sets: Prisma.Sql[] = [];
    const set = (col: string, val: Prisma.Sql) => sets.push(Prisma.sql`${Prisma.raw(`"${col}"`)} = ${val}`);
    const setNull = (...cols: string[]) => cols.forEach(c => set(c, Prisma.sql`NULL`));

    if (data.cancel) {
      // Cancel action - mark as skipped
      set("isPaused", Prisma.sql`false`);
      set("isQueued", Prisma.sql`false`);
      setNull("nextSendRetryAt"); // Clear any pending retry so it won't be picked up
      set("skippedReason", Prisma.sql`'MANUALLY_CANCELLED'::"EmailOutboxSkippedReason"`);
      set("skippedDetails", Prisma.sql`'{}'::jsonb`);
    } else {
      // Normal update path
      let needsRerenderReset = false;

      if (data.tsx_source !== undefined) {
        set("tsxSource", Prisma.sql`${data.tsx_source}`);
        needsRerenderReset = true;
      }
      if (data.theme_id !== undefined) {
        set("themeId", Prisma.sql`${data.theme_id}`);
        needsRerenderReset = true;
      }
      if (data.to !== undefined) {
        const serialized = serializeRecipient(apiRecipientToDb(data.to));
        set("to", Prisma.sql`${JSON.stringify(serialized)}::jsonb`);
        needsRerenderReset = true;
      }
      if (data.variables !== undefined) {
        set("extraRenderVariables", Prisma.sql`${JSON.stringify(data.variables)}::jsonb`);
        needsRerenderReset = true;
      }
      if (data.skip_deliverability_check !== undefined) {
        set("shouldSkipDeliverabilityCheck", Prisma.sql`${data.skip_deliverability_check}`);
      }
      if (data.scheduled_at_millis !== undefined) {
        set("scheduledAt", Prisma.sql`${new Date(data.scheduled_at_millis)}`);
        set("isQueued", Prisma.sql`false`);
      }
      if (data.is_paused !== undefined) {
        set("isPaused", Prisma.sql`${data.is_paused}`);
      }

      // If content changed, reset rendering and sending state
      if (needsRerenderReset) {
        set("isQueued", Prisma.sql`false`);
        // Reset retry fields (sendRetries to 0, others to null)
        set("sendRetries", Prisma.sql`0`);
        setNull(
          "renderedByWorkerId", "startedRenderingAt", "finishedRenderingAt",
          "renderErrorExternalMessage", "renderErrorExternalDetails",
          "renderErrorInternalMessage", "renderErrorInternalDetails",
          "renderedHtml", "renderedText", "renderedSubject",
          "renderedIsTransactional", "renderedNotificationCategoryId",
          "startedSendingAt", "finishedSendingAt",
          "nextSendRetryAt", "sendAttemptErrors",
          "sendServerErrorExternalMessage", "sendServerErrorExternalDetails",
          "sendServerErrorInternalMessage", "sendServerErrorInternalDetails",
          "skippedReason", "skippedDetails", "canHaveDeliveryInfo",
          "deliveredAt", "deliveryDelayedAt", "bouncedAt",
          "openedAt", "clickedAt", "unsubscribedAt", "markedAsSpamAt"
        );
      }
    }

    // If no fields to update, just touch updatedAt
    if (sets.length === 0) {
      set("updatedAt", Prisma.sql`NOW()`);
    }

    // Mark for external DB sync
    set("shouldUpdateSequenceId", Prisma.sql`TRUE`);

    const updateQuery: RawQuery<EmailOutbox | null> = {
      supportedPrismaClients: ["global"],
      readOnlyQuery: false,
      sql: Prisma.sql`
        UPDATE "EmailOutbox"
        SET ${Prisma.join(sets, ", ")}
        WHERE "tenancyId" = ${auth.tenancy.id}::uuid
          AND "id" = ${params.id}::uuid
          AND "status" = ANY(${[...EDITABLE_STATUSES]}::"EmailOutboxStatus"[])
          ${data.cancel ? Prisma.sql`AND "skippedReason" IS NULL` : Prisma.empty}
        RETURNING *
      `,
      postProcess: (rows): EmailOutbox | null => {
        if (rows.length === 0) return null;
        return parseEmailOutboxFromJson(rows[0]);
      },
    };

    const checkQuery: RawQuery<{ id: string, status: string } | null> = {
      supportedPrismaClients: ["global"],
      readOnlyQuery: true,
      sql: Prisma.sql`
        SELECT "id", "status" FROM "EmailOutbox"
        WHERE "tenancyId" = ${auth.tenancy.id}::uuid AND "id" = ${params.id}::uuid
      `,
      postProcess: (rows) => rows.length > 0 ? { id: rows[0].id, status: rows[0].status } : null,
    };

    const { updated, existing } = await rawQueryAll(globalPrismaClient, { updated: updateQuery, existing: checkQuery });

    if (updated) return prismaModelToCrud(updated);
    if (!existing) throw new StatusError(404, "Email not found");
    throw new KnownErrors.EmailNotEditable(existing.id, existing.status);
  },
}));

/** Parses row_to_json output back to EmailOutbox with proper Date types */
function parseEmailOutboxFromJson(j: Record<string, unknown>): EmailOutbox {
  const date = (k: string) => new Date(j[k] + "Z");
  const dateOrNull = (k: string) => j[k] ? date(k) : null;

  return {
    tenancyId: j.tenancyId as string,
    id: j.id as string,
    createdAt: date("createdAt"),
    updatedAt: date("updatedAt"),
    tsxSource: j.tsxSource as string,
    themeId: j.themeId as string | null,
    isHighPriority: j.isHighPriority as boolean,
    to: j.to as Prisma.JsonValue,
    extraRenderVariables: j.extraRenderVariables as Prisma.JsonValue,
    overrideSubject: j.overrideSubject as string | null,
    overrideNotificationCategoryId: j.overrideNotificationCategoryId as string | null,
    shouldSkipDeliverabilityCheck: j.shouldSkipDeliverabilityCheck as boolean,
    createdWith: j.createdWith as EmailOutbox["createdWith"],
    emailDraftId: j.emailDraftId as string | null,
    emailProgrammaticCallTemplateId: j.emailProgrammaticCallTemplateId as string | null,
    status: j.status as EmailOutbox["status"],
    simpleStatus: j.simpleStatus as EmailOutbox["simpleStatus"],
    priority: j.priority as number,
    isPaused: j.isPaused as boolean,
    renderedByWorkerId: j.renderedByWorkerId as string | null,
    startedRenderingAt: dateOrNull("startedRenderingAt"),
    finishedRenderingAt: dateOrNull("finishedRenderingAt"),
    renderErrorExternalMessage: j.renderErrorExternalMessage as string | null,
    renderErrorExternalDetails: j.renderErrorExternalDetails as Prisma.JsonValue,
    renderErrorInternalMessage: j.renderErrorInternalMessage as string | null,
    renderErrorInternalDetails: j.renderErrorInternalDetails as Prisma.JsonValue,
    renderedHtml: j.renderedHtml as string | null,
    renderedText: j.renderedText as string | null,
    renderedSubject: j.renderedSubject as string | null,
    renderedIsTransactional: j.renderedIsTransactional as boolean | null,
    renderedNotificationCategoryId: j.renderedNotificationCategoryId as string | null,
    scheduledAt: date("scheduledAt"),
    isQueued: j.isQueued as boolean,
    scheduledAtIfNotYetQueued: dateOrNull("scheduledAtIfNotYetQueued"),
    startedSendingAt: dateOrNull("startedSendingAt"),
    finishedSendingAt: dateOrNull("finishedSendingAt"),
    sendRetries: j.sendRetries as number,
    nextSendRetryAt: dateOrNull("nextSendRetryAt"),
    sendAttemptErrors: j.sendAttemptErrors as Prisma.JsonValue,
    sentAt: dateOrNull("sentAt"),
    sendServerErrorExternalMessage: j.sendServerErrorExternalMessage as string | null,
    sendServerErrorExternalDetails: j.sendServerErrorExternalDetails as Prisma.JsonValue,
    sendServerErrorInternalMessage: j.sendServerErrorInternalMessage as string | null,
    sendServerErrorInternalDetails: j.sendServerErrorInternalDetails as Prisma.JsonValue,
    skippedReason: j.skippedReason as EmailOutbox["skippedReason"],
    skippedDetails: j.skippedDetails as Prisma.JsonValue,
    canHaveDeliveryInfo: j.canHaveDeliveryInfo as boolean | null,
    deliveredAt: dateOrNull("deliveredAt"),
    deliveryDelayedAt: dateOrNull("deliveryDelayedAt"),
    bouncedAt: dateOrNull("bouncedAt"),
    openedAt: dateOrNull("openedAt"),
    clickedAt: dateOrNull("clickedAt"),
    unsubscribedAt: dateOrNull("unsubscribedAt"),
    markedAsSpamAt: dateOrNull("markedAsSpamAt"),
    sequenceId: j.sequenceId != null ? BigInt(j.sequenceId as string | number) : null,
    shouldUpdateSequenceId: j.shouldUpdateSequenceId as boolean,
  };
}
