import { getDataWarehouse, getDataWarehouseConnectionInfo, getDataWarehouseNames } from "@/lib/data-warehouse";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Get data warehouse",
    description: "Returns the project's ClickHouse data warehouse and the details needed to connect to it. Never returns the password — that is shown only when provisioning or rotating.",
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
    body: yupObject({
      status: yupString().oneOf(["not_provisioned", "provisioning", "ready", "failed"]).defined(),
      database_name: yupString().nullable().defined(),
      username: yupString().nullable().defined(),
      error: yupString().nullable().defined(),
      password_updated_at_millis: yupNumber().nullable().defined(),
      connection: yupObject({
        host: yupString().defined(),
        https_port: yupNumber().defined(),
        native_port: yupNumber().defined(),
      }).defined(),
    }).defined(),
  }),
  handler: async ({ auth }) => {
    const warehouse = await getDataWarehouse(auth.tenancy);
    const connection = getDataWarehouseConnectionInfo();
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        status: warehouse == null ? "not_provisioned" as const : ({
          PROVISIONING: "provisioning" as const,
          READY: "ready" as const,
          FAILED: "failed" as const,
        }[warehouse.status]),
        // Predictable before provisioning, so the dashboard can name the database up front.
        database_name: warehouse?.databaseName ?? getDataWarehouseNames(auth.tenancy.project.id).databaseName,
        username: warehouse?.userName ?? null,
        error: warehouse?.error ?? null,
        password_updated_at_millis: warehouse?.passwordUpdatedAt?.getTime() ?? null,
        connection: {
          host: connection.host,
          https_port: connection.httpsPort,
          native_port: connection.nativePort,
        },
      },
    };
  },
});
