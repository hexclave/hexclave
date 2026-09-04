import { KnownErrors, HexclaveAdminInterface } from "@hexclave/shared";
import { getProductionModeErrors } from "@hexclave/shared/dist/helpers/production-mode";
import { InternalApiKeyCreateCrudResponse } from "@hexclave/shared/dist/interface/admin-interface";
import type { AnalyticsClickmapOptions, AnalyticsClickmapResponse, AnalyticsClickmapTokenResponse, MetricsResponse, MetricsUserCounts, UserActivityResponse } from "@hexclave/shared/dist/interface/admin-metrics";
import { EmailTemplateCrud } from "@hexclave/shared/dist/interface/crud/email-templates";
import { InternalApiKeysCrud } from "@hexclave/shared/dist/interface/crud/internal-api-keys";
import type { EmailOutboxCrud } from "@hexclave/shared/dist/interface/crud/email-outbox";
import { ProjectsCrud } from "@hexclave/shared/dist/interface/crud/projects";
import type { Transaction, TransactionType } from "@hexclave/shared/dist/interface/crud/transactions";
import type { RestrictedReason } from "@hexclave/shared/dist/schema-fields";
import type { MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import { HexclaveAssertionError, captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import type { EditableMetadata } from "@hexclave/shared/dist/utils/jsx-editable-transpiler";
import { pick, typedEntries, typedValues } from "@hexclave/shared/dist/utils/objects";
import { Result } from "@hexclave/shared/dist/utils/results";
import { useMemo } from "react"; // THIS_LINE_PLATFORM react-like
import { AdminEmailOutbox, AdminSentEmail } from "../..";
import { EmailConfig, hexclaveAppInternalsSymbol } from "../../common";
import { AdminEmailTemplate } from "../../email-templates";
import { InternalApiKey, InternalApiKeyBase, InternalApiKeyBaseCrudRead, InternalApiKeyCreateOptions, InternalApiKeyFirstView, internalApiKeyCreateOptionsToCrud } from "../../internal-api-keys";
import { AdminProjectPermission, AdminProjectPermissionDefinition, AdminProjectPermissionDefinitionCreateOptions, AdminProjectPermissionDefinitionUpdateOptions, AdminTeamPermission, AdminTeamPermissionDefinition, AdminTeamPermissionDefinitionCreateOptions, AdminTeamPermissionDefinitionUpdateOptions, adminProjectPermissionDefinitionCreateOptionsToCrud, adminProjectPermissionDefinitionUpdateOptionsToCrud, adminTeamPermissionDefinitionCreateOptionsToCrud, adminTeamPermissionDefinitionUpdateOptionsToCrud } from "../../permissions";
import type { PlanUsage } from "../../plan-usage";
import { AdminOwnedProject, AdminProject, AdminProjectUpdateOptions, PushConfigOptions, adminProjectUpdateOptionsToCrud } from "../../projects";
import { AdminWorkflow, AdminWorkflowRun, AdminWorkflowRunDetails, AdminWorkflowRunsFilter, AdminWorkflowSyncResult, AdminWorkflowUpgradeResult, AdminWorkflowVersion, adminWorkflowFromCrud, adminWorkflowRunDetailsFromCrud, adminWorkflowRunFromCrud, adminWorkflowSyncResultFromCrud, adminWorkflowVersionFromCrud, isWorkflowRunDetailsJson } from "../../workflows";
import { ManagedEmailProviderListItem, ManagedEmailProviderSetupResult, ManagedEmailProviderStatus, EmailOutboxUpdateOptions, StackAdminApp, StackAdminAppConstructorOptions } from "../interfaces/admin-app";
import { clientVersion, createCache, getDefaultExtraRequestHeaders, getDefaultProjectId, getDefaultPublishableClientKey, getDefaultSecretServerKey, getDefaultSuperSecretAdminKey, resolveApiUrls, resolveConstructorOptions } from "./common";
import { _HexclaveServerAppImplIncomplete } from "./server-app-impl";

import { CompleteConfig, EnvironmentConfigOverrideOverride } from "@hexclave/shared/dist/config/schema";
import { branchConfigSourceSchema } from "@hexclave/shared/dist/schema-fields";
import * as yup from "yup";
import { PushedConfigSource } from "../../projects";
import { useAsyncCache } from "./common"; // THIS_LINE_PLATFORM react-like

type BranchConfigSourceApi = yup.InferType<typeof branchConfigSourceSchema>;
type PlanUsageResponse = Awaited<ReturnType<HexclaveAdminInterface["getPlanUsage"]>>;
/**
 * Converts a PushedConfigSource (SDK camelCase) to BranchConfigSourceApi (API snake_case).
 */
function pushedConfigSourceToApi(source: PushedConfigSource): BranchConfigSourceApi {
  if (source.type === "pushed-from-github") {
    return {
      type: "pushed-from-github",
      owner: source.owner,
      repo: source.repo,
      branch: source.branch,
      commit_hash: source.commitHash,
      config_file_path: source.configFilePath,
      workflow_path: source.workflowPath,
    };
  }
  return source;
}

/**
 * Converts a BranchConfigSourceApi (API snake_case) to PushedConfigSource (SDK camelCase).
 */
function apiToPushedConfigSource(source: BranchConfigSourceApi): PushedConfigSource {
  if (source.type === "pushed-from-github") {
    return {
      type: "pushed-from-github",
      owner: source.owner,
      repo: source.repo,
      branch: source.branch,
      commitHash: source.commit_hash,
      configFilePath: source.config_file_path,
      workflowPath: source.workflow_path,
    };
  }
  return source;
}

export class _HexclaveAdminAppImplIncomplete<HasTokenStore extends boolean, ProjectId extends string> extends _HexclaveServerAppImplIncomplete<HasTokenStore, ProjectId> implements StackAdminApp<HasTokenStore, ProjectId> {
  declare protected _interface: HexclaveAdminInterface;

  private readonly _adminProjectCache = createCache(async () => {
    return await this._interface.getProject();
  });
  private readonly _planUsageCache = createCache(async () => {
    return await this._interface.getPlanUsage();
  });
  private readonly _internalApiKeysCache = createCache(async () => {
    const res = await this._interface.listInternalApiKeys();
    return res;
  });
  private readonly _adminEmailThemeCache = createCache(async ([id]: [string]) => {
    return await this._interface.getEmailTheme(id);
  });
  private readonly _adminEmailThemesCache = createCache(async () => {
    return await this._interface.listEmailThemes();
  });
  private readonly _adminEmailTemplatesCache = createCache(async () => {
    return await this._interface.listInternalEmailTemplates();
  });
  private readonly _adminEmailDraftsCache = createCache(async () => {
    return await this._interface.listInternalEmailDrafts();
  });
  private readonly _adminWorkflowsCache = createCache(async () => {
    return await this._interface.listWorkflows();
  });
  private readonly _adminTeamPermissionDefinitionsCache = createCache(async () => {
    return await this._interface.listTeamPermissionDefinitions();
  });
  private readonly _adminProjectPermissionDefinitionsCache = createCache(async () => {
    return await this._interface.listProjectPermissionDefinitions();
  });
  private readonly _svixTokenCache = createCache(async () => {
    return await this._interface.getSvixToken();
  });
  // Cache key serializes filters via URLSearchParams (sorted keys) so
  // DependenciesMap (identity-keyed per array slot) treats two equal
  // filter objects as the same deterministic string entry.
  private readonly _metricsCache = createCache(async ([includeAnonymous, filtersKey]: [boolean, string]) => {
    const filters = filtersKey ? Object.fromEntries(new URLSearchParams(filtersKey)) : undefined;
    return await this._interface.getMetrics(includeAnonymous, filters);
  });
  private readonly _userActivityCache = createCache(async ([userId]: [string]) => {
    return await this._interface.getUserActivity(userId);
  });
  private readonly _metricsUserCountsCache = createCache(async () => {
    return await this._interface.getMetricsUserCounts();
  });
  private readonly _emailPreviewCache = createCache(async ([themeId, themeTsxSource, templateId, templateTsxSource]: [string | null | false | undefined, string | undefined, string | undefined, string | undefined]) => {
    return await this._interface.renderEmailPreview({ themeId, themeTsxSource, templateId, templateTsxSource });
  });
  private readonly _emailPreviewWithEditableMarkersCache = createCache(async ([themeId, themeTsxSource, templateId, templateTsxSource, editableSource]: [string | null | false | undefined, string | undefined, string | undefined, string | undefined, 'template' | 'theme' | 'both' | undefined]) => {
    return await this._interface.renderEmailPreview({ themeId, themeTsxSource, templateId, templateTsxSource, editableMarkers: true, editableSource });
  });
  private readonly _configOverridesCache = createCache(async () => {
    return await this._interface.getConfig();
  });
  private readonly _stripeAccountInfoCache = createCache(async () => {
    try {
      return await this._interface.getStripeAccountInfo();
    } catch (error: any) {
      if (error?.status === 404) {
        return null;
      }
      throw error;
    }
  });
  private readonly _transactionsCache = createCache(async ([cursor, limit, type, customerType, customerId]: [string | undefined, number | undefined, TransactionType | undefined, 'user' | 'team' | 'custom' | undefined, string | undefined]) => {
    return await this._interface.listTransactions({ cursor, limit, type, customerType, customerId });
  });

  constructor(options: StackAdminAppConstructorOptions<HasTokenStore, ProjectId>, extraOptions?: { uniqueIdentifier?: string, checkString?: string, interface?: HexclaveAdminInterface }) {
    const resolvedOptions = resolveConstructorOptions(options);

    const publishableClientKey = resolvedOptions.publishableClientKey ?? getDefaultPublishableClientKey();

    super(resolvedOptions, {
      ...extraOptions,
      interface: extraOptions?.interface ?? (() => {
        const apiUrls = resolveApiUrls(resolvedOptions.baseUrl);
        return new HexclaveAdminInterface({
          getBaseUrl: () => apiUrls()[0],
          getApiUrls: apiUrls,
          projectId: resolvedOptions.projectId ?? getDefaultProjectId(),
          extraRequestHeaders: resolvedOptions.extraRequestHeaders ?? getDefaultExtraRequestHeaders(),
          clientVersion,
          ...resolvedOptions.projectOwnerSession ? {
            projectOwnerSession: resolvedOptions.projectOwnerSession,
          } : {
            ...(publishableClientKey ? { publishableClientKey } : {}),
            secretServerKey: resolvedOptions.secretServerKey ?? getDefaultSecretServerKey(),
            superSecretAdminKey: resolvedOptions.superSecretAdminKey ?? getDefaultSuperSecretAdminKey(),
          },
        });
      })(),
    });
  }

  _adminConfigFromCrud(data: { config_string: string }): CompleteConfig {
    return JSON.parse(data.config_string);
  }

  _adminOwnedProjectFromCrud(data: ProjectsCrud['Admin']['Read'], onRefresh: () => Promise<void>): AdminOwnedProject {
    if (this._tokenStoreInit !== null) {
      throw new HexclaveAssertionError("Owned apps must always have tokenStore === null — did you not create this project with app._createOwnedApp()?");
    }
    return {
      ...this._adminProjectFromCrud(data, onRefresh),
      app: this as StackAdminApp<false>,
    };
  }

  _adminProjectFromCrud(data: ProjectsCrud['Admin']['Read'], onRefresh: () => Promise<void>): AdminProject {
    if (data.id !== this.projectId) {
      throw new HexclaveAssertionError(`The project ID of the provided project JSON (${data.id}) does not match the project ID of the app (${this.projectId})!`);
    }

    const app = this;
    return {
      id: data.id,
      displayName: data.display_name,
      description: data.description,
      createdAt: new Date(data.created_at_millis),
      isProductionMode: data.is_production_mode,
      isDevelopmentEnvironment: data.is_development_environment,
      ownerTeamId: data.owner_team_id,
      onboardingStatus: data.onboarding_status,
      onboardingState: data.onboarding_state ?? null,
      logoUrl: data.logo_url,
      logoFullUrl: data.logo_full_url,
      logoDarkModeUrl: data.logo_dark_mode_url,
      logoFullDarkModeUrl: data.logo_full_dark_mode_url,
      pushedConfigError: data.pushed_config_error == null ? null : {
        message: data.pushed_config_error.message,
      },
      configWarnings: data.config_warnings.map((warning) => ({
        message: warning.message,
      })),
      config: {
        signUpEnabled: data.config.sign_up_enabled,
        credentialEnabled: data.config.credential_enabled,
        magicLinkEnabled: data.config.magic_link_enabled,
        passkeyEnabled: data.config.passkey_enabled,
        clientTeamCreationEnabled: data.config.client_team_creation_enabled,
        clientUserDeletionEnabled: data.config.client_user_deletion_enabled,
        allowLocalhost: data.config.allow_localhost,
        oauthAccountMergeStrategy: data.config.oauth_account_merge_strategy,
        allowUserApiKeys: data.config.allow_user_api_keys,
        allowTeamApiKeys: data.config.allow_team_api_keys,
        oauthProviders: data.config.oauth_providers.map((p) => ((p.type === 'shared' ? {
          id: p.id,
          type: 'shared',
        } as const : {
          id: p.id,
          type: 'standard',
          clientId: p.client_id ?? throwErr("Client ID is missing"),
          clientSecret: p.id === "apple" ? p.client_secret : p.client_secret ?? throwErr("Client secret is missing"),
          facebookConfigId: p.facebook_config_id,
          microsoftTenantId: p.microsoft_tenant_id,
          appleTeamId: p.apple_team_id,
          appleKeyId: p.apple_key_id,
          applePrivateKey: p.apple_private_key,
          appleBundleIds: p.apple_bundle_ids,
        } as const))),
        emailConfig: data.config.email_config.type === 'shared' ? {
          type: 'shared'
        } : {
          type: 'standard',
          host: data.config.email_config.host ?? throwErr("Email host is missing"),
          port: data.config.email_config.port ?? throwErr("Email port is missing"),
          username: data.config.email_config.username ?? throwErr("Email username is missing"),
          password: data.config.email_config.password ?? throwErr("Email password is missing"),
          senderName: data.config.email_config.sender_name ?? throwErr("Email sender name is missing"),
          senderEmail: data.config.email_config.sender_email ?? throwErr("Email sender email is missing"),
        },
        emailTheme: data.config.email_theme,
        domains: data.config.domains.map((d) => ({
          domain: d.domain,
          handlerPath: d.handler_path,
        })),
        createTeamOnSignUp: data.config.create_team_on_sign_up,
        teamCreatorDefaultPermissions: data.config.team_creator_default_permissions,
        teamMemberDefaultPermissions: data.config.team_member_default_permissions,
        userDefaultPermissions: data.config.user_default_permissions,
      },
      async getConfig() {
        return app._adminConfigFromCrud(await app._interface.getConfig());
      },
      // IF_PLATFORM react-like
      useConfig() {
        const config = useAsyncCache(app._configOverridesCache, [], "project.useConfig()");
        return useMemo(() => app._adminConfigFromCrud(config), [config]);
      },
      // END_PLATFORM
      async updateConfig(configOverride: EnvironmentConfigOverrideOverride) {
        await app._interface.updateConfigOverride("environment", configOverride);
        await app._refreshProjectConfig();
      },
      async pushConfig(config: EnvironmentConfigOverrideOverride, options: PushConfigOptions) {
        await app._interface.setConfigOverride("branch", config, pushedConfigSourceToApi(options.source));
        await app._refreshProjectConfig();
      },
      async updatePushedConfig(config: EnvironmentConfigOverrideOverride) {
        await app._interface.updateConfigOverride("branch", config);
        await app._refreshProjectConfig();
      },
      async getPushedConfigSource(): Promise<PushedConfigSource> {
        const apiSource = await app._interface.getPushedConfigSource();
        return apiToPushedConfigSource(apiSource);
      },
      async unlinkPushedConfigSource(): Promise<void> {
        await app._interface.unlinkPushedConfigSource();
        await app._refreshProjectConfig();
      },
      async resetConfigOverrideKeys(level: "branch" | "environment", keys: string[]): Promise<void> {
        await app._interface.resetConfigOverrideKeys(level, keys);
        await app._refreshProjectConfig();
      },
      async listDeploymentServices() {
        return await app._interface.listDeploymentServices();
      },
      async listProjectSecrets() {
        return await app._interface.listProjectSecrets();
      },
      async setProjectSecret(key, value) {
        await app._interface.setProjectSecret(key, value);
      },
      async deleteProjectSecret(key) {
        await app._interface.deleteProjectSecret(key);
      },
      async listDeployments(options) {
        return await app._interface.listDeployments(options);
      },
      async getDeployment(deploymentId) {
        return await app._interface.getDeployment(deploymentId);
      },
      async getDeploymentBuildLogs(deploymentId, options) {
        return await app._interface.getDeploymentBuildLogs(deploymentId, options);
      },
      async getDeploymentServiceLogs(serviceId, options) {
        return await app._interface.getDeploymentServiceLogs(serviceId, options);
      },
      async addDeploymentServiceDomain(serviceId, hostname, options) {
        await app._interface.addDeploymentServiceDomain(serviceId, hostname, options);
        await app._refreshProjectConfig();
      },
      async getDeploymentServiceDomain(serviceId, hostname) {
        return await app._interface.getDeploymentServiceDomain(serviceId, hostname);
      },
      async deleteDeploymentServiceDomain(serviceId, hostname) {
        await app._interface.deleteDeploymentServiceDomain(serviceId, hostname);
        await app._refreshProjectConfig();
      },
      async getConfigOverride(level: "branch" | "environment"): Promise<Record<string, unknown>> {
        const result = await app._interface.getConfigOverride(level);
        return JSON.parse(result.config_string);
      },
      async replaceConfigOverride(level: "branch" | "environment", config: Record<string, unknown>): Promise<void> {
        if (level === "branch") {
          const source = await app._interface.getPushedConfigSource();
          await app._interface.setConfigOverride(level, config, source);
        } else {
          await app._interface.setConfigOverride(level, config);
        }
        await app._refreshProjectConfig();
      },
      async update(update: AdminProjectUpdateOptions) {
        const { requirePublishableClientKey, ...projectUpdate } = update;
        const updateOptions = adminProjectUpdateOptionsToCrud(projectUpdate);
        const hasConfigUpdate = !!updateOptions.config
          && typedValues(updateOptions.config).some((value) => value !== undefined);
        const hasProjectUpdate = typedEntries(updateOptions).some(([key, value]) => {
          if (key === "config") return hasConfigUpdate;
          return value !== undefined;
        });

        if (hasProjectUpdate) {
          await app._interface.updateProject(updateOptions);
          await onRefresh();
        }

        if (requirePublishableClientKey !== undefined) {
          await app._interface.updateConfigOverride("project", {
            "project.requirePublishableClientKey": requirePublishableClientKey,
          });
          await app._refreshProjectConfig();
        }
      },
      async delete() {
        await app._interface.deleteProject();
      },
      async getProductionModeErrors() {
        return getProductionModeErrors(data);
      },
      // IF_PLATFORM react-like
      useProductionModeErrors() {
        return getProductionModeErrors(data);
      },
      // END_PLATFORM
    };
  }

  _adminEmailTemplateFromCrud(data: EmailTemplateCrud['Admin']['Read']): AdminEmailTemplate {
    return {
      type: data.type,
      subject: data.subject,
      content: data.content,
      isDefault: data.is_default,
    };
  }

  _planUsageFromCrud(data: PlanUsageResponse): PlanUsage {
    return {
      ownerTeamId: data.owner_team_id,
      ownerTeamDisplayName: data.owner_team_display_name,
      planId: data.plan_id,
      planDisplayName: data.plan_display_name,
      periodStart: new Date(data.period_start_millis),
      periodEnd: new Date(data.period_end_millis),
      nextPlanId: data.next_plan_id,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- getPlanUsage() returns raw JSON without yup validation, so this field can be undefined at runtime if the backend hasn't deployed the field yet
      arePlanLimitsEnforced: data.are_plan_limits_enforced ?? true,
      rows: data.rows.map((row) => ({
        itemId: row.item_id,
        displayName: row.display_name,
        kind: row.kind,
        used: row.used,
        limit: row.limit,
        remaining: row.remaining,
        overage: row.overage,
        isUnlimited: row.is_unlimited,
      })),
    };
  }

  override async getProject(): Promise<AdminProject> {
    return this._adminProjectFromCrud(
      Result.orThrow(await this._adminProjectCache.getOrWait([], "write-only")),
      () => this._refreshProject()
    );
  }

  // IF_PLATFORM react-like
  override useProject(): AdminProject {
    const crud = useAsyncCache(this._adminProjectCache, [], "adminApp.useProject()");
    return useMemo(() => this._adminProjectFromCrud(
      crud,
      () => this._refreshProject()
    ), [crud]);
  }
  // END_PLATFORM

  async getPlanUsage(): Promise<PlanUsage> {
    return this._planUsageFromCrud(Result.orThrow(await this._planUsageCache.getOrWait([], "write-only")));
  }

  // IF_PLATFORM react-like
  usePlanUsage(): PlanUsage {
    const crud = useAsyncCache(this._planUsageCache, [], "adminApp.usePlanUsage()");
    return useMemo(() => this._planUsageFromCrud(crud), [crud]);
  }
  // END_PLATFORM

  protected _createInternalApiKeyBaseFromCrud(data: InternalApiKeyBaseCrudRead): InternalApiKeyBase {
    const app = this;
    return {
      id: data.id,
      description: data.description,
      expiresAt: new Date(data.expires_at_millis),
      manuallyRevokedAt: data.manually_revoked_at_millis ? new Date(data.manually_revoked_at_millis) : null,
      createdAt: new Date(data.created_at_millis),
      isValid() {
        return this.whyInvalid() === null;
      },
      whyInvalid() {
        if (this.expiresAt.getTime() < Date.now()) return "expired";
        if (this.manuallyRevokedAt) return "manually-revoked";
        return null;
      },
      async revoke() {
        const res = await app._interface.revokeInternalApiKeyById(data.id);
        await app._refreshInternalApiKeys();
        return res;
      }
    };
  }

  protected _createInternalApiKeyFromCrud(data: InternalApiKeysCrud["Admin"]["Read"]): InternalApiKey {
    return {
      ...this._createInternalApiKeyBaseFromCrud(data),
      publishableClientKey: data.publishable_client_key ? { lastFour: data.publishable_client_key.last_four } : null,
      secretServerKey: data.secret_server_key ? { lastFour: data.secret_server_key.last_four } : null,
      superSecretAdminKey: data.super_secret_admin_key ? { lastFour: data.super_secret_admin_key.last_four } : null,
    };
  }

  protected _createInternalApiKeyFirstViewFromCrud(data: InternalApiKeyCreateCrudResponse): InternalApiKeyFirstView {
    return {
      ...this._createInternalApiKeyBaseFromCrud(data),
      publishableClientKey: data.publishable_client_key,
      secretServerKey: data.secret_server_key,
      superSecretAdminKey: data.super_secret_admin_key,
    };
  }

  async listInternalApiKeys(): Promise<InternalApiKey[]> {
    const crud = Result.orThrow(await this._internalApiKeysCache.getOrWait([], "write-only"));
    return crud.map((j) => this._createInternalApiKeyFromCrud(j));
  }

  // IF_PLATFORM react-like
  useInternalApiKeys(): InternalApiKey[] {
    const crud = useAsyncCache(this._internalApiKeysCache, [], "adminApp.useInternalApiKeys()");
    return useMemo(() => {
      return crud.map((j) => this._createInternalApiKeyFromCrud(j));
    }, [crud]);
  }
  // END_PLATFORM

  async createInternalApiKey(options: InternalApiKeyCreateOptions): Promise<InternalApiKeyFirstView> {
    const crud = await this._interface.createInternalApiKey(internalApiKeyCreateOptionsToCrud(options));
    await this._refreshInternalApiKeys();
    return this._createInternalApiKeyFirstViewFromCrud(crud);
  }


  // IF_PLATFORM react-like
  useEmailThemes(): { id: string, displayName: string }[] {
    const crud = useAsyncCache(this._adminEmailThemesCache, [], "adminApp.useEmailThemes()");
    return useMemo(() => {
      return crud.map((theme) => ({
        id: theme.id,
        displayName: theme.display_name,
      }));
    }, [crud]);
  }
  useEmailTemplates(): { id: string, displayName: string, themeId?: string, tsxSource: string }[] {
    const crud = useAsyncCache(this._adminEmailTemplatesCache, [], "adminApp.useEmailTemplates()");
    return useMemo(() => {
      return crud.map((template) => ({
        id: template.id,
        displayName: template.display_name,
        themeId: template.theme_id,
        tsxSource: template.tsx_source,
      }));
    }, [crud]);
  }
  useEmailDrafts(): { id: string, displayName: string, themeId: string | undefined | false, tsxSource: string, sentAt: Date | null }[] {
    const crud = useAsyncCache(this._adminEmailDraftsCache, [], "adminApp.useEmailDrafts()");
    return useMemo(() => {
      return crud.map((draft) => ({
        id: draft.id,
        displayName: draft.display_name,
        themeId: draft.theme_id,
        tsxSource: draft.tsx_source,
        sentAt: draft.sent_at_millis ? new Date(draft.sent_at_millis) : null,
      }));
    }, [crud]);
  }
  useWorkflows(): AdminWorkflow[] {
    const crud = useAsyncCache(this._adminWorkflowsCache, [], "adminApp.useWorkflows()");
    return useMemo(() => crud.map(adminWorkflowFromCrud), [crud]);
  }
  // END_PLATFORM
  async listEmailThemes(): Promise<{ id: string, displayName: string }[]> {
    const crud = Result.orThrow(await this._adminEmailThemesCache.getOrWait([], "write-only"));
    return crud.map((theme) => ({
      id: theme.id,
      displayName: theme.display_name,
    }));
  }

  async listEmailTemplates(): Promise<{ id: string, displayName: string, themeId?: string, tsxSource: string }[]> {
    const crud = Result.orThrow(await this._adminEmailTemplatesCache.getOrWait([], "write-only"));
    return crud.map((template) => ({
      id: template.id,
      displayName: template.display_name,
      themeId: template.theme_id,
      tsxSource: template.tsx_source,
    }));
  }

  // ─── Workflows (internal-project gated; see the Workflows v1 spec) ───────

  async listWorkflows(): Promise<AdminWorkflow[]> {
    const crud = Result.orThrow(await this._adminWorkflowsCache.getOrWait([], "write-only"));
    return crud.map(adminWorkflowFromCrud);
  }

  async createWorkflow(options: { id: string, displayName?: string, source: string }): Promise<AdminWorkflowSyncResult> {
    const result = await this._interface.createWorkflow({
      id: options.id,
      display_name: options.displayName,
      source: options.source,
    });
    await this._adminWorkflowsCache.refresh([]);
    return adminWorkflowSyncResultFromCrud(result);
  }

  async updateWorkflowSource(workflowId: string, source: string): Promise<AdminWorkflowSyncResult> {
    const result = await this._interface.updateWorkflowSource(workflowId, source);
    await this._adminWorkflowsCache.refresh([]);
    return adminWorkflowSyncResultFromCrud(result);
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    await this._interface.deleteWorkflow(workflowId);
    await this._adminWorkflowsCache.refresh([]);
  }

  async setWorkflowPaused(workflowId: string, isPaused: boolean): Promise<void> {
    await this._interface.setWorkflowPaused(workflowId, isPaused);
    await this._adminWorkflowsCache.refresh([]);
  }

  async listWorkflowVersions(workflowId: string): Promise<AdminWorkflowVersion[]> {
    return (await this._interface.listWorkflowVersions(workflowId)).map(adminWorkflowVersionFromCrud);
  }

  async listWorkflowRuns(workflowId: string, filter: AdminWorkflowRunsFilter & { includeState: true }): Promise<{ runs: AdminWorkflowRunDetails[], nextCursor: string | null }>;
  async listWorkflowRuns(workflowId: string, filter?: AdminWorkflowRunsFilter): Promise<{ runs: AdminWorkflowRun[], nextCursor: string | null }>;
  async listWorkflowRuns(workflowId: string, filter: AdminWorkflowRunsFilter = {}): Promise<{ runs: AdminWorkflowRun[], nextCursor: string | null }> {
    if (filter.includeState === true) {
      const result = await this._interface.listWorkflowRuns(workflowId, {
        state: filter.state,
        version: filter.version,
        run_key: filter.runKey,
        cursor: filter.cursor,
        limit: filter.limit,
        include_state: true,
      });
      return {
        runs: result.runs.map((run) => adminWorkflowRunDetailsFromCrud(
          isWorkflowRunDetailsJson(run)
            ? run
            : throwErr("Workflow runs response omitted state after include_state=true"),
        )),
        nextCursor: result.next_cursor,
      };
    }
    const result = await this._interface.listWorkflowRuns(workflowId, {
      state: filter.state,
      version: filter.version,
      run_key: filter.runKey,
      cursor: filter.cursor,
      limit: filter.limit,
    });
    return {
      runs: result.runs.map(adminWorkflowRunFromCrud),
      nextCursor: result.next_cursor,
    };
  }

  async getWorkflowRun(runId: string): Promise<AdminWorkflowRunDetails> {
    return adminWorkflowRunDetailsFromCrud(await this._interface.getWorkflowRun(runId));
  }

  async cancelWorkflowRuns(workflowId: string, filter: { runKey?: string, runId?: string, state?: "queued" | "running" | "sleeping", version?: number } = {}): Promise<{ canceledCount: number }> {
    const result = await this._interface.cancelWorkflowRuns(workflowId, {
      run_key: filter.runKey,
      run_id: filter.runId,
      state: filter.state,
      version: filter.version,
    });
    await this._adminWorkflowsCache.refresh([]);
    return { canceledCount: result.canceled_count };
  }

  async upgradeWorkflowRuns(workflowId: string, options: { toVersion: number, runKey?: string, fromVersion?: number }): Promise<AdminWorkflowUpgradeResult> {
    const result = await this._interface.upgradeWorkflowRuns(workflowId, {
      to_version: options.toVersion,
      run_key: options.runKey,
      from_version: options.fromVersion,
    });
    return {
      upgradedCount: result.upgraded_count,
      skipped: result.skipped.map((skip) => ({
        runId: skip.run_id,
        runKey: skip.run_key,
        fromVersion: skip.from_version,
        diagnostic: {
          reason: skip.diagnostic.reason,
          suspendedStepKey: skip.diagnostic.suspended_step_key,
          foundStepKey: skip.diagnostic.found_step_key,
          consumedStepKeys: skip.diagnostic.consumed_step_keys,
          unconsumedStepKeys: skip.diagnostic.unconsumed_step_keys,
          details: skip.diagnostic.details,
        },
      })),
    };
  }

  async retryWorkflowRun(runId: string): Promise<void> {
    await this._interface.retryWorkflowRun(runId);
    await this._adminWorkflowsCache.refresh([]);
  }

  async sendWorkflowEvent(name: string, data?: unknown): Promise<{ eventId: string }> {
    const result = await this._interface.sendWorkflowEvent(name, data ?? null);
    // Sending an event can create a run asynchronously. Refresh the summary
    // cache so the workflow page does not keep showing the pre-event counts
    // after the runs grid has been explicitly reloaded.
    await this._adminWorkflowsCache.refresh([]);
    return { eventId: result.event_id };
  }

  async listEmailDrafts(): Promise<{ id: string, displayName: string, themeId: string | undefined | false, tsxSource: string, sentAt: Date | null }[]> {
    const crud = Result.orThrow(await this._adminEmailDraftsCache.getOrWait([], "write-only"));
    return crud.map((draft) => ({
      id: draft.id,
      displayName: draft.display_name,
      themeId: draft.theme_id,
      tsxSource: draft.tsx_source,
      sentAt: draft.sent_at_millis ? new Date(draft.sent_at_millis) : null,
    }));
  }


  async createTeamPermissionDefinition(data: AdminTeamPermissionDefinitionCreateOptions): Promise<AdminTeamPermission> {
    const crud = await this._interface.createTeamPermissionDefinition(adminTeamPermissionDefinitionCreateOptionsToCrud(data));
    await this._adminTeamPermissionDefinitionsCache.refresh([]);
    return this._serverTeamPermissionDefinitionFromCrud(crud);
  }

  async updateTeamPermissionDefinition(permissionId: string, data: AdminTeamPermissionDefinitionUpdateOptions) {
    await this._interface.updateTeamPermissionDefinition(permissionId, adminTeamPermissionDefinitionUpdateOptionsToCrud(data));
    await this._adminTeamPermissionDefinitionsCache.refresh([]);
  }

  async deleteTeamPermissionDefinition(permissionId: string): Promise<void> {
    await this._interface.deleteTeamPermissionDefinition(permissionId);
    await this._adminTeamPermissionDefinitionsCache.refresh([]);
  }

  async listTeamPermissionDefinitions(): Promise<AdminTeamPermissionDefinition[]> {
    const crud = Result.orThrow(await this._adminTeamPermissionDefinitionsCache.getOrWait([], "write-only"));
    return crud.map((p) => this._serverTeamPermissionDefinitionFromCrud(p));
  }

  async listTeamPermissionDefinitionsPaginated(
    options: { limit: number, cursor?: string, query?: string },
  ): Promise<{ items: AdminTeamPermissionDefinition[], nextCursor: string | null }> {
    const result = await this._interface.listTeamPermissionDefinitionsPaginated(options);
    return {
      items: result.items.map((p) => this._serverTeamPermissionDefinitionFromCrud(p)),
      nextCursor: result.nextCursor,
    };
  }

  // IF_PLATFORM react-like
  useTeamPermissionDefinitions(): AdminTeamPermissionDefinition[] {
    const crud = useAsyncCache(this._adminTeamPermissionDefinitionsCache, [], "adminApp.useTeamPermissionDefinitions()");
    return useMemo(() => {
      return crud.map((p) => this._serverTeamPermissionDefinitionFromCrud(p));
    }, [crud]);
  }
  // END_PLATFORM

  async createProjectPermissionDefinition(data: AdminProjectPermissionDefinitionCreateOptions): Promise<AdminProjectPermission> {
    const crud = await this._interface.createProjectPermissionDefinition(adminProjectPermissionDefinitionCreateOptionsToCrud(data));
    await this._adminProjectPermissionDefinitionsCache.refresh([]);
    return this._serverProjectPermissionDefinitionFromCrud(crud);
  }

  async updateProjectPermissionDefinition(permissionId: string, data: AdminProjectPermissionDefinitionUpdateOptions) {
    await this._interface.updateProjectPermissionDefinition(permissionId, adminProjectPermissionDefinitionUpdateOptionsToCrud(data));
    await this._adminProjectPermissionDefinitionsCache.refresh([]);
  }

  async deleteProjectPermissionDefinition(permissionId: string): Promise<void> {
    await this._interface.deleteProjectPermissionDefinition(permissionId);
    await this._adminProjectPermissionDefinitionsCache.refresh([]);
  }

  async listProjectPermissionDefinitions(): Promise<AdminProjectPermissionDefinition[]> {
    const crud = Result.orThrow(await this._adminProjectPermissionDefinitionsCache.getOrWait([], "write-only"));
    return crud.map((p) => this._serverProjectPermissionDefinitionFromCrud(p));
  }

  // IF_PLATFORM react-like
  useProjectPermissionDefinitions(): AdminProjectPermissionDefinition[] {
    const crud = useAsyncCache(this._adminProjectPermissionDefinitionsCache, [], "adminApp.useProjectPermissionDefinitions()");
    return useMemo(() => {
      return crud.map((p) => this._serverProjectPermissionDefinitionFromCrud(p));
    }, [crud]);
  }
  // END_PLATFORM
  // IF_PLATFORM react-like
  useSvixToken(): { token: string, url: string | undefined } {
    const crud = useAsyncCache(this._svixTokenCache, [], "adminApp.useSvixToken()");
    return { token: crud.token, url: crud.url };
  }
  // END_PLATFORM

  protected override async _refreshProject() {
    await Promise.all([
      super._refreshProject(),
      this._adminProjectCache.refresh([]),
    ]);
  }

  protected async _refreshProjectConfig() {
    await Promise.all([
      this._configOverridesCache.refresh([]),
      this._adminProjectCache.refresh([]),
    ]);
  }

  protected async _refreshInternalApiKeys() {
    await this._internalApiKeysCache.refresh([]);
  }

  protected override async _refreshUsers() {
    await Promise.all([
      super._refreshUsers(),
      this._metricsCache.refreshWhere(() => true),
      this._metricsUserCountsCache.refresh([]),
    ]);
  }

  get [hexclaveAppInternalsSymbol]() {
    return {
      ...super[hexclaveAppInternalsSymbol],
      // IF_PLATFORM react-like
      useMetrics: (
        includeAnonymous: boolean = false,
        filters?: { country_code?: string, referrer?: string, browser?: string, os?: string, device?: string, since?: string, until?: string },
      ): MetricsResponse => {
        const filtersKey = (() => {
          if (filters == null) return "";
          const params = new URLSearchParams();
          for (const key of ["browser", "country_code", "device", "os", "referrer", "since", "until"] as const) {
            const v = filters[key];
            if (v != null) params.set(key, v);
          }
          return params.toString();
        })();
        return useAsyncCache(this._metricsCache, [includeAnonymous, filtersKey] as const, "adminApp.useMetrics()") as MetricsResponse;
      },
      useUserActivity: (userId: string): UserActivityResponse => {
        return useAsyncCache(this._userActivityCache, [userId] as const, "adminApp.useUserActivity()") as UserActivityResponse;
      },
      useMetricsUserCounts: (): MetricsUserCounts => {
        return useAsyncCache(this._metricsUserCountsCache, [] as const, "adminApp.useMetricsUserCounts()") as MetricsUserCounts;
      },
      // END_PLATFORM
    };
  }

  async sendTestEmail(options: {
    recipientEmail: string,
    emailConfig: EmailConfig,
  }): Promise<Result<undefined, { errorMessage: string }>> {
    let response: { success: boolean, error_message?: string };
    try {
      response = await this._interface.sendTestEmail({
        recipient_email: options.recipientEmail,
        email_config: {
          ...(pick(options.emailConfig, ['host', 'port', 'username', 'password'])),
          sender_email: options.emailConfig.senderEmail,
          sender_name: options.emailConfig.senderName,
        },
      });
    } catch (error) {
      // Translate the quota-exhaustion KnownError into the existing
      // Result.error shape so SDK/dashboard callers don't need to branch on
      // exceptions. The backend throws `ItemQuantityInsufficientAmount`
      // (consistent with every other limit-rejection endpoint), but this
      // method's historical contract has always been a `Result`.
      if (error instanceof KnownErrors.ItemQuantityInsufficientAmount) {
        return Result.error({
          errorMessage: "Monthly email sending limit exceeded for your plan. Please upgrade your plan or wait until next month before sending more test emails.",
        });
      }
      throw error;
    }

    if (response.success) {
      return Result.ok(undefined);
    } else {
      return Result.error({ errorMessage: response.error_message ?? throwErr("Email test error not specified") });
    }
  }

  async sendTestWebhook(options: { endpointId: string }): Promise<Result<undefined, { errorMessage: string }>> {
    const response = await this._interface.sendTestWebhook({
      endpoint_id: options.endpointId,
    });

    if (response.success) {
      return Result.ok(undefined);
    } else {
      return Result.error({ errorMessage: response.error_message ?? throwErr("Webhook test error not specified") });
    }
  }

  async listSentEmails(): Promise<AdminSentEmail[]> {
    const response = await this._interface.listSentEmails();
    return response.items.map((email) => ({
      id: email.id,
      to: email.to ?? [],
      subject: email.subject,
      recipient: email.to?.[0] ?? "",
      sentAt: new Date(email.sent_at_millis),
      error: email.error,
    }));
  }

  async setupManagedEmailProvider(options: { subdomain: string, senderLocalPart: string }): Promise<ManagedEmailProviderSetupResult> {
    const response = await this._interface.setupManagedEmailProvider({
      subdomain: options.subdomain,
      sender_local_part: options.senderLocalPart,
    });
    return {
      domainId: response.domain_id,
      subdomain: response.subdomain,
      senderLocalPart: response.sender_local_part,
      nameServerRecords: response.name_server_records,
      status: response.status,
    };
  }

  async checkManagedEmailStatus(options: { domainId: string, subdomain: string, senderLocalPart: string }): Promise<ManagedEmailProviderStatus> {
    const response = await this._interface.checkManagedEmailStatus({
      domain_id: options.domainId,
      subdomain: options.subdomain,
      sender_local_part: options.senderLocalPart,
    });
    return {
      status: response.status,
    };
  }

  async listManagedEmailDomains(): Promise<ManagedEmailProviderListItem[]> {
    const response = await this._interface.listManagedEmailDomains();
    return response.items.map((item) => ({
      domainId: item.domain_id,
      subdomain: item.subdomain,
      senderLocalPart: item.sender_local_part,
      status: item.status,
      nameServerRecords: item.name_server_records,
    }));
  }

  async applyManagedEmailProvider(options: { domainId: string }): Promise<{ status: "applied" }> {
    const result = await this._interface.applyManagedEmailProvider({
      domain_id: options.domainId,
    });
    await this._refreshProjectConfig();
    return result;
  }

  async deleteManagedEmailDomain(options: { resendDomainId: string }): Promise<{ status: "deleted" }> {
    return await this._interface.deleteManagedEmailDomain({
      resend_domain_id: options.resendDomainId,
    });
  }

  async sendSignInInvitationEmail(email: string, callbackUrl: string): Promise<void> {
    await this._interface.sendSignInInvitationEmail(email, callbackUrl);
  }

  async createEmailTemplate(displayName: string): Promise<{ id: string }> {
    const result = await this._interface.createEmailTemplate(displayName);
    await this._adminEmailTemplatesCache.refresh([]);

    return result;
  }

  async deleteEmailTemplate(id: string): Promise<void> {
    await this._interface.deleteEmailTemplate(id);
    await this._adminEmailTemplatesCache.refresh([]);
  }

  async createEmailDraft(options: { displayName: string, themeId?: string | false, tsxSource?: string }): Promise<{ id: string }> {
    const result = await this._interface.createEmailDraft({
      display_name: options.displayName,
      theme_id: options.themeId,
      tsx_source: options.tsxSource,
    });
    await this._adminEmailDraftsCache.refresh([]);
    return result;
  }

  async updateEmailDraft(id: string, data: { displayName?: string, themeId?: string | undefined | false, tsxSource?: string }): Promise<void> {
    await this._interface.updateEmailDraft(id, {
      display_name: data.displayName,
      theme_id: data.themeId,
      tsx_source: data.tsxSource,
    });
    await this._adminEmailDraftsCache.refresh([]);
  }

  async deleteEmailDraft(id: string): Promise<void> {
    await this._interface.deleteEmailDraft(id);
    const current = this._adminEmailDraftsCache.getIfCached([]);
    if (current.status === "ok" && current.data.status === "ok") {
      this._adminEmailDraftsCache.forceSetCachedValue([], Result.ok(current.data.data.filter((d) => d.id !== id)));
    }
    await this._adminEmailDraftsCache.refresh([]);
  }

  async refreshEmailDrafts(): Promise<void> {
    await this._adminEmailDraftsCache.refresh([]);
  }

  async saveChatMessage(threadId: string, message: any): Promise<void> {
    await this._interface.saveChatMessage(threadId, message);
  }

  async listChatMessages(threadId: string): Promise<{ messages: Array<any> }> {
    return await this._interface.listChatMessages(threadId);
  }

  async rewriteTemplateSourceWithAI(templateTsxSource: string): Promise<{ tsxSource: string }> {
    const result = await this._interface.rewriteTemplateSourceWithAI(templateTsxSource);
    return { tsxSource: result.tsx_source };
  }

  async createEmailTheme(displayName: string): Promise<{ id: string }> {
    const result = await this._interface.createEmailTheme(displayName);
    await this._adminEmailThemesCache.refresh([]);
    return result;
  }

  async getEmailPreview(options: { themeId?: string | null | false, themeTsxSource?: string, templateId?: string, templateTsxSource?: string }): Promise<string> {
    const result = Result.orThrow(await this._emailPreviewCache.getOrWait([options.themeId, options.themeTsxSource, options.templateId, options.templateTsxSource], "write-only"));
    return result.html;
  }
  // IF_PLATFORM react-like
  useEmailPreview(options: { themeId?: string | null | false, themeTsxSource?: string, templateId?: string, templateTsxSource?: string }): string {
    const crud = useAsyncCache(this._emailPreviewCache, [options.themeId, options.themeTsxSource, options.templateId, options.templateTsxSource] as const, "adminApp.useEmailPreview()");
    return crud.html;
  }
  // END_PLATFORM
  async getEmailPreviewWithEditableMarkers(options: { themeId?: string | null | false, themeTsxSource?: string, templateId?: string, templateTsxSource?: string, editableSource?: 'template' | 'theme' | 'both' }): Promise<{ html: string, editableRegions?: Record<string, EditableMetadata> }> {
    const result = await this._interface.renderEmailPreview({ ...options, editableMarkers: true, editableSource: options.editableSource });
    return { html: result.html, editableRegions: result.editable_regions };
  }
  // IF_PLATFORM react-like
  useEmailPreviewWithEditableMarkers(options: { themeId?: string | null | false, themeTsxSource?: string, templateId?: string, templateTsxSource?: string, editableSource?: 'template' | 'theme' | 'both' }): { html: string, editableRegions?: Record<string, EditableMetadata> } {
    const crud = useAsyncCache(this._emailPreviewWithEditableMarkersCache, [options.themeId, options.themeTsxSource, options.templateId, options.templateTsxSource, options.editableSource] as const, "adminApp.useEmailPreviewWithEditableMarkers()");
    return { html: crud.html, editableRegions: crud.editable_regions };
  }
  // END_PLATFORM
  // IF_PLATFORM react-like
  useEmailTheme(id: string): { displayName: string, tsxSource: string } {
    const crud = useAsyncCache(this._adminEmailThemeCache, [id] as const, "adminApp.useEmailTheme()");
    return {
      displayName: crud.display_name,
      tsxSource: crud.tsx_source,
    };
  }
  // END_PLATFORM
  async updateEmailTheme(id: string, tsxSource: string): Promise<void> {
    await this._interface.updateEmailTheme(id, tsxSource);
    await this._adminEmailThemesCache.refresh([]);
    await this._adminEmailThemeCache.invalidate([id]);
  }

  async deleteEmailTheme(id: string): Promise<void> {
    await this._interface.deleteEmailTheme(id);
    await this._adminEmailThemesCache.refresh([]);
    await this._adminEmailThemeCache.invalidate([id]);
  }

  async updateEmailTemplate(id: string, tsxSource: string, themeId: string | null | false): Promise<{ renderedHtml: string }> {
    const result = await this._interface.updateEmailTemplate(id, tsxSource, themeId);
    await this._adminEmailTemplatesCache.refresh([]);
    return { renderedHtml: result.rendered_html };
  }

  async setupPayments(): Promise<{ url: string }> {
    const result = await this._interface.setupPayments();
    await this._stripeAccountInfoCache.refresh([]);
    return result;
  }

  async createStripeWidgetAccountSession(): Promise<{ client_secret: string }> {
    return await this._interface.createStripeWidgetAccountSession();
  }

  async getPaymentMethodConfigs(): Promise<{ configId: string, methods: Array<{ id: string, name: string, enabled: boolean, available: boolean, overridable: boolean }> } | null> {
    return await this._interface.getPaymentMethodConfigs();
  }

  async updatePaymentMethodConfigs(configId: string, updates: Record<string, 'on' | 'off'>): Promise<void> {
    await this._interface.updatePaymentMethodConfigs(configId, updates);
  }

  async createItemQuantityChange(options: (
    { userId: string, itemId: string, quantity: number, expiresAt?: string, description?: string } |
    { teamId: string, itemId: string, quantity: number, expiresAt?: string, description?: string } |
    { customCustomerId: string, itemId: string, quantity: number, expiresAt?: string, description?: string }
  )): Promise<void> {
    await this._interface.updateItemQuantity(
      { itemId: options.itemId, ...("userId" in options ? { userId: options.userId } : ("teamId" in options ? { teamId: options.teamId } : { customCustomerId: options.customCustomerId })) },
      {
        delta: options.quantity,
        expires_at: options.expiresAt,
        description: options.description,
        allow_negative: true,
      }
    );
    const [customerType, customerId] = "userId" in options
      ? ["user", options.userId] as const
      : "teamId" in options
        ? ["team", options.teamId] as const
        : ["custom", options.customCustomerId] as const;
    try {
      // Best-effort: the quantity change is already persisted at this point, so
      // a cache refresh failure must not make the mutation look failed (a retry
      // would apply the delta twice).
      await this._refreshItemCache(customerType, customerId, options.itemId);
      await this._transactionsCache.invalidateWhere(() => true);
    } catch (error) {
      captureError("create-item-quantity-change-cache-refresh", error);
    }
  }

  async refundTransaction(options: {
    type: "subscription" | "one-time-purchase",
    id: string,
    invoiceId?: string,
    amountUsd: MoneyAmount,
    endAction?: "now" | "at-period-end",
  }): Promise<{ refundTransactionId: string }> {
    const result = await this._interface.refundTransaction({
      type: options.type,
      id: options.id,
      invoiceId: options.invoiceId,
      amountUsd: options.amountUsd,
      endAction: options.endAction,
    });
    await this._transactionsCache.invalidateWhere(() => true);
    return { refundTransactionId: result.refundTransactionId };
  }

  async listTransactions(params: { cursor?: string, limit?: number, type?: TransactionType, customerType?: 'user' | 'team' | 'custom', customerId?: string }): Promise<{ transactions: Transaction[], nextCursor: string | null }> {
    const crud = Result.orThrow(await this._transactionsCache.getOrWait([params.cursor, params.limit, params.type, params.customerType, params.customerId] as const, "write-only"));
    return crud;
  }

  // Email Outbox methods

  private _emailOutboxCrudToAdmin(crud: EmailOutboxCrud["Admin"]["Read"]): AdminEmailOutbox {
    const recipient = crud.to;
    let to: AdminEmailOutbox["to"];
    if (recipient.type === "user-primary-email") {
      to = { type: "user-primary-email", userId: recipient.user_id };
    } else if (recipient.type === "user-custom-emails") {
      to = { type: "user-custom-emails", userId: recipient.user_id, emails: recipient.emails };
    } else {
      to = { type: "custom-emails", emails: recipient.emails };
    }

    // Base fields present on all emails
    const base = {
      id: crud.id,
      createdAt: new Date(crud.created_at_millis),
      updatedAt: new Date(crud.updated_at_millis),
      tsxSource: crud.tsx_source,
      themeId: crud.theme_id,
      to,
      scheduledAt: new Date(crud.scheduled_at_millis),
      // Source tracking for grouping emails by template/draft
      createdWith: crud.created_with,
      emailDraftId: crud.email_draft_id,
      emailProgrammaticCallTemplateId: crud.email_programmatic_call_template_id,
      variables: crud.variables,
      isPaused: false as const,
      hasRendered: false as const,
      hasDelivered: false as const,
      // Retry tracking fields
      sendRetries: crud.send_retries,
      nextSendRetryAt: crud.next_send_retry_at_millis ? new Date(crud.next_send_retry_at_millis) : null,
      sendAttemptErrors: crud.send_attempt_errors ? crud.send_attempt_errors.map((e) => ({
        attemptNumber: e.attempt_number,
        timestamp: e.timestamp,
        externalMessage: e.external_message,
        externalDetails: e.external_details,
        internalMessage: e.internal_message,
        internalDetails: e.internal_details,
      })) : null,
    };

    // Rendered fields (available after rendering completes successfully)
    const rendered = crud.has_rendered ? {
      ...base,
      startedRenderingAt: new Date(crud.started_rendering_at_millis),
      renderedAt: new Date(crud.rendered_at_millis),
      subject: crud.subject,
      html: crud.html,
      text: crud.text,
      isTransactional: crud.is_transactional,
      isHighPriority: crud.is_high_priority,
      notificationCategoryId: crud.notification_category_id,
      hasRendered: true as const,
    } : null;

    // Started sending fields
    const startedSending = rendered && crud.started_sending_at_millis ? {
      ...rendered,
      startedSendingAt: new Date(crud.started_sending_at_millis),
    } : null;

    // Finished delivering fields
    const finishedDelivering = startedSending && crud.has_delivered ? {
      ...startedSending,
      deliveredAt: new Date(crud.delivered_at_millis),
      hasDelivered: true as const,
    } : null;

    // Use type assertion at the end because TypeScript has trouble with
    // spread + override patterns on discriminated unions with const literal types
    const result = (() => {
      switch (crud.status) {
        case "paused": {
          return {
            ...base,
            status: "paused" as const,
            simpleStatus: "in-progress" as const,
            isPaused: true as const,
          };
        }
        case "preparing": {
          return {
            ...base,
            status: "preparing" as const,
            simpleStatus: "in-progress" as const,
          };
        }
        case "rendering": {
          return {
            ...base,
            status: "rendering" as const,
            simpleStatus: "in-progress" as const,
            startedRenderingAt: new Date(crud.started_rendering_at_millis),
          };
        }
        case "render-error": {
          return {
            ...base,
            status: "render-error" as const,
            simpleStatus: "error" as const,
            startedRenderingAt: new Date(crud.started_rendering_at_millis),
            renderedAt: new Date(crud.rendered_at_millis),
            renderError: crud.render_error,
          };
        }
        case "scheduled": {
          return {
            ...rendered!,
            status: "scheduled" as const,
            simpleStatus: "in-progress" as const,
          };
        }
        case "queued": {
          return {
            ...rendered!,
            status: "queued" as const,
            simpleStatus: "in-progress" as const,
          };
        }
        case "sending": {
          return {
            ...startedSending!,
            status: "sending" as const,
            simpleStatus: "in-progress" as const,
          };
        }
        case "server-error": {
          return {
            ...startedSending!,
            status: "server-error" as const,
            simpleStatus: "error" as const,
            errorAt: new Date(crud.error_at_millis),
            serverError: crud.server_error,
          };
        }
        case "skipped": {
          return {
            ...base,
            status: "skipped" as const,
            simpleStatus: "ok" as const,
            skippedAt: new Date(crud.skipped_at_millis),
            skippedReason: crud.skipped_reason,
            skippedDetails: crud.skipped_details,
            hasRendered: crud.has_rendered,
            // Optional fields
            startedRenderingAt: crud.started_rendering_at_millis ? new Date(crud.started_rendering_at_millis) : undefined,
            renderedAt: crud.rendered_at_millis ? new Date(crud.rendered_at_millis) : undefined,
            subject: crud.subject,
            html: crud.html,
            text: crud.text,
            isTransactional: crud.is_transactional,
            isHighPriority: crud.is_high_priority,
            notificationCategoryId: crud.notification_category_id,
            startedSendingAt: crud.started_sending_at_millis ? new Date(crud.started_sending_at_millis) : undefined,
          };
        }
        case "bounced": {
          return {
            ...startedSending!,
            status: "bounced" as const,
            simpleStatus: "error" as const,
            bouncedAt: new Date(crud.bounced_at_millis),
          };
        }
        case "delivery-delayed": {
          return {
            ...startedSending!,
            status: "delivery-delayed" as const,
            simpleStatus: "ok" as const,
            deliveryDelayedAt: new Date(crud.delivery_delayed_at_millis),
          };
        }
        case "sent": {
          return {
            ...finishedDelivering!,
            status: "sent" as const,
            simpleStatus: "ok" as const,
            canHaveDeliveryInfo: crud.can_have_delivery_info,
          };
        }
        case "opened": {
          return {
            ...finishedDelivering!,
            status: "opened" as const,
            simpleStatus: "ok" as const,
            openedAt: new Date(crud.opened_at_millis),
            canHaveDeliveryInfo: true as const,
          };
        }
        case "clicked": {
          return {
            ...finishedDelivering!,
            status: "clicked" as const,
            simpleStatus: "ok" as const,
            clickedAt: new Date(crud.clicked_at_millis),
            canHaveDeliveryInfo: true as const,
          };
        }
        case "marked-as-spam": {
          return {
            ...finishedDelivering!,
            status: "marked-as-spam" as const,
            simpleStatus: "ok" as const,
            markedAsSpamAt: new Date(crud.marked_as_spam_at_millis),
            canHaveDeliveryInfo: true as const,
          };
        }
        default: {
          throw new HexclaveAssertionError(`Unknown email outbox status: ${crud.status}`, { status: crud.status });
        }
      }
    })();
    // SAFETY: The status switch above covers every schema variant, and each branch adds the fields
    // required by that discriminated AdminEmailOutbox member.
    return result as AdminEmailOutbox;
  }

  async listOutboxEmails(options?: { status?: string, simpleStatus?: string, userId?: string, limit?: number, cursor?: string }): Promise<{ items: AdminEmailOutbox[], nextCursor: string | null }> {
    const response = await this._interface.listOutboxEmails({
      status: options?.status,
      simple_status: options?.simpleStatus,
      user_id: options?.userId,
      limit: options?.limit,
      cursor: options?.cursor,
    });
    return {
      items: response.items.map((item) => this._emailOutboxCrudToAdmin(item)),
      nextCursor: response.pagination?.next_cursor ?? null,
    };
  }

  async getOutboxEmail(id: string): Promise<AdminEmailOutbox> {
    const response = await this._interface.getOutboxEmail(id);
    return this._emailOutboxCrudToAdmin(response);
  }

  async updateOutboxEmail(id: string, options: EmailOutboxUpdateOptions): Promise<AdminEmailOutbox> {
    const response = await this._interface.updateOutboxEmail(id, {
      is_paused: options.isPaused,
      scheduled_at_millis: options.scheduledAtMillis,
      cancel: options.cancel,
      tsx_source: options.tsxSource,
      theme_id: options.themeId,
    });
    return this._emailOutboxCrudToAdmin(response);
  }

  async pauseOutboxEmail(id: string): Promise<AdminEmailOutbox> {
    return await this.updateOutboxEmail(id, { isPaused: true });
  }

  async unpauseOutboxEmail(id: string): Promise<AdminEmailOutbox> {
    return await this.updateOutboxEmail(id, { isPaused: false });
  }

  async cancelOutboxEmail(id: string): Promise<AdminEmailOutbox> {
    return await this.updateOutboxEmail(id, { cancel: true });
  }

  // IF_PLATFORM react-like
  useTransactions(params: { cursor?: string, limit?: number, type?: TransactionType, customerType?: 'user' | 'team' | 'custom', customerId?: string }): { transactions: Transaction[], nextCursor: string | null } {
    const data = useAsyncCache(this._transactionsCache, [params.cursor, params.limit, params.type, params.customerType, params.customerId] as const, "adminApp.useTransactions()");
    return data;
  }
  // END_PLATFORM

  async getStripeAccountInfo(): Promise<null | { account_id: string, charges_enabled: boolean, details_submitted: boolean, payouts_enabled: boolean }> {
    return Result.orThrow(await this._stripeAccountInfoCache.getOrWait([], "write-only"));
  }

  // IF_PLATFORM react-like
  useStripeAccountInfo(): { account_id: string, charges_enabled: boolean, details_submitted: boolean, payouts_enabled: boolean } | null {
    const data = useAsyncCache(this._stripeAccountInfoCache, [], "adminApp.useStripeAccountInfo()");
    return data;
  }
  // END_PLATFORM

  async getAnalyticsClickmap(options: AnalyticsClickmapOptions): Promise<AnalyticsClickmapResponse> {
    return await this._interface.getAnalyticsClickmap({
      kind: options.kind,
      member_user_ids: options.memberUserIds,
      route_path: options.routePath,
      route_regex: options.routeRegex,
      url_pattern: options.urlPattern,
      user_id: options.userId,
      replay_id: options.replayId,
      device: options.device,
      viewport_width_min: options.viewportWidthMin,
      viewport_width_max: options.viewportWidthMax,
      sampling: options.sampling,
      since: options.since,
      until: options.until,
    });
  }

  async createAnalyticsClickmapToken(options: { origin: string }): Promise<AnalyticsClickmapTokenResponse> {
    return await this._interface.createAnalyticsClickmapToken(options);
  }

  async previewAffectedUsersByOnboardingChange(
    onboarding: { requireEmailVerification?: boolean },
    limit?: number,
  ): Promise<{
    affectedUsers: Array<{
      id: string,
      displayName: string | null,
      primaryEmail: string | null,
      restrictedReason: RestrictedReason,
    }>,
    totalAffectedCount: number,
  }> {
    const result = await this._interface.previewAffectedUsersByOnboardingChange(
      { require_email_verification: onboarding.requireEmailVerification },
      limit,
    );
    return {
      affectedUsers: result.affected_users.map(u => ({
        id: u.id,
        displayName: u.display_name,
        primaryEmail: u.primary_email,
        restrictedReason: u.restricted_reason as RestrictedReason,
      })),
      totalAffectedCount: result.total_affected_count,
    };
  }
}
