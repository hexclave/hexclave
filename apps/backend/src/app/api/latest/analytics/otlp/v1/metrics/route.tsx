import { getSharedClickhouseAdminClient } from "@/lib/clickhouse";
import { createOtlpHttpResponse, parseOtlpHttpRequest, resolveOtlpClientContext } from "@/lib/otlp/http";
import { buildOtlpMetricRows, insertOtlpMetrics } from "@/lib/otlp/metric-writer";
import { normalizeOtlpJsonMetricsRequest } from "@/lib/otlp/metrics";
import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

const MAX_METRIC_DATA_POINTS_PER_REQUEST = 10_000;

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Export OpenTelemetry metrics",
    description: "Accepts authenticated OTLP/HTTP JSON or protobuf ExportMetricsServiceRequest messages.",
    tags: ["Observability"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
      user: adaptSchema,
      refreshTokenId: adaptSchema,
    }).defined(),
    body: yupMixed().defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    body: yupMixed().defined(),
    headers: yupObject({
      "content-type": yupTuple([yupString().defined()]).defined(),
    }).defined(),
  }),
  handler: async ({ auth, body }, fullRequest) => {
    assertObservabilityEnabled(auth.tenancy);
    const { userId, refreshTokenId } = resolveOtlpClientContext("metrics", auth);

    const { encoding, value: metricsRequest } = parseOtlpHttpRequest({
      kind: "metrics",
      headers: fullRequest.headers,
      body,
      normalize: normalizeOtlpJsonMetricsRequest,
    });

    const tenant = {
      projectId: auth.tenancy.project.id,
      branchId: auth.tenancy.branchId,
      userId,
      refreshTokenId,
    };
    const rows = buildOtlpMetricRows(metricsRequest, tenant);
    if (rows.length > MAX_METRIC_DATA_POINTS_PER_REQUEST) {
      throw new StatusError(StatusError.PayloadTooLarge, `OTLP metrics request contains more than ${MAX_METRIC_DATA_POINTS_PER_REQUEST} data points`);
    }
    if (rows.length > 0) {
      await insertOtlpMetrics(getSharedClickhouseAdminClient(), metricsRequest, tenant);
    }
    return createOtlpHttpResponse("metrics", encoding);
  },
});
