import { Prisma } from "@/generated/prisma/client";
import { deviceAuthAttemptStatuses, getDeviceAuthAttemptStatus } from "@/lib/device-auth";
import { getPrismaClientForTenancy, getPrismaSchemaForTenancy, globalPrismaClient, sqlQuoteIdent } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupArray, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

/**
 * Read-only overview for the CLI Auth and Agent Auth dashboard pages. Both are
 * the same device-auth flow (see lib/device-auth.ts), so one endpoint serves
 * both; `kind` picks which rows of the shared table to look at.
 *
 * All numbers describe a bounded recent window: exact all-time aggregates would
 * scan unbounded history on every page load.
 */

const recentAttemptLimit = 50;
const sessionLimit = 200;

type AttemptRow = {
  id: string,
  refreshToken: string | null,
  expiresAt: Date,
  usedAt: Date | null,
  deniedAt: Date | null,
  createdAt: Date,
  agentName: string | null,
  agentDescription: string | null,
  agentUrl: string | null,
  userHint: string | null,
};

type SessionRow = {
  id: string,
  projectUserId: string,
  agentName: string | null,
  createdAt: Date,
  lastActiveAt: Date,
  expiresAt: Date | null,
};

type ProjectUserRow = {
  projectUserId: string,
  displayName: string | null,
  primaryEmail: string | null,
  isAnonymous: boolean,
};

