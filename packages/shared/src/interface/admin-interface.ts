import * as yup from "yup";
import type { EnvironmentConfigOverrideOverride } from "../config/schema";
import type { DeploymentMemorySize, DeploymentSourceManifest } from "../deployments";
import { KnownErrors } from "../known-errors";
import { branchConfigSourceSchema, type ConfigAgentRunApi, type RestrictedReason } from "../schema-fields";
import { AccessToken, InternalSession, RefreshToken } from "../sessions";
import type { MoneyAmount } from "../utils/currency-constants";
import { Result } from "../utils/results";
import { urlString } from "../utils/urls";
import type { AnalyticsClickmapDevice, AnalyticsClickmapKind, AnalyticsClickmapResponse, AnalyticsClickmapTokenResponse, MetricsResponse, MetricsUserCounts, UserActivityResponse } from "./admin-metrics";
import { EmailOutboxCrud } from "./crud/email-outbox";
import { InternalEmailsCrud } from "./crud/emails";
import { InternalApiKeysCrud } from "./crud/internal-api-keys";
import { ProjectPermissionDefinitionsCrud } from "./crud/project-permissions";
import { ProjectsCrud } from "./crud/projects";
import { SvixTokenCrud } from "./crud/svix-token";
import { TeamPermissionDefinitionsCrud } from "./crud/team-permissions";
import type { Transaction, TransactionType } from "./crud/transactions";
import type { PlanUsageResponse } from "./plan-usage";
import { HexclaveServerInterface, ServerAuthApplicationOptions } from "./server-interface";
import type {
  WorkflowCancelRunsResultJson,
  WorkflowRunDetailsJson,
  WorkflowRunJson,
  WorkflowRunsFilterJson,
  WorkflowSummaryJson,
  WorkflowSyncResultJson,
  WorkflowUpgradeRunsResultJson,
  WorkflowVersionJson,
} from "./workflows";

export type { PlanUsageResponse } from "./plan-usage";

type BranchConfigSourceApi = yup.InferType<typeof branchConfigSourceSchema>;

export type ChatContent = Array<
  | { type: "text", text: string }
  | { type: "tool-call", toolName: string, toolCallId: string, args: any, argsText: string, result: any }
>;

// One line of a service's RUNTIME output — what the container printed while
// running, as opposed to what its build printed. `stream` is "system" for the
// runtime's own lifecycle events (machine started, health check failed) and
// "stdout"/"stderr" for the service's own output; `instance` names the machine
// that printed it, so a multi-instance service can be filtered down to one.
//
// NOT redacted: a runtime process can print anything, including env values.
export type AdminDeploymentServiceLogLineJson = {
  at_millis: number,
  stream: "stdout" | "stderr" | "system",
  instance: string | null,
  text: string,
};

// What ONE service did in one deployment. There is no separate run entity: a
// deploy builds every service of its deployment source in a single builder
// machine, so the build belongs to the deployment and this is only the outcome
// of applying that service.
export type AdminDeploymentServiceOutcomeJson = {
  service_id: string,
  // "skipped" = the deploy never got to it, because something it depends on
  // failed first (or the build did).
  status: "pending" | "building" | "deploying" | "deployed" | "failed" | "skipped",
  url: string | null,
  revision: string | null,
  // The digest-pinned image this deploy actually ran for the service — what its
  // build pushed, or what its `image` reference resolved to. Null until the
  // apply has happened, and on deployments from before this was recorded.
  image: string | null,
  error: string | null,
};

// One env var of a deployment service, normalized from the definition (as
// synced from the deploy file's `services` export): "plain" vars carry their
// literal `value`, "connection" vars carry the "serviceId.outputKey" reference
// they resolve to at deploy time, and "secret" vars carry only the
// `secret_key` naming a per-project secret (values are write-only). Any
// `secret(key, default)` fallback from the deploy file is deliberately absent:
// defaults never leave the deploy request, so nothing server-side or in the
// dashboard can report on them.
export type AdminDeploymentEnvVarJson = {
  key: string,
  type: "plain" | "secret" | "connection",
  value: string | null,
  secret_key: string | null,
};

// One `hexclave deploy`: one deployment source, one source upload, one build,
// and the services that build shipped. Mirrors DeploymentApiShape in
// apps/backend/src/lib/deployments — the two are hand-maintained duplicates, so
// they must be edited together.
export type AdminDeploymentJson = {
  id: string,
  // The user-facing "#47", monotonic per project.
  number: number,
  // WHICH deploy file this came from: the `deploymentGroupId` export of the
  // hexclave.deploy.ts that ran. (A project deployed before services moved out
  // of hexclave.config.ts may still show a source named after that file; nothing
  // writes one any more.) A project deployed from several repositories has one
  // source per repository, and this is what tells their deployments apart in a
  // single list.
  deployment_source_id: string,
  status: "queued" | "building" | "deploying" | "deployed" | "failed" | "canceled",
  triggered_by: string,
  created_at_millis: number,
  // Null until the deployment is terminal.
  finished_at_millis: number | null,
  error: string | null,
  // Whether the build produced a log to read (see getDeploymentBuildLogs).
  has_build_logs: boolean,
  // What this deploy PACKAGED: paths and sizes, never contents. One manifest per
  // deployment, because a deploy uploads one tree and every source-built service
  // is built from it — a service's slice is the subtree under its
  // `root_directory`. Null when nothing was packaged (every service ran an
  // already-built image) and on deployments from before this was recorded.
  //
  // Also null on the deployments LIST, which omits it: it is per-deployment and
  // the list is polled. Read one deployment to get its manifest.
  source_manifest: DeploymentSourceManifest | null,
  // Every service the deploy intended to ship, in the order it applied them.
  services: AdminDeploymentServiceOutcomeJson[],
};

