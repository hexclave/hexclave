import { getClickhouseAdminClient } from "@/lib/clickhouse";
import { captureError, HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupArray, yupBoolean, yupNumber, yupObject, yupRecord, yupString } from "@hexclave/shared/dist/schema-fields";
import { buildSecurityEventsOffendersQuery, buildSecurityEventsSummaryQuery } from "./security-event-queries";

const MAX_EVENT_ROWS = 5000;
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type RawEventRow = {
  event_at: string,
  event_type: "$sign-in-attempt" | "$permission-check" | "$user-restricted" | "$sign-up-rule-trigger",
  outcome: string | null,
  method: string | null,
  failure_reason: string | null,
  action: string | null,
  rule_id: string | null,
  email: string | null,
  auth_method: string | null,
  oauth_provider: string | null,
  permission_id: string | null,
  team_id: string | null,
  restricted_reason: string | null,
  ip: string | null,
  country_code: string | null,
  region_code: string | null,
  city_name: string | null,
  ip_is_trusted: boolean | null,
  user_id: string | null,
};

const eventSchema = yupObject({
  event_at: yupString().defined(),
  category: yupString().oneOf(["sign_in_attempt", "permission_check", "user_restricted", "sign_up_rule"]).defined(),
  outcome: yupString().nullable().defined(),
  method: yupString().nullable().defined(),
  reason: yupString().nullable().defined(),
  failure_reason: yupString().nullable().defined(),
  rule_id: yupString().nullable().defined(),
  email: yupString().nullable().defined(),
  auth_method: yupString().nullable().defined(),
  oauth_provider: yupString().nullable().defined(),
  permission_id: yupString().nullable().defined(),
  team_id: yupString().nullable().defined(),
  restricted_reason: yupString().nullable().defined(),
  ip: yupString().nullable().defined(),
  country_code: yupString().nullable().defined(),
  region_code: yupString().nullable().defined(),
  city_name: yupString().nullable().defined(),
  ip_is_trusted: yupBoolean().nullable().defined(),
  user_id: yupString().nullable().defined(),
}).defined();

