import { trace as otelTrace, type Context } from "@opentelemetry/api";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { Result } from "@hexclave/shared/dist/utils/results";
import type { AnalyticsReplayOptions } from "./analytics-config";
import { buildCapturedEventData, buildErrorEventData, buildErrorEventDataFromNormalized, buildLinkedExceptionValues, createClientErrorCapturePolicy, generateErrorEventId, installClientErrorCapture, type ClientErrorCapture, type ClientErrorCapturePolicy, type NormalizedErrorCaptureOptions } from "./error-capture";
import type { CapturedErrorEvent, CaptureEvent, CaptureExceptionOptions, CaptureMessageOptions, ErrorAttachmentInput, ErrorAttachmentTransport, ErrorBreadcrumb, ErrorEventId, ErrorScopeData, PendingErrorAttachment } from "../interfaces/error-capture";
import type { EventTracker } from "./event-tracker";
import type { TelemetryResource } from "./telemetry-config";
import type { NetworkCaptureConfig } from "./network-capture";
import type { SessionRecorder } from "./session-replay";
import { buildAmbientSessionContext, generateOtelSpanId, getActiveOtelSpanContext } from "./otel-context";
import { createInertSpanHandle } from "./span-handle";
import { buildPropagationHeaderValues, fetchWithSpanPropagation } from "./span-propagation";
import { getCustomTelemetryDataError, getCustomTelemetryNameError, preCaught, rejectedPreCaught, resolveSpanParent, type Span, type SpanContext, type StartSpanOptions, type TrackOptions } from "./telemetry-core";
import { getActiveErrorScope, mergeErrorScopeData } from "./error-scope";
import { generateUuid } from "./telemetry-transport";
import { createOtelSpanFacade } from "./otel-span-facade";
import { emitHexclaveOtelError, emitHexclaveOtelEvent } from "./otel-log-facade";
import { registerManagedBrowserOtel, type BrowserManagedOtelRegistration } from "./browser-otel-sdk";
import { processErrorEvent, type ErrorProcessingResult } from "./error-processors";
import { createLogger, installConsoleCapture, type ConsoleCaptureLevel, type LogEmitItem } from "./logs";
import { createDefaultErrorIntegrationRegistry, type ErrorIntegrationRegistry, type ErrorIntegrationRuntime } from "./integration-registry";
import { assertErrorAttachmentDeliveryConfigured, deliverErrorAttachments, getErrorAttachmentInputs } from "./error-attachments";
import { installBrowserResourceErrorCapture } from "./browser-resource-errors";


const IDLE_LOAD_TIMEOUT_MS = 2_000;
const FALLBACK_LOAD_DELAY_MS = 200;

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  // SAFETY: probing for the thenable protocol; reading a possibly-absent
  // `then` as unknown claims nothing about the value.
  return typeof (value as { then?: unknown }).then === "function";
}

export type ClientAnalyticsDeps = {
  projectId: string,
  resource: TelemetryResource,
  sendReplayBatch: (body: string, options: { keepalive: boolean }) => Promise<Result<Response, Error>>,
  /** Resolves the stable refresh-token root before the browser tracker starts. */
  getSessionRootContext: () => Promise<SpanContext>,
  /** Returns a validated cached refresh-token root without doing I/O, when one is already available. */
  getCachedSessionRootContext?: () => SpanContext | null,
  /** Replay options incl. the enabled flag; the recorder module is not even fetched when disabled. */
  replayOptions: AnalyticsReplayOptions,
  /** Enables product autocapture independently from the shared telemetry transport. */
  productAnalyticsEnabled: boolean,
  registerBackgroundTask?: (promise: Promise<unknown>) => void,
  getPropagationPolicy: () => { selfOrigin: string | null, allowedOrigins: readonly string[], allowLocalhost: boolean, correlationBaggage: boolean },
  integritySignals: boolean,
  /** Normalized URL policy for the official browser HTTP instrumentations. */
  networkCapture: NetworkCaptureConfig,
  /** Shared deterministic healthy-trace rate used by propagation and flush. */
  traceSampleRate: number,
  /** Normalized ObservabilityOptions.errorCapture — the global $error capture installs eagerly from this facade. */
  errorCapture: NormalizedErrorCaptureOptions,
  /** Resource service.version / deployment environment and SDK version, stamped on $error events. */
  release: string | null,
  environment: string | null,
  sdkVersion: string,
  analyticsBaseUrl: string,
  openTelemetryProvider: "managed" | "existing-provider" | "disabled",
  /**
   * Error, console, and fetch hooks. Delivery (`openTelemetryProvider`) can
   * stay managed when Analytics is on and Observability is off; this flag
   * is what keeps those hooks off in that case.
   */
  instrumentationEnabled?: boolean,
  /** When false, automatic hooks/load are deferred until an explicit call. */
  automaticSideEffects?: boolean,
  /** Existing console instrumentation configuration, bridged into breadcrumbs. */
  consoleCaptureLevels?: readonly ConsoleCaptureLevel[],
  /** Existing OTel log sink used by the console instrumentation bridge. */
  emitLog?: (item: LogEmitItem) => "ok" | "unavailable",
  /** Receives every accepted local error identity, including automatic captures. */
  onErrorEventId?: (eventId: ErrorEventId) => void,
  errorAttachmentTransport?: ErrorAttachmentTransport,
  onAttachmentPending?: (attachment: PendingErrorAttachment) => void | PromiseLike<void>,
  getOtlpRequestHeaders: () => Promise<Record<string, string>>,
};

