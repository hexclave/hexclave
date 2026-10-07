import { KnownErrors } from "@hexclave/shared";
import { Result } from "@hexclave/shared/dist/utils/results";
import type { GenericQueryCtx } from "convex/server";
import type { AnalyticsQueryOptions, AnalyticsQueryResponse } from "@hexclave/shared/dist/interface/crud/analytics";
import type { AdminGetSessionReplayChunkEventsResponse } from "@hexclave/shared/dist/interface/crud/session-replays";
import { AsyncStoreProperty, GetCurrentPartialUserOptions, GetCurrentUserOptions } from "../../common";
import { CustomerProductsList, CustomerProductsRequestOptions, InlineProduct, ServerItem } from "../../customers";
import { DataVaultStore } from "../../data-vault";
import { EmailDeliveryInfo, SendEmailOptions } from "../../email";
import { ServerListTeamsOptions, ServerListUsersOptions, ServerTeam, ServerTeamCreateOptions } from "../../teams";
import type { AdminSessionReplay, ListSessionReplayChunksOptions, ListSessionReplayChunksResult, ListSessionReplaysOptions, ListSessionReplaysResult, SessionReplayAllEventsResult } from "../../session-replays";
import { ProjectCurrentServerUser, ServerOAuthProvider, ServerUser, ServerUserCreateOptions, SyncedPartialServerUser, TokenPartialUser } from "../../users";
import { _HexclaveServerAppImpl } from "../implementations";
import { StackClientApp, StackClientAppConstructorOptions } from "./client-app";


export type { AdminSessionReplay, AdminSessionReplayChunk, ListSessionReplaysOptions, ListSessionReplaysResult, ListSessionReplayChunksOptions, ListSessionReplayChunksResult, SessionReplayAllEventsResult } from "../../session-replays";


