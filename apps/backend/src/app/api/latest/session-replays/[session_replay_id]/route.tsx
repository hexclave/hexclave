import { Prisma } from "@/generated/prisma/client";
import { getPrismaClientForTenancy, getPrismaSchemaForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import {
  aggregateSessionReplayChunksByReplayIds,
  querySessionReplayAdminRows,
  sessionReplayAdminRowToApiItem,
} from "../session-replay-admin-rows";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Get session replay",
    description: "Returns metadata for a single session replay, including the user it belongs to, its start and last-event timestamps, and its chunk and event counts.",
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
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      id: yupString().defined(),
      refresh_token_id: yupString().defined(),
      project_user: yupObject({
        id: yupString().defined(),
        display_name: yupString().nullable().defined(),
        primary_email: yupString().nullable().defined(),
      }).defined(),
      started_at_millis: yupNumber().defined(),
      last_event_at_millis: yupNumber().defined(),
      chunk_count: yupNumber().defined(),
      event_count: yupNumber().defined(),
    }).defined(),
  }),
  async handler({ auth, params }) {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const schema = await getPrismaSchemaForTenancy(auth.tenancy);
    const sessionReplayId = params.session_replay_id;

    const rows = await querySessionReplayAdminRows({
      prisma,
      schema,
      tenancyId: auth.tenancy.id,
      suffixSql: Prisma.sql`AND sr."id" = ${sessionReplayId} LIMIT 1`,
    });

    const row = rows.at(0);
    if (row == null) {
      throw new KnownErrors.ItemNotFound(sessionReplayId);
    }

    const aggById = await aggregateSessionReplayChunksByReplayIds(prisma, auth.tenancy.id, [sessionReplayId]);
    const agg = aggById.get(sessionReplayId) ?? { chunkCount: 0, eventCount: 0 };

    return {
      statusCode: 200,
      bodyType: "json",
      body: sessionReplayAdminRowToApiItem(row, agg),
    };
  },
});
