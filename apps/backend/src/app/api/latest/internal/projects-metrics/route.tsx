import { getClickhouseAdminClientForMetrics } from "@/lib/clickhouse";
import { listManagedProjectIds } from "@/lib/projects";
import { DEFAULT_BRANCH_ID } from "@/lib/tenancies";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { MetricsDataPointsSchema } from "@hexclave/shared/dist/interface/admin-metrics";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupNumber, yupObject, yupRecord, yupString } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

const SIGNUPS_WINDOW_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function formatClickhouseDateTimeParam(date: Date): string {
  // ClickHouse DateTime params are passed as "YYYY-MM-DDTHH:MM:SS" (no timezone); treat them as UTC.
  return date.toISOString().slice(0, 19);
}

// Deduplicates row versions with argMax rather than FINAL: tiny projects spread across monthly
// parts each cost whole granules of other tenants' rows, and FINAL merge-sorting all of them
// across parts exceeded the 512 MB query cap. argMax only holds the matching user ids in memory,
// and grouping by id across partitions still collapses users whose signed_up_at moved partition.
export function getProjectTotalUsersQuery(table: string): string {
  return `
    SELECT
      projectId,
      countIf(isDeleted = 0 AND isAnonymous = 0) AS totalUsers
    FROM (
      SELECT
        project_id AS projectId,
        argMax(sync_is_deleted, sync_sequence_id) AS isDeleted,
        argMax(is_anonymous, sync_sequence_id) AS isAnonymous
      FROM ${table}
      WHERE project_id IN {projectIds:Array(String)}
        AND branch_id = {branchId:String}
      GROUP BY project_id, id
    )
    GROUP BY projectId
    HAVING totalUsers > 0
  `;
}

type ProjectMetrics = {
  total_users: number,
  daily_signups: { date: string, activity: number }[],
};

export function applyProjectMetricsRows(
  byProject: Map<string, ProjectMetrics>,
  totals: { projectId: string, totalUsers: number }[],
  signups: { projectId: string, day: string, signups: number }[],
) {
  for (const row of totals) {
    const project = byProject.get(row.projectId);
    if (project == null) continue;
    project.total_users = Number(row.totalUsers);
  }

  const dailyIndex = new Map<string, Map<string, number>>();
  for (const row of signups) {
    const project = byProject.get(row.projectId);
    if (project == null) continue;
    const dayKey = row.day.split("T")[0];
    let m = dailyIndex.get(row.projectId);
    if (!m) {
      m = new Map();
      dailyIndex.set(row.projectId, m);
    }
    m.set(dayKey, Number(row.signups));
  }

  for (const [id, project] of byProject) {
    const m = dailyIndex.get(id);
    if (!m) continue;
    project.daily_signups = project.daily_signups.map((point) => ({
      date: point.date,
      activity: m.get(point.date) ?? 0,
    }));
  }
}

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
      user: adaptSchema,
      project: adaptSchema.defined(),
    }),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      projects: yupRecord(yupString().defined(), yupObject({
        total_users: yupNumber().integer().defined(),
        daily_signups: MetricsDataPointsSchema,
      }).defined()).defined(),
    }).defined(),
  }),
  handler: async (req) => {
    if (!req.auth.user) {
      throw new KnownErrors.UserAuthenticationRequired();
    }
    if (req.auth.project.id !== "internal") {
      throw new KnownErrors.ExpectedInternalProject();
    }

    const projectIds = await listManagedProjectIds(req.auth.user);

    const now = new Date();
    const todayUtc = new Date(now);
    todayUtc.setUTCHours(0, 0, 0, 0);
    const since = new Date(todayUtc.getTime() - (SIGNUPS_WINDOW_DAYS - 1) * ONE_DAY_MS);
    const untilExclusive = new Date(todayUtc.getTime() + ONE_DAY_MS);

    const emptySeries = () => {
      const out: { date: string, activity: number }[] = [];
      for (let i = 0; i < SIGNUPS_WINDOW_DAYS; i += 1) {
        const day = new Date(since.getTime() + i * ONE_DAY_MS);
        out.push({ date: day.toISOString().split("T")[0], activity: 0 });
      }
      return out;
    };

    const byProject = new Map<string, ProjectMetrics>();
    for (const id of projectIds) {
      byProject.set(id, {
        total_users: 0,
        daily_signups: emptySeries(),
      });
    }
    const buildResponse = () => ({
      statusCode: 200 as const,
      bodyType: "json" as const,
      body: { projects: Object.fromEntries(byProject) },
    });

    if (projectIds.length === 0) {
      return buildResponse();
    }

    let totalRows: Array<{ projectId: string, totalUsers: string | number }>;
    let signupRows: Array<{ projectId: string, day: string, signups: string | number }>;
    try {
      const clickhouseClient = getClickhouseAdminClientForMetrics();
      const [totalResult, signupResult] = await Promise.all([
        clickhouseClient.query({
          query: getProjectTotalUsersQuery("analytics_internal.users"),
          query_params: {
            projectIds,
            branchId: DEFAULT_BRANCH_ID,
          },
          format: "JSONEachRow",
        }),
        clickhouseClient.query({
          query: `
            SELECT
              project_id AS projectId,
              toString(toDate(signed_up_at, 'UTC')) AS day,
              count() AS signups
            FROM analytics_internal.users FINAL
            WHERE project_id IN {projectIds:Array(String)}
              AND branch_id = {branchId:String}
              AND sync_is_deleted = 0
              AND is_anonymous = 0
              AND signed_up_at >= {since:DateTime}
              AND signed_up_at < {untilExclusive:DateTime}
            GROUP BY project_id, day
          `,
          query_params: {
            projectIds,
            branchId: DEFAULT_BRANCH_ID,
            since: formatClickhouseDateTimeParam(since),
            untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
          },
          format: "JSONEachRow",
        }),
      ]);
      [totalRows, signupRows] = await Promise.all([
        totalResult.json<{ projectId: string, totalUsers: string | number }>(),
        signupResult.json<{ projectId: string, day: string, signups: string | number }>(),
      ]);
    } catch (cause) {
      throw new HexclaveAssertionError("Failed to load project metrics.", {
        cause,
        userId: req.auth.user.id,
        projectIds,
        signupsSince: since.toISOString(),
        signupsUntilExclusive: untilExclusive.toISOString(),
      });
    }

    applyProjectMetricsRows(
      byProject,
      totalRows.map((r) => ({ projectId: r.projectId, totalUsers: Number(r.totalUsers) })),
      signupRows.map((r) => ({
        projectId: r.projectId,
        day: r.day,
        signups: Number(r.signups),
      })),
    );

    return buildResponse();
  },
});