export class ClientAnalytics {
  private readonly _deps: ClientAnalyticsDeps;
  private _segmentId: string;
  private _tracker: EventTracker | null = null;
  private _recorder: SessionRecorder | null = null;
  private _loadPromise: Promise<EventTracker> | null = null;
  private readonly _preloadGlobalSpans = new Set<Span>();
  private _bufferGeneration = 0;
  private _errorCapture: ClientErrorCapture | null = null;
  private _errorIntegrationRegistry: ErrorIntegrationRegistry | null = null;
  private readonly _integrationBreadcrumbs: ErrorBreadcrumb[] = [];
  private _browserOtelRegistration: BrowserManagedOtelRegistration | null;
  private _browserOtelRegistrationFailed = false;
  private readonly _pendingErrorProcessing = new Set<Promise<void>>();
  private _resolvedSessionRoot: SpanContext | null = null;
  private _preTrackerAmbient: { segmentId: string, context: Context } | null = null;
  private _sessionRootResultPromise: Promise<Result<SpanContext, unknown>> | null = null;

  constructor(deps: ClientAnalyticsDeps) {
    this._deps = deps;
    this._segmentId = generateUuid();
    this._resolvedSessionRoot = deps.openTelemetryProvider === "managed"
      && deps.automaticSideEffects !== false
      ? deps.getCachedSessionRootContext?.() ?? null
      : null;
    this._browserOtelRegistration = deps.openTelemetryProvider === "managed" && deps.automaticSideEffects !== false
      ? this._registerManagedBrowserOtel()
      : null;

    if (this._browserOtelRegistration !== null) {
      queueMicrotask(() => runAsynchronously(async () => {
        const sessionRootResult = await this._getSessionRootResult();
        if (sessionRootResult.status === "ok") {
          this._resolvedSessionRoot = sessionRootResult.data;
          this._preTrackerAmbient = null;
        }
        if (this._isInstrumentationEnabled()) {
          this._browserOtelRegistration?.enableHttpInstrumentation();
        }
      }, { noErrorLogging: true }));
    }

    if (deps.automaticSideEffects !== false && !this._browserOtelRegistrationFailed) {
      const kickOff = () => runAsynchronously(async () => {
        await this._ensureLoaded();
      }, { noErrorLogging: true });
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(kickOff, { timeout: IDLE_LOAD_TIMEOUT_MS });
      } else {
        setTimeout(kickOff, FALLBACK_LOAD_DELAY_MS);
      }
    }

