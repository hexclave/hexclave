import { ProductionModeError } from "@hexclave/shared/dist/helpers/production-mode";
import { AdminUserProjectsCrud, ProjectsCrud } from "@hexclave/shared/dist/interface/crud/projects";
import { ProjectOnboardingStatus } from "@hexclave/shared/dist/schema-fields";

import { CompleteConfig, EnvironmentConfigNormalizedOverride, EnvironmentConfigOverrideOverride } from "@hexclave/shared/dist/config/schema";
import type { AdminDeploymentDomainJson, AdminDeploymentJson, AdminDeploymentServiceLogLineJson, AdminDeploymentServiceOutcomeJson, AdminProjectSecretJson, AdminDeploymentServiceJson } from "@hexclave/shared/dist/interface/admin-interface";
import { StackAdminApp } from "../apps/interfaces/admin-app";
import { AdminProjectConfig, AdminProjectConfigUpdateOptions, ProjectConfig } from "../project-configs";

export type { AdminDeploymentDomainJson, AdminDeploymentEnvVarJson, AdminDeploymentJson, AdminDeploymentServiceLogLineJson, AdminDeploymentServiceOutcomeJson, AdminProjectSecretJson, AdminDeploymentServiceJson } from "@hexclave/shared/dist/interface/admin-interface";

/**
 * SDK type for pushed config source (camelCase for SDK).
 * Represents where the branch config was pushed from.
 */
export type PushedConfigSource =
  | { type: "pushed-from-github", owner: string, repo: string, branch: string, commitHash: string, configFilePath: string, workflowPath?: string }
  | { type: "pushed-from-unknown" }
  | { type: "unlinked" };

export type PushConfigOptions = {
  /**
   * The source of this config push.
   */
  source: PushedConfigSource,
};


export type Project = {
  readonly id: string,
  readonly displayName: string,
  readonly isDevelopmentEnvironment: boolean,
  readonly pushedConfigError: { message: string } | null,
  readonly configWarnings: { message: string }[],
  readonly config: ProjectConfig,
};

