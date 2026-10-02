import { KnownErrors } from "@hexclave/shared";
import type { RequestListener } from "@hexclave/shared/dist/interface/client-interface";
import { CurrentUserCrud } from "@hexclave/shared/dist/interface/crud/current-user";
import { Result } from "@hexclave/shared/dist/utils/results";
import { AsyncStoreProperty, AuthLike, GetCurrentPartialUserOptions, GetCurrentUserOptions, HandlerUrlOptions, HandlerUrls, hexclaveAppInternalsSymbol, OAuthScopesOnSignIn, RedirectMethod, RedirectToOptions, ResolvedHandlerUrls, TokenStoreInit } from "../../common";
import { CustomerInvoicesList, CustomerInvoicesRequestOptions, CustomerProductsList, CustomerProductsRequestOptions, Item } from "../../customers";
import { Project } from "../../projects";
import { ProjectCurrentUser, SyncedPartialUser, TokenPartialUser } from "../../users";
import { _HexclaveClientAppImpl } from "../implementations";
import type { ParentRef, Span, StartSpanOptions, TrackOptions } from "../implementations/event-tracker";
import type { AnalyticsOptions, AnalyticsOptionsJson } from "../implementations/analytics-config";
import type { ObservabilityOptions, ObservabilityOptionsJson } from "../implementations/observability-config";
import type { TelemetryOptions } from "../implementations/telemetry-config";
import type { Logger } from "../implementations/logs";
import type { CaptureEvent, CaptureExceptionOptions, CaptureMessageOptions, ErrorEventId, ErrorScope } from "./error-capture";

export type { CapturedErrorEvent, CaptureEvent, CaptureExceptionOptions, CaptureMessageOptions, ErrorAttachmentInput, ErrorAttachmentMetadata, ErrorAttachmentTransport, ErrorAttachmentType, ErrorAttachmentUploadRequest, ErrorAttachmentUploadResult, ErrorBeforeSend, ErrorEventHint, ErrorEventProcessor, ErrorEventId, ErrorLevel, ErrorProcessorDecision, ErrorProcessorResult, ErrorScope, ErrorScopeData, PendingErrorAttachment } from "./error-capture";

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
  observability?: ObservabilityOptions,
  telemetry?: TelemetryOptions,
} & (
  { tokenStore: TokenStoreInit<HasTokenStore> } | { tokenStore?: undefined, inheritsFrom: StackClientApp<HasTokenStore, any> }
) & (
  string extends ProjectId ? unknown : ({ projectId: ProjectId } | { inheritsFrom: StackClientApp<any, ProjectId> })
);


