import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { type PrismaClientWithReplica, sqlQuoteIdent } from "@/prisma-client";

/** Row shape from the admin session replay list / get SQL (SessionReplay + ProjectUser + primary email). */
export type SessionReplayAdminListRow = {
  id: string,
  projectUserId: string,
  refreshTokenId: string,
  startedAt: Date,
  lastEventAt: Date,
  projectUserDisplayName: string | null,
  primaryEmail: string | null,
};

export type SessionReplayChunkAgg = { chunkCount: number, eventCount: number };

/**
 * Base query used by the internal session replay list and single-replay routes.
 * `suffixSql` is everything after `WHERE sr."tenancyId" = …` (filters, ORDER BY, LIMIT).
 */
export async function querySessionReplayAdminRows(options: {
  prisma: PrismaClientWithReplica<PrismaClient>,
  schema: string,
  tenancyId: string,
  suffixSql: Prisma.Sql,
}): Promise<SessionReplayAdminListRow[]> {
  const { prisma, schema, tenancyId, suffixSql } = options;
  return await prisma.$replica().$queryRaw<SessionReplayAdminListRow[]>`
    SELECT
      sr."id",
      sr."projectUserId",
      sr."refreshTokenId",
      sr."startedAt",
      sr."lastEventAt",
      pu."displayName" AS "projectUserDisplayName",
      (
        SELECT cc."value"
        FROM ${sqlQuoteIdent(schema)}."ContactChannel" cc
        WHERE cc."projectUserId" = sr."projectUserId"
          AND cc."tenancyId" = sr."tenancyId"
          AND cc."type" = 'EMAIL'
          AND cc."isPrimary" = 'TRUE'::"BooleanTrue"
        LIMIT 1
      ) AS "primaryEmail"
    FROM ${sqlQuoteIdent(schema)}."SessionReplay" sr
    JOIN ${sqlQuoteIdent(schema)}."ProjectUser" pu
      ON pu."projectUserId" = sr."projectUserId"
      AND pu."tenancyId" = sr."tenancyId"
    WHERE sr."tenancyId" = ${tenancyId}::UUID
      ${suffixSql}
  `;
}

export async function aggregateSessionReplayChunksByReplayIds(
  prisma: PrismaClientWithReplica<PrismaClient>,
  tenancyId: string,
  sessionReplayIds: string[],
): Promise<Map<string, SessionReplayChunkAgg>> {
  if (sessionReplayIds.length === 0) {
    return new Map();
  }
  const chunkAggs = await prisma.sessionReplayChunk.groupBy({
    by: ["sessionReplayId"],
    where: { tenancyId, sessionReplayId: { in: sessionReplayIds } },
    _count: { _all: true },
    _sum: { eventCount: true },
  });
  const map = new Map<string, SessionReplayChunkAgg>();
  for (const a of chunkAggs) {
    map.set(a.sessionReplayId, {
      chunkCount: a._count._all,
      eventCount: a._sum.eventCount ?? 0,
    });
  }
  return map;
}

export function sessionReplayAdminRowToApiItem(
  row: SessionReplayAdminListRow,
  agg: SessionReplayChunkAgg,
) {
  return {
    id: row.id,
    // Lets the dashboard correlate the replay with the analytics events of this
    // exact session, rather than with the same user's other concurrent sessions.
    refresh_token_id: row.refreshTokenId,
    project_user: {
      id: row.projectUserId,
      display_name: row.projectUserDisplayName ?? null,
      primary_email: row.primaryEmail ?? null,
    },
    started_at_millis: row.startedAt.getTime(),
    last_event_at_millis: row.lastEventAt.getTime(),
    chunk_count: agg.chunkCount,
    event_count: agg.eventCount,
  };
}
