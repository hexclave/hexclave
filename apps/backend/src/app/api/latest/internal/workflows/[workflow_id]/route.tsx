import { deleteWorkflow, setWorkflowPaused } from "@/lib/workflows/api";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const PATCH = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    // Admin-only, like every other route that writes a WorkflowDefinition
    // (create, source, delete). Server keys get the run-level and event verbs;
    // disabling a workflow project-wide is not one of them.
    auth: yupObject({
      type: yupString().oneOf(["admin"]).defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      workflow_id: yupString().defined(),
    }).defined(),
    body: yupObject({
      is_paused: yupBoolean().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      workflow_id: yupString().defined(),
      is_paused: yupBoolean().defined(),
      paused_at_millis: yupNumber().nullable().defined(),
    }).defined(),
  }),
  async handler({ auth: { tenancy }, params, body }) {
    const result = await setWorkflowPaused(tenancy, params.workflow_id, body.is_paused);
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        workflow_id: params.workflow_id,
        is_paused: result.isPaused,
        paused_at_millis: result.pausedAtMillis,
      },
    };
  },
});

export const DELETE = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: yupString().oneOf(["admin"]).defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      workflow_id: yupString().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["success"]).defined(),
  }),
  async handler({ auth: { tenancy }, params }) {
    await deleteWorkflow(tenancy, params.workflow_id);
    return {
      statusCode: 200,
      bodyType: "success",
    };
  },
});
