import type { AnalyticsClickmapOptions, AnalyticsClickmapResponse, AnalyticsClickmapTokenResponse } from "@hexclave/shared/dist/interface/admin-metrics";
import type { Transaction, TransactionType } from "@hexclave/shared/dist/interface/crud/transactions";
import type { FeatureFlagEvaluateRequest, FeatureFlagEvaluateResponse, FeatureFlagExperimentResults, FeatureFlagExperimentRun } from "@hexclave/shared/dist/interface/crud/feature-flags";
import { InternalSession } from "@hexclave/shared/dist/sessions";
import type { MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { Result } from "@hexclave/shared/dist/utils/results";
import { AsyncStoreProperty, EmailConfig } from "../../common";
import { AdminEmailOutbox, AdminSentEmail } from "../../email";
import { InternalApiKey, InternalApiKeyCreateOptions, InternalApiKeyFirstView } from "../../internal-api-keys";
import { AdminProjectPermission, AdminProjectPermissionDefinition, AdminProjectPermissionDefinitionCreateOptions, AdminProjectPermissionDefinitionUpdateOptions, AdminTeamPermission, AdminTeamPermissionDefinition, AdminTeamPermissionDefinitionCreateOptions, AdminTeamPermissionDefinitionUpdateOptions } from "../../permissions";
import type { PlanUsage } from "../../plan-usage";
import { AdminProject } from "../../projects";
import type { AdminWorkflow, AdminWorkflowRun, AdminWorkflowRunDetails, AdminWorkflowRunsFilter, AdminWorkflowSyncResult, AdminWorkflowUpgradeResult, AdminWorkflowVersion } from "../../workflows";
import { _HexclaveAdminAppImpl } from "../implementations";
import { StackServerApp, StackServerAppConstructorOptions } from "./server-app";

export type EmailOutboxListOptions = {
  status?: string,
  simpleStatus?: string,
  userId?: string,
  limit?: number,
  cursor?: string,
};

export type EmailOutboxListResult = {
  items: AdminEmailOutbox[],
  nextCursor: string | null,
};

export type EmailOutboxUpdateOptions = {
  isPaused?: boolean,
  scheduledAtMillis?: number,
  cancel?: boolean,
  tsxSource?: string,
  themeId?: string | null,
};

export type ManagedEmailProviderSetupResult = {
  domainId: string,
  subdomain: string,
  senderLocalPart: string,
  nameServerRecords: string[],
  status: ManagedEmailProviderStatus["status"],
};

export type ManagedEmailProviderStatus = {
  status: "pending_dns" | "pending_verification" | "verified" | "applied" | "failed",
};

export type ManagedEmailProviderListItem = {
  domainId: string,
  subdomain: string,
  senderLocalPart: string,
  status: ManagedEmailProviderStatus["status"],
  nameServerRecords: string[],
};

export type { AdminWorkflow, AdminWorkflowDivergenceDiagnostic, AdminWorkflowRun, AdminWorkflowRunDetails, AdminWorkflowRunsFilter, AdminWorkflowRunState, AdminWorkflowStep, AdminWorkflowStepAttempt, AdminWorkflowSyncResult, AdminWorkflowTrigger, AdminWorkflowUpgradeResult, AdminWorkflowVersion } from "../../workflows";


/** @deprecated Use `HexclaveAdminAppConstructorOptions` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export type StackAdminAppConstructorOptions<HasTokenStore extends boolean, ProjectId extends string> = (
  & StackServerAppConstructorOptions<HasTokenStore, ProjectId>
  & {
    superSecretAdminKey?: string,
    projectOwnerSession?: InternalSession | (() => Promise<string | null>),
  }
);


/** @deprecated Use `HexclaveAdminApp` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export type StackAdminApp<HasTokenStore extends boolean = boolean, ProjectId extends string = string> = (
  & AsyncStoreProperty<"project", [], AdminProject, false>
  & AsyncStoreProperty<"planUsage", [], PlanUsage, false>
  & AsyncStoreProperty<"internalApiKeys", [], InternalApiKey[], true>
  & AsyncStoreProperty<"teamPermissionDefinitions", [], AdminTeamPermissionDefinition[], true>
  & AsyncStoreProperty<"projectPermissionDefinitions", [], AdminProjectPermissionDefinition[], true>
  & AsyncStoreProperty<"emailThemes", [], { id: string, displayName: string }[], true>
  & AsyncStoreProperty<"emailPreview", [{ themeId?: string | null | false, themeTsxSource?: string, templateId?: string, templateTsxSource?: string }], string, false>
  & AsyncStoreProperty<"emailPreviewWithEditableMarkers", [{ themeId?: string | null | false, themeTsxSource?: string, templateId?: string, templateTsxSource?: string, editableSource?: 'template' | 'theme' | 'both' }], { html: string, editableRegions?: Record<string, unknown> }, false> // THIS_LINE_PLATFORM react-like
  & AsyncStoreProperty<"emailTemplates", [], { id: string, displayName: string, themeId?: string, tsxSource: string }[], true>
  & AsyncStoreProperty<"emailDrafts", [], { id: string, displayName: string, themeId: string | undefined | false, tsxSource: string, sentAt: Date | null }[], true>
  & AsyncStoreProperty<"workflows", [], AdminWorkflow[], true>
  & AsyncStoreProperty<"stripeAccountInfo", [], { account_id: string, charges_enabled: boolean, details_submitted: boolean, payouts_enabled: boolean } | null, false>
  & AsyncStoreProperty<
    "transactions",
    [{
      cursor?: string,
      limit?: number,
      type?: TransactionType,
      customerType?: 'user' | 'team' | 'custom',
      customerId?: string,
    }],
    { transactions: Transaction[], nextCursor: string | null },
    true
  >
  & {
    createInternalApiKey(options: InternalApiKeyCreateOptions): Promise<InternalApiKeyFirstView>,

    createTeamPermissionDefinition(data: AdminTeamPermissionDefinitionCreateOptions): Promise<AdminTeamPermission>,
    updateTeamPermissionDefinition(permissionId: string, data: AdminTeamPermissionDefinitionUpdateOptions): Promise<void>,
    deleteTeamPermissionDefinition(permissionId: string): Promise<void>,
    /**
     * @param options.query Free-text search; matches against permission ID and description.
     */
    listTeamPermissionDefinitionsPaginated(options: { limit: number, cursor?: string, query?: string }): Promise<{ items: AdminTeamPermissionDefinition[], nextCursor: string | null }>,

    createProjectPermissionDefinition(data: AdminProjectPermissionDefinitionCreateOptions): Promise<AdminProjectPermission>,
    updateProjectPermissionDefinition(permissionId: string, data: AdminProjectPermissionDefinitionUpdateOptions): Promise<void>,
    deleteProjectPermissionDefinition(permissionId: string): Promise<void>,

    useSvixToken(): { token: string, url: string | undefined }, // THIS_LINE_PLATFORM react-like

    sendTestEmail(options: {
      recipientEmail: string,
      emailConfig: EmailConfig,
    }): Promise<Result<undefined, { errorMessage: string }>>,

    sendTestWebhook(options: { endpointId: string }): Promise<Result<undefined, { errorMessage: string }>>,

    sendSignInInvitationEmail(email: string, callbackUrl: string): Promise<void>,

    listSentEmails(): Promise<AdminSentEmail[]>,
    setupManagedEmailProvider(options: { subdomain: string, senderLocalPart: string }): Promise<ManagedEmailProviderSetupResult>,
    checkManagedEmailStatus(options: { domainId: string, subdomain: string, senderLocalPart: string }): Promise<ManagedEmailProviderStatus>,
    listManagedEmailDomains(): Promise<ManagedEmailProviderListItem[]>,
    applyManagedEmailProvider(options: { domainId: string }): Promise<{ status: "applied" }>,
    deleteManagedEmailDomain(options: { resendDomainId: string }): Promise<{ status: "deleted" }>,

    useEmailTheme(id: string): { displayName: string, tsxSource: string }, // THIS_LINE_PLATFORM react-like
    createEmailTheme(displayName: string): Promise<{ id: string }>,
    updateEmailTheme(id: string, tsxSource: string): Promise<void>,
    deleteEmailTheme(id: string): Promise<void>,
    saveChatMessage(threadId: string, message: any): Promise<void>,
    listChatMessages(threadId: string): Promise<{ messages: Array<any> }>,
    rewriteTemplateSourceWithAI(templateTsxSource: string): Promise<{ tsxSource: string }>,
    updateEmailTemplate(id: string, tsxSource: string, themeId: string | null | false): Promise<{ renderedHtml: string }>,
    createEmailTemplate(displayName: string): Promise<{ id: string }>,
    deleteEmailTemplate(id: string): Promise<void>,

    // Workflows (internal-project gated; see the Workflows v1 spec). The
    // management verbs live on the admin app only in v1.
    createWorkflow(options: { id: string, displayName?: string, source: string }): Promise<AdminWorkflowSyncResult>,
    updateWorkflowSource(workflowId: string, source: string): Promise<AdminWorkflowSyncResult>,
    deleteWorkflow(workflowId: string): Promise<void>,
    /** Pauses/resumes run creation. In-flight runs are unaffected. */
    setWorkflowPaused(workflowId: string, isPaused: boolean): Promise<void>,
    listWorkflowVersions(workflowId: string): Promise<AdminWorkflowVersion[]>,
    listWorkflowRuns: {
      (workflowId: string, filter: AdminWorkflowRunsFilter & { includeState: true }): Promise<{ runs: AdminWorkflowRunDetails[], nextCursor: string | null }>,
      (workflowId: string, filter?: AdminWorkflowRunsFilter): Promise<{ runs: AdminWorkflowRun[], nextCursor: string | null }>,
    },
    getWorkflowRun(runId: string): Promise<AdminWorkflowRunDetails>,
    cancelWorkflowRuns(workflowId: string, filter?: { runKey?: string, runId?: string, state?: "queued" | "running" | "sleeping", version?: number }): Promise<{ canceledCount: number }>,
    upgradeWorkflowRuns(workflowId: string, options: { toVersion: number, runKey?: string, fromVersion?: number }): Promise<AdminWorkflowUpgradeResult>,
    retryWorkflowRun(runId: string): Promise<void>,
    sendWorkflowEvent(name: string, data?: unknown): Promise<{ eventId: string }>,

    setupPayments(): Promise<{ url: string }>,
    createStripeWidgetAccountSession(): Promise<{ client_secret: string }>,
    getPaymentMethodConfigs(): Promise<{ configId: string, methods: Array<{ id: string, name: string, enabled: boolean, available: boolean, overridable: boolean }> } | null>,
    updatePaymentMethodConfigs(configId: string, updates: Record<string, 'on' | 'off'>): Promise<void>,
    createEmailDraft(options: { displayName: string, themeId?: string | undefined | false, tsxSource?: string }): Promise<{ id: string }>,
    updateEmailDraft(id: string, data: { displayName?: string, themeId?: string | undefined | false, tsxSource?: string }): Promise<void>,
    deleteEmailDraft(id: string): Promise<void>,
    refreshEmailDrafts(): Promise<void>,
    createItemQuantityChange(options: (
      { userId: string, itemId: string, quantity: number, expiresAt?: string, description?: string } |
      { teamId: string, itemId: string, quantity: number, expiresAt?: string, description?: string } |
      { customCustomerId: string, itemId: string, quantity: number, expiresAt?: string, description?: string }
    )): Promise<void>,
    refundTransaction(options: {
      type: "subscription" | "one-time-purchase",
      id: string,
      invoiceId?: string,
      amountUsd: MoneyAmount,
      endAction?: "now" | "at-period-end",
    }): Promise<{ refundTransactionId: string }>,
    getAnalyticsClickmap(options: AnalyticsClickmapOptions): Promise<AnalyticsClickmapResponse>,
    createAnalyticsClickmapToken(options: { origin: string }): Promise<AnalyticsClickmapTokenResponse>,

    testFeatureFlags(request: FeatureFlagEvaluateRequest): Promise<FeatureFlagEvaluateResponse>,
    listFeatureFlagExperimentRuns(experimentId: string): Promise<FeatureFlagExperimentRun[]>,
    createFeatureFlagExperimentRun(experimentId: string, experimentConfig: Json): Promise<FeatureFlagExperimentRun>,
    startFeatureFlagExperimentRun(experimentId: string, runId: string): Promise<FeatureFlagExperimentRun>,
    pauseFeatureFlagExperimentRun(experimentId: string, runId: string): Promise<FeatureFlagExperimentRun>,
    resumeFeatureFlagExperimentRun(experimentId: string, runId: string): Promise<FeatureFlagExperimentRun>,
    completeFeatureFlagExperimentRun(experimentId: string, runId: string): Promise<FeatureFlagExperimentRun>,
    createFeatureFlagExperimentRevision(experimentId: string, runId: string, experimentConfig: Json): Promise<FeatureFlagExperimentRun>,
    getFeatureFlagExperimentResults(experimentId: string, runId: string): Promise<FeatureFlagExperimentResults>,

    // Email Outbox methods
    listOutboxEmails(options?: EmailOutboxListOptions): Promise<EmailOutboxListResult>,
    getOutboxEmail(id: string): Promise<AdminEmailOutbox>,
    updateOutboxEmail(id: string, options: EmailOutboxUpdateOptions): Promise<AdminEmailOutbox>,
    pauseOutboxEmail(id: string): Promise<AdminEmailOutbox>,
    unpauseOutboxEmail(id: string): Promise<AdminEmailOutbox>,
    cancelOutboxEmail(id: string): Promise<AdminEmailOutbox>,
  }
  & StackServerApp<HasTokenStore, ProjectId>
);
/** @deprecated Use `HexclaveAdminAppConstructor` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export type StackAdminAppConstructor = {
  new <
    HasTokenStore extends boolean,
    ProjectId extends string
  >(options: StackAdminAppConstructorOptions<HasTokenStore, ProjectId>): StackAdminApp<HasTokenStore, ProjectId>,
  new(options: StackAdminAppConstructorOptions<boolean, string>): StackAdminApp<boolean, string>,
};
export type HexclaveAdminAppConstructorOptions<HasTokenStore extends boolean, ProjectId extends string> = StackAdminAppConstructorOptions<HasTokenStore, ProjectId>;
export type HexclaveAdminApp<HasTokenStore extends boolean = boolean, ProjectId extends string = string> = StackAdminApp<HasTokenStore, ProjectId>;
export type HexclaveAdminAppConstructor = StackAdminAppConstructor;
export const HexclaveAdminApp: HexclaveAdminAppConstructor = _HexclaveAdminAppImpl;
/** @deprecated Use `HexclaveAdminApp` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export const StackAdminApp: StackAdminAppConstructor = HexclaveAdminApp;
