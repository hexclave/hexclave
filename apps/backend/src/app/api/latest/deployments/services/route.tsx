import { HEXCLAVE_SERVICE_ID, assertServicesAllowedByPlan, getOrCreateDeploymentSource, listServiceRows, serviceToApiShape, syncSourceServices, tearDownServices } from "@/lib/deployments";
import { runtimeForRequestedVersion } from "@/lib/deployments/runtime";
import { getPrismaClientForTenancy, retryTransaction } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { DEPLOYMENT_SOURCE_ID_REGEX, MAX_DEPLOYMENT_SOURCE_ID_LENGTH, deploymentBuilderDefinitionSchema, deploymentMemorySizesForType, deploymentServiceDefinitionSchema } from "@hexclave/shared/dist/deployments";
import { adaptSchema, serverOrHigherAuthTypeSchema, userSpecifiedIdSchema, yupArray, yupMixed, yupNumber, yupObject, yupRecord, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { randomUUID } from "node:crypto";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "List deployment services",
    description: "Lists every deployment service of the project, as last synced from a deploy file's `services` export, merged with its operational state (deploy status, env vars, domains). Services of every deployment source are listed together; each one reports the source that declares it.",
    tags: ["Deploy"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      items: yupArray(yupMixed().defined()).defined(),
    }).defined(),
  }),
  handler: async ({ auth }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const rows = await listServiceRows(prisma, auth.tenancy);
    const items = await Promise.all(rows.map(async (row) => await serviceToApiShape({ prisma, tenancy: auth.tenancy, row })));
    return {
      statusCode: 200,
      bodyType: "json",
      body: { items },
    };
  },
});

export const PUT = createSmartRouteHandler({
  metadata: {
    summary: "Sync a deployment source's service definitions",
    description: "Upserts the service definitions evaluated from ONE deploy file's `deploy` export, and removes the services that file no longer declares. Called by `hexclave deploy` before deploying. Scoped to the deployment source named by `source_id` (the deploy file's own `deploymentGroupId` export): services of other sources are never touched, which is what lets several repositories deploy into one project. A service id already owned by another source is refused. Removing a service tears down its containers but keeps its persistent volume and any custom domain, unattached.",
    tags: ["Deploy"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    body: yupObject({
      source_id: yupString()
        .defined()
        .max(MAX_DEPLOYMENT_SOURCE_ID_LENGTH, "deployment source ids may be at most ${max} characters long")
        .matches(DEPLOYMENT_SOURCE_ID_REGEX, "deployment source ids must contain only letters, numbers, underscores, dots, and hyphens (not starting with a dot or hyphen)"),
      services: yupRecord(
        userSpecifiedIdSchema("serviceId").notOneOf([HEXCLAVE_SERVICE_ID], `The service id ${JSON.stringify(HEXCLAVE_SERVICE_ID)} is reserved for the managed Hexclave service`),
        deploymentServiceDefinitionSchema.defined(),
      ).defined(),
      // The machine that BUILDS this source, as opposed to the machines its
      // services run on. One per source, so it is synced alongside the
      // definitions rather than per service — and inside the same fence, so a
      // deploy cannot pair one checkout's source with another's builder size.
      // Absent clears any size the source had pinned.
      builder: deploymentBuilderDefinitionSchema.optional(),
      // The deploy file's `version` export: an INTERNAL, undocumented token that selects
      // which infrastructure runtime the project's services run on. Absent is the default
      // runtime; an unknown token, or one this environment has not enabled, is refused —
      // see runtimeForRequestedVersion. Synced with the definitions so it rides the same
      // fence, and stored on the source.
      version: yupString().optional(),
    }).defined(),
    method: yupString().oneOf(["PUT"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      sync_id: yupString().uuid().defined(),
      removed_service_ids: yupArray(yupString().defined()).defined(),
      items: yupArray(yupMixed().defined()).defined(),
    }).defined(),
  }),
  handler: async ({ auth, body }) => {
    if (Object.keys(body.services).length === 0) {
      // An empty sync would REMOVE every service of this source, which is a
      // very different intent from "my deploy file has no services yet" — and
      // the latter is what an empty `services` export actually means.
      throw new StatusError(400, "The services record must contain at least one service. (Nothing to sync — the deploy file's `services` are empty.)");
    }
    const runtime = runtimeForRequestedVersion(body.version);
    // The wire schema accepts every size ANY runtime offers a type; this is where the
    // runtime is known, so this is where a size the project's runtime has no shape for is
    // refused — before the upload, and with the sizes that ARE available named.
    for (const [serviceId, definition] of Object.entries(body.services)) {
      if (definition.memory === undefined) continue;
      const available = deploymentMemorySizesForType(definition.type, runtime);
      if (!(available as readonly string[]).includes(definition.memory)) {
        throw new StatusError(400, `The memory size ${JSON.stringify(definition.memory)} of service ${JSON.stringify(serviceId)} is not available for a ${JSON.stringify(definition.type)} service on this project's runtime — it can be ${available.join(", ")}.`);
      }
    }
    await assertServicesAllowedByPlan(auth.tenancy, body.services, body.builder, runtime, body.source_id);
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const syncId = randomUUID();
    // One transaction: the sync detaches volumes before re-attaching them, so a
    // failure partway through would otherwise commit the detach and leave a
    // service silently volume-less on its next deploy.
    //
    // SERIALIZABLE, like the deployment-create route. The detach-then-attach spans several
    // writes against the (tenancyId, serviceId) unique index on volumes, so two concurrent
    // syncs moving one disk between services interleave into a constraint violation — a 500
    // on a sync that is perfectly valid against the state it would have seen. At this level
    // the loser gets a serialization failure that retryTransaction retries against the
    // committed newer state instead.
    const { removedServiceIds } = await retryTransaction(prisma, async (transaction) => {
      const source = await getOrCreateDeploymentSource(transaction, auth.tenancy, body.source_id);
      return await syncSourceServices(transaction, auth.tenancy, source, body.services, syncId, body.builder, runtime);
    }, { level: "serializable" });

    // AFTER the transaction: tearing down a container is not something a
    // database transaction can roll back, so it must not run inside one.
    await tearDownServices(auth.tenancy, removedServiceIds);

    const rows = await listServiceRows(prisma, auth.tenancy);
    const items = await Promise.all(rows.map(async (row) => await serviceToApiShape({ prisma, tenancy: auth.tenancy, row })));
    return {
      statusCode: 200,
      bodyType: "json",
      body: { sync_id: syncId, removed_service_ids: removedServiceIds, items },
    };
  },
});
