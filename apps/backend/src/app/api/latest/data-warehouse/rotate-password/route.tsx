import { getDataWarehouseConnectionInfo, rotateDataWarehousePassword } from "@/lib/data-warehouse";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Rotate data warehouse password",
    description: "Issues a new password for the project's data warehouse user and returns it once. New connections must use the new password; an already-established native-protocol session authenticated with the old one is not terminated.",
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
    // Read connection metadata first, so a failure here cannot lose a password
    // ClickHouse has already activated.
    const connection = getDataWarehouseConnectionInfo();
    const { password, warehouse } = await rotateDataWarehousePassword(auth.tenancy);
    const passwordUpdatedAtMillis = warehouse.passwordUpdatedAt?.getTime();
    if (passwordUpdatedAtMillis == null) {
      throw new HexclaveAssertionError("A rotated Data Warehouse must have passwordUpdatedAt");
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