const trendSchema = yupObject({
  attempts: yupNumber().defined(),
  failures: yupNumber().defined(),
  denials: yupNumber().defined(),
}).defined();

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    query: yupObject({
      from: yupString().optional(),
      to: yupString().optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      events: yupArray(eventSchema).defined(),
      capped: yupBoolean().defined(),
      summary: yupRecord(yupString().defined(), yupNumber().defined()).defined(),
      trends: yupRecord(yupString().defined(), trendSchema).defined(),
      top_offenders: yupObject({
        emails: yupRecord(yupString().defined(), yupNumber().defined()).defined(),
        ips: yupRecord(yupString().defined(), yupNumber().defined()).defined(),
        countries: yupRecord(yupString().defined(), yupNumber().defined()).defined(),
      }).defined(),
    }).defined(),
  }),
  handler: async (req) => {
    const tenancy = req.auth.tenancy;
    const now = new Date();
    const from = req.query.from
      ? /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
        ? new Date(`${req.query.from}T00:00:00.000Z`)
        : new Date(req.query.from)
      : new Date(now.getTime() - DEFAULT_WINDOW_MS);
    // Date-only end bounds represent a complete calendar day in the dashboard.
    const to = req.query.to
      ? /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
        ? new Date(`${req.query.to}T23:59:59.999Z`)
        : new Date(req.query.to)
      : now;
    const fromDateOnly = req.query.from != null && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from);
    const toDateOnly = req.query.to != null && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to);
    if (
      !Number.isFinite(from.getTime())
      || !Number.isFinite(to.getTime())
      || (fromDateOnly && from.toISOString().slice(0, 10) !== req.query.from)
      || (toDateOnly && to.toISOString().slice(0, 10) !== req.query.to)
      || from > to
    ) {
      throw new StatusError(StatusError.BadRequest, "Invalid compliance event date range.");
    }
    const sharedWhere = `
          WHERE project_id = {projectId:String}
            AND branch_id = {branchId:String}
            AND event_at >= {from:DateTime}
            AND event_at <= {to:DateTime}
            AND (event_type != '$sign-up-rule-trigger' OR CAST(data.action, 'Nullable(String)') IN ('reject', 'restrict'))`;
    const sharedParams = {
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      from: from.toISOString().slice(0, 19),
      to: to.toISOString().slice(0, 19),
    };

    const client = getClickhouseAdminClient();
    try {
      const result = await client.query({
        query: `
          SELECT
            event_at,
            event_type,
            NULLIF(CAST(data.outcome, 'Nullable(String)'), '') AS outcome,
            NULLIF(CAST(data.method, 'Nullable(String)'), '') AS method,
            COALESCE(NULLIF(CAST(data.failure_reason, 'Nullable(String)'), ''), NULLIF(CAST(data.failureReason, 'Nullable(String)'), '')) AS failure_reason,
            NULLIF(CAST(data.action, 'Nullable(String)'), '') AS action,
            COALESCE(NULLIF(CAST(data.rule_id, 'Nullable(String)'), ''), NULLIF(CAST(data.ruleId, 'Nullable(String)'), '')) AS rule_id,
            NULLIF(CAST(data.email, 'Nullable(String)'), '') AS email,
            COALESCE(NULLIF(CAST(data.auth_method, 'Nullable(String)'), ''), NULLIF(CAST(data.authMethod, 'Nullable(String)'), '')) AS auth_method,
            COALESCE(NULLIF(CAST(data.oauth_provider, 'Nullable(String)'), ''), NULLIF(CAST(data.oauthProvider, 'Nullable(String)'), '')) AS oauth_provider,
            COALESCE(NULLIF(CAST(data.permission_id, 'Nullable(String)'), ''), NULLIF(CAST(data.permissionId, 'Nullable(String)'), '')) AS permission_id,
            COALESCE(NULLIF(CAST(data.team_id, 'Nullable(String)'), ''), NULLIF(CAST(data.teamId, 'Nullable(String)'), '')) AS team_id,
            COALESCE(NULLIF(CAST(data.restricted_reason, 'Nullable(String)'), ''), NULLIF(CAST(data.restrictedReason, 'Nullable(String)'), '')) AS restricted_reason,
            NULLIF(CAST(data.ip_info.ip, 'Nullable(String)'), '') AS ip,
            NULLIF(CAST(data.ip_info.country_code, 'Nullable(String)'), '') AS country_code,
            NULLIF(CAST(data.ip_info.region_code, 'Nullable(String)'), '') AS region_code,
            NULLIF(CAST(data.ip_info.city_name, 'Nullable(String)'), '') AS city_name,
            CAST(data.ip_info.is_trusted, 'Nullable(Bool)') AS ip_is_trusted,
            NULLIF(user_id, '') AS user_id
          FROM analytics_internal.events
          ${sharedWhere}
            AND event_type IN ('$sign-in-attempt', '$permission-check', '$user-restricted', '$sign-up-rule-trigger')
          ORDER BY event_at DESC
          LIMIT ${MAX_EVENT_ROWS + 1}
        `,
        query_params: {
          ...sharedParams,
        },
        format: "JSONEachRow",
      });
      const rawRows: RawEventRow[] = await result.json();
      const capped = rawRows.length > MAX_EVENT_ROWS;
      const eventRows = rawRows.slice(0, MAX_EVENT_ROWS);
      const trendsResult = await client.query({
        query: `
          SELECT
            toDate(event_at) AS day,
            countIf(event_type = '$sign-in-attempt') AS attempts,
            countIf(event_type = '$sign-in-attempt' AND CAST(data.outcome, 'Nullable(String)') = 'failed') AS failures,
            countIf(event_type IN ('$permission-check', '$user-restricted')
              OR (event_type = '$sign-up-rule-trigger' AND CAST(data.action, 'Nullable(String)') IN ('reject', 'restrict'))) AS denials
          FROM analytics_internal.events
          ${sharedWhere}
            AND event_type IN ('$sign-in-attempt', '$permission-check', '$user-restricted', '$sign-up-rule-trigger')
          GROUP BY day
          ORDER BY day ASC
        `,
        query_params: {
          ...sharedParams,
        },
        format: "JSONEachRow",
      });
      const rawTrendRows: Array<{ day: string, attempts: number | string, failures: number | string, denials: number | string }> = await trendsResult.json();
      const trends = Object.fromEntries(rawTrendRows.map((row) => [
        row.day.slice(0, 10),
        {
          attempts: Number(row.attempts),
          failures: Number(row.failures),
          denials: Number(row.denials),
        },
      ]));
      const summaryResult = await client.query({
        query: buildSecurityEventsSummaryQuery(sharedWhere),
        query_params: {
          ...sharedParams,
        },
        format: "JSONEachRow",
      });
      const rawSummaryRows: Array<{ bucket: string, count: number | string }> = await summaryResult.json();
      const summary: Record<string, number> = {};
      for (const row of rawSummaryRows) {
        summary[row.bucket] = (summary[row.bucket] ?? 0) + Number(row.count);
      }
      const offendersResult = await client.query({
        query: buildSecurityEventsOffendersQuery(sharedWhere),
        query_params: {
          ...sharedParams,
        },
        format: "JSONEachRow",
      });
      const rawOffenderRows: Array<{ kind: "email" | "ip" | "country", value: string, count: number | string }> = await offendersResult.json();
      const topOffenders = {
        emails: {} as Record<string, number>,
        ips: {} as Record<string, number>,
        countries: {} as Record<string, number>,
      };
      for (const row of rawOffenderRows) {
        if (row.kind === "email") topOffenders.emails[row.value] = Number(row.count);
        if (row.kind === "ip") topOffenders.ips[row.value] = Number(row.count);
        if (row.kind === "country") topOffenders.countries[row.value] = Number(row.count);
      }
      const events = eventRows.map((row) => {
        const category = row.event_type === "$sign-in-attempt"
          ? "sign_in_attempt" as const
          : row.event_type === "$permission-check"
            ? "permission_check" as const
            : row.event_type === "$user-restricted"
              ? "user_restricted" as const
              : "sign_up_rule" as const;
        const reason = category === "sign_up_rule"
          ? row.action
          : category === "sign_in_attempt"
            ? row.failure_reason
            : category === "user_restricted"
              ? row.restricted_reason
              : row.permission_id;
        return {
          event_at: new Date(row.event_at).toISOString(),
          category,
          outcome: row.outcome ?? (category === "sign_up_rule" ? row.action === "reject" ? "denied" : "restricted" : null),
          method: row.method,
          reason,
          failure_reason: row.failure_reason,
          rule_id: row.rule_id,
          email: row.email,
          auth_method: row.auth_method,
          oauth_provider: row.oauth_provider,
          permission_id: row.permission_id,
          team_id: row.team_id,
          restricted_reason: row.restricted_reason,
          ip: row.ip,
          country_code: row.country_code,
          region_code: row.region_code,
          city_name: row.city_name,
          ip_is_trusted: row.ip_is_trusted,
          user_id: row.user_id,
        };
      });
      return {
        statusCode: 200 as const,
        bodyType: "json" as const,
        body: {
          events,
          capped,
          summary,
          trends,
          top_offenders: topOffenders,
        },
      };
    } catch (error) {
      if (error instanceof StatusError) throw error;
      captureError("compliance-security-events-clickhouse-query", new HexclaveAssertionError(
        "Failed to load compliance security events.",
        { cause: error },
      ));
      throw new HexclaveAssertionError("Compliance events are temporarily unavailable.", { cause: error });
    } finally {
      await client.close();
    }
  },
});