export type AdminDeploymentServiceJson = {
  id: string,
  // Which deploy file declares this service.
  deployment_source_id: string,
  // "server" = one instance that suspends when idle (minInstances 0) or stays
  // up (1), and the only kind that may hold a persistent volume; "serverless" =
  // scales between the bounds below and stops on scale-down.
  type: "server" | "serverless",
  // Whether the service takes public ingress. A property of the SERVICE, not of
  // a port: the runtime serves every declared port on every address the service
  // has, so a public service is reachable on all of them and a private one on
  // none. A public service is always all-HTTP.
  public: boolean,
  // The ports the container listens on, keyed by port number — the same shape
  // the deploy file writes. Empty on rows synced before the definition existed.
  ports: Record<string, { protocol: "http" | "tcp" }>,
  // Scaling bounds; null on unsynced rows.
  min_instances: number | null,
  max_instances: number | null,
  // The memory the service RUNS with. Never null, unlike the bounds above: a
  // service that names no size runs its type's default, and resolving that
  // needs the type-to-default mapping, which is not something a reader of this
  // shape should have to carry.
  memory: DeploymentMemorySize,
  // The CPU that comes with that memory. Derived rather than declared — the two
  // runtimes accept only certain machine shapes and cpu/memory pairs, so memory
  // is the only dial — and reported because `shared` is a genuine surprise
  // otherwise: on the smaller server sizes the vCPU is a burstable fraction of
  // a core rather than a whole one.
  cpu: { count: number, shared: boolean },
  root_directory: string | null,
  // Null = built with Railpack auto-detection rather than a Dockerfile.
  dockerfile_path: string | null,
  // The image this service runs, canonical and fully qualified
  // ("docker.io/library/postgres:16"), as the deploy file named it. With no
  // `build_command` it is the whole story and the service is not built at all;
  // with one it is the BASE the service is built on. Null = no image was named,
  // so the fields above say what the build starts from instead. Mutually
  // exclusive with dockerfile_path.
  image: string | null,
  // A single command line run while the image is built (null = none). Its base
  // is `image`, or `dockerfile_path`'s Dockerfile, or the Hexclave base image.
  build_command: string | null,
  // A single command line run as the container's process instead of the image's
  // own (null = the image decides). Applied at run time, so it never builds.
  start_command: string | null,
  // Null = no persistent disk (an ephemeral container filesystem). Otherwise a
  // single-entry record keyed by volume id, which names a disk owned by the
  // deployment source — it outlives the service that mounts it. Mirrors
  // DeploymentServiceApiShape in apps/backend/src/lib/deployments — the two are
  // hand-maintained duplicates, so they must be edited together.
  persistent_volumes: Record<string, { path: string, size_gb: number }> | null,
  provisioned: boolean,
  status: "not_deployed" | "queued" | "building" | "deploying" | "deployed" | "failed" | "canceled",
  has_successful_deploy: boolean,
  url: string | null,
  env: AdminDeploymentEnvVarJson[],
  domains: { hostname: string, port: number | null, is_primary: boolean, verified: boolean }[],
  // The deployment that last shipped this service, if any.
  latest_deployment_id: string | null,
};

export type AdminProjectSecretJson = {
  key: string,
  created_at_millis: number,
  updated_at_millis: number,
};

export type AdminDeploymentDomainJson = {
  hostname: string,
  is_primary: boolean,
  verified: boolean,
  pending_first_deploy: boolean,
  dns_records: { type: string, name: string, value: string }[],
};

export type AdminAuthApplicationOptions = ServerAuthApplicationOptions &(
  | {
    superSecretAdminKey: string,
  }
  | {
    projectOwnerSession: InternalSession | (() => Promise<string | null>),
  }
);

export type InternalApiKeyCreateCrudRequest = {
  has_publishable_client_key: boolean,
  has_secret_server_key: boolean,
  has_super_secret_admin_key: boolean,
  expires_at_millis: number,
  description: string,
};

export type InternalApiKeyCreateCrudResponse = InternalApiKeysCrud["Admin"]["Read"] & {
  publishable_client_key?: string,
  secret_server_key?: string,
  super_secret_admin_key?: string,
};


export class HexclaveAdminInterface extends HexclaveServerInterface {
  constructor(public readonly options: AdminAuthApplicationOptions) {
    super(options);
  }

  public async sendAdminRequest(path: string, options: RequestInit, session: InternalSession | null, requestType: "admin" = "admin") {
    return await this.sendServerRequest(
      path,
      {
        ...options,
        headers: {
          // Hexclave rebrand: emit x-hexclave-* request header; the backend proxy dual-accepts both names.
          "x-hexclave-super-secret-admin-key": "superSecretAdminKey" in this.options ? this.options.superSecretAdminKey : "",
          ...options.headers,
        },
      },
      session,
      requestType,
    );
  }

  protected async sendAdminRequestAndCatchKnownError<E extends typeof KnownErrors[keyof KnownErrors]>(
    path: string,
    requestOptions: RequestInit,
    tokenStoreOrNull: InternalSession | null,
    errorsToCatch: readonly E[],
  ): Promise<Result<
    Response & {
      usedTokens: {
        accessToken: AccessToken,
        refreshToken: RefreshToken | null,
      } | null,
    },
    InstanceType<E>
  >> {
    try {
      return Result.ok(await this.sendAdminRequest(path, requestOptions, tokenStoreOrNull));
    } catch (e) {
      for (const errorType of errorsToCatch) {
        if (errorType.isInstance(e)) {
          return Result.error(e as InstanceType<E>);
        }
      }
      throw e;
    }
  }

  async getProject(): Promise<ProjectsCrud["Admin"]["Read"]> {
    const response = await this.sendAdminRequest(
      "/internal/projects/current",
      {
        method: "GET",
      },
      null,
    );
    return await response.json();
  }

