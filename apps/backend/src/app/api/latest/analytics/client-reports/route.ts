import {
  ErrorIngestClientReportParseError,
  parseErrorIngestClientReportRequest,
  persistErrorIngestClientReportRequest,
} from "@/lib/error-ingest";
import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Record telemetry client reports",
    description: "Records bounded, payload-free client drop reports for telemetry delivery diagnostics.",
    tags: ["Analytics Events"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    body: yupMixed().defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ accepted: yupNumber().defined() }).defined(),
  }),
  handler: async ({ auth, body }) => {
    assertObservabilityEnabled(auth.tenancy);
    let request: ReturnType<typeof parseErrorIngestClientReportRequest>;
    try {
      request = parseErrorIngestClientReportRequest(body);
    } catch (error) {
      if (error instanceof ErrorIngestClientReportParseError) {
        throw new StatusError(StatusError.BadRequest, error.message);
      }
      throw error;
    }
    const accepted = await persistErrorIngestClientReportRequest({
      tenancyId: auth.tenancy.id,
      projectId: auth.tenancy.project.id,
      branchId: auth.tenancy.branchId,
    }, request);
    return { statusCode: 200, bodyType: "json", body: { accepted } };
  },
});