export type AdminProject = {
  readonly id: string,
  readonly displayName: string,
  readonly description: string | null,
  readonly createdAt: Date,
  readonly isProductionMode: boolean,
  readonly isDevelopmentEnvironment: boolean,
  readonly ownerTeamId: string | null,
  readonly onboardingStatus: ProjectOnboardingStatus,
  readonly onboardingState: NonNullable<ProjectsCrud["Admin"]["Read"]["onboarding_state"]> | null,
  readonly logoUrl: string | null | undefined,
  readonly logoFullUrl: string | null | undefined,
  readonly logoDarkModeUrl: string | null | undefined,
  readonly logoFullDarkModeUrl: string | null | undefined,

  readonly config: AdminProjectConfig,

  update(this: AdminProject, update: AdminProjectUpdateOptions): Promise<void>,
  delete(this: AdminProject): Promise<void>,

  getConfig(this: AdminProject): Promise<CompleteConfig>,
  // NEXT_LINE_PLATFORM react-like
  useConfig(this: AdminProject): CompleteConfig,

  /**
   * Updates the environment's config by merging the provided config into the existing config.
   *
   * Changes made with `updateConfig` always take precedence over those made with `pushConfig`, even if the `pushConfig`
   * config was pushed after the changes were made with `updateConfig`. This is best for environment-specific
   * configuration like secrets, API keys, and other values that you wouldn't push into a source repository.
   */
  // We have some strict types here in order to prevent accidental overwriting of a top-level property of a config object
  updateConfig(
    this: AdminProject,
    config: EnvironmentConfigOverrideOverride,
  ): Promise<void>,

  /**
   * Pushes a config, replacing any previous config pushed with `pushConfig`.
   *
   * **Note:** This function does **not** replace any changes made with `updateConfig`. Changes made with
   * `updateConfig` always take precedence over those made with `pushConfig`, even if the `pushConfig`
   * config was pushed after the changes were made with `updateConfig`.
   *
   * This is useful for programmatically deploying configuration. More often than not, you'll want to use
   * `updateConfig` instead.
   */
  pushConfig(
    this: AdminProject,
    config: EnvironmentConfigOverrideOverride,
    options: PushConfigOptions,
  ): Promise<void>,

  /**
   * Updates the pushed config by merging the provided config into the existing pushed config.
   *
   * **Warning:** This is almost always **not** the function you want to call. Changes made with
   * `updatePushedConfig` will be replaced entirely the next time `pushConfig` is called. Consider using
   * `pushConfig` to set the full pushed config, or `updateConfig` for environment-specific values that
   * should persist across pushes.
   *
   * This function is useful for making temporary modifications to the pushed config before the next push.
   */
  updatePushedConfig(
    this: AdminProject,
    config: EnvironmentConfigOverrideOverride
  ): Promise<void>,

  /**
   * Gets the source metadata for the pushed config, indicating where it was pushed from.
   *
   * The source can be:
   * - `pushed-from-github`: Config was pushed from a GitHub repository
   * - `pushed-from-unknown`: Config was pushed via CLI but source details unknown
   * - `unlinked`: Config can be edited directly on the dashboard
   */
  getPushedConfigSource(this: AdminProject): Promise<PushedConfigSource>,

  /**
   * Unlinks the pushed config source, setting it to "unlinked".
   * This allows the config to be edited directly on the dashboard without external push restrictions.
   */
  unlinkPushedConfigSource(this: AdminProject): Promise<void>,

  /**
   * Resets (removes) specific keys from the config override at the specified level.
   * Uses the same nested key logic as the override algorithm: resetting key "a.b" also resets "a.b.c".
   *
   * This is useful when updating the pushed config (branch level) and wanting to remove the same keys
   * from the environment config override so that the branch config values take precedence.
   */
  resetConfigOverrideKeys(this: AdminProject, level: "branch" | "environment", keys: string[]): Promise<void>,

  /**
   * Gets the raw config override at the specified level (before merging/defaults).
   * Useful for inspecting exactly what's been set at each level.
   */
  getConfigOverride(this: AdminProject, level: "branch" | "environment"): Promise<Record<string, unknown>>,

  /**
   * Replaces the entire config override at the specified level.
   * For branch level, preserves the existing source metadata.
   */
  replaceConfigOverride(this: AdminProject, level: "branch" | "environment", config: Record<string, unknown>): Promise<void>,

  getProductionModeErrors(this: AdminProject): Promise<ProductionModeError[]>,
  // NEXT_LINE_PLATFORM react-like
  useProductionModeErrors(this: AdminProject): ProductionModeError[],

  /**
   * Lists the project's deployment services (definitions as synced from the
   * deploy file's `deploy` export by `hexclave deploy`, merged with their
   * operational state: deploy status, env vars, domains). Definitions are
   * read-only through the SDK — the deploy file is the source of truth.
   */
  listDeploymentServices(this: AdminProject): Promise<AdminDeploymentServiceJson[]>,

  /**
   * Lists the project's stored secrets (keys and timestamps only — values are
   * write-only and can never be read back).
   */
  listProjectSecrets(this: AdminProject): Promise<AdminProjectSecretJson[]>,

  /**
   * Sets (or overwrites) the value of a project secret. Values are only read
   * server-side by the feature that consumes them — today, a deploy filling
   * `secret()` env vars.
   */
  setProjectSecret(this: AdminProject, key: string, value: string): Promise<void>,

  /**
   * Deletes a stored project secret value.
   */
  deleteProjectSecret(this: AdminProject, key: string): Promise<void>,

  /**
   * Lists the project's deployments (one per `hexclave deploy`) newest first,
   * each with the services it deployed and their runs.
   */
  listDeployments(this: AdminProject, options?: { limit?: number }): Promise<AdminDeploymentJson[]>,

  /**
   * Reads one deployment, including what each of its services did.
   */
  getDeployment(this: AdminProject, deploymentId: string): Promise<AdminDeploymentJson>,

  /**
   * Returns the build logs of a deployment collected so far (the server follows
   * a running build for a while before returning). One deploy is one build, so
   * one log covers every service it shipped.
   */
  getDeploymentBuildLogs(this: AdminProject, deploymentId: string, options?: { signal?: AbortSignal }): Promise<string>,

  /**
   * Follows a service's RUNTIME logs (what the container printed while running,
   * not what its build printed), calling `onLine` per line as it arrives.
   *
   * A runtime log has no end, so this resolves when the server stops following
   * — after a few minutes — rather than when the service stops. Call again with
   * the largest `at_millis` seen to resume exactly where it left off; omit it to
   * start at the tail. These lines are NOT redacted.
   */
  getDeploymentServiceLogs(this: AdminProject, serviceId: string, options: {
    sinceMillis?: number,
    /** False returns what is available right now instead of following. */
    follow?: boolean,
    signal?: AbortSignal,
    onLine: (line: AdminDeploymentServiceLogLineJson) => void,
  }): Promise<void>,

  /**
   * Adds a custom domain to a deployment service.
   */
  addDeploymentServiceDomain(this: AdminProject, serviceId: string, hostname: string, options?: { isPrimary?: boolean }): Promise<void>,

  /**
   * Returns a domain's verification state and the DNS records the user must
   * create. Poll this until `verified` is true.
   */
  getDeploymentServiceDomain(this: AdminProject, serviceId: string, hostname: string): Promise<AdminDeploymentDomainJson>,

  /**
   * Removes a custom domain from a deployment service.
   */
  deleteDeploymentServiceDomain(this: AdminProject, serviceId: string, hostname: string): Promise<void>,
} & Project;

