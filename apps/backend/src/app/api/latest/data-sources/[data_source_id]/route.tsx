import { deleteDataSource, getDataSourceOrThrow } from "@/lib/data-sources";
import { serializeDataSource } from "@/lib/data-sources/serialize";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

const paramsSchema = yupObject({
  data_source_id: yupString().defined(),
}).defined();

export const GET = createSmartRouteHandler({
  metadata: { summary: "Get data source", tags: ["Data Warehouse"], hidden: true },
  request: yupObject({
    auth: yupObject({ type: adminAuthTypeSchema, tenancy: adaptSchema.defined() }).defined(),
    params: paramsSchema,
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ data_source: yupMixed().defined() }).defined(),
  }),
  handler: async ({ auth, params }) => ({
    statusCode: 200,
    bodyType: "json",
    body: { data_source: serializeDataSource(await getDataSourceOrThrow(auth.tenancy, params.data_source_id)) },
  }),
});

export const DELETE = createSmartRouteHandler({
  metadata: {
    summary: "Disconnect a data source",
    description: "Drops the replication slot on the source if one was created, and forgets the connection. Tables already synced into the warehouse are left in place.",
    tags: ["Data Warehouse"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({ type: adminAuthTypeSchema, tenancy: adaptSchema.defined() }).defined(),
    method: yupString().oneOf(["DELETE"]).defined(),
    params: paramsSchema,
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["success"]).defined(),
  }),
  handler: async ({ auth, params }) => {
    await deleteDataSource(auth.tenancy, params.data_source_id);
    return { statusCode: 200, bodyType: "success" };
  },
});
