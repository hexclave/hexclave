import { OTLP_METRIC_TYPES, queryOtlpMetrics } from "@/lib/otlp/metric-query";
import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import {
  adaptSchema,
  adminAuthTypeSchema,
  jsonSchema,
  yupNumber,
  yupObject,
  yupString,
} from "@hexclave/shared/dist/schema-fields";

export const POST = createSmartRouteHandler({
  metadata: {
    hidden: true,
    summary: "Query native OpenTelemetry metrics",
    description: "Returns a bounded, project-scoped native OpenTelemetry Metrics read model for the observability dashboard.",
    tags: ["Analytics"],
  },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    body: yupObject({
      hours: yupNumber().integer().oneOf([1, 24, 168, 720]).default(24),
      metric_name: yupString().nonEmpty().max(255).optional(),
      metric_type: yupString().oneOf([...OTLP_METRIC_TYPES]).optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: jsonSchema.defined(),
  }),
  async handler({ auth, body }) {
    assertObservabilityEnabled(auth.tenancy);

    return {
      statusCode: 200,
      bodyType: "json",
      body: await queryOtlpMetrics({
        tenancy: auth.tenancy,
        request: {
          hours: body.hours,
          metricName: body.metric_name,
          metricType: body.metric_type,
        },
      }),
    };
  },
});
