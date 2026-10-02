import { getServiceRowOrThrow, serviceToApiShape } from "@/lib/deployments";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, serverOrHigherAuthTypeSchema, userSpecifiedIdSchema, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

// Note: services are read-only through this API. Definitions are synced from
// the deploy file's `deploy` export by `hexclave deploy` (see the collection
// route's PUT); there is deliberately no PATCH/DELETE — the deploy file is the
// single source of truth, and removal/cleanup is handled out-of-band.

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Get deployment service",
    description: "Returns a deployment service definition (as last synced from the deploy file) merged with its operational state.",
    tags: ["Deploy"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      service_id: userSpecifiedIdSchema("serviceId").defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupMixed().defined(),
  }),
  handler: async ({ auth, params }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const row = await getServiceRowOrThrow(prisma, auth.tenancy, params.service_id);
    return {
      statusCode: 200,
      bodyType: "json",
      body: await serviceToApiShape({ prisma, tenancy: auth.tenancy, row }),
    };
  },
});
