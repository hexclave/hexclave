import { refreshDataSourceProbe } from "@/lib/data-sources";
import { serializeCatalog } from "@/lib/data-sources/serialize";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

// Connects out to the customer's database under a 120s statement timeout per
// stream, so it needs more than the platform default.
export const maxDuration = 300;

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Read a data source's catalog",
    description: "Re-reads the source's tables and capabilities. Run on every visit to the table picker, so a customer who enables logical replication later is offered change data capture without reconnecting.",
    tags: ["Data Warehouse"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({ type: adminAuthTypeSchema, tenancy: adaptSchema.defined() }).defined(),
    params: yupObject({ data_source_id: yupString().defined() }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ catalog: yupMixed().defined() }).defined(),
  }),
  handler: async ({ auth, params }) => ({
    statusCode: 200,
    bodyType: "json",
    body: { catalog: serializeCatalog(await refreshDataSourceProbe(auth.tenancy, params.data_source_id)) },
  }),
});
