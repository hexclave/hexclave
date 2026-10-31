import { getPrismaClientForTenancy, getPrismaSchemaForTenancy, sqlQuoteIdent } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { MetricsEntityKpisSchema } from "@hexclave/shared/dist/interface/admin-metrics";
import { adaptSchema, adminAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { loadDailyActiveTeamsSplit, loadDailyActiveUsersSplit, loadTotalUsers } from "../route";

// The Users and Teams pages used to load the full /internal/metrics bundle
// (twice) just for their four KPI cards. On large projects that bundle takes
// minutes, so this route runs only the queries those cards read.
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
      entity: yupString().oneOf(["users", "teams"]).defined(),
    }),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: MetricsEntityKpisSchema,
  }),
  handler: async (req) => {
    const now = new Date();
    const tenancy = req.auth.tenancy;
    const schema = await getPrismaSchemaForTenancy(tenancy);
    const prisma = await getPrismaClientForTenancy(tenancy);

    if (req.query.entity === "users") {
      const [dailyNew, dailyActiveSplit, totalRows] = await Promise.all([
        loadTotalUsers(tenancy, now, false),
        loadDailyActiveUsersSplit(tenancy, now, false),
        prisma.$replica().$queryRaw<[{ total: number }]>`
          SELECT COUNT(*)::int AS total
          FROM ${sqlQuoteIdent(schema)}."ProjectUser"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "isAnonymous" = false
        `,
      ]);
      return {
        statusCode: 200,
        bodyType: "json",
        body: {
          daily_new: dailyNew,
          daily_active_split: dailyActiveSplit,
          total: Number(totalRows[0].total),
        },
      };
    }

    const [dailyActiveSplit, totalRows] = await Promise.all([
      loadDailyActiveTeamsSplit(tenancy, now),
      prisma.$replica().$queryRaw<[{ total: number }]>`
        SELECT COUNT(*)::int AS total
        FROM ${sqlQuoteIdent(schema)}."Team"
        WHERE "tenancyId" = ${tenancy.id}::UUID
      `,
    ]);
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        // No pure team-creation series exists; newly active teams are the
        // closest proxy.
        daily_new: dailyActiveSplit.new,
        daily_active_split: dailyActiveSplit,
        total: Number(totalRows[0].total),
      },
    };
  },
});
