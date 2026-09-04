export {
  HexclaveAdminApp,
  HexclaveClientApp,
  HexclaveServerApp,
} from "./apps";

// Legacy Stack* aliases — same runtime symbols, kept for backwards compatibility.
// Prefer the Hexclave* equivalents in new code.
// The @deprecated JSDoc lives on the original declarations in ./apps/interfaces/*.ts
// so it survives dts bundling (per-specifier JSDoc on re-exports does not).
export { StackAdminApp } from "./apps";
export { StackClientApp } from "./apps";
export { StackServerApp } from "./apps";

// HexclaveAdminApp / HexclaveClientApp / HexclaveServerApp are already exported above as values
// (which TypeScript treats as both value and type). Only the constructor / options / JSON
// helper types need separate type-only re-exports.
export type {
  HexclaveAdminAppConstructor,
  HexclaveAdminAppConstructorOptions,
  HexclaveClientAppConstructor,
  HexclaveClientAppConstructorOptions,
  HexclaveClientAppJson,
  HexclaveServerAppConstructor,
  HexclaveServerAppConstructorOptions,
} from "./apps";

// Legacy Stack* type aliases — @deprecated tags live on the original declarations
// in ./apps/interfaces/*.ts (per-specifier JSDoc on re-exports doesn't survive dts bundling).
export type { StackAdminAppConstructor } from "./apps";
export type { StackAdminAppConstructorOptions } from "./apps";
export type { StackClientAppConstructor } from "./apps";
export type { StackClientAppConstructorOptions } from "./apps";
export type { StackClientAppJson } from "./apps";
export type { StackServerAppConstructor } from "./apps";
export type { StackServerAppConstructorOptions } from "./apps";

export type {
  EmailOutboxListOptions,
  EmailOutboxListResult,
  EmailOutboxUpdateOptions
} from "./apps/interfaces/admin-app";

export type {
  AdminWorkflow,
  AdminWorkflowDivergenceDiagnostic,
  AdminWorkflowRun,
  AdminWorkflowRunDetails,
  AdminWorkflowRunsFilter,
  AdminWorkflowRunState,
  AdminWorkflowStep,
  AdminWorkflowStepAttempt,
  AdminWorkflowSyncResult,
  AdminWorkflowTrigger,
  AdminWorkflowUpgradeResult,
  AdminWorkflowVersion
} from "./workflows";

export type {
  AdminSessionReplay,
  AdminSessionReplayChunk,
  ListSessionReplayChunksOptions,
  ListSessionReplayChunksResult,
  ListSessionReplaysOptions,
  ListSessionReplaysResult,
  SessionReplayAllEventsResult
} from "./session-replays";

export type {
  ProjectConfig
} from "./project-configs";

export type {
  InternalApiKey,
  InternalApiKeyBase,
  InternalApiKeyBaseCrudRead,
  InternalApiKeyCreateOptions,
  InternalApiKeyFirstView
} from "./internal-api-keys";

export {
  hexclaveAppInternalsSymbol,
} from "./common";

export type {
  FeatureFlagDetails,
  FeatureFlagExposureMode,
  FeatureFlagOptions,
  FeatureFlagRequest,
} from "./feature-flags";
export type {
  FeatureFlagExperimentMetricResult,
  FeatureFlagExperimentResults,
  FeatureFlagExperimentRun,
  FeatureFlagExperimentRunStatus,
} from "@hexclave/shared/dist/interface/crud/feature-flags";
export type { Json } from "@hexclave/shared/dist/utils/json";
export type { TrackEventOptions } from "./apps/implementations/event-tracker";
export {
  getPagePrompt,
} from "./url-targets";
export type {
  GetCurrentUserOptions,
  /** @deprecated Use GetCurrentUserOptions instead */
  GetCurrentUserOptions as GetUserOptions,
  HandlerUrlOptions,
  HandlerUrls, OAuthScopesOnSignIn, ResolvedHandlerUrls
} from "./common";

export type {
  Connection,
  OAuthConnection
} from "./connected-accounts";

export type {
  ContactChannel,
  ServerContactChannel
} from "./contact-channels";

export type {
  AdminEmailOutbox,
  AdminEmailOutboxRecipient,
  AdminEmailOutboxSimpleStatus,
  AdminEmailOutboxStatus,
  AdminSendAttemptError,
  AdminSentEmail
} from "./email";

export type {
  AdminProjectPermission,
  AdminProjectPermissionDefinition,
  AdminProjectPermissionDefinitionCreateOptions,
  AdminProjectPermissionDefinitionUpdateOptions, AdminTeamPermission,
  AdminTeamPermissionDefinition,
  AdminTeamPermissionDefinitionCreateOptions,
  AdminTeamPermissionDefinitionUpdateOptions
} from "./permissions";

export type {
  AdminDomainConfig,
  AdminEmailConfig,
  AdminOAuthProviderConfig,
  AdminProjectConfig,
  AdminProjectConfigUpdateOptions,
  OAuthProviderConfig
} from "./project-configs";

export type {
  AdminDeploymentDomainJson,
  AdminDeploymentEnvVarJson,
  AdminDeploymentJson,
  AdminDeploymentServiceLogLineJson,
  AdminDeploymentServiceOutcomeJson,
  AdminProjectSecretJson,
  AdminDeploymentServiceJson,
  AdminOwnedProject,
  AdminProject,
  AdminProjectCreateOptions,
  AdminProjectUpdateOptions,
  Project,
  PushedConfigSource
} from "./projects";

export type {
  PlanUsage,
  PlanUsageKind,
  PlanUsageNextPlanId,
  PlanUsagePlanId,
  PlanUsageRow,
} from "./plan-usage";

export type {
  EditableTeamMemberProfile, ReceivedTeamInvitation,
  SentTeamInvitation, ServerListUsersOptions,
  ServerTeam,
  ServerTeamCreateOptions, ServerTeamMemberProfile,
  ServerTeamUpdateOptions,
  ServerTeamUser,
  Team,
  TeamCreateOptions,
  TeamInvitation,
  TeamMemberProfile,
  TeamUpdateOptions,
  TeamUser
} from "./teams";

export type {
  Auth,
  CurrentInternalServerUser,
  CurrentInternalUser,
  CurrentServerUser,
  CurrentUser,
  OAuthProvider,
  ServerOAuthProvider,
  ServerUser,
  User
} from "./users";