export type AdminOwnedProject = {
  readonly app: StackAdminApp<false>,
} & AdminProject;

export type AdminProjectUpdateOptions = {
  displayName?: string,
  description?: string,
  isProductionMode?: boolean,
  onboardingStatus?: ProjectOnboardingStatus,
  /**
   * Updates `project.requirePublishableClientKey` in the project-level config override.
   */
  requirePublishableClientKey?: boolean,
  logoUrl?: string | null,
  logoFullUrl?: string | null,
  logoDarkModeUrl?: string | null,
  logoFullDarkModeUrl?: string | null,
  config?: AdminProjectConfigUpdateOptions,
};
export function adminProjectUpdateOptionsToCrud(options: AdminProjectUpdateOptions): ProjectsCrud["Admin"]["Update"] {
  return {
    display_name: options.displayName,
    description: options.description,
    is_production_mode: options.isProductionMode,
    onboarding_status: options.onboardingStatus,
    logo_url: options.logoUrl,
    logo_full_url: options.logoFullUrl,
    logo_dark_mode_url: options.logoDarkModeUrl,
    logo_full_dark_mode_url: options.logoFullDarkModeUrl,
    /**
     * NOTE: Do not update this config anymore. It's been superseded by the new config in schema.ts.
     * @deprecated
     */
    config: {
      domains: options.config?.domains?.map((d) => ({
        domain: d.domain,
        handler_path: d.handlerPath
      })),
      oauth_providers: options.config?.oauthProviders
        ?.filter((p): p is Exclude<typeof p, { type: 'custom_oidc' }> => p.type !== 'custom_oidc')
        .map((p) => ({
          id: p.id as any,
          type: p.type,
          ...(p.type === 'standard' && {
            client_id: p.clientId,
            client_secret: p.clientSecret,
            facebook_config_id: p.facebookConfigId,
            microsoft_tenant_id: p.microsoftTenantId,
            apple_team_id: p.appleTeamId,
            apple_key_id: p.appleKeyId,
            apple_private_key: p.applePrivateKey,
            apple_bundle_ids: p.appleBundleIds,
          }),
        })),
      email_config: options.config?.emailConfig && (
        options.config.emailConfig.type === 'shared' ? {
          type: 'shared',
        } : {
          type: 'standard',
          host: options.config.emailConfig.host,
          port: options.config.emailConfig.port,
          username: options.config.emailConfig.username,
          password: options.config.emailConfig.password,
          sender_name: options.config.emailConfig.senderName,
          sender_email: options.config.emailConfig.senderEmail,
        }
      ),
      email_theme: options.config?.emailTheme,
      sign_up_enabled: options.config?.signUpEnabled,
      credential_enabled: options.config?.credentialEnabled,
      magic_link_enabled: options.config?.magicLinkEnabled,
      passkey_enabled: options.config?.passkeyEnabled,
      allow_localhost: options.config?.allowLocalhost,
      create_team_on_sign_up: options.config?.createTeamOnSignUp,
      client_team_creation_enabled: options.config?.clientTeamCreationEnabled,
      client_user_deletion_enabled: options.config?.clientUserDeletionEnabled,
      team_creator_default_permissions: options.config?.teamCreatorDefaultPermissions,
      team_member_default_permissions: options.config?.teamMemberDefaultPermissions,
      user_default_permissions: options.config?.userDefaultPermissions,
      oauth_account_merge_strategy: options.config?.oauthAccountMergeStrategy,
      allow_user_api_keys: options.config?.allowUserApiKeys,
      allow_team_api_keys: options.config?.allowTeamApiKeys,
    },
  };
}

export type AdminProjectCreateOptions = Omit<AdminProjectUpdateOptions, 'displayName'> & {
  displayName: string,
  teamId: string,
  isDevelopmentEnvironment?: boolean,
};
export function adminProjectCreateOptionsToCrud(options: AdminProjectCreateOptions): AdminUserProjectsCrud["Server"]["Create"] {
  return {
    ...adminProjectUpdateOptionsToCrud(options),
    display_name: options.displayName,
    is_development_environment: options.isDevelopmentEnvironment,
    owner_team_id: options.teamId,
  };
}