export const GET = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }),
    query: yupObject({
      kind: yupString().oneOf(["cli", "agent"]).defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      summary: yupObject({
        attempts_in_window: yupNumber().integer().defined(),
        waiting_attempts_in_window: yupNumber().integer().defined(),
        success_attempts_in_window: yupNumber().integer().defined(),
        denied_attempts_in_window: yupNumber().integer().defined(),
        expired_attempts_in_window: yupNumber().integer().defined(),
        used_attempts_in_window: yupNumber().integer().defined(),
        active_sessions_in_window: yupNumber().integer().defined(),
        attempt_window_limit: yupNumber().integer().defined(),
        session_window_limit: yupNumber().integer().defined(),
      }).defined(),
      recent_attempts: yupArray(yupObject({
        id: yupString().defined(),
        status: yupString().oneOf(deviceAuthAttemptStatuses).defined(),
        created_at: yupString().defined(),
        expires_at: yupString().defined(),
        used_at: yupString().nullable().defined(),
        agent: yupObject({
          name: yupString().defined(),
          description: yupString().nullable().defined(),
          url: yupString().nullable().defined(),
          user_hint: yupString().nullable().defined(),
        }).nullable().defined(),
      }).defined()).defined(),
      sessions: yupArray(yupObject({
        session_id: yupString().defined(),
        agent_name: yupString().nullable().defined(),
        user_id: yupString().defined(),
        display_name: yupString().nullable().defined(),
        primary_email: yupString().nullable().defined(),
        is_anonymous: yupBoolean().defined(),
        created_at: yupString().defined(),
        last_active_at: yupString().defined(),
        expires_at: yupString().nullable().defined(),
        is_expired: yupBoolean().defined(),
      }).defined()).defined(),
    }).defined(),
  }),
  handler: async ({ auth: { tenancy }, query: { kind } }) => {
    const prisma = await getPrismaClientForTenancy(tenancy);
    const schema = await getPrismaSchemaForTenancy(tenancy);
    const now = new Date();
    const kindFilter = kind === "agent" ? Prisma.sql`"agentName" IS NOT NULL` : Prisma.sql`"agentName" IS NULL`;

    const recentAttempts = await prisma.$replica().$queryRaw<AttemptRow[]>(Prisma.sql`
      SELECT "id", "refreshToken", "expiresAt", "usedAt", "deniedAt", "createdAt", "agentName", "agentDescription", "agentUrl", "userHint"
      FROM ${sqlQuoteIdent(schema)}."CliAuthAttempt"
      WHERE "tenancyId" = ${tenancy.id}::UUID
        AND ${kindFilter}
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT ${recentAttemptLimit}
    `);
    const attemptsWithStatus = recentAttempts.map((attempt) => ({ attempt, status: getDeviceAuthAttemptStatus(attempt, now) }));
    const countByStatus = (status: typeof deviceAuthAttemptStatuses[number]) => attemptsWithStatus.filter((a) => a.status === status).length;

    // Which sessions "belong" to the flow differs: agent sessions are tagged on
    // the token itself, whereas a CLI receives an untagged copy of the browser's
    // token, so the only trace is the attempt row that handed it out. The
    // LIMIT is applied before the nullable-column predicates so a tenant with
    // sparse completed attempts does not scan its entire history.
    let sessions: SessionRow[];
    if (kind === "agent") {
      sessions = await globalPrismaClient.$replica().$queryRaw<SessionRow[]>(Prisma.sql`
        SELECT "id", "projectUserId", "agentName", "createdAt", "lastActiveAt", "expiresAt"
        FROM "ProjectUserRefreshToken"
        WHERE "tenancyId" = ${tenancy.id}::UUID
          AND "agentName" IS NOT NULL
        ORDER BY "lastActiveAt" DESC
        LIMIT ${sessionLimit}
      `);
    } else {
      const handedOutTokens = await prisma.$replica().$queryRaw<{ refreshToken: string }[]>(Prisma.sql`
        WITH "recentAttempts" AS MATERIALIZED (
          SELECT "refreshToken", "usedAt"
          FROM ${sqlQuoteIdent(schema)}."CliAuthAttempt"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "agentName" IS NULL
          ORDER BY "createdAt" DESC, "id" DESC
          LIMIT ${sessionLimit}
        )
        SELECT "refreshToken"
        FROM "recentAttempts"
        WHERE "refreshToken" IS NOT NULL
          AND "usedAt" IS NOT NULL
      `);
      sessions = handedOutTokens.length === 0 ? [] : await globalPrismaClient.$replica().$queryRaw<SessionRow[]>(Prisma.sql`
        SELECT "id", "projectUserId", "agentName", "createdAt", "lastActiveAt", "expiresAt"
        FROM "ProjectUserRefreshToken"
        WHERE "tenancyId" = ${tenancy.id}::UUID
          AND "refreshToken" = ANY(${handedOutTokens.map((row) => row.refreshToken)})
        ORDER BY "lastActiveAt" DESC
        LIMIT ${sessionLimit}
      `);
    }

    // Sessions live in the global DB, users in the tenancy's source-of-truth DB.
    const userIds = [...new Set(sessions.map((session) => session.projectUserId))];
    const userRows = userIds.length === 0 ? [] : await prisma.$replica().$queryRaw<ProjectUserRow[]>(Prisma.sql`
      SELECT
        pu."projectUserId",
        pu."displayName",
        pu."isAnonymous",
        cc."value" AS "primaryEmail"
      FROM ${sqlQuoteIdent(schema)}."ProjectUser" pu
      LEFT JOIN ${sqlQuoteIdent(schema)}."ContactChannel" cc
        ON cc."tenancyId" = pu."tenancyId"
        AND cc."projectUserId" = pu."projectUserId"
        AND cc."type"::text = 'EMAIL'
        AND cc."isPrimary"::text = 'TRUE'
      WHERE pu."tenancyId" = ${tenancy.id}::UUID
        AND pu."projectUserId" = ANY(${userIds}::UUID[])
    `);
    const usersById = new Map(userRows.map((user) => [user.projectUserId, user]));

    const formattedSessions = sessions.map((session) => {
      const user = usersById.get(session.projectUserId);
      return {
        session_id: session.id,
        agent_name: session.agentName,
        user_id: session.projectUserId,
        display_name: user?.displayName ?? null,
        primary_email: user?.primaryEmail ?? null,
        // The user row can only be missing if it was deleted after the session was created; treat that like a
        // regular (non-anonymous) user so the dashboard falls back to showing the raw user ID.
        is_anonymous: user?.isAnonymous ?? false,
        created_at: session.createdAt.toISOString(),
        last_active_at: session.lastActiveAt.toISOString(),
        expires_at: session.expiresAt?.toISOString() ?? null,
        is_expired: session.expiresAt != null && session.expiresAt < now,
      };
    });

    return {
      statusCode: 200 as const,
      bodyType: "json" as const,
      body: {
        summary: {
          attempts_in_window: recentAttempts.length,
          waiting_attempts_in_window: countByStatus("waiting"),
          success_attempts_in_window: countByStatus("success"),
          denied_attempts_in_window: countByStatus("denied"),
          expired_attempts_in_window: countByStatus("expired"),
          used_attempts_in_window: countByStatus("used"),
          active_sessions_in_window: formattedSessions.filter((session) => !session.is_expired).length,
          attempt_window_limit: recentAttemptLimit,
          session_window_limit: sessionLimit,
        },
        recent_attempts: attemptsWithStatus.map(({ attempt, status }) => ({
          id: attempt.id,
          status,
          created_at: attempt.createdAt.toISOString(),
          expires_at: attempt.expiresAt.toISOString(),
          used_at: attempt.usedAt?.toISOString() ?? null,
          agent: attempt.agentName == null ? null : {
            name: attempt.agentName,
            description: attempt.agentDescription,
            url: attempt.agentUrl,
            user_hint: attempt.userHint,
          },
        })),
        sessions: formattedSessions,
      },
    };
  },
});
