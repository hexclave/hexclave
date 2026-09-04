import { getClickhouseAdminClient } from "@/lib/clickhouse";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupNumber, yupObject, yupRecord, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

const LAST_EXPOSURES_QUERY = `
SELECT
  flag_id,
  formatDateTime(max(event_at), '%FT%TZ', 'UTC') AS last_exposure_iso
FROM analytics_internal.feature_flag_exposures
WHERE project_id = {projectId:String}
  AND branch_id = {branchId:String}
GROUP BY flag_id
`;

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      last_exposure_iso_by_flag_id: yupRecord(yupString(), yupString().defined()).defined(),
    }).defined(),
  }),
  async handler({ auth }) {
    if (auth.tenancy.config.apps.installed["feature-flags"]?.enabled !== true) {
      throw new StatusError(StatusError.BadRequest, "Feature flags are not enabled for this project");
    }
    const result = await getClickhouseAdminClient().query({
      query: LAST_EXPOSURES_QUERY,
      query_params: {
        projectId: auth.tenancy.project.id,
        branchId: auth.tenancy.branchId,
      },
      format: "JSONEachRow",
      clickhouse_settings: {
        max_execution_time: 15,
        max_result_rows: "10000",
        result_overflow_mode: "throw",
      },
    });
    const rows = await result.json<{ flag_id: string, last_exposure_iso: string }>();
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        last_exposure_iso_by_flag_id: Object.fromEntries(rows.map((row) => [row.flag_id, row.last_exposure_iso])),
      },
    };
  },
});