    if (deps.automaticSideEffects !== false && this._isInstrumentationEnabled()) {
      this._installClientErrorCapture();
      this._installErrorIntegrations();
    }
  }

  private _isInstrumentationEnabled(): boolean {
    if (this._browserOtelRegistrationFailed) return false;
    return this._deps.instrumentationEnabled ?? this._deps.openTelemetryProvider !== "disabled";
  }

  private _errorCapturePolicy: ClientErrorCapturePolicy | null = null;

  private _getErrorCapturePolicy(): ClientErrorCapturePolicy {
    this._errorCapturePolicy ??= createClientErrorCapturePolicy({
      ignoreErrors: this._deps.errorCapture.ignoreErrors,
      getCurrentPageViewSpanId: () => this.getCurrentPageViewSpanId(),
    });
    return this._errorCapturePolicy;
  }

  private _installClientErrorCapture(): void {
    if (this._errorCapture !== null) return;
    if (!this._isInstrumentationEnabled() || !this._deps.errorCapture.enabled) return;
    this._errorCapture = installClientErrorCapture({
      emit: (data, scope) => this.trackErrorEvent(data, scope),
      ignoreErrors: this._deps.errorCapture.ignoreErrors,
      release: this._deps.release,
      environment: this._deps.environment,
      sdkVersion: this._deps.sdkVersion,
      getCurrentPageViewSpanId: () => this.getCurrentPageViewSpanId(),
      policy: this._getErrorCapturePolicy(),
    });
  }

  private _createErrorIntegrationRuntime(): ErrorIntegrationRuntime | null {
    const levels = this._deps.consoleCaptureLevels;
    const emitLog = this._deps.emitLog;
    if (!this._isInstrumentationEnabled()) {
      return null;
    }
    const errorCaptureEnabled = this._deps.errorCapture.enabled;

    const browser: NonNullable<ErrorIntegrationRuntime["browser"]> = {};
    if (errorCaptureEnabled) {
      browser.onResourceError = (handler) => installBrowserResourceErrorCapture(handler, {
        networkCapture: this._deps.networkCapture,
      });
    }
    if (levels !== undefined && levels.length > 0 && emitLog !== undefined) {
      browser.onConsole = (handler) => installConsoleCapture({
        levels,
        logger: createLogger({
          emit: (item) => {
            handler({
              level: item.level === "warn"
                ? "warn"
                : item.level === "error"
                  ? "error"
                  : item.level === "debug"
                    ? "debug"
                    : "info",
              message: item.message,
            });
            return emitLog(item);
          },
          origin: "console",
        }),
        projectId: this._deps.projectId,
        serviceName: this._deps.resource.service.name,
        ...errorCaptureEnabled ? { captureError: (error: Error) => this.captureConsoleError(error) } : {},
      });
    }
    if (browser.onConsole === undefined && browser.onResourceError === undefined) {
      return null;
    }

    return {
      captureException: (error, options) => this.captureException(error, options, getActiveErrorScope()?.snapshot()),
      addBreadcrumb: (breadcrumb) => this._addIntegrationBreadcrumb(breadcrumb),
      browser,
    };
  }

  private _installErrorIntegrations(): void {
    if (this._errorIntegrationRegistry !== null) return;
    const runtime = this._createErrorIntegrationRuntime();
    if (runtime === null) return;
    const registry = createDefaultErrorIntegrationRegistry(runtime);
    registry.installDefaults();
    this._errorIntegrationRegistry = registry;
  }

  private _addIntegrationBreadcrumb(breadcrumb: ErrorBreadcrumb): void {
    this._integrationBreadcrumbs.push(breadcrumb);
    if (this._integrationBreadcrumbs.length > 100) this._integrationBreadcrumbs.shift();
  }

  /**
   * Tears down all automatic browser error hooks owned by this facade. This is
   * intentionally explicit: authentication rotation clears breadcrumb state,
   * while lifecycle owners decide when the actual global hooks should leave.
   */
  uninstallErrorIntegrations(): void {
    this._errorIntegrationRegistry?.uninstallAll();
    this._errorIntegrationRegistry = null;
    this._errorCapture?.uninstall();
    this._errorCapture = null;
    this._integrationBreadcrumbs.length = 0;
  }

  private _registerManagedBrowserOtel(): BrowserManagedOtelRegistration | null {
    if (this._browserOtelRegistrationFailed) return null;
    try {
      return this._registerManagedBrowserOtelOrThrow();
    } catch (error) {
      this._browserOtelRegistrationFailed = true;
      console.warn("Hexclave analytics: managed browser OpenTelemetry could not be registered; telemetry from this app instance will be dropped.", error);
      return null;
    }
  }

  private _registerManagedBrowserOtelOrThrow(): BrowserManagedOtelRegistration {
    const deps = this._deps;
    return registerManagedBrowserOtel({
      analyticsBaseUrl: deps.analyticsBaseUrl,
      projectId: deps.projectId,
      clientVersion: deps.sdkVersion,
      traceSampleRate: deps.traceSampleRate,
      resource: deps.resource,
      getRequestHeaders: deps.getOtlpRequestHeaders,
      networkCapture: deps.networkCapture,
      getPropagationPolicy: () => {
        const policy = deps.getPropagationPolicy();
        return { allowedOrigins: policy.allowedOrigins, allowLocalhost: policy.allowLocalhost, correlationBaggage: policy.correlationBaggage };
      },
      installHttpInstrumentationImmediately: this._isInstrumentationEnabled() && this._resolvedSessionRoot !== null,
      getAmbientOtelContext: () => this._tracker !== null
        ? this._tracker.getAmbientOtelContext()
        : this._preTrackerAmbientContext(),
    });
  }

  private _getSessionRootResult(): Promise<Result<SpanContext, unknown>> {
    if (this._sessionRootResultPromise === null) {
      this._sessionRootResultPromise = Result.fromPromise(this._deps.getSessionRootContext());
    }
    return this._sessionRootResultPromise;
  }

  /**
   * Ambient base for the pre-load window: the tracker (and with it the
   * `$page-view` anchor) arrives up to seconds after construction, but the
   * app's bootstrap requests fire immediately. Anchoring them on the
   * refresh-token session root keeps them inside the session trace. The
   * tracker takes over the moment it loads (see the getAmbientOtelContext
   * wiring above), so this anchor can only serve the first seconds of a page —
   * a window in which the session identity cannot have rotated.
   */
  private _preTrackerAmbientContext(): Context | null {
    const root = this._resolvedSessionRoot;
    if (root === null) return null;
    const cache = this._preTrackerAmbient;
    if (cache !== null && cache.segmentId === this._segmentId) return cache.context;
    const context = buildAmbientSessionContext({ anchor: root, sessionReplaySegmentId: this._segmentId });
    this._preTrackerAmbient = { segmentId: this._segmentId, context };
    return context;
  }

  /** The installed global error capture, or null. Exposed for tests. */
  getErrorCapture(): ClientErrorCapture | null {
    return this._errorCapture;
  }

  updateOtelPropagationPolicy(): void {
    this._browserOtelRegistration?.updatePropagationPolicy();
  }

  /** The loaded tracker, or null while the module is still on its way. Exposed for tests. */
  getLoadedTracker(): EventTracker | null {
    return this._tracker;
  }

  /** Triggers the load (if not already running) and resolves once the runtime is live. */
  loadNow(): Promise<void> {
    return preCaught(this._ensureLoaded().then(() => {}));
  }

  private _ensureLoaded(): Promise<EventTracker> {
    if (this._loadPromise === null) {
      this._loadPromise = preCaught(this._doLoad());
    }
    return this._loadPromise;
  }

  private async _doLoad(): Promise<EventTracker> {
    if (this._browserOtelRegistrationFailed) {
      throw new Error("Hexclave analytics: managed browser OpenTelemetry is unavailable for this app instance");
    }
    const trackerImport = Result.fromPromise(import("./event-tracker"));
    const recorderImport = this._deps.replayOptions.enabled ? Result.fromPromise(import("./session-replay")) : null;
    const sessionRootResultPromise = this._getSessionRootResult();

    const trackerModule = await trackerImport;
    if (trackerModule.status === "error") {
      console.warn("Hexclave analytics: failed to load the analytics runtime; telemetry from this page will be dropped.", trackerModule.error);
      throw new Error("Hexclave analytics: failed to load the analytics runtime");
    }
    const sessionRootResult = await sessionRootResultPromise;
    if (sessionRootResult.status === "error") {
      console.warn("Hexclave analytics: failed to resolve the authenticated session trace; browser capture will continue with local trace roots.", sessionRootResult.error);
    }
    const tracker = new trackerModule.data.EventTracker({
      projectId: this._deps.projectId,
      resource: this._deps.resource,
      clientVersion: this._deps.sdkVersion,
      ...this._browserOtelRegistration === null ? {} : {
        forceFlushOtel: async () => await this._browserOtelRegistration?.forceFlush(),
      },
      sessionReplaySegmentId: this._segmentId,
      ...sessionRootResult.status === "error" ? {} : { sessionRootContext: sessionRootResult.data },
      sessionReplayEnabled: this._deps.replayOptions.enabled,
      productAnalyticsEnabled: this._deps.productAnalyticsEnabled,
      keystrokeCapture: {
        enabled: this._deps.replayOptions.enabled === true && this._deps.replayOptions.captureKeystrokes === true,
        maskAllInputs: this._deps.replayOptions.maskAllInputs ?? true,
        blockClass: this._deps.replayOptions.blockClass,
        blockSelector: this._deps.replayOptions.blockSelector,
      },
      registerBackgroundTask: this._deps.registerBackgroundTask,
      getPropagationPolicy: this._deps.getPropagationPolicy,
      integritySignals: this._deps.integritySignals,
    });
    this._tracker = tracker;
    tracker.start();
    for (const span of this._preloadGlobalSpans) {
      if (!span.isEnded) tracker.setGlobalSpan(span);
    }
    this._preloadGlobalSpans.clear();

    if (recorderImport !== null) {
      const recorderModule = await recorderImport;
      if (recorderModule.status === "error") {
        console.warn("Hexclave analytics: failed to load the session replay runtime; this page will not be recorded.", recorderModule.error);
      } else {
        this._recorder = new recorderModule.data.SessionRecorder({
          projectId: this._deps.projectId,
          resource: this._deps.resource,
          sendBatch: this._deps.sendReplayBatch,
          sessionReplaySegmentId: this._segmentId,
          onSessionRotation: () => this.setSessionReplaySegmentId(generateUuid()),
          onSessionReplaySegmentMaterialized: async (segmentId) => {
            const sessionRootContext = await this._deps.getSessionRootContext();
            this._tracker?.markSessionReplaySegmentMaterialized(segmentId, sessionRootContext);
          },
        }, this._deps.replayOptions);
        this._recorder.start();
      }
    }
    return tracker;
  }

  private _preloadAmbientContexts(): SpanContext[] {
    const contexts: SpanContext[] = [];
    if (this._resolvedSessionRoot !== null) contexts.push(this._resolvedSessionRoot);
    for (const span of this._preloadGlobalSpans) {
      if (!span.isEnded) contexts.push(span.spanContext());
    }
    const activeOtelSpanContext = getActiveOtelSpanContext();
    if (activeOtelSpanContext !== null) contexts.push(activeOtelSpanContext);
    return contexts;
  }

  /**
   * The enclosing span for a pre-load EVENT: resolved synchronously because the
   * browser sync-stack ambient frames close at the first await. Null when there is
   * no enclosing span (events never mint a trace of their own).
   */
  private _resolvePreloadEnclosingSpan(options: TrackOptions | undefined): { span: SpanContext | null } | { error: string } {
    const resolved = resolveSpanParent({
      explicit: options?.parent,
      ambient: this.getAmbientSpanContexts(),
      root: options?.root,
    });
    if ("error" in resolved) return resolved;
    return { span: resolved.parentSpanId === null ? null : {
      traceId: resolved.traceId,
      spanId: resolved.parentSpanId,
      ...resolved.traceFlags === undefined ? {} : { traceFlags: resolved.traceFlags },
      ...resolved.traceState === undefined ? {} : { traceState: resolved.traceState },
    } };
  }

  /** See EventTracker.getAmbientSpanContexts — used by cross-tier propagation. */
  getAmbientSpanContexts(): SpanContext[] {
    return this._tracker !== null ? this._tracker.getAmbientSpanContexts() : this._preloadAmbientContexts();
  }

  /** See EventTracker.getPageViewSpanContext. Null pre-load: the tab's first
   * page view is minted by the tracker, so nothing encloses a pre-load request. */
  getPageViewSpanContext(): SpanContext | null {
    return this._tracker?.getPageViewSpanContext() ?? null;
  }

  getSessionReplaySegmentId(): string {
    return this._tracker?.getSessionReplaySegmentId() ?? this._segmentId;
  }

  getCurrentPageViewSpanId(): string | null {
    return this._tracker?.getCurrentPageViewSpanId() ?? null;
  }

  setSessionReplaySegmentId(id: string): void {
    this._segmentId = id;
    this._tracker?.setSessionReplaySegmentId(id);
    this._recorder?.setSessionReplaySegmentId(id);
  }

  async clearBuffer(): Promise<void> {
    this._bufferGeneration += 1;
    this.setSessionReplaySegmentId(generateUuid());
    this._preloadGlobalSpans.clear();
    this._integrationBreadcrumbs.length = 0;
    this._tracker?.clearBuffer();
    this._recorder?.clearBuffer();
    await this._drainPendingErrorProcessing();
    if (this._browserOtelRegistration !== null) {
      this._browserOtelRegistration = await this._browserOtelRegistration.flushBeforeAuthenticationChange();
    }
  }

  /**
   * Awaits the pending error-processing set until it is QUIESCENT, not just a
   * snapshot of it: an accepted event's processing task schedules its
   * attachment delivery as a NEW set entry, so a single Promise.all over the
   * initial members would return while that upload still runs — and, on the
   * sign-out path, let it authenticate as the next user.
   */
  private async _drainPendingErrorProcessing(): Promise<void> {
    while (this._pendingErrorProcessing.size > 0) {
      await Promise.all([...this._pendingErrorProcessing]);
    }
  }

  resumeSessionReplayAfterAuthentication(): void {
    this._recorder?.captureFullSnapshotForCurrentSegment();
  }

  trackCustomEvent(eventType: string, data?: Record<string, unknown>, options?: TrackOptions): Promise<void> {
    const nameError = getCustomTelemetryNameError("event", eventType);
    if (nameError) return rejectedPreCaught(nameError);
    const dataError = getCustomTelemetryDataError(data);
    if (dataError) return rejectedPreCaught(dataError);
    const enclosing = this._resolvePreloadEnclosingSpan(options);
    if ("error" in enclosing) return rejectedPreCaught(enclosing.error);
    this.ensureProviderForExplicitSignal();
    if (this._browserOtelRegistrationFailed) return preCaught(Promise.resolve());
    const pageViewSpanId = this.getCurrentPageViewSpanId();
    emitHexclaveOtelEvent({
      eventName: eventType,
      data,
      clientVersion: this._deps.sdkVersion,
      parent: enclosing.span,
      correlationAttributes: {
        "hexclave.session_replay.segment.id": this.getSessionReplaySegmentId(),
        ...pageViewSpanId === null ? {} : { "hexclave.page_view.span_id": pageViewSpanId },
      },
    });
    return preCaught(this._browserOtelRegistration?.forceFlush() ?? Promise.resolve());
  }

  captureException(error: unknown, options?: CaptureExceptionOptions, scope?: ErrorScopeData): ErrorEventId {
    this.assertErrorCaptureAvailable();
    this._ensureManualErrorProvider();
    const eventId = generateErrorEventId();
    const mergedScope = mergeErrorScopeData(scope, options);
    this.trackErrorEvent(buildErrorEventData(error, {
      mechanismType: options?.mechanism ?? "captured.exception",
      handled: options?.handled ?? true,
      release: this._deps.release,
      environment: this._deps.environment,
      sdkVersion: this._deps.sdkVersion,
      eventId,
      scope: mergedScope,
    }), mergedScope, error);
    return eventId;
  }

  captureMessage(message: string, options?: CaptureMessageOptions, scope?: ErrorScopeData): ErrorEventId {
    if (message === "") throw new Error("Hexclave captureMessage requires a non-empty message");
    this.assertErrorCaptureAvailable();
    this._ensureManualErrorProvider();
    const eventId = generateErrorEventId();
    const mergedScope = mergeErrorScopeData(scope, options);
    this.trackErrorEvent(buildCapturedEventData({
      message,
      name: "Message",
      handled: true,
      mechanism: options?.mechanism ?? "captured.message",
      ...options,
    }, {
      eventId,
      release: this._deps.release,
      environment: this._deps.environment,
      sdkVersion: this._deps.sdkVersion,
      scope: mergedScope,
    }), mergedScope);
    return eventId;
  }

  captureEvent(event: CaptureEvent, scope?: ErrorScopeData): ErrorEventId {
    this.assertErrorCaptureAvailable();
    this._ensureManualErrorProvider();
    const eventId = generateErrorEventId();
    const mergedScope = mergeErrorScopeData(scope, event);
    this.trackErrorEvent(buildCapturedEventData(event, {
      eventId,
      release: this._deps.release,
      environment: this._deps.environment,
      sdkVersion: this._deps.sdkVersion,
      scope: mergedScope,
    }), mergedScope);
    return eventId;
  }

  private assertErrorCaptureAvailable(): void {
    if (!this._isInstrumentationEnabled()) {
      throw new Error("Hexclave error capture is unavailable because observability is disabled");
    }
  }

  /**
   * Lazily registers the managed provider so an EXPLICIT signal call
   * (trackEvent / startSpan / logger / capture*) always lands on a recording
   * provider, even when `automaticSideEffects: false` skipped the eager
   * registration at construction. Only the provider comes up — automatic
   * hooks (page views, HTTP instrumentation, global handlers) stay off, so
   * the side-effects switch keeps its meaning.
   */
  ensureProviderForExplicitSignal(): void {
    if (this._deps.openTelemetryProvider === "managed" && this._browserOtelRegistration === null) {
      this._browserOtelRegistration = this._registerManagedBrowserOtel();
    }
  }

  private _ensureManualErrorProvider(): void {
    this.ensureProviderForExplicitSignal();
    this._installClientErrorCapture();
    this._installErrorIntegrations();
  }

  /** OTel LogRecord delivery after the bounded processor/privacy pipeline. */
  trackErrorEvent(data: CapturedErrorEvent, scope?: ErrorScopeData, originalException?: unknown): void {
    const dataWithIntegrationBreadcrumbs = this._integrationBreadcrumbs.length === 0
      ? data
      : {
        ...data,
        breadcrumbs: [
          ...this._integrationBreadcrumbs,
          ...data.breadcrumbs ?? [],
        ].slice(-100),
      };
    const attachments = getErrorAttachmentInputs(scope);
    assertErrorAttachmentDeliveryConfigured(attachments, this._deps.errorAttachmentTransport, this._deps.onAttachmentPending);
    const processed = processErrorEvent(dataWithIntegrationBreadcrumbs, {
      eventProcessors: this._deps.errorCapture.eventProcessors,
      scopeProcessors: scope?.eventProcessors,
      beforeSend: this._deps.errorCapture.beforeSend,
      hint: {
        eventId: dataWithIntegrationBreadcrumbs.event_id,
        mechanism: typeof dataWithIntegrationBreadcrumbs.mechanism_type === "string" ? dataWithIntegrationBreadcrumbs.mechanism_type : "captured",
        handled: dataWithIntegrationBreadcrumbs.handled === true,
        ...originalException === undefined ? {} : { originalException },
        scope: scope ?? {},
        attachments,
      },
      onFailure: (failure) => {
        console.warn(`Hexclave error processor ${failure.reason} in ${failure.stage} (${failure.processorName}); event dropped`);
      },
    });
    const deliver = (result: ErrorProcessingResult): void => {
      if (result.status === "dropped") return;
      this._trackAcceptedErrorEvent(result.event, attachments);
    };
    if (isPromiseLike(processed)) {
      const pending = Promise.resolve(processed).then(deliver);
      this._pendingErrorProcessing.add(pending);
      runAsynchronously(pending.then(
        () => {
          this._pendingErrorProcessing.delete(pending);
        },
        (error) => {
          this._pendingErrorProcessing.delete(pending);
          throw error;
        },
      ), { noErrorLogging: true });
      return;
    }
    deliver(processed);
  }

  private _trackAcceptedErrorEvent(data: CapturedErrorEvent, attachments: readonly ErrorAttachmentInput[] = []): void {
    this._deps.onErrorEventId?.(data.event_id);
    if (this._browserOtelRegistrationFailed) return;
    const enclosing = this._resolvePreloadEnclosingSpan(undefined);
    if ("error" in enclosing) return;
    const pageViewSpanId = this.getCurrentPageViewSpanId();
    emitHexclaveOtelError({
      data,
      clientVersion: this._deps.sdkVersion,
      parent: enclosing.span,
      correlationAttributes: {
        "hexclave.session_replay.segment.id": this.getSessionReplaySegmentId(),
        ...pageViewSpanId === null ? {} : { "hexclave.page_view.span_id": pageViewSpanId },
      },
    });
    const registration = this._browserOtelRegistration;
    if (registration !== null) runAsynchronously(async () => await registration.forceFlush(), { noErrorLogging: true });
    if (attachments.length > 0) {
      const pending = deliverErrorAttachments({
        eventId: data.event_id,
        attachments,
        transport: this._deps.errorAttachmentTransport,
        onPending: this._deps.onAttachmentPending,
      });
      this._pendingErrorProcessing.add(pending);
      runAsynchronously(pending.then(
        () => {
          this._pendingErrorProcessing.delete(pending);
        },
        (error) => {
          this._pendingErrorProcessing.delete(pending);
          throw error;
        },
      ), { noErrorLogging: true });
    }
  }

  /** Promotes a real console.error(Error) call while retaining its $log row. */
  captureConsoleError(error: Error): void {
    const admission = this._getErrorCapturePolicy().admit(error);
    if (admission === null) return;
    const scope = getActiveErrorScope()?.snapshot();
    this.trackErrorEvent(buildErrorEventDataFromNormalized(admission.normalized, {
      mechanismType: "console.error",
      handled: true,
      release: this._deps.release,
      environment: this._deps.environment,
      sdkVersion: this._deps.sdkVersion,
      scope,
      exceptionValues: buildLinkedExceptionValues(error, admission.normalized),
    }), scope, error);
  }

  startSpan(spanType: string, options?: StartSpanOptions): Span {
    const ambient = this.getAmbientSpanContexts();
    const resolved = resolveSpanParent({
      explicit: options?.parent,
      ambient,
      links: options?.links,
      fallbackParent: this.getPageViewSpanContext(),
      root: options?.root,
    });
    if ("error" in resolved) {
      throw new Error(`Hexclave analytics: ${resolved.error}`);
    }
    const parent = resolved.parentSpanId === null
      ? undefined
      : {
        traceId: resolved.traceId,
        spanId: resolved.parentSpanId,
        ...resolved.traceFlags === undefined ? {} : { traceFlags: resolved.traceFlags },
        ...resolved.traceState === undefined ? {} : { traceState: resolved.traceState },
      };
    this.ensureProviderForExplicitSignal();
    if (this._browserOtelRegistrationFailed) {
      return createInertSpanHandle({
        traceId: resolved.traceId,
        spanId: generateOtelSpanId(),
        spanType,
        startedAtMs: options?.startedAtMs ?? Date.now(),
        parentSpanId: resolved.parentSpanId,
        initialData: { ...options?.data ?? {} },
        ...resolved.traceFlags === undefined ? {} : { traceFlags: resolved.traceFlags },
        ...resolved.traceState === undefined ? {} : { traceState: resolved.traceState },
      });
    }
    const pageViewSpanId = this.getCurrentPageViewSpanId();
    const span = createOtelSpanFacade({
      tracer: otelTrace.getTracer("@hexclave/sdk-browser", this._deps.sdkVersion),
      spanType,
      startOptions: {
        ...options,
        ...parent === undefined ? { root: true } : { parent, root: false },
        links: resolved.links,
      },
      correlationBaggage: this._deps.getPropagationPolicy().correlationBaggage,
      correlationAttributes: {
        "hexclave.session_replay.segment.id": this.getSessionReplaySegmentId(),
        ...pageViewSpanId === null ? {} : { "hexclave.page_view.span_id": pageViewSpanId },
      },
      capabilities: {
        trackEvent: (eventType, data, trackOptions) => this.trackCustomEvent(eventType, data, trackOptions),
        onEnded: (endedSpan) => this.clearGlobalSpan(endedSpan),
        getSpanPropagationHeaders: (currentSpan) => this._preloadSpanPropagationHeaders(currentSpan),
        fetch: (currentSpan, input, init) => this._preloadSpanFetch(currentSpan, input, init),
      },
    });
    return span;
  }

  private _preloadSpanPropagationHeaders(_span: Span): Record<string, string> {
    if (!this._deps.getPropagationPolicy().correlationBaggage) return {};
    const segmentId = this.getSessionReplaySegmentId();
    return buildPropagationHeaderValues({
      traceparent: null,
      context: {
        ...segmentId ? { sessionReplaySegmentId: segmentId } : {},
      },
    });
  }

  private _preloadSpanFetch(span: Span, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const policy = this._deps.getPropagationPolicy();
    return fetchWithSpanPropagation({
      input,
      init,
      headerValues: this._preloadSpanPropagationHeaders(span),
      selfOrigin: policy.selfOrigin,
      allowedOrigins: policy.allowedOrigins,
      allowLocalhost: policy.allowLocalhost,
    });
  }

  setGlobalSpan(span: Span): void {
    if (this._tracker !== null) {
      this._tracker.setGlobalSpan(span);
      return;
    }
    if (span.isEnded) {
      console.warn("Hexclave analytics: setGlobalSpan() called with an already-ended span; ignoring");
      return;
    }
    this._preloadGlobalSpans.add(span);
  }

  clearGlobalSpan(span: Span): void {
    this._tracker?.clearGlobalSpan(span);
    this._preloadGlobalSpans.delete(span);
  }

  /**
   * Sends everything buffered right now. Loading the runtime is part of the
   * delivery guarantee — anything queued pre-load can only ship through it.
   */
  async flush(): Promise<void> {
    if (this._browserOtelRegistrationFailed) return;
    const tracker = await preCaught(this._ensureLoaded());
    await this._drainPendingErrorProcessing();
    await Promise.all([
      tracker.flush(),
      this._browserOtelRegistration?.forceFlush() ?? Promise.resolve(),
    ]);
  }
}