/** @deprecated Use `HexclaveServerAppConstructorOptions` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export type StackServerAppConstructorOptions<HasTokenStore extends boolean, ProjectId extends string> = StackClientAppConstructorOptions<HasTokenStore, ProjectId> & {
  secretServerKey?: string,
};

/** @deprecated Use `HexclaveServerApp` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export type StackServerApp<HasTokenStore extends boolean = boolean, ProjectId extends string = string> = (
  & {
    createTeam(data: ServerTeamCreateOptions): Promise<ServerTeam>,
    /**
     * @deprecated use `getUser()` instead
     */
    getServerUser(): Promise<ProjectCurrentServerUser<ProjectId> | null>,

    createUser(options: ServerUserCreateOptions): Promise<ServerUser>,
    grantProduct(options: (
      ({ userId: string } | { teamId: string } | { customCustomerId: string }) &
      ({ productId: string } | { product: InlineProduct }) &
      { quantity?: number }
    )): Promise<void>,
    createCheckoutUrl(options: (
      ({ userId: string } | { teamId: string } | { customCustomerId: string }) &
      ({ productId: string } | { product: InlineProduct }) &
      { returnUrl?: string }
    )): Promise<string>,

    // IF_PLATFORM react-like
    useUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'redirect' }): ProjectCurrentServerUser<ProjectId>,
    useUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'throw' }): ProjectCurrentServerUser<ProjectId>,
    useUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'anonymous' }): ProjectCurrentServerUser<ProjectId>,
    useUser(options?: GetCurrentUserOptions<HasTokenStore>): ProjectCurrentServerUser<ProjectId> | null,
    useUser(id: string): ServerUser | null,
    useUser(options: { apiKey: string, or?: "return-null" | "anonymous" }): ServerUser | null,
    useUser(options: { from: "convex", ctx: GenericQueryCtx<any>, or?: "return-null" | "anonymous" }): ServerUser | null,
    // END_PLATFORM

    /**
     * @deprecated Whether an app object has server permissions does not determine whether this
     * call runs in a browser, so an async read should not implicitly choose a navigation strategy.
     * In React, use useUser({ or: "redirect" }). Otherwise, call getUser() and explicitly invoke
     * redirectToSignIn() from browser code when it returns null.
     */
    getUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'redirect' }): Promise<ProjectCurrentServerUser<ProjectId>>,
    getUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'throw' }): Promise<ProjectCurrentServerUser<ProjectId>>,
    getUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'anonymous' }): Promise<ProjectCurrentServerUser<ProjectId>>,
    getUser(options?: GetCurrentUserOptions<HasTokenStore>): Promise<ProjectCurrentServerUser<ProjectId> | null>,
    getUser(id: string): Promise<ServerUser | null>,
    getUser(options: { apiKey: string, or?: "return-null" | "anonymous" }): Promise<ServerUser | null>,
    getUser(options: { from: "convex", ctx: GenericQueryCtx<any>, or?: "return-null" | "anonymous" }): Promise<ServerUser | null>,

    // note: we don't special-case 'anonymous' here to return non-null, see GetPartialUserOptions for more details
    getPartialUser(options: GetCurrentPartialUserOptions<HasTokenStore> & { from: 'token' }): Promise<TokenPartialUser | null>,
    getPartialUser(options: GetCurrentPartialUserOptions<HasTokenStore> & { from: 'convex' }): Promise<TokenPartialUser | null>,
    getPartialUser(options: GetCurrentPartialUserOptions<HasTokenStore>): Promise<SyncedPartialServerUser | TokenPartialUser | null>,
    // IF_PLATFORM react-like
    usePartialUser(options: GetCurrentPartialUserOptions<HasTokenStore> & { from: 'token' }): TokenPartialUser | null,
    usePartialUser(options: GetCurrentPartialUserOptions<HasTokenStore> & { from: 'convex' }): TokenPartialUser | null,
    usePartialUser(options: GetCurrentPartialUserOptions<HasTokenStore>): SyncedPartialServerUser | TokenPartialUser | null,
    // END_PLATFORM
    // IF_PLATFORM react-like
    useTeam(id: string): ServerTeam | null,
    useTeam(options: { apiKey: string }): ServerTeam | null,
    // END_PLATFORM
    getTeam(id: string): Promise<ServerTeam | null>,
    getTeam(options: { apiKey: string }): Promise<ServerTeam | null>,


    useUsers(options?: ServerListUsersOptions): ServerUser[] & { nextCursor: string | null }, // THIS_LINE_PLATFORM react-like
    listUsers(options?: ServerListUsersOptions): Promise<ServerUser[] & { nextCursor: string | null }>,

    /**
     * Returns every direct (or recursive) team permission grant for every
     * member of the given team in one request. Use this instead of calling
     * `user.listPermissions(team)` per row when rendering a roster — that
     * pattern produces an N+1 over the team-member endpoint.
     */
    listTeamMemberPermissions(teamId: string, options?: { recursive?: boolean }): Promise<{ userId: string, permissionId: string }[]>,
    // IF_PLATFORM react-like
    useTeamMemberPermissions(teamId: string, options?: { recursive?: boolean }): { userId: string, permissionId: string }[],
    // END_PLATFORM

    // TODO this should actually be on ServerUser
    createOAuthProvider(options: {
      userId: string,
      accountId: string,
      providerConfigId: string,
      email: string,
      allowSignIn: boolean,
      allowConnectedAccounts: boolean,
    }): Promise<Result<ServerOAuthProvider, InstanceType<typeof KnownErrors.OAuthProviderAccountIdAlreadyUsedForSignIn>>>,

    sendEmail(options: SendEmailOptions): Promise<void>,

    getEmailDeliveryStats(): Promise<EmailDeliveryInfo>,
    // IF_PLATFORM react-like
    useEmailDeliveryStats(): EmailDeliveryInfo,
    // END_PLATFORM

    activateEmailCapacityBoost(): Promise<void>,

    queryAnalytics(options: AnalyticsQueryOptions): Promise<AnalyticsQueryResponse>,

    listSessionReplays(options?: ListSessionReplaysOptions): Promise<ListSessionReplaysResult>,
    getSessionReplay(sessionReplayId: string): Promise<AdminSessionReplay>,
    listSessionReplayChunks(sessionReplayId: string, options?: ListSessionReplayChunksOptions): Promise<ListSessionReplayChunksResult>,
    getSessionReplayChunkEvents(sessionReplayId: string, chunkId: string): Promise<AdminGetSessionReplayChunkEventsResponse>,
    getSessionReplayEvents(sessionReplayId: string, options?: { offset?: number, limit?: number }): Promise<SessionReplayAllEventsResult>,
  }
  & AsyncStoreProperty<"user", [id: string], ServerUser | null, false>
  & Omit<AsyncStoreProperty<"users", [], ServerUser[], true>, "listUsers" | "useUsers">
  & AsyncStoreProperty<"teams", [options?: ServerListTeamsOptions], ServerTeam[] & { nextCursor: string | null }, true>
  & AsyncStoreProperty<"dataVaultStore", [id: string], DataVaultStore, false>
  & AsyncStoreProperty<
    "item",
    [{ itemId: string, userId: string } | { itemId: string, teamId: string } | { itemId: string, customCustomerId: string }],
    ServerItem,
    false
  >
  & AsyncStoreProperty<
    "products",
    [options: CustomerProductsRequestOptions],
    CustomerProductsList,
    true
  >
  & StackClientApp<HasTokenStore, ProjectId>
);
/** @deprecated Use `HexclaveServerAppConstructor` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export type StackServerAppConstructor = {
  new <
    TokenStoreType extends string,
    HasTokenStore extends (TokenStoreType extends {} ? true : boolean),
    ProjectId extends string
  >(options: StackServerAppConstructorOptions<HasTokenStore, ProjectId>): StackServerApp<HasTokenStore, ProjectId>,
  new (options: StackServerAppConstructorOptions<boolean, string>): StackServerApp<boolean, string>,
};
export type HexclaveServerAppConstructorOptions<HasTokenStore extends boolean, ProjectId extends string> = StackServerAppConstructorOptions<HasTokenStore, ProjectId>;
export type HexclaveServerApp<HasTokenStore extends boolean = boolean, ProjectId extends string = string> = StackServerApp<HasTokenStore, ProjectId>;
export type HexclaveServerAppConstructor = StackServerAppConstructor;
export const HexclaveServerApp: HexclaveServerAppConstructor = _HexclaveServerAppImpl;
/** @deprecated Use `HexclaveServerApp` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export const StackServerApp: StackServerAppConstructor = HexclaveServerApp;
