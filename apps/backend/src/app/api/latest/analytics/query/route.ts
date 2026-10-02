import { getClickhouseExternalClient } from "@/lib/clickhouse";
import { getSafeClickhouseErrorMessage } from "@/lib/clickhouse-errors";
import { arePlanLimitsEnforced, getBillingTeamId } from "@/lib/plan-entitlements";
import { getAnalyticsPlanItemQuantities } from "@/lib/plan-metering";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { ITEM_IDS, PLAN_LIMITS } from "@hexclave/shared/dist/plans";
import { adaptSchema, jsonSchema, serverOrHigherAuthTypeSchema, yupArray, yupBoolean, yupMixed, yupNumber, yupObject, yupRecord, yupString } from "@hexclave/shared/dist/schema-fields";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { Result } from "@hexclave/shared/dist/utils/results";
import { randomUUID } from "crypto";

const MAX_QUERY_TIMEOUT_MS = Math.max(...Object.values(PLAN_LIMITS).map(p => p.analyticsTimeoutSeconds)) * 1000;
const DEFAULT_QUERY_TIMEOUT_MS = 10_000;
const MAX_RESULT_ROWS = 10_000;
const MAX_RESULT_BYTES = 10 * 1024 * 1024;

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Run analytics query",
    description: "Runs a read-only ClickHouse SQL query against the current project's analytics dataset.",
    tags: ["Analytics"],
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema,
      tenancy: adaptSchema,
    }).defined(),
    body: yupObject({
      include_all_branches: yupBoolean().default(false).meta({ openapiField: { description: "Reserved for future branch-wide analytics queries. Must be false.", exampleValue: false } }),
      query: yupString().defined().nonEmpty().meta({ openapiField: { description: "A read-only ClickHouse SQL query.", exampleValue: "SELECT count() AS event_count FROM events" } }),
      params: yupRecord(yupString().defined(), yupMixed().defined()).default({}).meta({ openapiField: { description: "ClickHouse query parameters referenced by the query.", exampleValue: { event_type: "$page-view" } } }),
      timeout_ms: yupNumber().integer().min(1_000).max(MAX_QUERY_TIMEOUT_MS).default(DEFAULT_QUERY_TIMEOUT_MS).meta({ openapiField: { description: "Maximum query execution time in milliseconds. The effective timeout is also capped by the project's plan.", exampleValue: DEFAULT_QUERY_TIMEOUT_MS } }),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      result: yupArray(jsonSchema.defined()).defined().meta({ openapiField: { description: "Query result rows as plain JSON objects.", exampleValue: [{ event_count: 42 }] } }),
      query_id: yupString().defined().meta({ openapiField: { description: "The ClickHouse query ID. Use it to fetch query timing stats.", exampleValue: "00000000-0000-0000-0000-000000000000:main:00000000-0000-0000-0000-000000000001" } }),
    }).defined(),
  }),
  async handler({ body, auth }) {
    // include_all_branches is currently a no-op. Multiple branches per project
    // are not implemented yet: every project has a single branch hardcoded to
    // DEFAULT_BRANCH_ID ("main"), with no way to create or switch branches (see
    // lib/tenancies.tsx). So there are no other branches to include, and queries
    // stay scoped to the current branch via the ClickHouse row policy that
    // filters on SQL_branch_id (set below).
    // TODO: when multi-branch support lands, make include_all_branches=true query
    // across all branches in the project instead of just auth.tenancy.branchId.


    let effectiveTimeoutMs = body.timeout_ms;
    const billingTeamId = getBillingTeamId(auth.tenancy.project);
    if (billingTeamId != null && arePlanLimitsEnforced()) {
      const quantities = await getAnalyticsPlanItemQuantities(billingTeamId, [ITEM_IDS.analyticsTimeoutSeconds]);
      const timeoutQuantity = quantities.get(ITEM_IDS.analyticsTimeoutSeconds)
        ?? throwErr("Requested analytics timeout quantity is missing from the billing snapshot");
      // clickHouse treats max_execution_time=0 as
      // "unlimited", so a customer with zero timeout entitlement (no active
      // plan in the plans line, or a transient gap between paid-plan end
      // and free regrant) would otherwise get unbounded query execution.
      if (timeoutQuantity <= 0) {
        throw new KnownErrors.ItemQuantityInsufficientAmount(ITEM_IDS.analyticsTimeoutSeconds, billingTeamId, 1);
      }
      const maxAllowedMs = timeoutQuantity * 1000;
      effectiveTimeoutMs = Math.min(body.timeout_ms, maxAllowedMs);
    }

    const client = getClickhouseExternalClient();
    const queryId = `${auth.tenancy.project.id}:${auth.tenancy.branchId}:${randomUUID()}`;
    const resultSet = await Result.fromPromise(client.query({
      query: body.query,
      query_id: queryId,
      query_params: body.params,
      clickhouse_settings: {
        SQL_project_id: auth.tenancy.project.id,
        SQL_branch_id: auth.tenancy.branchId,
        max_execution_time: effectiveTimeoutMs / 1000,
        readonly: "1",
        allow_ddl: 0,
        max_result_rows: MAX_RESULT_ROWS.toString(),
        max_result_bytes: MAX_RESULT_BYTES.toString(),
        result_overflow_mode: "throw",
      },
      format: "JSONEachRow",
    }));

    if (resultSet.status === "error") {
      const message = getSafeClickhouseErrorMessage(resultSet.error, body.query);
      throw new KnownErrors.AnalyticsQueryError(message);
    }

    const rows = await resultSet.data.json<Record<string, Json>>();
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        result: rows,
        query_id: queryId,
      },
    };
  },
});