/** @deprecated Use `HexclaveClientAppJson` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export type StackClientAppJson<HasTokenStore extends boolean, ProjectId extends string> = {
  baseUrl?: string | { browser: string, server: string },
  extraRequestHeaders?: Record<string, string>,
  projectId?: ProjectId,
  publishableClientKey?: string,
  urls?: HandlerUrlOptions,
  oauthScopesOnSignIn?: Partial<OAuthScopesOnSignIn>,
  tokenStore?: TokenStoreInit<HasTokenStore>,
  redirectMethod?: RedirectMethod,
  devTool?: boolean | "auto",
  noAutomaticPrefetch?: boolean,
  // Serialized so a deserialized app stays inert (fromClientJson skips
  // registration side effects when false); participates in the checkString like
  // every other field, so two apps sharing a uniqueIdentifier but disagreeing
  // on inertness conflict loudly instead of silently reusing one of them.
  automaticSideEffects?: boolean,
  inheritsFrom?: undefined,
  analytics?: AnalyticsOptionsJson,
  observability?: ObservabilityOptionsJson,
  // Only the `resource` half of TelemetryOptions crosses the serialization boundary:
  // `telemetryOptionsToJson` drops `waitUntil`, since a runtime hook can't survive
  // being serialized into the client payload and re-hydrated on the other side.
  telemetry?: Pick<TelemetryOptions, "resource">,
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

    cancelSubscription(options: { productId: string, subscriptionId?: string } | { productId: string, subscriptionId?: string, teamId: string }): Promise<void>,

    /**
     * Tracks a custom analytics event as a named OpenTelemetry LogRecord. In
     * managed-provider mode the returned promise resolves after the provider
     * force-flushes; existing-provider mode acknowledges synchronous provider
     * acceptance because that provider owns delivery. Invalid input and unavailable analytics reject instead of
     * silently dropping the event; fire-and-forget use is safe because the SDK
     * observes rejected promises internally.
     */
    trackEvent(eventType: string, data?: Record<string, unknown>, options?: TrackOptions): Promise<void>,

    /**
     * Captures a handled or unhandled exception through the same `$error`
     * pipeline used by automatic integrations. The returned UUID is placed in
     * the event payload before delivery, so callers can correlate it with
     * backend records even while the transport is asynchronous.
     */
    captureException(error: unknown, options?: CaptureExceptionOptions): ErrorEventId,

    /**
     * Captures a message through the `$error` pipeline. Same pre-delivery UUID
     * contract as `captureException`.
     */
    captureMessage(message: string, options?: CaptureMessageOptions): ErrorEventId,

    /**
     * Captures a pre-normalized event or exception chain through the `$error`
     * pipeline. Same pre-delivery UUID contract as `captureException`.
     */
    captureEvent(event: CaptureEvent): ErrorEventId,

    /** Returns the most recently attempted error event ID, if any. Delivery may still drop it later. */
    lastEventId(): ErrorEventId | undefined,

    /**
     * Runs work with an isolated error scope. Scope fields apply to captures
     * made inside the callback and are propagated through the active OTel
     * context when the runtime provides an async context manager. The return
     * type is preserved: synchronous callbacks stay synchronous and async
     * callbacks return their own Promise.
     */
    withErrorScope<T>(fn: (scope: ErrorScope) => T): T,

    /**
     * Async counterpart for runtimes where callers need an explicit
     * promise-chain boundary. Server/framework adapters use the same
     * AsyncLocalStorage-backed runner internally; this method makes that
     * guarantee available to generic server jobs and route code too.
     */
    withErrorScopeAsync<T>(fn: (scope: ErrorScope) => Promise<T>): Promise<T>,

    /**
     * Native structured logging: `logger.trace/debug/info/warn/error(message, data?)`
     * emits an OpenTelemetry LogRecord through the configured LoggerProvider
     * (the same path automatic console capture uses). Fire-and-forget and guaranteed never to throw into your code:
     * invalid structured data is dropped with a console warning, and
     * environments without a delivery path warn once and drop. Messages are
     * truncated to 8KB; `data` follows the same rules as event data. Logs
     * use standard OTel trace/span context correlation plus namespaced
     * Hexclave replay/page attributes.
     */
    readonly logger: Logger,

    /**
     * Starts a custom span through the active OTel Tracer. The provider owns
     * recording, sampling, processing, and export. Invalid input throws
     * synchronously; when the ENVIRONMENT makes
     * telemetry impossible (e.g. during server-side rendering on a client
     * app), an inert no-op span is returned instead — all its methods are safe
     * to call and `spanContext()` keeps the identity it would have had — so
     * isomorphic code does not need environment branches around span calls.
     */
    startSpan(spanType: string, options?: StartSpanOptions): Span,

    /**
     * Registers a span as an ambient parent for all subsequently tracked custom
     * events and spans. Ending the span automatically unregisters it.
     *
     * Registering several is fine: a span has exactly one parent, so the NEAREST
     * ambient span wins and any other global span in a different trace is recorded
     * as a link instead of being rejected.
     */
    setGlobalSpan(span: Span): void,
    clearGlobalSpan(span: Span): void,

    /**
     * Sends all buffered analytics immediately and settles in-flight sends.
     */
    flush(): Promise<void>,

    /**
     * Runs `fn` inside a span: the span starts on entry, is an ambient parent
     * for everything created inside the callback, and ends automatically when
     * `fn` settles. On throw, `data.error` is recorded and the error is
     * rethrown — telemetry failures never affect `fn`'s result.
     *
     * Ambient parenting covers the callback's full async extent on runtimes
     * with an exact async-context primitive (servers/edge today, browsers once
     * TC39 AsyncContext ships) and the callback's synchronous window in
     * browsers. After an `await` in a browser, parent via the handle you
     * already have — `span.trackEvent` / `span.withSpan` / `span.fetch` /
     * `span.run`. Handle-based item methods are exact everywhere; `span.run`
     * covers its callback's synchronous window in the browser fallback. Opt out
     * of the ambient parent per item with `root: true`, which starts a new trace.
     */
    withSpan<T>(spanType: string, fn: (span: Span) => Promise<T> | T): Promise<T>,
    withSpan<T>(spanType: string, options: StartSpanOptions, fn: (span: Span) => Promise<T> | T): Promise<T>,

    /**
     * The cross-tier propagation headers — the standard `traceparent` plus
     * `baggage` — for a request the SDK cannot attach them to
     * itself. `fetch` to same-origin (and
     * `observability.spanPropagation.allowedOrigins`) already gets them
     * automatically, so this is the escape hatch for other transports (XHR,
     * sendBeacon, WebSocket handshakes) or manually-built requests.
     *
     * `traceparent` carries the hierarchy for a head-sampled enclosing span, so
     * the receiving tier joins the same trace without naming a parent the
     * flusher may drop. `baggage` carries non-hierarchical
     * correlation only (per-tab replay segment, current page view). Returns `{}`
     * when there is nothing to propagate (analytics off, non-browser).
     *
     * Setting these on a `fetch` also overrides the automatic ones. `parent` pins
     * the trace explicitly and `root: true` drops the ambient parent — together the
     * precise-control path when overlapping async flows could mix ambient frames
     * (the documented browser sync-stack fallback):
     * `fetch(url, { headers: app.getSpanPropagationHeaders({ parent: span }) })`.
     * With `root: true` and no `parent` there is no span to name, so no
     * `traceparent` is emitted — inventing a trace id would fabricate a parent span
     * that never exists.
     */
    getSpanPropagationHeaders(options?: { parent?: ParentRef, root?: boolean }): Record<string, string>,

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
