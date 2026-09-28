import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GcpApiError, GcpClient, parseGcpOperation } from "./client.js";

const TENANT_APIS = [
  "artifactregistry.googleapis.com",
  "compute.googleapis.com",
  "iam.googleapis.com",
  "logging.googleapis.com",
  "run.googleapis.com",
];

export type TenantProjectConfig = {
  envId: string,
  billingAccount: string,
  parent: string | null,
  projectPrefix: string,
  additionalApis?: string[],
};

export type TenantProject = {
  projectId: string,
  projectNumber: string,
};

type ProjectResource = {
  name: string,
  projectId: string,
  state: string,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProject(value: unknown): ProjectResource {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.projectId !== "string" || typeof value.state !== "string") {
    throw new Error("Google Cloud returned an invalid project resource");
  }
  return { name: value.name, projectId: value.projectId, state: value.state };
}

function projectNumberFromName(name: string): string {
  const match = /^projects\/([0-9]+)$/.exec(name);
  if (match === null) throw new Error(`Google Cloud returned invalid project resource name ${JSON.stringify(name)}`);
  return match[1];
}

function sanitizeProjectFragment(value: string, maxLength: number): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (sanitized === "" ? "x" : sanitized).slice(0, maxLength).replace(/-$/, "x");
}

export function projectIdForNamespace(config: Pick<TenantProjectConfig, "envId" | "projectPrefix">, ns: string): string {
  return `${projectIdPrefix(config)}-${createHash("sha256").update(`${config.envId}\0${ns}`).digest("hex").slice(0, 16)}`.slice(0, 30).replace(/-$/, "0");
}

// The prefix every Marshal-managed project id starts with, and the only one
// deleteDisposableProject will tear down.
export function projectIdPrefix(config: Pick<TenantProjectConfig, "envId" | "projectPrefix">): string {
  const configuredPrefix = sanitizeProjectFragment(config.projectPrefix, 8);
  const prefix = /^[a-z]/.test(configuredPrefix) ? configuredPrefix : `h${configuredPrefix}`.slice(0, 8);
  return prefix;
}

function projectEnvFragment(config: Pick<TenantProjectConfig, "envId">): string {
  return sanitizeProjectFragment(config.envId, 4);
}

// A fresh id for a pooled (pre-provisioned) project: unlike projectIdForNamespace it is
// NOT derived from the namespace, because the whole point of the pool is that projects
// exist before any tenant is known. Uniqueness comes from randomness; the assignment
// mapping in the store provides the per-namespace determinism instead.
export function pooledProjectId(config: Pick<TenantProjectConfig, "envId" | "projectPrefix">): string {
  const id = `${projectIdPrefix(config)}-${projectEnvFragment(config)}-${randomBytes(6).toString("hex")}`.slice(0, 30);
  return id.replace(/-$/, "0");
}

function normalizeBillingAccount(value: string): string {
  return value.startsWith("billingAccounts/") ? value : `billingAccounts/${value}`;
}

// A newly ACTIVE Resource Manager project can briefly be unknown to Cloud Billing. This
// matches ONLY its exact readiness response, so account and permission failures stay loud —
// the check is deliberately narrow and must stay that way.
//
// The status and message alone are NOT narrow enough: Cloud Billing answers a permanently
// exhausted billing-account project quota with the very same `400 "Precondition check
// failed."`, and only the `QuotaFailure` in `error.details` separates it from a project that
// is merely not visible yet. Treating that as propagation parks the pool forever on a
// condition no amount of waiting fixes, reporting "Cloud Billing has not accepted the project
// yet" while the real answer is that the account needs a quota increase.
function isBillingPropagationError(error: unknown): boolean {
  return error instanceof GcpApiError
    && error.status === 400
    && error.providerMessage === "Precondition check failed."
    && !error.providerDetailTypes.includes("google.rpc.QuotaFailure");
}

const inFlightProjects = new Map<string, Promise<TenantProject>>();

export class TenantProjectManager {
  constructor(
    private readonly client: GcpClient,
    private readonly config: TenantProjectConfig,
  ) {}

