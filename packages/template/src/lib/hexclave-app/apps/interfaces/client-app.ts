import { KnownErrors } from "@hexclave/shared";
import type { RequestListener } from "@hexclave/shared/dist/interface/client-interface";
import { CurrentUserCrud } from "@hexclave/shared/dist/interface/crud/current-user";
import { Result } from "@hexclave/shared/dist/utils/results";
import { AsyncStoreProperty, AuthLike, GetCurrentPartialUserOptions, GetCurrentUserOptions, HandlerUrlOptions, HandlerUrls, hexclaveAppInternalsSymbol, OAuthScopesOnSignIn, RedirectMethod, RedirectToOptions, ResolvedHandlerUrls, TokenStoreInit } from "../../common";
import { CustomerInvoicesList, CustomerInvoicesRequestOptions, CustomerProductsList, CustomerProductsRequestOptions, Item } from "../../customers";
import { Project } from "../../projects";
import { ProjectCurrentUser, SyncedPartialUser, TokenPartialUser } from "../../users";
import { _HexclaveClientAppImpl } from "../implementations";
import { AnalyticsOptions } from "../implementations/session-replay";
import type { Json } from "@hexclave/shared/dist/utils/json";
import type { FeatureFlagDetails, FeatureFlagOptions, FeatureFlagRequest } from "../../feature-flags";
import type { TrackEventOptions } from "../implementations/event-tracker";

/** @deprecated Use `HexclaveClientAppConstructorOptions` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export type StackClientAppConstructorOptions<HasTokenStore extends boolean, ProjectId extends string> = {
  baseUrl?: string | { browser: string, server: string },
  extraRequestHeaders?: Record<string, string>,
  projectId?: ProjectId,
  publishableClientKey?: string,
  urls?: HandlerUrlOptions,
  oauthScopesOnSignIn?: Partial<OAuthScopesOnSignIn>,
  tokenStore?: TokenStoreInit<HasTokenStore>,
  redirectMethod?: RedirectMethod,
  inheritsFrom?: StackClientApp<any, any>,

  /**
   * Whether to show the Hexclave dev tool indicator in browser-like environments.
   *
   * - `true`: always show
   * - `false`: never show
   * - `"auto"` (default): show based on NODE_ENV or origin heuristics
   */
  devTool?: boolean | "auto",

  /**
   * By default, the Stack app will automatically prefetch some data from Stack's server when this app is first
   * constructed. This improves the performance of your app, but will create network requests that are unnecessary if
   * the app is never used or disposed of immediately. To disable this behavior, set this option to true.
   */
  noAutomaticPrefetch?: boolean,

  /**
   * Whether the constructor starts browser integrations and other automatic side effects. Defaults to `true`.
   *
   * Set this to `false` when the app is instantiated inside a custom dashboard. Explicit method calls remain
   * available and can still perform their documented side effects.
   */
  automaticSideEffects?: boolean,

  /**
   * Options for analytics and session recording. Replays are enabled by default;
   * set `{ replays: { enabled: false } }` to opt out.
   */
  analytics?: AnalyticsOptions,
} & (
  { tokenStore: TokenStoreInit<HasTokenStore> } | { tokenStore?: undefined, inheritsFrom: StackClientApp<HasTokenStore, any> }
) & (
  string extends ProjectId ? unknown : ({ projectId: ProjectId } | { inheritsFrom: StackClientApp<any, ProjectId> })
);


