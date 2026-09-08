import { getServiceRowOrThrow, marshalNamespaceForTenancy } from "@/lib/deployments";
import { MarshalApiError, getMarshalClientOrThrow, getMarshalDeploymentsConfigOrNull, sanitizeMarshalError } from "@/lib/deployments/marshal-client";
import { Tenancy } from "@/lib/tenancies";
import { PrismaClientTransaction, getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, serverOrHigherAuthTypeSchema, userSpecifiedIdSchema, yupArray, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

const authSchema = yupObject({
  type: serverOrHigherAuthTypeSchema,
  tenancy: adaptSchema.defined(),
}).defined();

const paramsSchema = yupObject({
  service_id: userSpecifiedIdSchema("serviceId").defined(),
  hostname: yupString().defined().lowercase(),
}).defined();

// Domains are purely operational state, so the row is the source of truth
// (the service itself must still exist in the project's configuration).
async function findDomainRowOrThrow(prisma: PrismaClientTransaction, tenancy: Tenancy, serviceId: string, hostname: string) {
  const service = await prisma.deploymentService.findUnique({
    where: {
      tenancyId_serviceId: {
        tenancyId: tenancy.id,
        serviceId,
      },
    },
  });
  // Hostnames are unique per tenancy, so the lookup is by (tenancy, hostname) and the row
  // must additionally belong to THIS service — a hostname held by a sibling service is a 404
  // here, not someone else's row to read or delete.
  const domain = service == null ? null : await prisma.deploymentDomain.findFirst({
    where: {
      tenancyId: tenancy.id,
      serviceId,
      hostname,
    },
  });
  if (service == null || domain == null) {
    throw new StatusError(404, `The domain ${JSON.stringify(hostname)} is not configured on this service.`);
  }
  return { service, domain };
}

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Get deployment service domain",
    description: "Returns the verification state of a domain and the DNS records the user must create. Re-checks verification with the runtime on every read, so polling this endpoint picks up DNS changes.",
    tags: ["Deploy"],
    hidden: true,
  },
  request: yupObject({
    auth: authSchema,
    params: paramsSchema,
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      hostname: yupString().defined(),
      is_primary: yupBoolean().defined(),
      verified: yupBoolean().defined(),
      // True while the service has never been deployed: the runtime hasn't
      // been told about the domain yet, and the DNS targets (the app's IPs)
      // only exist once it has, so no records can be shown.
      pending_first_deploy: yupBoolean().defined(),
      dns_records: yupArray(yupObject({
        type: yupString().defined(),
        name: yupString().defined(),
        value: yupString().defined(),
      }).defined()).defined(),
    }).defined(),
  }),
  handler: async ({ auth, params }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    await getServiceRowOrThrow(prisma, auth.tenancy, params.service_id);
    const { service, domain } = await findDomainRowOrThrow(prisma, auth.tenancy, params.service_id, params.hostname);

    if (service.provisionedAt == null || getMarshalDeploymentsConfigOrNull() == null) {
      // Not provisioned yet: the runtime doesn't know the domain and its DNS
      // targets don't exist yet — deploy first.
      return {
        statusCode: 200,
        bodyType: "json",
        body: {
          hostname: params.hostname,
          is_primary: domain.isPrimary,
          verified: false,
          pending_first_deploy: true,
          dns_records: [],
        },
      } as const;
    }

    const client = getMarshalClientOrThrow();
    let result;
    try {
      // Safe for polling: Marshal may promote this tenancy's pending TXT proof, but it cannot
      // repoint an already claimed hostname. A PUT can repoint, so it must not be used here.
      result = await client.getDomain(marshalNamespaceForTenancy(auth.tenancy), params.hostname);
    } catch (e) {
      if (e instanceof MarshalApiError && e.status === 404) {
        // The runtime doesn't have this hostname attached (spec reset, or it is
        // attached to a different service); treat like pre-first-deploy so the
        // UI shows "deploy first" rather than a stale verified state.
        //
        // The CACHED flag has to be cleared too, not just the response: the service list and
        // detail endpoints read `verified` from the row, so leaving it true would keep them
        // advertising a custom URL that the runtime no longer routes.
        if (domain.verified) {
          await prisma.deploymentDomain.update({
            where: { tenancyId_id: { tenancyId: auth.tenancy.id, id: domain.id } },
            data: { verified: false },
          });
        }
        return {
          statusCode: 200,
          bodyType: "json",
          body: {
            hostname: params.hostname,
            is_primary: domain.isPrimary,
            verified: false,
            pending_first_deploy: true,
            dns_records: [],
          },
        } as const;
      }
      sanitizeMarshalError(e, "Checking the domain failed");
    }

    // The runtime holds one claim per hostname, so it can legitimately answer with a
    // DIFFERENT service than the one being read (a repoint, or a duplicate row predating the
    // per-tenancy uniqueness constraint). This service does not own the certificate in that
    // case, so it must not report the other service's verification state as its own.
    if (result.service_key !== params.service_id) {
      await prisma.deploymentDomain.update({
        where: { tenancyId_id: { tenancyId: auth.tenancy.id, id: domain.id } },
        data: { verified: false },
      });
      return {
        statusCode: 200,
        bodyType: "json",
        body: {
          hostname: params.hostname,
          is_primary: domain.isPrimary,
          verified: false,
          pending_first_deploy: true,
          dns_records: [],
        },
      } as const;
    }

    await prisma.deploymentDomain.update({
      where: { tenancyId_id: { tenancyId: auth.tenancy.id, id: domain.id } },
      data: { verified: result.verified },
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        hostname: params.hostname,
        is_primary: domain.isPrimary,
        verified: result.verified,
        pending_first_deploy: false,
        // Once verified there is nothing left for the user to create; while pending, the records
        // include both Hexclave's ownership TXT proof and the shared frontend routing record.
        dns_records: result.verified ? [] : result.dns_records,
      },
    };
  },
});

