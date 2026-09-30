import { syncDataSource } from "@/lib/data-sources";
import { serializeDataSource } from "@/lib/data-sources/serialize";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

// Connects out to the customer's database under a 120s statement timeout per
// stream, so it needs more than the platform default.
export const maxDuration = 300;

// Leaves room to serialize the response and for the platform's own shutdown.
const SYNC_DEADLINE_MS = (maxDuration - 20) * 1000;

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Sync a data source now",
    description: "Runs every configured stream once. One stream failing does not stop the others; each carries its own error.",
    tags: ["Data Warehouse"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({ type: adminAuthTypeSchema, tenancy: adaptSchema.defined() }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
    params: yupObject({ data_source_id: yupString().defined() }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ data_source: yupMixed().defined() }).defined(),
  }),
  handler: async ({ auth, params }) => ({
    statusCode: 200,
    bodyType: "json",
    body: { data_source: serializeDataSource(await syncDataSource(auth.tenancy, params.data_source_id, { deadlineMs: Date.now() + SYNC_DEADLINE_MS })) },
  }),
});
