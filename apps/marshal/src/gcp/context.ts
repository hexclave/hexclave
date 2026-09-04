import { getConfig } from "../config.js";
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
  const client = createGcpClient();
  const manager = new TenantProjectManager(client, {
    envId: config.envId,
    billingAccount: config.gcp.billingAccount,
    parent: config.gcp.projectParent,
    projectPrefix: config.gcp.projectPrefix,
  });
  const project = config.gcp.existingProjectIdForTests === null
    ? await tenantProjectForNamespace(ns, manager)
    : await manager.describeExistingProject(config.gcp.existingProjectIdForTests);
  const computeConfig = {
    projectId: project.projectId,
    region: config.gcp.region,
    zone: config.gcp.zone,
    network: config.gcp.network,
    subnetwork: config.gcp.subnetwork,
  };
  const compute = new ComputeClient(client, computeConfig);
  await compute.ensureNetwork();
  return {
    project,
    compute,
    cloudRun: new CloudRunClient(client, computeConfig),
    artifactRegistry: new ArtifactRegistryClient(client, project.projectId, config.gcp.region),
    domains: new DomainLoadBalancerClient(client, {
      tenantProjectId: project.projectId,
      platformProjectId: config.gcp.platformProjectId,
      environmentId: config.envId,
      region: config.gcp.region,
    }),
    logging: new GcpLoggingClient(client, project.projectId),
  };
}

export function resetTenantContextsForTests(): void {
  cachedContexts.clear();
}