export const DELETE = createSmartRouteHandler({
  metadata: {
    summary: "Remove domain from deployment service",
    description: "Removes a domain from a deployment service (runtime and operational state). The service stays running and internally reachable; its public IPs are released when the last domain is removed.",
    tags: ["Deploy"],
    hidden: true,
  },
  request: yupObject({
    auth: authSchema,
    params: paramsSchema,
    method: yupString().oneOf(["DELETE"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      success: yupBoolean().oneOf([true]).defined(),
    }).defined(),
  }),
  handler: async ({ auth, params }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    await getServiceRowOrThrow(prisma, auth.tenancy, params.service_id);
    const { service, domain } = await findDomainRowOrThrow(prisma, auth.tenancy, params.service_id, params.hostname);

    // A provisioned service may hold a GLOBAL hostname claim in the runtime, and
    // this row is the only record that this project owns it. Deleting the row
    // while the claim survives strands the hostname: it blocks every future
    // attachment, and the API that could release it only reaches claims it can
    // still find a row for. So refuse rather than delete a row we cannot back
    // with cleanup — the claim outlives the request, the row must too.
    if (service.provisionedAt != null && getMarshalDeploymentsConfigOrNull() == null) {
      throw new StatusError(400, `The domain ${JSON.stringify(params.hostname)} cannot be removed right now: deployments are not configured on this Hexclave instance, so its certificate and hostname claim in the deployment runtime cannot be released. Configure HEXCLAVE_MARSHAL_API_KEY (and HEXCLAVE_MARSHAL_URL) and try again.`);
    }
    if (service.provisionedAt != null) {
      try {
        // Scoped to this service on purpose: the runtime's hostname claim is global, so an
        // unscoped delete would tear down the certificate of whichever service currently owns
        // the hostname — which is not necessarily this one.
        await getMarshalClientOrThrow().deleteDomain(marshalNamespaceForTenancy(auth.tenancy), params.hostname, params.service_id);
      } catch (e) {
        // Already detached on the runtime, never attached, or held by another
        // service — deleting this service's row is still correct.
        if (!(e instanceof MarshalApiError && e.status === 404)) {
          sanitizeMarshalError(e, "Removing the domain failed");
        }
      }
    }
    await prisma.deploymentDomain.deleteMany({
      where: {
        tenancyId: auth.tenancy.id,
        id: domain.id,
      },
    });
    return {
      statusCode: 200,
      bodyType: "json",
      body: { success: true },
    };
  },
});