/** @deprecated Use `HexclaveClientAppJson` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export type StackClientAppJson<HasTokenStore extends boolean, ProjectId extends string> = StackClientAppConstructorOptions<HasTokenStore, ProjectId> & { inheritsFrom?: undefined } & {
  uniqueIdentifier: string,
  // note: if you add more fields here, make sure to ensure the checkString in the constructor has/doesn't have them
};

/** @deprecated Use `HexclaveClientApp` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export type StackClientApp<HasTokenStore extends boolean = boolean, ProjectId extends string = string> = (
  & {
    readonly projectId: ProjectId,

    /**
     * The version of the Hexclave SDK.
     */
    readonly version: string,

    /**
     * @deprecated Do not use `app.urls` for navigation. It is static and does not include runtime redirect-back,
     * cross-domain auth, or sign-out state. Use the matching `redirectToXyz()` method instead, for example
     * `redirectToSignIn()`, `redirectToSignUp()`, `redirectToSignOut()`, or `redirectToAccountSettings()`.
     */
    readonly urls: Readonly<ResolvedHandlerUrls>,

    signInWithOAuth(provider: string, options?: { returnTo?: string }): Promise<void>,
    signInWithCredential(options: { email: string, password: string, noRedirect?: boolean }): Promise<Result<undefined, KnownErrors["EmailPasswordMismatch"] | KnownErrors["InvalidTotpCode"]>>,
    signUpWithCredential(options: {
      email: string,
      password: string,
      noRedirect?: boolean,
    } & ({ noVerificationCallback: true } | { noVerificationCallback?: false, verificationCallbackUrl?: string })): Promise<Result<undefined, KnownErrors["UserWithEmailAlreadyExists"] | KnownErrors["ContactChannelAlreadyUsedForAuthBySomeoneElse"] | KnownErrors["PasswordRequirementsNotMet"] | KnownErrors["BotChallengeFailed"]>>,
    signInWithPasskey(): Promise<Result<undefined, KnownErrors["PasskeyAuthenticationFailed"] | KnownErrors["InvalidTotpCode"] | KnownErrors["PasskeyWebAuthnError"]>>,
    callOAuthCallback(): Promise<boolean>,
    promptCliLogin(options: { appUrl: string, expiresInMillis?: number, anonRefreshToken?: string, promptLink?: (url: string, loginCode: string) => void }): Promise<Result<string, KnownErrors["CliAuthError"] | KnownErrors["CliAuthExpiredError"] | KnownErrors["CliAuthUsedError"]>>,
    sendForgotPasswordEmail(email: string, options?: { callbackUrl?: string }): Promise<Result<undefined, KnownErrors["UserNotFound"]>>,
    sendMagicLinkEmail(email: string, options?: { callbackUrl?: string }): Promise<Result<{ nonce: string }, KnownErrors["RedirectUrlNotWhitelisted"] | KnownErrors["BotChallengeFailed"]>>,
    resetPassword(options: { code: string, password: string }): Promise<Result<undefined, KnownErrors["VerificationCodeError"]>>,
    verifyPasswordResetCode(code: string): Promise<Result<undefined, KnownErrors["VerificationCodeError"]>>,
    verifyTeamInvitationCode(code: string): Promise<Result<undefined, KnownErrors["VerificationCodeError"] | KnownErrors["TeamInvitationEmailMismatch"]>>,
    acceptTeamInvitation(code: string): Promise<Result<undefined, KnownErrors["VerificationCodeError"] | KnownErrors["TeamInvitationEmailMismatch"]>>,
    getTeamInvitationDetails(code: string): Promise<Result<{ teamDisplayName: string }, KnownErrors["VerificationCodeError"] | KnownErrors["TeamInvitationEmailMismatch"]>>,
    verifyEmail(code: string): Promise<Result<undefined, KnownErrors["VerificationCodeError"]>>,
    signInWithMagicLink(code: string, options?: { noRedirect?: boolean }): Promise<Result<undefined, KnownErrors["VerificationCodeError"] | KnownErrors["InvalidTotpCode"]>>,
    signInWithMfa(otp: string, code: string, options?: { noRedirect?: boolean }): Promise<Result<undefined, KnownErrors["VerificationCodeError"] | KnownErrors["InvalidTotpCode"]>>,

    redirectToOAuthCallback(): Promise<void>,

    getConvexClientAuth(options: HasTokenStore extends false ? { tokenStore: TokenStoreInit } : { tokenStore?: TokenStoreInit }): (args: { forceRefreshToken: boolean }) => Promise<string | null>,
    getConvexHttpClientAuth(options: { tokenStore: TokenStoreInit }): Promise<string>,

    // IF_PLATFORM react-like
    useUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'redirect' }): ProjectCurrentUser<ProjectId>,
    useUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'throw' }): ProjectCurrentUser<ProjectId>,
    useUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'anonymous' }): ProjectCurrentUser<ProjectId>,
    useUser(options?: GetCurrentUserOptions<HasTokenStore>): ProjectCurrentUser<ProjectId> | null,
    // END_PLATFORM

    /**
     * @deprecated Whether an app object has server permissions does not determine whether this
     * call runs in a browser, so an async read should not implicitly choose a navigation strategy.
     * In React, use useUser({ or: "redirect" }). Otherwise, call getUser() and explicitly invoke
     * redirectToSignIn() from browser code when it returns null.
     */
    getUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'redirect' }): Promise<ProjectCurrentUser<ProjectId>>,
    getUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'throw' }): Promise<ProjectCurrentUser<ProjectId>>,
    getUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'anonymous' }): Promise<ProjectCurrentUser<ProjectId>>,
    getUser(options?: GetCurrentUserOptions<HasTokenStore>): Promise<ProjectCurrentUser<ProjectId> | null>,

    getFeatureFlag<T extends Json>(key: string, fallback: T, options?: FeatureFlagOptions): Promise<T>,
    getFeatureFlagDetails<T extends Json>(key: string, fallback: T, options?: FeatureFlagOptions): Promise<FeatureFlagDetails<T>>,
    getFeatureFlags(requests: readonly FeatureFlagRequest[]): Promise<Map<string, FeatureFlagDetails<Json>>>,
    trackFeatureFlagExposure(details: FeatureFlagDetails<Json>): Promise<void>,
    trackEvent(name: string, options?: TrackEventOptions): Promise<void>,

    // IF_PLATFORM react-like
    useFeatureFlag<T extends Json>(key: string, fallback: T, options?: FeatureFlagOptions): T,
    useFeatureFlagDetails<T extends Json>(key: string, fallback: T, options?: FeatureFlagOptions): FeatureFlagDetails<T>,
    // END_PLATFORM

    cancelSubscription(options: { productId: string, subscriptionId?: string } | { productId: string, subscriptionId?: string, teamId: string }): Promise<void>,

    // note: we don't special-case 'anonymous' here to return non-null, see GetPartialUserOptions for more details
    getPartialUser(options: GetCurrentPartialUserOptions<HasTokenStore> & { from: 'token' }): Promise<TokenPartialUser | null>,
    getPartialUser(options: GetCurrentPartialUserOptions<HasTokenStore> & { from: 'convex' }): Promise<TokenPartialUser | null>,
    getPartialUser(options: GetCurrentPartialUserOptions<HasTokenStore>): Promise<SyncedPartialUser | TokenPartialUser | null>,
    // IF_PLATFORM react-like
    usePartialUser(options: GetCurrentPartialUserOptions<HasTokenStore> & { from: 'token' }): TokenPartialUser | null,
    usePartialUser(options: GetCurrentPartialUserOptions<HasTokenStore> & { from: 'convex' }): TokenPartialUser | null,
    usePartialUser(options: GetCurrentPartialUserOptions<HasTokenStore>): SyncedPartialUser | TokenPartialUser | null,
    // END_PLATFORM
    useNavigate(): (to: string) => void, // THIS_LINE_PLATFORM react-like

    [hexclaveAppInternalsSymbol]: {
      toClientJson(): StackClientAppJson<HasTokenStore, ProjectId>,
      setCurrentUser(userJsonPromise: Promise<CurrentUserCrud['Client']['Read'] | null>): void,
      getConstructorOptions(): StackClientAppConstructorOptions<HasTokenStore, ProjectId> & { inheritsFrom?: undefined },
      sendSessionReplayBatch(body: string, options: { keepalive: boolean }): Promise<Result<Response, Error>>,
      sendAnalyticsEventBatch(body: string, options: { keepalive: boolean }): Promise<Result<Response, Error>>,
      addRequestListener(listener: RequestListener): () => void,
      sendRequest(path: string, requestOptions: RequestInit, requestType?: "client" | "server" | "admin"): Promise<Response>,
      getUrls(): Readonly<ResolvedHandlerUrls>,
      getRedirectMethod(): RedirectMethod,
      redirectToUrl(url: string | URL, options?: { replace?: boolean }): Promise<void>,
      getRedirectToHandlerUrl(handlerName: keyof HandlerUrls, options?: RedirectToOptions): Promise<string>,
      redirectToHandler(handlerName: keyof HandlerUrls, options?: RedirectToOptions): Promise<void>,
      /** Raw flow metadata only. Never navigate to this value without normal redirect validation. */
      getRawAfterAuthReturnTo(): string | null,
      signInWithTokens(tokens: { accessToken: string, refreshToken: string }): Promise<void>,
      awaitPendingAuthResolutions(): Promise<void>,
      isTrustedRedirectUrl(url: string): Promise<boolean>,
    },
  }
  & AsyncStoreProperty<"project", [], Project, false>
  & AsyncStoreProperty<
    "item",
    [{ itemId: string, userId: string } | { itemId: string, teamId: string } | { itemId: string, customCustomerId: string }],
    Item,
    false
  >
  & AsyncStoreProperty<
    "products",
    [options: CustomerProductsRequestOptions],
    CustomerProductsList,
    true
  >
  & AsyncStoreProperty<
    "invoices",
    [options: CustomerInvoicesRequestOptions],
    CustomerInvoicesList,
    true
  >
  & { [K in `redirectTo${Capitalize<keyof Omit<HandlerUrls, 'handler' | 'oauthCallback'>>}`]: (options?: RedirectToOptions) => Promise<void> }
  & AuthLike<HasTokenStore extends false ? { tokenStore: TokenStoreInit } : { tokenStore?: TokenStoreInit }>
);
/** @deprecated Use `HexclaveClientAppConstructor` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export type StackClientAppConstructor = {
  new <
    TokenStoreType extends string,
    HasTokenStore extends (TokenStoreType extends {} ? true : boolean),
    ProjectId extends string
  >(options: StackClientAppConstructorOptions<HasTokenStore, ProjectId>): StackClientApp<HasTokenStore, ProjectId>,
  new(options: StackClientAppConstructorOptions<boolean, string>): StackClientApp<boolean, string>,

  [hexclaveAppInternalsSymbol]: {
    fromClientJson<HasTokenStore extends boolean, ProjectId extends string>(
      json: StackClientAppJson<HasTokenStore, ProjectId>
    ): StackClientApp<HasTokenStore, ProjectId>,
  },
};
export type HexclaveClientAppConstructorOptions<HasTokenStore extends boolean, ProjectId extends string> = StackClientAppConstructorOptions<HasTokenStore, ProjectId>;
export type HexclaveClientAppJson<HasTokenStore extends boolean, ProjectId extends string> = StackClientAppJson<HasTokenStore, ProjectId>;
export type HexclaveClientApp<HasTokenStore extends boolean = boolean, ProjectId extends string = string> = StackClientApp<HasTokenStore, ProjectId>;
export type HexclaveClientAppConstructor = StackClientAppConstructor;
export const HexclaveClientApp: HexclaveClientAppConstructor = _HexclaveClientAppImpl;
/** @deprecated Use `HexclaveClientApp` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export const StackClientApp: StackClientAppConstructor = HexclaveClientApp;
