import { setDataSourceStreams } from "@/lib/data-sources";
import { serializeDataSource } from "@/lib/data-sources/serialize";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { DATA_SOURCE_SYNC_MODES } from "@hexclave/shared/dist/data-sources/modes";
import { adaptSchema, adminAuthTypeSchema, yupArray, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

// Connects out to the customer's database under a 120s statement timeout per
// stream, so it needs more than the platform default.
export const maxDuration = 300;

export const PUT = createSmartRouteHandler({
  metadata: {
    summary: "Configure which tables a data source syncs",
    description: "Replaces the stream list wholesale. Modes are re-validated against a fresh probe, so a mode the picker offered but the source can no longer support is rejected rather than silently downgraded.",
    tags: ["Data Warehouse"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({ type: adminAuthTypeSchema, tenancy: adaptSchema.defined() }).defined(),
    method: yupString().oneOf(["PUT"]).defined(),
    params: yupObject({ data_source_id: yupString().defined() }).defined(),
    body: yupObject({
      streams: yupArray(yupObject({
        schema_name: yupString().defined(),
        table_name: yupString().defined(),
        mode: yupString().oneOf([...DATA_SOURCE_SYNC_MODES]).defined(),
        cursor_column: yupString().nullable().default(null),
      }).defined()).defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ data_source: yupMixed().defined() }).defined(),
  }),
  handler: async ({ auth, params, body }) => {
    const source = await setDataSourceStreams(
      auth.tenancy,
      params.data_source_id,
      body.streams.map(stream => ({
        schemaName: stream.schema_name,
        tableName: stream.table_name,
        mode: stream.mode,
        cursorColumn: stream.cursor_column ?? null,
      })),
    );
    return { statusCode: 200, bodyType: "json", body: { data_source: serializeDataSource(source) } };
  },
});
