import { Prisma } from "@/generated/prisma/client";
import { getPrismaClientForTenancy, getPrismaSchemaForTenancy, globalPrismaClient, sqlQuoteIdent } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupArray, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

const recentAttemptLimit = 50;
const agentSessionLimit = 200;

type AgentAuthAttemptRow = {
  id: string,
  agentName: string,
  agentDescription: string | null,
  agentUrl: string | null,
  userHint: string | null,
  status: "pending" | "approved" | "denied" | "expired" | "used",
  approvedByUserId: string | null,
  expiresAt: Date,
  createdAt: Date,
};

type AgentSessionRow = {
  id: string,
  projectUserId: string,
  agentName: string,
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
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      summary: yupObject({
        attempts_in_window: yupNumber().integer().defined(),
        pending_attempts_in_window: yupNumber().integer().defined(),
        used_attempts_in_window: yupNumber().integer().defined(),
        denied_attempts_in_window: yupNumber().integer().defined(),
        expired_attempts_in_window: yupNumber().integer().defined(),
        active_agent_sessions_in_window: yupNumber().integer().defined(),
        attempt_window_limit: yupNumber().integer().defined(),
        agent_session_window_limit: yupNumber().integer().defined(),
      }).defined(),
      recent_attempts: yupArray(yupObject({
        id: yupString().defined(),
        agent_name: yupString().defined(),
        agent_description: yupString().nullable().defined(),
        agent_url: yupString().nullable().defined(),
        user_hint: yupString().nullable().defined(),
        status: yupString().oneOf(["pending", "approved", "denied", "expired", "used"]).defined(),
        approved_by_user_id: yupString().nullable().defined(),
        created_at: yupString().defined(),
        expires_at: yupString().defined(),
      }).defined()).defined(),
      agent_sessions: yupArray(yupObject({
        session_id: yupString().defined(),
        agent_name: yupString().defined(),
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
  handler: async (req) => {
    const tenancy = req.auth.tenancy;
    const prisma = await getPrismaClientForTenancy(tenancy);
    const schema = await getPrismaSchemaForTenancy(tenancy);
    const now = new Date();

    // Bounded recent window, like the CLI auth page: all-time aggregates would
    // scan unbounded history on every dashboard load.
    const recentAttempts = await prisma.$replica().$queryRaw<AgentAuthAttemptRow[]>(Prisma.sql`
      SELECT
        "id",
        "agentName",
        "agentDescription",
        "agentUrl",
        "userHint",
        CASE
          WHEN "usedAt" IS NOT NULL THEN 'used'
          WHEN "deniedAt" IS NOT NULL THEN 'denied'
          WHEN "approvedAt" IS NOT NULL THEN 'approved'
          WHEN "expiresAt" < ${now} THEN 'expired'
          ELSE 'pending'
        END AS "status",
        "approvedByUserId",
        "expiresAt",
        "createdAt"
      FROM ${sqlQuoteIdent(schema)}."AgentAuthAttempt"
      WHERE "tenancyId" = ${tenancy.id}::UUID
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT ${recentAttemptLimit}
    `);

    const counts = new Map<AgentAuthAttemptRow["status"], number>();
    for (const attempt of recentAttempts) {
      counts.set(attempt.status, (counts.get(attempt.status) ?? 0) + 1);
    }

    // Agent sessions live in the global refresh-token table; the tenancy prefix
    // of its primary key keeps this bounded to one project.
    const agentSessions = await globalPrismaClient.$replica().$queryRaw<AgentSessionRow[]>(Prisma.sql`
      SELECT
        "id",
        "projectUserId",
        "agentName",
        "createdAt",
        "lastActiveAt",
        "expiresAt"
      FROM "ProjectUserRefreshToken"
      WHERE "tenancyId" = ${tenancy.id}::UUID
        AND "agentName" IS NOT NULL
      ORDER BY "lastActiveAt" DESC
      LIMIT ${agentSessionLimit}
    `);

    const userIds = [...new Set(agentSessions.map((session) => session.projectUserId))];
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

    const formattedSessions = agentSessions.map((session) => {
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
          pending_attempts_in_window: counts.get("pending") ?? 0,
          used_attempts_in_window: counts.get("used") ?? 0,
          denied_attempts_in_window: counts.get("denied") ?? 0,
          expired_attempts_in_window: counts.get("expired") ?? 0,
          active_agent_sessions_in_window: formattedSessions.filter((session) => !session.is_expired).length,
          attempt_window_limit: recentAttemptLimit,
          agent_session_window_limit: agentSessionLimit,
        },
        recent_attempts: recentAttempts.map((attempt) => ({
          id: attempt.id,
          agent_name: attempt.agentName,
          agent_description: attempt.agentDescription,
          agent_url: attempt.agentUrl,
          user_hint: attempt.userHint,
          status: attempt.status,
          approved_by_user_id: attempt.approvedByUserId,
          created_at: attempt.createdAt.toISOString(),
          expires_at: attempt.expiresAt.toISOString(),
        })),
        agent_sessions: formattedSessions,
      },
    };
  },
});