  async ensureForNamespace(ns: string): Promise<TenantProject> {
    const projectId = projectIdForNamespace(this.config, ns);
    const existing = inFlightProjects.get(projectId);
    if (existing !== undefined) return await existing;
    const provisioning = this.provisionProject(projectId, `Hexclave tenant ${sanitizeProjectFragment(ns, 14)}`);
    inFlightProjects.set(projectId, provisioning);
    try {
      return await provisioning;
    } finally {
      inFlightProjects.delete(projectId);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-state provisioning steps.
  //
  // The pool advancer (src/project-pool.ts) drives these one resume point at a time, because
  // it runs on a cron in a serverless function that is frozen at response time and therefore
  // cannot hold a multi-minute wait. provisionProject below composes the same steps for the
  // lazy per-namespace path, which IS a synchronous request and keeps its blocking waits.

  // Idempotent. Creates the project if Resource Manager does not have it and returns the
  // project number once it is ACTIVE. The caller must already have recorded its intent to
  // create this id: a create that succeeds and is never recorded is an invisible billed
  // project.
  async ensureProjectActive(projectId: string, displayName: string): Promise<string> {
    let project = await this.findProject(projectId);
    if (project === null) {
      const body = {
        projectId,
        displayName,
        labels: {
          "hexclave-environment": sanitizeProjectFragment(this.config.envId, 63),
          "hexclave-managed": "true",
        },
        ...(this.config.parent === null ? {} : { parent: this.config.parent }),
      };
      let created: unknown = null;
      try {
        created = await this.client.request("https://cloudresourcemanager.googleapis.com/v3/projects", { method: "POST", body });
      } catch (error) {
        // findProject reads projects:search, which is eventually consistent and can still be
        // omitting a project that exists — including one an earlier attempt of this very
        // provision created. Resource Manager answers that create with ALREADY_EXISTS, so the
        // project is there and waiting for it is the whole remaining job.
        if (!(error instanceof GcpApiError && error.status === 409)) throw error;
      }
      if (created !== null) await this.client.waitForOperation(parseGcpOperation(created));
      project = await this.waitForActiveProject(projectId);
    } else if (project.state !== "ACTIVE") {
      project = await this.waitForActiveProject(projectId);
    }
    return projectNumberFromName(project.name);
  }

  // ONE billing PUT. Returns false when Cloud Billing does not know the project yet — the
  // pool's only genuinely slow wait, and the reason billing_pending exists as a resume point.
  // Every other failure throws, so a wrong account or a missing role stays loud.
  async attachBillingOnce(projectId: string): Promise<boolean> {
    try {
      await this.putBillingInfo(projectId);
      return true;
    } catch (error) {
      if (!isBillingPropagationError(error)) throw error;
      return false;
    }
  }

  // Starts (or restarts) API enablement and returns the operation name to poll later.
  async beginEnableApis(projectId: string): Promise<string> {
    const serviceIds = [...new Set([...TENANT_APIS, ...(this.config.additionalApis ?? [])])];
    const result = await this.client.request(`https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/services:batchEnable`, {
      method: "POST",
      body: { serviceIds },
    });
    return parseGcpOperation(result).name;
  }

  async isEnableApisDone(operationName: string): Promise<boolean> {
    const operation = await this.client.pollOperation(operationName, { apiBaseUrl: "https://serviceusage.googleapis.com/v1/" });
    return operation.done === true;
  }

  // Service identity plus the runtime bindings. Seconds, and idempotent, so the advancer runs
  // it inline rather than parking on it.
  async ensureProjectIam(projectId: string, projectNumber: string): Promise<void> {
    await this.ensureServiceIdentity(projectNumber, "run.googleapis.com");
    await this.ensureRuntimeIam(projectId, projectNumber);
  }

  // The project side of describing an already-provisioned project: no provisioning, only
  // existence, state, and the project number everything downstream keys off.
  async describeActiveProject(projectId: string): Promise<TenantProject> {
    const project = await this.findProject(projectId);
    if (project === null) throw new Error(`tenant GCP project ${JSON.stringify(projectId)} does not exist or is not visible`);
    if (project.state !== "ACTIVE") throw new Error(`tenant GCP project ${JSON.stringify(projectId)} is not active`);
    return { projectId, projectNumber: projectNumberFromName(project.name) };
  }

  async describeExistingProject(projectId: string): Promise<TenantProject> {
    const project = await this.findProject(projectId);
    if (project === null) throw new Error(`configured existing GCP test project ${JSON.stringify(projectId)} does not exist or is not visible`);
    if (project.state !== "ACTIVE") throw new Error(`configured existing GCP test project ${JSON.stringify(projectId)} is not active`);
    return { projectId, projectNumber: projectNumberFromName(project.name) };
  }

  private async findProject(projectId: string): Promise<ProjectResource | null> {
    // Resource Manager deliberately permission-hides unknown project IDs behind a 403
    // for projects.get. Search returns an empty result instead, so a provisioner with
    // parent-level projectCreator can distinguish "not created yet" without requiring
    // global visibility into unrelated projects.
    const result = await this.client.request(`https://cloudresourcemanager.googleapis.com/v3/projects:search?query=${encodeURIComponent(`id:${projectId}`)}`);
    if (!isRecord(result) || (result.projects !== undefined && !Array.isArray(result.projects))) {
      throw new Error("Google Cloud returned an invalid project search result");
    }
    if (!Array.isArray(result.projects)) return null;
    const matches = result.projects.map(parseProject).filter((project) => project.projectId === projectId);
    if (matches.length > 1) throw new Error(`Google Cloud returned multiple projects for exact project ID ${JSON.stringify(projectId)}`);
    return matches[0] ?? null;
  }

  private async getProject(projectId: string): Promise<ProjectResource | null> {
    const result = await this.client.request(`https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(projectId)}`, { allow404: true });
    return result === null ? null : parseProject(result);
  }

  // Idempotent and full: whatever a tenant project needs to host runtimes — existence,
  // billing, APIs, service identity, runtime IAM — is ensured here. Safe to re-run on an
  // already-provisioned project, which is how a pooled project is claimed with zero GCP
  // work and how the lazy fallback provisions one from scratch.
  private async provisionProject(projectId: string, displayName: string): Promise<TenantProject> {
    const projectNumber = await this.ensureProjectActive(projectId, displayName);
    await this.waitForBilling(projectId);
    await this.client.waitForOperation({ name: await this.beginEnableApis(projectId) }, {
      apiBaseUrl: "https://serviceusage.googleapis.com/v1/",
      timeoutMillis: 10 * 60 * 1000,
    });
    await this.ensureProjectIam(projectId, projectNumber);
    return { projectId, projectNumber };
  }

  private async waitForActiveProject(projectId: string): Promise<ProjectResource> {
    const startedAt = performance.now();
    for (;;) {
      const project = await this.getProject(projectId);
      if (project !== null && project.state === "ACTIVE") return project;
      if (performance.now() - startedAt > 2 * 60 * 1000) throw new GcpApiError(408, `projects/${projectId}`, "timed out waiting for the tenant project to become active");
      await delay(1000);
    }
  }

  private async putBillingInfo(projectId: string): Promise<void> {
    await this.client.request(`https://cloudbilling.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/billingInfo`, {
      method: "PUT",
      body: { billingAccountName: normalizeBillingAccount(this.config.billingAccount) },
    });
  }

  // The blocking form, for the LAZY per-namespace path only: that path runs inside a request
  // that must return a usable project, so it has nowhere to yield to. The pool never calls
  // this — it parks in billing_pending between cron ticks instead, which is the whole point
  // of the state machine.
  private async waitForBilling(projectId: string): Promise<void> {
    const startedAt = performance.now();
    let retryDelayMillis = 1000;
    for (;;) {
      if (await this.attachBillingOnce(projectId)) return;
      // "Briefly" does heavy lifting in isBillingPropagationError: on reseller/offline-billing
      // organizations the window is regularly longer than ten minutes, so the patience here
      // has to exceed any realistic propagation delay.
      if (performance.now() - startedAt > 20 * 60 * 1000) {
        throw new GcpApiError(408, `projects/${projectId}/billingInfo`, "timed out waiting for Cloud Billing to accept the newly created project");
      }
      await delay(retryDelayMillis);
      retryDelayMillis = Math.min(retryDelayMillis * 2, 30_000);
    }
  }

  private async ensureServiceIdentity(projectNumber: string, service: string): Promise<void> {
    const result = await this.client.request(`https://serviceusage.googleapis.com/v1beta1/projects/${projectNumber}/services/${service}:generateServiceIdentity`, { method: "POST", body: {} });
    if (isRecord(result) && typeof result.name === "string") {
      const operation = parseGcpOperation(result);
      // Service Usage uses this sentinel when the identity already exists. It is a
      // completed operation marker, not an operation ID accepted by operations.get.
      if (operation.name === "operations/finished.DONE_OPERATION") return;
      await this.client.waitForOperation(operation, { apiBaseUrl: "https://serviceusage.googleapis.com/v1beta1/" });
    }
  }

  private async ensureRuntimeIam(projectId: string, projectNumber: string): Promise<void> {
    const policyValue = await this.client.request(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}:getIamPolicy`, {
      method: "POST",
      body: { options: { requestedPolicyVersion: 3 } },
    });
    if (!isRecord(policyValue)) throw new Error(`Google Cloud returned an invalid IAM policy for project ${projectId}`);
    const defaultComputeMember = `serviceAccount:${projectNumber}-compute@developer.gserviceaccount.com`;
    const existingBindings = (Array.isArray(policyValue.bindings) ? policyValue.bindings : []).map((binding) => {
      if (!isRecord(binding) || binding.role !== "roles/editor" || !Array.isArray(binding.members)) return binding;
      // Older organizations can still grant Editor automatically to the default Compute SA.
      // Never preserve that project-wide privilege for tenant-controlled runtime code.
      return { ...binding, members: binding.members.filter((member) => member !== defaultComputeMember) };
    }).filter((binding) => !isRecord(binding) || !Array.isArray(binding.members) || binding.members.length > 0);
    const additions = [
      // TODO(security): split this into dedicated builder and runtime service accounts. The
      // metadata firewall prevents build steps from stealing the token, and Editor is removed
      // above, but runtime containers still do not need the builder's registry-write role.
      { role: "roles/artifactregistry.writer", member: defaultComputeMember },
      { role: "roles/logging.logWriter", member: defaultComputeMember },
      { role: "roles/compute.networkUser", member: `serviceAccount:service-${projectNumber}@serverless-robot-prod.iam.gserviceaccount.com` },
    ];
    const bindings = existingBindings.map((binding) => {
      if (!isRecord(binding) || typeof binding.role !== "string" || !Array.isArray(binding.members)) return binding;
      const addition = additions.find((candidate) => candidate.role === binding.role);
      if (addition === undefined || binding.members.includes(addition.member)) return binding;
      return { ...binding, members: [...binding.members, addition.member] };
    });
    for (const addition of additions) {
      const alreadyPresent = bindings.some((binding) => isRecord(binding) && binding.role === addition.role && Array.isArray(binding.members) && binding.members.includes(addition.member));
      if (!alreadyPresent) bindings.push({ role: addition.role, members: [addition.member] });
    }
    await this.client.request(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}:setIamPolicy`, {
      method: "POST",
      body: { policy: { ...policyValue, version: 3, bindings } },
    });
  }

  async deleteDisposableProject(projectId: string): Promise<void> {
    if (!projectId.startsWith(`${projectIdPrefix(this.config)}-`)) {
      throw new Error(`refusing to delete project ${JSON.stringify(projectId)} because it is outside Marshal's configured project prefix`);
    }
    let deleted: unknown | null;
    try {
      // Delete first because projects.search is eventually consistent and can briefly
      // omit a project that was just created during a failed provisioning attempt.
      deleted = await this.client.request(`https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(projectId)}`, { method: "DELETE", allow404: true });
    } catch (error) {
      if (!(error instanceof GcpApiError) || error.status !== 403) throw error;
      if (await this.findProject(projectId) !== null) throw error;
      return;
    }
    if (deleted !== null) await this.client.waitForOperation(parseGcpOperation(deleted));
  }
}

export function resetTenantProjectCacheForTests(): void {
  inFlightProjects.clear();
}
