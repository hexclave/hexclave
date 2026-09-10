import { AUDIT_LOG_ACTIONS, AUDIT_LOG_NO_TARGET_USER_ID } from "@/lib/audit-log";
import { globalPrismaClient } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupArray, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { isUuid } from "@hexclave/shared/dist/utils/uuids";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const auditLogEventSchema = yupObject({
  id: yupString().defined(),
  created_at_millis: yupNumber().defined(),
  action: yupString().oneOf([...AUDIT_LOG_ACTIONS]).defined(),
  actor_type: yupString().oneOf(["admin_user", "server_key", "unknown"]).defined(),
  actor_user_id: yupString().nullable().defined(),
  actor_label: yupString().defined(),
  target_user_id: yupString().nullable().defined(),
  reason: yupString().nullable().defined(),
  metadata: yupMixed().nullable().defined(),
}).defined();

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    query: yupObject({
      cursor: yupString().optional(),
      limit: yupString().optional(),
      action: yupString().oneOf([...AUDIT_LOG_ACTIONS]).optional(),
      target_user_id: yupString().uuid().optional(),
    }).default(() => ({})),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      items: yupArray(auditLogEventSchema).defined(),
      pagination: yupObject({
        next_cursor: yupString().nullable().defined(),
      }).defined(),
    }).defined(),
  }),
  handler: async ({ auth: { tenancy }, query }) => {
    // Admin-only list API (same pattern as other compliance internal routes).
    // Dashboard viewing is gated by the Compliance app; writes are always-on.
    const limitRaw = query.limit == null ? DEFAULT_LIMIT : Number(query.limit);
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
      throw new StatusError(StatusError.BadRequest, `limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    const limit = limitRaw;

    const cursor = query.cursor;
    if (cursor != null && !isUuid(cursor)) {
      throw new StatusError(StatusError.BadRequest, "cursor must be a valid UUID");
    }

    const cursorRow = cursor == null ? null : await globalPrismaClient.auditLogEvent.findUnique({
      where: {
        tenancyId_id: {
          tenancyId: tenancy.id,
          id: cursor,
        },
      },
    });
    if (cursor != null && cursorRow == null) {
      throw new StatusError(StatusError.BadRequest, "cursor does not match an audit log event");
    }

    const rows = await globalPrismaClient.auditLogEvent.findMany({
      where: {
        tenancyId: tenancy.id,
        ...(query.action != null ? { action: query.action } : {}),
        ...(query.target_user_id != null ? { targetUserId: query.target_user_id } : {}),
        ...(cursorRow != null ? {
          OR: [
            { createdAt: { lt: cursorRow.createdAt } },
            {
              AND: [
                { createdAt: cursorRow.createdAt },
                { id: { lt: cursorRow.id } },
              ],
            },
          ],
        } : {}),
      },
      orderBy: [
        { createdAt: "desc" },
        { id: "desc" },
      ],
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    const next = rows.length > limit ? page[page.length - 1]?.id ?? null : null;

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        items: page.map((row) => ({
          id: row.id,
          created_at_millis: row.createdAt.getTime(),
          action: row.action as typeof AUDIT_LOG_ACTIONS[number],
          actor_type: row.actorType as "admin_user" | "server_key" | "unknown",
          actor_user_id: row.actorUserId,
          actor_label: row.actorLabel,
          target_user_id: row.targetUserId === AUDIT_LOG_NO_TARGET_USER_ID ? null : row.targetUserId,
          reason: row.reason,
          metadata: row.metadata ?? null,
        })),
        pagination: {
          next_cursor: next,
        },
      },
    };
  },
});
