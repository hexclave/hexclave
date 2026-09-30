import { createDataSource, listDataSources } from "@/lib/data-sources";
import { serializeCatalog, serializeDataSource } from "@/lib/data-sources/serialize";
import { DATA_SOURCE_SSL_MODES } from "@/lib/data-sources/postgres";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

// Connects out to the customer's database under a 120s statement timeout per
// stream, so it needs more than the platform default.
export const maxDuration = 300;

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "List data sources",
    description: "Returns every source configured for this project, with the streams each one syncs.",
    tags: ["Data Warehouse"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ data_sources: yupMixed().defined() }).defined(),
  }),
  handler: async ({ auth }) => ({
    statusCode: 200,
    bodyType: "json",
    body: { data_sources: (await listDataSources(auth.tenancy)).map(serializeDataSource) },
  }),
});

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Connect a data source",
    description: "Verifies the credentials, reads the source's catalog, and stores the connection. The password is encrypted before it is written and is never returned.",
    tags: ["Data Warehouse"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
    body: yupObject({
      host: yupString().defined(),
      port: yupNumber().min(1).max(65535).defined(),
      database: yupString().defined(),
      username: yupString().defined(),
      password: yupString().defined(),
      ssl_mode: yupString().oneOf([...DATA_SOURCE_SSL_MODES]).default("require"),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      data_source: yupMixed().defined(),
      catalog: yupMixed().defined(),
    }).defined(),
  }),
  handler: async ({ auth, body }) => {
    const { source, probe } = await createDataSource(auth.tenancy, {
      host: body.host,
      port: body.port,
      database: body.database,
      username: body.username,
      password: body.password,
      sslMode: body.ssl_mode,
    });
    return {
      statusCode: 200,
      bodyType: "json",
      body: { data_source: serializeDataSource(source), catalog: serializeCatalog(probe) },
    };
  },
});
