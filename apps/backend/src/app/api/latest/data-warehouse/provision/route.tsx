import { getDataWarehouseConnectionInfo, provisionDataWarehouse } from "@/lib/data-warehouse";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Provision data warehouse",
    description: "Creates a ClickHouse database for the project along with a user that has read/write access to it. The password is returned once and cannot be retrieved again; use the rotate endpoint to issue a new one.",
    tags: ["Data Warehouse"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      database_name: yupString().defined(),
      username: yupString().defined(),
      password: yupString().defined(),
      password_updated_at_millis: yupNumber().defined(),
      connection: yupObject({
        host: yupString().defined(),
        https_port: yupNumber().defined(),
        native_port: yupNumber().defined(),
      }).defined(),
    }).defined(),
  }),
  handler: async ({ auth }) => {
    // Read connection metadata first: a malformed port must not fail the response
    // after provisioning, discarding the only copy of the password.
    const connection = getDataWarehouseConnectionInfo();
    const { password, warehouse } = await provisionDataWarehouse(auth.tenancy);
    const passwordUpdatedAtMillis = warehouse.passwordUpdatedAt?.getTime();
    if (passwordUpdatedAtMillis == null) {
      throw new HexclaveAssertionError("A newly provisioned Data Warehouse must have passwordUpdatedAt");
    }
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        database_name: warehouse.databaseName,
        username: warehouse.userName,
        password,
        password_updated_at_millis: passwordUpdatedAtMillis,
        connection: {
          host: connection.host,
          https_port: connection.httpsPort,
          native_port: connection.nativePort,
        },
      },
    };
  },
});
