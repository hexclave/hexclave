import { getClickhouseAdminClient } from "@/lib/clickhouse";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupArray, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";

const ANALYTICS_HOURS = 48;

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
      // Triggers per rule with hourly breakdown for sparklines
      rule_triggers: yupArray(yupObject({
        rule_id: yupString().defined(),
        total_count: yupNumber().integer().defined(),
        all_time_count: yupNumber().integer().defined(),
        hourly_counts: yupArray(yupObject({
          hour: yupString().defined(),
          count: yupNumber().integer().defined(),
        }).defined()).defined(),
      }).defined()).defined(),
      analytics_hours: yupNumber().integer().defined(),
      // Summary stats
      total_triggers: yupNumber().integer().defined(),
      triggers_by_action: yupObject({
        allow: yupNumber().integer().defined(),
        reject: yupNumber().integer().defined(),
        restrict: yupNumber().integer().defined(),
        log: yupNumber().integer().defined(),
      }).defined(),
    }).defined(),
  }),
  handler: async (req) => {
    const projectId = req.auth.tenancy.project.id;
    const branchId = req.auth.tenancy.branchId;

    // Generate hour keys for the sparkline
    const now = new Date();
    now.setUTCMinutes(0, 0, 0);
    const since = new Date(now.getTime() - (ANALYTICS_HOURS - 1) * 60 * 60 * 1000);
    const hourKeys = Array.from({ length: ANALYTICS_HOURS }, (_, index) => {
      const hour = new Date(since.getTime() + index * 60 * 60 * 1000);
      return hour.toISOString().slice(0, 13) + ':00:00.000Z';
    });

    const client = getClickhouseAdminClient();

    const result = await client.query({
      query: `
        SELECT
          COALESCE(
            NULLIF(CAST(data.rule_id, 'Nullable(String)'), ''),
            NULLIF(CAST(data.ruleId, 'Nullable(String)'), '')
          ) as rule_id,
          CAST(data.action, 'String') as action,
          toStartOfHour(event_at) as hour,
          count() AS trigger_count
        FROM analytics_internal.events
        PREWHERE project_id = {projectId:String}
          AND branch_id = {branchId:String}
          AND event_type = '$sign-up-rule-trigger'
          AND event_at >= {since:DateTime}
        GROUP BY rule_id, action, hour
        HAVING rule_id IS NOT NULL
        ORDER BY hour ASC, rule_id ASC, action ASC
      `,
      query_params: {
        projectId,
        branchId,
        since: since.toISOString().slice(0, 19),
      },
      format: "JSONEachRow",
    });
    const rawRows: {
      rule_id: string | null,
      action: "allow" | "reject" | "restrict" | "log",
      hour: string,
      trigger_count: number | string,
    }[] = await result.json();

    const rows = rawRows.filter((row): row is typeof row & { rule_id: string } => row.rule_id != null && row.rule_id !== '');

    // Group by rule and hour for sparkline data
    const ruleTriggersMap = new Map<string, {
      totalCount: number,
      hourlyMap: Map<string, number>,
    }>();

    // Summary counts by action
    const actionCounts = {
      allow: 0,
      reject: 0,
      restrict: 0,
      log: 0,
    };

    for (const row of rows) {
      const triggerCount = Number(row.trigger_count);
      // Update action counts
      const action = row.action;
      if (action in actionCounts) {
        actionCounts[action] += triggerCount;
      }

      // Update rule triggers
      let ruleData = ruleTriggersMap.get(row.rule_id);
      if (!ruleData) {
        ruleData = { totalCount: 0, hourlyMap: new Map() };
        ruleTriggersMap.set(row.rule_id, ruleData);
      }
      ruleData.totalCount += triggerCount;

      // Group by hour (normalize to ISO format)
      // ClickHouse returns datetime without timezone, treat as UTC
      const hourKey = new Date(row.hour + 'Z').toISOString().slice(0, 13) + ':00:00.000Z';
      ruleData.hourlyMap.set(hourKey, (ruleData.hourlyMap.get(hourKey) ?? 0) + triggerCount);
    }

    // Build hourly breakdown for each rule
    const allTimeResult = await client.query({
      query: `
        SELECT
          COALESCE(
            NULLIF(CAST(data.rule_id, 'Nullable(String)'), ''),
            NULLIF(CAST(data.ruleId, 'Nullable(String)'), '')
          ) as rule_id,
          count() as total_count
        FROM analytics_internal.events
        PREWHERE project_id = {projectId:String}
          AND branch_id = {branchId:String}
          AND event_type = '$sign-up-rule-trigger'
        GROUP BY rule_id
        HAVING rule_id IS NOT NULL
      `,
      query_params: {
        projectId,
        branchId,
      },
      format: "JSONEachRow",
    });
    const rawAllTimeRows: {
      rule_id: string | null,
      total_count: number | string,
    }[] = await allTimeResult.json();
    const allTimeCountMap = new Map<string, number>();
    for (const row of rawAllTimeRows) {
      if (row.rule_id == null || row.rule_id === "") {
        continue;
      }
      allTimeCountMap.set(row.rule_id, Number(row.total_count));
    }

    // Build hourly breakdown for each rule and merge with all-time counts so
    // rules that had no recent matches still surface their lifetime trigger count.
    const allRuleIds = new Set<string>([
      ...ruleTriggersMap.keys(),
      ...allTimeCountMap.keys(),
    ]);
    const ruleTriggers = Array.from(allRuleIds)
      .map((ruleId) => {
        const recentRuleData = ruleTriggersMap.get(ruleId);
        const recentCount = recentRuleData?.totalCount ?? 0;

        return {
          rule_id: ruleId,
          total_count: recentCount,
          all_time_count: allTimeCountMap.get(ruleId) ?? recentCount,
          hourly_counts: hourKeys.map((hour) => ({
            hour,
            count: recentRuleData?.hourlyMap.get(hour) ?? 0,
          })),
        };
      })
      .sort((a, b) => stringCompare(a.rule_id, b.rule_id));

    return {
      statusCode: 200 as const,
      bodyType: "json" as const,
      body: {
        rule_triggers: ruleTriggers,
        analytics_hours: ANALYTICS_HOURS,
        total_triggers: rows.reduce((total, row) => total + Number(row.trigger_count), 0),
        triggers_by_action: actionCounts,
      },
    };
  },
});
