import { deploymentToApiShape, isTerminalDeploymentStatus, refreshDeploymentFromMarshal } from "@/lib/deployments";
import { getMarshalDeploymentsConfigOrNull } from "@/lib/deployments/marshal-client";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Get deployment",
    description: "Reads one deployment: which deployment source it came from, its build status, and what each of its services did. Refreshed from the runtime on read while it is still in flight — this is what `hexclave deploy` polls.",
    tags: ["Deploy"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      deployment_id: yupString().uuid().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupMixed().defined(),
  }),
  handler: async ({ auth, params }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const include = { source: { select: { sourceId: true } } } as const;
    const deployment = await prisma.deployment.findUnique({
      where: { tenancyId_id: { tenancyId: auth.tenancy.id, id: params.deployment_id } },
      include,
    });
    if (deployment == null) {
      throw new StatusError(404, `No deployment with id ${JSON.stringify(params.deployment_id)} exists in this project.`);
    }
    // Poll-on-read: there is no background poller, so this request IS what
    // advances a deployment's status. A runtime error propagates here (unlike
    // in the listing, where one bad row must not take the page down) — the
    // caller is asking about this deployment specifically.
    if (!isTerminalDeploymentStatus(deployment.status) && getMarshalDeploymentsConfigOrNull() != null) {
      await refreshDeploymentFromMarshal(prisma, auth.tenancy, deployment);
    }
    const refreshed = await prisma.deployment.findUnique({
      where: { tenancyId_id: { tenancyId: auth.tenancy.id, id: params.deployment_id } },
      include,
    });
    if (refreshed == null) {
      throw new StatusError(404, `No deployment with id ${JSON.stringify(params.deployment_id)} exists in this project.`);
    }
    return {
      statusCode: 200,
      bodyType: "json",
      body: deploymentToApiShape(refreshed),
    };
  },
});
