import { gcpConfig, getConfig } from "../config.js";
import { tenantProjectForNamespace } from "../project-pool.js";
import { CloudRunClient } from "./cloud-run.js";
import { ComputeClient } from "./compute.js";
import { createGcpClient, createTenantProjectManager } from "./manager.js";
import { TenantProjectManager, type TenantProject } from "./projects.js";
import { ArtifactRegistryClient } from "./artifact-registry.js";
import { DomainLoadBalancerClient } from "./domains.js";
import { GcpLoggingClient } from "./logging.js";

export type TenantContext = {
  project: TenantProject,
  cloudRun: CloudRunClient,
  compute: ComputeClient,
  artifactRegistry: ArtifactRegistryClient,
  domains: DomainLoadBalancerClient,
  logging: GcpLoggingClient,
};

const cachedContexts = new Map<string, Promise<TenantContext>>();

export async function tenantContext(ns: string): Promise<TenantContext> {
  const cached = cachedContexts.get(ns);
  if (cached !== undefined) return await cached;
  const created = createTenantContext(ns);
  cachedContexts.set(ns, created);
  try {
    return await created;
  } catch (error) {
    cachedContexts.delete(ns);
    throw error;
  }
}

async function createTenantContext(ns: string): Promise<TenantContext> {
  const config = getConfig();
  const gcp = gcpConfig();
  const client = createGcpClient();
  const manager = new TenantProjectManager(client, {
    envId: config.envId,
    billingAccount: gcp.billingAccount,
    parent: gcp.projectParent,
    projectPrefix: gcp.projectPrefix,
  });
  const project = gcp.existingProjectIdForTests === null
    ? await tenantProjectForNamespace(ns, manager)
    : await manager.describeExistingProject(gcp.existingProjectIdForTests);
  const computeConfig = {
    projectId: project.projectId,
    region: gcp.region,
    zone: gcp.zone,
    network: gcp.network,
    subnetwork: gcp.subnetwork,
  };
  const compute = new ComputeClient(client, computeConfig);
  await compute.ensureNetwork();
  return {
    project,
    compute,
    cloudRun: new CloudRunClient(client, computeConfig),
    artifactRegistry: new ArtifactRegistryClient(client, project.projectId, gcp.region),
    domains: new DomainLoadBalancerClient(client, {
      tenantProjectId: project.projectId,
      platformProjectId: gcp.platformProjectId,
      environmentId: config.envId,
      region: gcp.region,
    }),
    logging: new GcpLoggingClient(client, project.projectId),
  };
}

export function resetTenantContextsForTests(): void {
  cachedContexts.clear();
}
