import { deploymentToApiShape } from "@/lib/deployments";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

// Runs are loaded with the service id they belong to so the response can report
// the deployment's services without a second query per run.
const DEPLOYMENT_INCLUDE = { source: { select: { sourceId: true } } } as const;

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Conclude deployment",
    description: "Marks a deployment as no longer being worked on by the client that created it. A deployment the runtime never accepted reads as still in flight — correct while `hexclave deploy` is still packaging and uploading, but wrong once the client has given up. `hexclave deploy` calls this when it stops, so a deploy that died before the upload finished becomes terminal instead of polling forever.",
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
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupMixed().defined(),
  }),
  handler: async ({ auth, params }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    // Purely the existence check for the 404 — whether it is ALREADY concluded is decided by
    // the conditional write below, not here.
    const existing = await prisma.deployment.findUnique({
      where: { tenancyId_id: { tenancyId: auth.tenancy.id, id: params.deployment_id } },
      select: { id: true },
    });
    if (existing == null) {
      throw new StatusError(404, `No deployment with id ${JSON.stringify(params.deployment_id)} exists in this project.`);
    }
    // IDEMPOTENT, and the first conclusion wins. A retried CLI request (or a
    // second `hexclave deploy` handed the same id) must not move the timestamp:
    // it is used as the finish time for a deployment that never reached the
    // runtime at all,
    // so overwriting it would stretch a finished deploy's duration on every
    // retry. Progress reported after this point still counts — the column only
    // says "the client stopped", never "ignore what arrives later".
    //
    // The null check is part of the WRITE PREDICATE, not a read-then-write: two concurrent
    // concludes both pass a separate `existing.concludedAt === null` check and the second
    // overwrites the first's timestamp, which is exactly the stretch this is meant to
    // prevent. updateMany matches zero rows for the loser instead.
    await prisma.deployment.updateMany({
      where: { tenancyId: auth.tenancy.id, id: params.deployment_id, concludedAt: null },
      data: { concludedAt: new Date() },
    });
    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { tenancyId_id: { tenancyId: auth.tenancy.id, id: params.deployment_id } },
      include: DEPLOYMENT_INCLUDE,
    });
    return {
      statusCode: 200,
      bodyType: "json",
      body: deploymentToApiShape(deployment),
    };
  },
});