  async updateProject(update: ProjectsCrud["Admin"]["Update"]): Promise<ProjectsCrud["Admin"]["Read"]> {
    const response = await this.sendAdminRequest(
      "/internal/projects/current",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(update),
      },
      null,
    );
    return await response.json();
  }

  async createInternalApiKey(
    options: InternalApiKeyCreateCrudRequest,
  ): Promise<InternalApiKeyCreateCrudResponse> {
    const response = await this.sendAdminRequest(
      "/internal/api-keys",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(options),
      },
      null,
    );
    return await response.json();
  }

  async listInternalApiKeys(): Promise<InternalApiKeysCrud["Admin"]["Read"][]> {
    const response = await this.sendAdminRequest("/internal/api-keys", {}, null);
    const result = await response.json() as InternalApiKeysCrud["Admin"]["List"];
    return result.items;
  }

  async revokeInternalApiKeyById(id: string) {
    await this.sendAdminRequest(
      `/internal/api-keys/${id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          revoked: true,
        }),
      },
      null,
    );
  }

  async getInternalApiKey(id: string, session: InternalSession): Promise<InternalApiKeysCrud["Admin"]["Read"]> {
    const response = await this.sendAdminRequest(`/internal/api-keys/${id}`, {}, session);
    return await response.json();
  }

  async listInternalEmailTemplates(): Promise<{ id: string, display_name: string, theme_id?: string, tsx_source: string }[]> {
    const response = await this.sendAdminRequest(`/internal/email-templates`, {}, null);
    const result = await response.json() as { templates: { id: string, display_name: string, theme_id?: string, tsx_source: string }[] };
    return result.templates;
  }

  // ─── Workflows (internal-project gated; see the Workflows v1 spec) ───────

  async listWorkflows(): Promise<WorkflowSummaryJson[]> {
    const response = await this.sendAdminRequest(`/internal/workflows`, {}, null);
    const result = await response.json() as { workflows: WorkflowSummaryJson[] };
    return result.workflows;
  }

  async createWorkflow(options: { id: string, display_name?: string, source: string }): Promise<WorkflowSyncResultJson> {
    const response = await this.sendAdminRequest(
      `/internal/workflows`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options),
      },
      null,
    );
    return await response.json();
  }

  async updateWorkflowSource(workflowId: string, source: string): Promise<WorkflowSyncResultJson> {
    const response = await this.sendAdminRequest(
      urlString`/internal/workflows/${workflowId}/source`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
      },
      null,
    );
    return await response.json();
  }

  async setWorkflowPaused(workflowId: string, isPaused: boolean): Promise<{ is_paused: boolean, paused_at_millis: number | null }> {
    const response = await this.sendAdminRequest(
      urlString`/internal/workflows/${workflowId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_paused: isPaused }),
      },
      null,
    );
    return await response.json();
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    await this.sendAdminRequest(
      urlString`/internal/workflows/${workflowId}`,
      { method: "DELETE" },
      null,
    );
  }

  async listWorkflowVersions(workflowId: string): Promise<WorkflowVersionJson[]> {
    const response = await this.sendAdminRequest(urlString`/internal/workflows/${workflowId}/versions`, {}, null);
    const result = await response.json() as { versions: WorkflowVersionJson[] };
    return result.versions;
  }

  async listWorkflowRuns(workflowId: string, filter: WorkflowRunsFilterJson = {}): Promise<{ runs: WorkflowRunJson[], next_cursor: string | null }> {
    const params = new URLSearchParams();
    if (filter.state !== undefined) params.set("state", filter.state);
    if (filter.version !== undefined) params.set("version", String(filter.version));
    if (filter.run_key !== undefined) params.set("run_key", filter.run_key);
    if (filter.cursor !== undefined) params.set("cursor", filter.cursor);
    if (filter.limit !== undefined) params.set("limit", String(filter.limit));
    if (filter.include_state !== undefined) params.set("include_state", String(filter.include_state));
    const query = params.toString();
    const response = await this.sendAdminRequest(urlString`/internal/workflows/${workflowId}/runs` + (query ? `?${query}` : ""), {}, null);
    return await response.json();
  }

  async getWorkflowRun(runId: string): Promise<WorkflowRunDetailsJson> {
    const response = await this.sendAdminRequest(urlString`/internal/workflows/runs/${runId}`, {}, null);
    return await response.json();
  }

  async cancelWorkflowRuns(workflowId: string, filter: { run_key?: string, run_id?: string, state?: string, version?: number }): Promise<WorkflowCancelRunsResultJson> {
    const response = await this.sendAdminRequest(
      urlString`/internal/workflows/${workflowId}/runs/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(filter),
      },
      null,
    );
    return await response.json();
  }

  async upgradeWorkflowRuns(workflowId: string, options: { to_version: number, run_key?: string, from_version?: number }): Promise<WorkflowUpgradeRunsResultJson> {
    const response = await this.sendAdminRequest(
      urlString`/internal/workflows/${workflowId}/runs/upgrade`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options),
      },
      null,
    );
    return await response.json();
  }

  async retryWorkflowRun(runId: string): Promise<{ run_id: string }> {
    const response = await this.sendAdminRequest(
      urlString`/internal/workflows/runs/${runId}/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      null,
    );
    return await response.json();
  }

  async sendWorkflowEvent(name: string, data: unknown): Promise<{ event_id: string }> {
    const response = await this.sendAdminRequest(
      `/internal/workflows/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, data }),
      },
      null,
    );
    return await response.json();
  }

  async listInternalEmailDrafts(): Promise<{ id: string, display_name: string, theme_id?: string | undefined | false, tsx_source: string, sent_at_millis?: number | null }[]> {
    const response = await this.sendAdminRequest(`/internal/email-drafts`, {}, null);
    const result = await response.json() as { drafts: { id: string, display_name: string, theme_id?: string | undefined | false, tsx_source: string, sent_at_millis?: number | null }[] };
    return result.drafts;
  }

  async createEmailDraft(options: { display_name?: string, theme_id?: string | false, tsx_source?: string }): Promise<{ id: string }> {
    const response = await this.sendAdminRequest(
      `/internal/email-drafts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(options),
      },
      null,
    );
    return await response.json();
  }

  async updateEmailDraft(id: string, data: { display_name?: string, theme_id?: string | null | false, tsx_source?: string, sent_at_millis?: number | null }): Promise<void> {
    await this.sendAdminRequest(
      `/internal/email-drafts/${id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      null,
    );
  }

  async deleteEmailDraft(id: string): Promise<void> {
    await this.sendAdminRequest(
      `/internal/email-drafts/${id}`,
      {
        method: "DELETE",
      },
      null,
    );
  }

  async listEmailThemes(): Promise<{ id: string, display_name: string }[]> {
    const response = await this.sendAdminRequest(`/internal/email-themes`, {}, null);
    const result = await response.json() as { themes: { id: string, display_name: string }[] };
    return result.themes;
  }


  // Team permission definitions methods
  async listTeamPermissionDefinitions(): Promise<TeamPermissionDefinitionsCrud['Admin']['Read'][]> {
    const response = await this.sendAdminRequest(`/team-permission-definitions`, {}, null);
    const result = await response.json() as TeamPermissionDefinitionsCrud['Admin']['List'];
    return result.items;
  }

  async listTeamPermissionDefinitionsPaginated(
    options: { limit: number, cursor?: string, query?: string },
  ): Promise<{ items: TeamPermissionDefinitionsCrud['Admin']['Read'][], nextCursor: string | null }> {
    const params = new URLSearchParams();
    params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.query) params.set("query", options.query);
    const response = await this.sendAdminRequest(`/team-permission-definitions?${params.toString()}`, {}, null);
    const result = await response.json() as TeamPermissionDefinitionsCrud['Admin']['List'];
    return {
      items: result.items,
      nextCursor: result.pagination?.next_cursor ?? null,
    };
  }

  async createTeamPermissionDefinition(data: TeamPermissionDefinitionsCrud['Admin']['Create']): Promise<TeamPermissionDefinitionsCrud['Admin']['Read']> {
    const response = await this.sendAdminRequest(
      "/team-permission-definitions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      null,
    );
    return await response.json();
  }

  async updateTeamPermissionDefinition(permissionId: string, data: TeamPermissionDefinitionsCrud['Admin']['Update']): Promise<TeamPermissionDefinitionsCrud['Admin']['Read']> {
    const response = await this.sendAdminRequest(
      `/team-permission-definitions/${permissionId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      null,
    );
    return await response.json();
  }

  async deleteTeamPermissionDefinition(permissionId: string): Promise<void> {
    await this.sendAdminRequest(
      `/team-permission-definitions/${permissionId}`,
      { method: "DELETE" },
      null,
    );
  }

  async listProjectPermissionDefinitions(): Promise<ProjectPermissionDefinitionsCrud['Admin']['Read'][]> {
    const response = await this.sendAdminRequest(`/project-permission-definitions`, {}, null);
    const result = await response.json() as ProjectPermissionDefinitionsCrud['Admin']['List'];
    return result.items;
  }

  async createProjectPermissionDefinition(data: ProjectPermissionDefinitionsCrud['Admin']['Create']): Promise<ProjectPermissionDefinitionsCrud['Admin']['Read']> {
    const response = await this.sendAdminRequest(
      "/project-permission-definitions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      null,
    );
    return await response.json();
  }

  async updateProjectPermissionDefinition(permissionId: string, data: ProjectPermissionDefinitionsCrud['Admin']['Update']): Promise<ProjectPermissionDefinitionsCrud['Admin']['Read']> {
    const response = await this.sendAdminRequest(
      `/project-permission-definitions/${permissionId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      null,
    );
    return await response.json();
  }

  async deleteProjectPermissionDefinition(permissionId: string): Promise<void> {
    await this.sendAdminRequest(
      `/project-permission-definitions/${permissionId}`,
      { method: "DELETE" },
      null,
    );
  }

  async getSvixToken(): Promise<SvixTokenCrud["Admin"]["Read"]> {
    const response = await this.sendAdminRequest(
      "/webhooks/svix-token",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      null,
    );
    return await response.json();
  }

  async deleteProject(): Promise<void> {
    await this.sendAdminRequest(
      "/internal/projects/current",
      {
        method: "DELETE",
      },
      null,
    );
  }

  async getMetrics(
    includeAnonymous: boolean = false,
    filters?: {
      country_code?: string,
      referrer?: string,
      browser?: string,
      os?: string,
      device?: string,
      since?: string,
      until?: string,
    },
  ): Promise<MetricsResponse> {
    const params = new URLSearchParams();
    if (includeAnonymous) {
      params.append('include_anonymous', 'true');
    }
    if (filters?.country_code) params.append('filter_country_code', filters.country_code);
    if (filters?.referrer) params.append('filter_referrer', filters.referrer);
    if (filters?.browser) params.append('filter_browser', filters.browser);
    if (filters?.os) params.append('filter_os', filters.os);
    if (filters?.device) params.append('filter_device', filters.device);
    if (filters?.since) params.append('filter_since', filters.since);
    if (filters?.until) params.append('filter_until', filters.until);
    const queryString = params.toString();
    const response = await this.sendAdminRequest(
      `/internal/metrics${queryString ? `?${queryString}` : ''}`,
      {
        method: "GET",
      },
      null,
    );
    const body = (await response.json()) as MetricsResponse;
    // The yup schema's .optional().default(...) fallbacks only run during
    // backend response validation, not on this client-side cast — apply them
    // here too so the one-release-cycle tolerance for older servers that the
    // schema comments promise actually holds for dashboard consumers. The
    // Partial views widen the static type (which claims these are always
    // defined) to match what an older server can actually send.
    const rawBody: Partial<MetricsResponse> = body;
    const rawAnalytics: Partial<MetricsResponse["analytics_overview"]> = body.analytics_overview;
    return {
      ...body,
      live_users: rawBody.live_users ?? 0,
      hourly_users: rawBody.hourly_users ?? [],
      hourly_active_users: rawBody.hourly_active_users ?? [],
      analytics_overview: {
        ...body.analytics_overview,
        hourly_page_views: rawAnalytics.hourly_page_views ?? [],
        hourly_active_users: rawAnalytics.hourly_active_users ?? [],
        hourly_visitors: rawAnalytics.hourly_visitors ?? [],
        daily_anonymous_visitors_fallback: rawAnalytics.daily_anonymous_visitors_fallback ?? [],
        anonymous_visitors_fallback: rawAnalytics.anonymous_visitors_fallback ?? 0,
        top_regions: rawAnalytics.top_regions ?? [],
        bounce_rate: rawAnalytics.bounce_rate ?? 0,
        daily_bounce_rate: rawAnalytics.daily_bounce_rate ?? [],
        daily_avg_session_seconds: rawAnalytics.daily_avg_session_seconds ?? [],
        top_browsers: rawAnalytics.top_browsers ?? [],
        top_operating_systems: rawAnalytics.top_operating_systems ?? [],
        top_devices: rawAnalytics.top_devices ?? [],
      },
    };
  }

  async getPlanUsage(): Promise<PlanUsageResponse> {
    const response = await this.sendAdminRequest(
      "/internal/plan-usage",
      {
        method: "GET",
      },
      null,
    );
    return await response.json();
  }

  async getUserActivity(userId: string): Promise<UserActivityResponse> {
    const response = await this.sendAdminRequest(
      urlString`/internal/user-activity?user_id=${userId}`,
      {
        method: "GET",
      },
      null,
    );
    return (await response.json()) as UserActivityResponse;
  }

  async getAnalyticsClickmap(options: {
    kind: AnalyticsClickmapKind,
    member_user_ids?: string[],
    route_path?: string,
    route_regex?: string,
    url_pattern?: string,
    user_id?: string,
    replay_id?: string,
    device?: AnalyticsClickmapDevice,
    viewport_width_min?: number,
    viewport_width_max?: number,
    sampling?: number,
    since: string,
    until: string,
  }): Promise<AnalyticsClickmapResponse> {
    const response = await this.sendAdminRequest(
      "/internal/analytics/clickmap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options),
      },
      null,
    );
    return (await response.json()) as AnalyticsClickmapResponse;
  }

  async createAnalyticsClickmapToken(options: {
    origin: string,
  }): Promise<AnalyticsClickmapTokenResponse> {
    const response = await this.sendAdminRequest(
      "/internal/analytics/clickmap-token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options),
      },
      null,
    );
    return (await response.json()) as AnalyticsClickmapTokenResponse;
  }

  async getMetricsUserCounts(): Promise<MetricsUserCounts> {
    const response = await this.sendAdminRequest(
      "/internal/metrics/user-counts",
      {
        method: "GET",
      },
      null,
    );
    return (await response.json()) as MetricsUserCounts;
  }

  async sendTestEmail(data: {
    recipient_email: string,
    email_config: {
      host: string,
      port: number,
      username: string,
      password: string,
      sender_email: string,
      sender_name: string,
    },
  }): Promise<{ success: boolean, error_message?: string }> {
    const response = await this.sendAdminRequest(`/internal/send-test-email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
    }, null);
    return await response.json();
  }

  async sendTestWebhook(data: {
    endpoint_id: string,
  }): Promise<{ success: boolean, error_message?: string }> {
    const response = await this.sendAdminRequest(`/internal/send-test-webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
    }, null);
    return await response.json();
  }

  async listSentEmails(): Promise<InternalEmailsCrud["Admin"]["List"]> {
    const response = await this.sendAdminRequest("/internal/emails", {
      method: "GET",
    }, null);
    return await response.json();
  }

  async setupManagedEmailProvider(data: {
    subdomain: string,
    sender_local_part: string,
  }): Promise<{
      domain_id: string,
      subdomain: string,
      sender_local_part: string,
      name_server_records: string[],
      status: "pending_dns" | "pending_verification" | "verified" | "applied" | "failed",
    }> {
    const response = await this.sendAdminRequest("/internal/emails/managed-onboarding/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
    }, null);
    return await response.json();
  }

  async checkManagedEmailStatus(data: {
    domain_id: string,
    subdomain: string,
    sender_local_part: string,
  }): Promise<{ status: "pending_dns" | "pending_verification" | "verified" | "applied" | "failed" }> {
    const response = await this.sendAdminRequest("/internal/emails/managed-onboarding/check", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
    }, null);
    return await response.json();
  }

  async listManagedEmailDomains(): Promise<{
      items: Array<{
        domain_id: string,
        subdomain: string,
        sender_local_part: string,
        status: "pending_dns" | "pending_verification" | "verified" | "applied" | "failed",
        name_server_records: string[],
      }>,
    }> {
    const response = await this.sendAdminRequest("/internal/emails/managed-onboarding/list", {
      method: "GET",
    }, null);
    return await response.json();
  }

  async deleteManagedEmailDomain(data: {
    resend_domain_id: string,
  }): Promise<{ status: "deleted" }> {
    const response = await this.sendAdminRequest("/internal/emails/managed-onboarding/delete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
    }, null);
    return await response.json();
  }

  async applyManagedEmailProvider(data: {
    domain_id: string,
  }): Promise<{ status: "applied" }> {
    const response = await this.sendAdminRequest("/internal/emails/managed-onboarding/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
    }, null);
    return await response.json();
  }

  async sendSignInInvitationEmail(
    email: string,
    callbackUrl: string,
  ): Promise<void> {
    await this.sendAdminRequest(
      "/internal/send-sign-in-invitation",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          callback_url: callbackUrl,
        }),
      },
      null,
    );
  }

  async saveChatMessage(threadId: string, message: any): Promise<void> {
    await this.sendAdminRequest(
      `/internal/ai-chat/${threadId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ message }),
      },
      null,
    );
  }

  async listChatMessages(threadId: string): Promise<{ messages: Array<any> }> {
    const response = await this.sendAdminRequest(
      `/internal/ai-chat/${threadId}`,
      { method: "GET" },
      null,
    );
    return await response.json();
  }

  async renderEmailPreview(options: {
    themeId?: string | null | false,
    themeTsxSource?: string,
    templateId?: string,
    templateTsxSource?: string,
    editableMarkers?: boolean,
    editableSource?: 'template' | 'theme' | 'both',
  }): Promise<{ html: string, editable_regions?: Record<string, unknown> }> {
    const response = await this.sendAdminRequest(`/emails/render-email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        theme_id: options.themeId,
        theme_tsx_source: options.themeTsxSource,
        template_id: options.templateId,
        template_tsx_source: options.templateTsxSource,
        editable_markers: options.editableMarkers,
        editable_source: options.editableSource,
      }),
    }, null);
    return await response.json();
  }

  async rewriteTemplateSourceWithAI(templateTsxSource: string): Promise<{ tsx_source: string }> {
    const response = await this.sendAdminRequest(`/internal/rewrite-template-source`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        template_tsx_source: templateTsxSource,
      }),
    }, null);
    return await response.json();
  }

  async createEmailTheme(displayName: string): Promise<{ id: string }> {
    const response = await this.sendAdminRequest(
      `/internal/email-themes`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          display_name: displayName,
        }),
      },
      null,
    );
    return await response.json();
  }

  async getEmailTheme(id: string): Promise<{ display_name: string, tsx_source: string }> {
    const response = await this.sendAdminRequest(
      `/internal/email-themes/${id}`,
      { method: "GET" },
      null,
    );
    return await response.json();
  }

  async updateEmailTheme(id: string, tsxSource: string): Promise<void> {
    await this.sendAdminRequest(
      `/internal/email-themes/${id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tsx_source: tsxSource,
        }),
      },
      null,
    );
  }

  async deleteEmailTheme(id: string): Promise<void> {
    await this.sendAdminRequest(
      `/internal/email-themes/${id}`,
      {
        method: "DELETE",
      },
      null,
    );
  }

  async updateEmailTemplate(id: string, tsxSource: string, themeId: string | null | false): Promise<{ rendered_html: string }> {
    const response = await this.sendAdminRequest(
      `/internal/email-templates/${id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ tsx_source: tsxSource, theme_id: themeId }),
      },
      null,
    );
    return await response.json();
  }

  async getConfig(): Promise<{ config_string: string }> {
    const response = await this.sendAdminRequest(
      `/internal/config`,
      { method: "GET" },
      null,
    );
    return await response.json();
  }

  async getConfigOverride(level: "project" | "branch" | "environment"): Promise<{ config_string: string }> {
    const response = await this.sendAdminRequest(
      `/internal/config/override/${level}`,
      { method: "GET" },
      null,
    );
    return await response.json();
  }

  async setConfigOverride(level: "project" | "branch" | "environment", configOverride: any, source?: BranchConfigSourceApi): Promise<void> {
    await this.sendAdminRequest(
      `/internal/config/override/${level}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          config_string: JSON.stringify(configOverride),
          ...(source && { source }),
        }),
      },
      null,
    );
  }

  async updateConfigOverride(level: "project" | "branch" | "environment", configOverrideOverride: any): Promise<void> {
    await this.sendAdminRequest(
      `/internal/config/override/${level}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ config_override_string: JSON.stringify(configOverrideOverride) }),
      },
      null,
    );
  }

  async getPushedConfigSource(): Promise<BranchConfigSourceApi> {
    const response = await this.sendAdminRequest(
      `/internal/config/source`,
      { method: "GET" },
      null,
    );
    const data = await response.json();
    return data.source;
  }

  async unlinkPushedConfigSource(): Promise<void> {
    await this.sendAdminRequest(
      `/internal/config/source`,
      { method: "DELETE" },
      null,
    );
  }

  /**
   * Reads a specific config-agent run's state (or `null`) for the linked GitHub
   * repo. Polled by the dashboard — using the id returned by `applyConfigViaAgent`
   * — for live progress and the review diff. Runs are independent, so each is
   * addressed by its own id rather than "the" run on the branch.
   */
  async getConfigAgentRun(runId: string): Promise<ConfigAgentRunApi | null> {
    const response = await this.sendAdminRequest(
      `/internal/config/github/run?run_id=${encodeURIComponent(runId)}`,
      { method: "GET" },
      null,
    );
    const data = await response.json();
    return data.agent_run ?? null;
  }

  /**
   * Applies a dashboard config change to the linked GitHub repo by running the
   * config agent in a sandbox (server-side). Returns immediately with the new run's
   * `id`; poll `getConfigAgentRun(id)` for progress. The GitHub access token is the
   * caller's own OAuth token and is used transiently server-side.
   */
  async applyConfigViaAgent(options: { configUpdate: EnvironmentConfigOverrideOverride, githubAccessToken: string }): Promise<{ status: "started", id: string }> {
    const response = await this.sendAdminRequest(
      `/internal/config/github/apply`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          github_access_token: options.githubAccessToken,
          config_update_string: JSON.stringify(options.configUpdate),
        }),
      },
      null,
    );
    return await response.json();
  }

  /**
   * Cancels a specific in-flight agent-driven config write: hard-stops the sandbox
   * so the agent stops mid-work. Also cancels runs in `awaiting_review`. No revert
   * — if the agent already pushed, the commit stays. Returns `not-running` if the
   * run is gone or already terminal.
   */
  async cancelConfigAgentRun(runId: string): Promise<{ status: "cancelling" | "not-running" }> {
    const response = await this.sendAdminRequest(
      `/internal/config/github/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: runId }),
      },
      null,
    );
    return await response.json();
  }

  /**
   * Commits a specific run's reviewed change to GitHub. Only valid when that run is in
   * `awaiting_review` status; the change (diff + base commit) was captured at apply time
   * and is rebuilt + pushed via the GitHub API here, so no live sandbox is involved.
   * Returns `not-awaiting-review` if the run isn't in a committable state.
   */
  async commitConfigAgentRun(runId: string, options: { githubAccessToken: string, commitMessage?: string }): Promise<{ status: "committing" | "not-awaiting-review" }> {
    const response = await this.sendAdminRequest(
      `/internal/config/github/commit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          run_id: runId,
          github_access_token: options.githubAccessToken,
          ...(options.commitMessage ? { commit_message: options.commitMessage } : {}),
        }),
      },
      null,
    );
    return await response.json();
  }

  async resetConfigOverrideKeys(level: "branch" | "environment", keys: string[]): Promise<void> {
    await this.sendAdminRequest(
      `/internal/config/override/${level}/reset-keys`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ keys }),
      },
      null,
    );
  }
  async createEmailTemplate(displayName: string): Promise<{ id: string }> {
    const response = await this.sendAdminRequest(
      `/internal/email-templates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          display_name: displayName,
        }),
      },
      null,
    );
    return await response.json();
  }

  async deleteEmailTemplate(id: string): Promise<void> {
    await this.sendAdminRequest(
      `/internal/email-templates/${id}`,
      {
        method: "DELETE",
      },
      null,
    );
  }

  async setupPayments(): Promise<{ url: string }> {
    const response = await this.sendAdminRequest(
      "/internal/payments/setup",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      null,
    );
    return await response.json();
  }

  async getStripeAccountInfo(): Promise<null | { account_id: string, charges_enabled: boolean, details_submitted: boolean, payouts_enabled: boolean }> {
    const response = await this.sendAdminRequestAndCatchKnownError(
      "/internal/payments/stripe/account-info",
      {},
      null,
      [KnownErrors.StripeAccountInfoNotFound],
    );
    if (response.status === "error") {
      return null;
    }
    return await response.data.json();
  }

  async getPaymentMethodConfigs(): Promise<{ configId: string, methods: Array<{ id: string, name: string, enabled: boolean, available: boolean, overridable: boolean }> } | null> {
    const response = await this.sendAdminRequestAndCatchKnownError(
      "/internal/payments/method-configs",
      { method: "GET" },
      null,
      [KnownErrors.StripeAccountInfoNotFound],
    );
    if (response.status === "error") {
      return null;
    }
    const data = await response.data.json();
    return {
      configId: data.config_id,
      methods: data.methods,
    };
  }

  async updatePaymentMethodConfigs(configId: string, updates: Record<string, 'on' | 'off'>): Promise<void> {
    await this.sendAdminRequest(
      "/internal/payments/method-configs",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config_id: configId, updates }),
      },
      null,
    );
  }

  async createStripeWidgetAccountSession(): Promise<{ client_secret: string }> {
    const response = await this.sendAdminRequest(
      "/internal/payments/stripe-widgets/account-session",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      null,
    );
    return await response.json();
  }

  async listTransactions(params?: { cursor?: string, limit?: number, type?: TransactionType, customerType?: 'user' | 'team' | 'custom', customerId?: string }): Promise<{ transactions: Transaction[], nextCursor: string | null }> {
    const qs = new URLSearchParams();
    if (params?.cursor) qs.set('cursor', params.cursor);
    if (typeof params?.limit === 'number') qs.set('limit', String(params.limit));
    if (params?.type) qs.set('type', params.type);
    if (params?.customerType) qs.set('customer_type', params.customerType);
    if (params?.customerId) qs.set('customer_id', params.customerId);
    const response = await this.sendAdminRequest(
      `/internal/payments/transactions${qs.size ? `?${qs.toString()}` : ''}`,
      { method: 'GET' },
      null,
    );
    const json = await response.json() as { transactions: Transaction[], next_cursor: string | null };
    return { transactions: json.transactions, nextCursor: json.next_cursor };
  }

  async refundTransaction(options: {
    type: "subscription" | "one-time-purchase",
    id: string,
    invoiceId?: string,
    amountUsd: MoneyAmount,
    /**
     * Lifecycle action for the source purchase:
     *   "now"           — end product access immediately (revokes product,
     *                     expires item grants, cancels Stripe sub if any).
     *   "at-period-end" — schedule sub cancel-at-period-end; subscriptions
     *                     only — rejected for one-time purchases.
     *   undefined       — no lifecycle change; refund money only.
     */
    endAction?: "now" | "at-period-end",
  }): Promise<{ success: boolean, refundTransactionId: string }> {
    const response = await this.sendAdminRequest(
      "/internal/payments/transactions/refund",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: options.type,
          id: options.id,
          ...(options.invoiceId !== undefined ? { invoice_id: options.invoiceId } : {}),
          amount_usd: options.amountUsd,
          ...(options.endAction !== undefined ? { end_action: options.endAction } : {}),
        }),
      },
      null,
    );
    const json = await response.json();
    return { success: json.success, refundTransactionId: json.refund_transaction_id };
  }


  async previewAffectedUsersByOnboardingChange(
    onboarding: { require_email_verification?: boolean },
    limit?: number,
  ): Promise<{
    affected_users: Array<{
      id: string,
      display_name: string | null,
      primary_email: string | null,
      restricted_reason: RestrictedReason,
    }>,
    total_affected_count: number,
  }> {
    const response = await this.sendAdminRequest(
      `/internal/onboarding/preview-affected-users${limit ? `?limit=${limit}` : ''}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ onboarding }),
      },
      null,
    );
    return await response.json();
  }

  async listOutboxEmails(options?: { status?: string, simple_status?: string, user_id?: string, limit?: number, cursor?: string }): Promise<EmailOutboxCrud["Server"]["List"]> {
    const qs = new URLSearchParams();
    if (options?.status) qs.set('status', options.status);
    if (options?.simple_status) qs.set('simple_status', options.simple_status);
    if (options?.user_id) qs.set('user_id', options.user_id);
    if (options?.limit !== undefined) qs.set('limit', options.limit.toString());
    if (options?.cursor) qs.set('cursor', options.cursor);
    const response = await this.sendServerRequest(
      `/emails/outbox${qs.size ? `?${qs.toString()}` : ''}`,
      { method: 'GET' },
      null,
    );
    return await response.json();
  }

  async getOutboxEmail(id: string): Promise<EmailOutboxCrud["Server"]["Read"]> {
    const response = await this.sendServerRequest(
      `/emails/outbox/${id}`,
      { method: 'GET' },
      null,
    );
    return await response.json();
  }

  async updateOutboxEmail(id: string, data: EmailOutboxCrud["Server"]["Update"]): Promise<EmailOutboxCrud["Server"]["Read"]> {
    const response = await this.sendServerRequest(
      `/emails/outbox/${id}`,
      {
        method: 'PATCH',
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      null,
    );
    return await response.json();
  }

  // ---- Deployments app ------------------------------------------------------

  async listDeploymentServices(): Promise<AdminDeploymentServiceJson[]> {
    const response = await this.sendAdminRequest(
      "/deployments/services",
      { method: "GET" },
      null,
    );
    return (await response.json()).items;
  }

  async listProjectSecrets(): Promise<AdminProjectSecretJson[]> {
    const response = await this.sendAdminRequest(
      "/project-secrets",
      { method: "GET" },
      null,
    );
    return (await response.json()).items;
  }

  async setProjectSecret(key: string, value: string): Promise<void> {
    await this.sendAdminRequest(
      "/project-secrets",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ key, value }),
      },
      null,
    );
  }

  async deleteProjectSecret(key: string): Promise<void> {
    await this.sendAdminRequest(
      urlString`/project-secrets/${key}`,
      { method: "DELETE" },
      null,
    );
  }

  async listDeployments(options?: { limit?: number }): Promise<AdminDeploymentJson[]> {
    const response = await this.sendAdminRequest(
      `/deployments/deployments` + (options?.limit !== undefined ? `?limit=${options.limit}` : ""),
      { method: "GET" },
      null,
    );
    return (await response.json()).items;
  }

  async getDeployment(deploymentId: string): Promise<AdminDeploymentJson> {
    const response = await this.sendAdminRequest(
      urlString`/deployments/deployments/${deploymentId}`,
      { method: "GET" },
      null,
    );
    return await response.json();
  }

  async getDeploymentBuildLogs(deploymentId: string, options?: { signal?: AbortSignal }): Promise<string> {
    // One build per deployment, so one log: the endpoint streams chunked plain
    // text until the deployment is terminal (or a server-side cap), and reading
    // the full body gives "the logs so far". Pass a signal so an abandoned view
    // can abort — otherwise the server keeps following the build for minutes.
    const response = await this.sendAdminRequest(
      urlString`/deployments/deployments/${deploymentId}/logs`,
      { method: "GET", signal: options?.signal },
      null,
    );
    return await response.text();
  }

  /**
   * Follows a service's runtime logs, calling `onLine` for each line as it arrives.
   *
   * The endpoint streams NDJSON and follows for a few minutes before closing, so
   * this resolves when the server stops following rather than when the service
   * stops running — there is no end to a runtime log. Resume by calling again
   * with the largest `at_millis` seen; omit it to start at the tail.
   *
   * Rejects if the stream ends in an error, AFTER delivering everything that
   * arrived before it: the lines already handed to `onLine` are real output and
   * the caller should keep them.
   */
  async getDeploymentServiceLogs(serviceId: string, options: {
    sinceMillis?: number,
    /** False returns what is available right now instead of following. */
    follow?: boolean,
    signal?: AbortSignal,
    onLine: (line: AdminDeploymentServiceLogLineJson) => void,
  }): Promise<void> {
    const params = new URLSearchParams();
    if (options.sinceMillis !== undefined) params.set("since_millis", String(options.sinceMillis));
    if (options.follow === false) params.set("follow", "false");
    const query = params.toString();
    const response = await this.sendAdminRequest(
      `${urlString`/deployments/services/${serviceId}/logs`}${query === "" ? "" : `?${query}`}`,
      { method: "GET", signal: options.signal },
      null,
    );
    if (response.body === null) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Held on an object rather than a plain `let`: it is written from inside
    // handleLine, and TypeScript keeps narrowing a plain local to its
    // initializer across a closure it cannot see run (the check at the bottom
    // would then be "always false").
    const stream = { error: null as string | null };
    const handleLine = (raw: string) => {
      if (raw === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A truncated line must not take down a tail that is otherwise fine.
        return;
      }
      if (parsed === null || typeof parsed !== "object") return;
      // The server's one control line. Real log lines always carry `at_millis`,
      // which is what tells the two apart without a discriminator on every line.
      const errorMessage = (parsed as { _error?: unknown })._error;
      if (typeof errorMessage === "string") {
        stream.error = errorMessage;
        return;
      }
      if (typeof (parsed as { at_millis?: unknown }).at_millis !== "number") return;
      options.onLine(parsed as AdminDeploymentServiceLogLineJson);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Split on every complete line; a chunk can end mid-line.
        while (true) {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex < 0) break;
          handleLine(buffer.slice(0, newlineIndex));
          buffer = buffer.slice(newlineIndex + 1);
        }
      }
      buffer += decoder.decode();
      handleLine(buffer);
    } finally {
      reader.releaseLock();
    }
    if (stream.error !== null) throw new Error(stream.error);
  }

  async addDeploymentServiceDomain(serviceId: string, hostname: string, options?: { isPrimary?: boolean }): Promise<void> {
    await this.sendAdminRequest(
      urlString`/deployments/services/${serviceId}/domains`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ hostname, ...(options?.isPrimary ? { is_primary: true } : {}) }),
      },
      null,
    );
  }

  async getDeploymentServiceDomain(serviceId: string, hostname: string): Promise<AdminDeploymentDomainJson> {
    const response = await this.sendAdminRequest(
      urlString`/deployments/services/${serviceId}/domains/${hostname}`,
      { method: "GET" },
      null,
    );
    return await response.json();
  }

  async deleteDeploymentServiceDomain(serviceId: string, hostname: string): Promise<void> {
    await this.sendAdminRequest(
      urlString`/deployments/services/${serviceId}/domains/${hostname}`,
      { method: "DELETE" },
      null,
    );
  }

}
