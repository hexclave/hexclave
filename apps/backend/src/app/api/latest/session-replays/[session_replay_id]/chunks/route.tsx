import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { Prisma } from "@/generated/prisma/client";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupArray, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "List session replay chunks",
    description: "Lists the chunks of a session replay in recording order, with cursor-based pagination. Each chunk describes a batch of recorded events without including the events themselves.",
    tags: ["Session Replays"],
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      session_replay_id: yupString().uuid().defined(),
    }).defined(),
    query: yupObject({
      cursor: yupString().uuid().optional(),
      limit: yupString().optional(),
    }).optional(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      items: yupArray(yupObject({
        id: yupString().defined(),
        batch_id: yupString().defined(),
        session_replay_segment_id: yupString().nullable().defined(),
        browser_session_id: yupString().nullable().defined(),
        event_count: yupNumber().defined(),
        byte_length: yupNumber().defined(),
        first_event_at_millis: yupNumber().defined(),
        last_event_at_millis: yupNumber().defined(),
        created_at_millis: yupNumber().defined(),
      }).defined()).defined(),
      pagination: yupObject({
        next_cursor: yupString().nullable().defined(),
      }).defined(),
    }).defined(),
  }),
  async handler({ auth, params, query }) {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    const sessionReplayId = params.session_replay_id;
    const exists = await prisma.sessionReplay.findUnique({
      where: { tenancyId_id: { tenancyId: auth.tenancy.id, id: sessionReplayId } },
      select: { id: true },
    });
    if (!exists) {
      throw new KnownErrors.ItemNotFound(sessionReplayId);
    }

    const rawLimit = query.limit ?? String(DEFAULT_LIMIT);
    const parsedLimit = Number.parseInt(rawLimit, 10);
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_LIMIT));

    const cursorId = query.cursor;
    let cursorPivot: { firstEventAt: Date } | null = null;
    if (cursorId) {
      cursorPivot = await prisma.sessionReplayChunk.findFirst({
        where: {
          tenancyId: auth.tenancy.id,
          sessionReplayId,
          id: cursorId,
        },
        select: { firstEventAt: true },
      });
      if (!cursorPivot) {
        throw new KnownErrors.ItemNotFound(cursorId);
      }
    }

    const cursorWhere: Prisma.SessionReplayChunkWhereInput = cursorId && cursorPivot ? {
      OR: [
        { firstEventAt: { gt: cursorPivot.firstEventAt } },
        { AND: [{ firstEventAt: { equals: cursorPivot.firstEventAt } }, { id: { gt: cursorId } }] },
      ],
    } : {};

    const chunks = await prisma.sessionReplayChunk.findMany({
      where: {
        tenancyId: auth.tenancy.id,
        sessionReplayId,
        ...cursorWhere,
      },
      orderBy: [{ firstEventAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: {
        id: true,
        batchId: true,
        sessionReplaySegmentId: true,
        browserSessionId: true,
        eventCount: true,
        byteLength: true,
        firstEventAt: true,
        lastEventAt: true,
        createdAt: true,
      },
    });

    const hasMore = chunks.length > limit;
    const page = hasMore ? chunks.slice(0, limit) : chunks;
    const nextCursor = hasMore ? page[page.length - 1]!.id : null;

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        items: page.map((c) => ({
          id: c.id,
          batch_id: c.batchId,
          session_replay_segment_id: c.sessionReplaySegmentId,
          browser_session_id: c.browserSessionId,
          event_count: c.eventCount,
          byte_length: c.byteLength,
          first_event_at_millis: c.firstEventAt.getTime(),
          last_event_at_millis: c.lastEventAt.getTime(),
          created_at_millis: c.createdAt.getTime(),
        })),
        pagination: { next_cursor: nextCursor },
      },
    };
  },
});
