# Analytics & Telemetry

The custom-telemetry surface shared by HexclaveClientApp and HexclaveServerApp:
events, spans, logs, error capture, network capture, and cross-tier trace
propagation. Client-side autocapture ($page-view, $click, session replay, web
vitals) is browser-only; the APIs below exist on both app classes unless marked
otherwise.

All new SDK telemetry ships over OTLP/HTTP to the standard `/v1/traces` and
`/v1/logs` signal endpoints (see "Signal wire formats and compatibility"). The
released POST /api/v1/analytics/events/batch route is kept only as a
receiver-side compatibility adapter for already-deployed SDKs; new SDK code
never sends to it.

Telemetry must NEVER throw into or otherwise affect user code, except where a
method's contract explicitly says it throws/rejects on invalid input.


## Shared validation rules

These are enforced identically by the SDK (locally, before buffering) and the
server at the OTLP ingestion boundary (an invalid item is rejected there, so
local validation must not drift):

- Custom event/span type names: regex ^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$.
  "$"-prefixed names are reserved for system telemetry and rejected for custom
  items.
- data payloads: plain JSON-serializable object, at most 64,000 bytes when
  JSON.stringify'd. For spans the cap applies to the accumulated merged data.
- Span identity is W3C trace context, not a bespoke scheme:
    trace id  = 32 lowercase hex chars, never all-zero
    span id   = 16 lowercase hex chars, never all-zero, unique within its trace
    parent    = a single span id, or NULL meaning "this span is the trace root"
  A span's parent_span_id must differ from its own span_id. The configured OTel
  SDK IdGenerator owns ordinary operation IDs. Session lifecycle nodes are the one
  exception: their W3C ids are deterministically derived from their UUIDs so
  the browser, ingestion tier, and virtual refresh-token projection agree
  without shared state. There are NO id
  prefixes and NO ancestry arrays — a span's position in the tree is exactly
  (trace_id, span_id, parent_span_id).
  This is a deliberate interop decision: the ids Hexclave stores are byte-for-byte
  the ids a standard `traceparent` header carries, so a Hexclave trace can be
  read, joined, or continued by any OpenTelemetry-compatible tool with no
  translation layer that could disagree with ours.
- Batch ids, user ids, and the replay / segment / refresh-token correlation ids
  stay RFC 4122-shaped uuids, regex
  ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$
  (case-insensitive). Generate with crypto.randomUUID().
- A span has AT MOST ONE parent, so there is no ancestor chain and nothing to
  cap. Work that is causally related but is NOT this span's parent belongs in
  `links` (see "Parent resolution").
- $log messages: at most 8,192 UTF-8 bytes. $error messages/stacks: same cap.
  Truncation must never split a UTF-8 code point.


## Trace boundaries

An authenticated browser trace begins at the refresh-token session and keeps
the product's lifecycle hierarchy while using scalar W3C parents throughout:

    $refresh-token
      ├─ $page-view                     (before replay attribution resolves)
      └─ $session-replay                (when replay capture is enabled)
          └─ $session-replay-segment    (one per tab per replay)
              └─ later $page-view
                  ├─ $away / $offline
                  ├─ $click / $error / $log …  (events inside the page view)
                  ├─ custom withSpan / startSpan
                  └─ OTel HTTP client span
                      └─ backend request span   (via `traceparent`)
                          └─ library spans (Prisma, Drizzle, AI SDK, …)

When replay capture is disabled, every `$page-view` is a direct child of
`$refresh-token`. When it is enabled, a deterministic segment id is NOT enough
to parent under: early pages remain refresh-direct until a successful replay
batch confirms that ingestion materialized the segment under the current
refresh-token trace. A stale acknowledgement for a pre-rotation segment is
ignored. The acknowledgement refreshes the session root and restarts the page
when that root changed, so a page can never combine one trace id with a segment
row materialized in another trace. Requests that do not belong to an
authenticated browser session still use the ordinary W3C boundary below.

Browser listener startup MUST NOT await refresh-token identity resolution.
Anonymous sign-up and token refresh are network operations and may be slow or
temporarily unavailable; `$click`, `$keystroke`, and `$page-view` capture must
start as soon as the analytics runtime loads. Until the authenticated root is
available, the page view uses a fresh local trace. Resolving the root (and later
materializing the replay segment) rotates the page-view span into the durable
session hierarchy without dropping capture during either transition.

A span whose `parent_span_id` is null is a root activity: a `$page-view`, a
backend request that arrived with no accepted incoming `traceparent`, or
anything started with no enclosing context at all (for example a custom span,
background job, or fetch before a browser page view exists).

Resolution order for anything else started in the browser: explicit `parent` →
nearest ambient span (global spans, enclosing `withSpan` frames) → current
`$page-view` → nothing. The page view is an ancestor of LAST RESORT
(`fallbackParent`), not a peer ambient context: when something nearer wins it is
NOT recorded as a link, because `page_view_span_id` already states that
relationship on every row.

`root: true` opts an individual call out of all of the above.

`refresh_token_id`, `session_replay_id`, `session_replay_segment_id` and
`page_view_span_id` remain scalar CORRELATION columns, so "which
session/tab/page was this?" stays a cheap equality filter even though the
corresponding lifecycle spans also form the browser trace's ancestor chain.

The root span of a trace is the span whose `parent_span_id` is null; that is the
only definition, and it is the same definition every OTel-compatible consumer
uses.


## Constructor options

Both app constructors accept three independent option objects. Analytics
defaults to enabled; Observability is strictly opt-in — `observability.enabled`
defaults to false, and no observability instrumentation (error/console hooks,
network capture, OTel provider, span propagation, exporters) may be installed
unless the caller passes `observability.enabled: true`. They share one delivery
core.

  TelemetryResource = {
    service: {
      name: string
      namespace?: string
      version?: string
      instanceId?: string
    }
    deploymentEnvironmentName?: string
    attributes?: Record<string, unknown>
  }

  analytics: {
    enabled?: bool
    replays?: { enabled?, captureKeystrokes?, maskAllInputs?, blockClass?, blockSelector? }
    integritySignals?: bool
  }

`analytics.replays.captureKeystrokes` defaults to false. When enabled alongside
session replay, the browser SDK groups `keydown` activity after 500ms of idle
time and emits a `$keystroke` event whose data contains only `count`,
`duration_ms`, `url`, and `path`. It MUST NEVER emit key values or typed text.
Targets inside the effective replay `blockClass` / `blockSelector`, the default
`rr-mask` class, password inputs, or any input masked by `maskAllInputs` are
excluded entirely so the count cannot reveal a masked value's length.

The effective replay block selector MUST always include
`[data-hexclave-session-replay-block]`, in addition to any customer-provided
`blockSelector`. Hexclave-owned embedded replay players use this attribute to
keep a nested rrweb mirror out of the surrounding recording; recording nested
mirror IDs can corrupt unrelated nodes during playback.

`analytics.enabled` controls custom/product events, autocapture, replays, and
integrity signals. It does not disable code instrumentation.

`analytics.replays.enabled` defaults to true. Replay recording is not sampled
by `observability.traceSampleRate`; that option only selects root traces.

  observability: {
    enabled?: bool
    release?: string
    environment?: string
    traceSampleRate?: number
    errorCapture?: {
      enabled?: bool,
      ignoreErrors?: string[],
      eventProcessors?: ErrorEventProcessor[],
      beforeSend?: ErrorBeforeSend,
      attachmentTransport?: ErrorAttachmentTransport,
      onAttachmentPending?: (attachment: PendingErrorAttachment) => void | PromiseLike<void>,
    }
    logs?: { captureConsole?: ("log" | "warn" | "error" | "info" | "debug")[] }
    openTelemetry?: {
      provider?: "managed" | "existing-provider" | "auto"
    }
    spanPropagation?: {
      enabled?: bool
      allowedOrigins?: string[]
      useTrustedDomains?: bool
    }
    network?: {
      enabled?: bool
      allowOrigins?: string[]
      denyOrigins?: string[]
      ignoreUrls?: string[]
    }
  }

`observability.enabled` controls errors, logs, spans, propagation, and network
or library instrumentation. Console capture defaults to warn+error; error,
network, and propagation capture default to enabled. Release and environment
use the platform defaults described in the error-capture section.

On servers, `observability.openTelemetry.provider` defaults to `managed`.
Managed mode synchronously installs official Node TracerProvider and
LoggerProvider instances,
AsyncLocalStorage context manager, W3C trace-context+baggage propagator,
parent-based ratio sampler, Hexclave correlation processor, and authenticated
OTLP/HTTP trace and log exporters. Any pre-existing global registration is a configuration
error and MUST throw rather than silently routing spans elsewhere.

`auto` mode MUST install the same managed graph when no global tracer
provider is registered. If a host provider is already registered when
installation runs, `auto` MUST adopt that provider and MUST NOT throw.
Adoption MUST NOT install Hexclave's TracerProvider, context manager,
propagator, MeterProvider, LoggerProvider, or instrumentations.

`existing-provider` mode MUST NOT mutate any OpenTelemetry global. The
application configures its own trace/logger providers with the exporters and correlation
processor exposed by the framework package's Node-only `/otel` entrypoint and
owns its sampler, resource, instrumentations, context manager, propagator, and
lifecycle. Hexclave's `Span`, event, and logger APIs remain thin facades over
the active OTel globals in both modes.
  telemetry: {
    resource?: TelemetryResource
    waitUntil?: (promise) => void
  }

`telemetry.resource` is the immutable identity of the process, deployment, or
browser application producing the telemetry. It is REQUIRED whenever either
Analytics or Observability is effectively enabled. Analytics defaults to
enabled and Observability is opt-in, so omitting it is valid only when
`analytics.enabled` is explicitly false and `observability.enabled` is not set
to true (or when the app has no telemetry delivery path, such as an
owner-session admin app). Validate and throw
synchronously at app construction; NEVER infer a service from the SDK class,
framework, hostname, request URL, project, or runtime, and NEVER substitute a
generic fallback such as "Hexclave".

Every event, span, log, error, replay batch, and derived library/network signal
emitted by one app instance carries the same frozen resource. There is no
per-item or per-span resource override. Validate and defensively snapshot the
complete resource at construction, so later mutation of the caller's input
object cannot change service identity. An app created with `inheritsFrom`
inherits the parent's entire `telemetry` object when `telemetry` is omitted. If
the child supplies `telemetry`, top-level constructor replacement semantics
apply; in particular an explicit `telemetry.resource` replaces the parent's
resource ATOMICALLY — do not deep-merge `service` or `attributes`. Serialization
across runtime boundaries preserves `resource` but omits the function-valued
`waitUntil`.

The logical service identity tuple is:

  (service.namespace ?? "", service.name)

`service.version`, `service.instanceId`, and
`deploymentEnvironmentName` describe a version, replica/browser instance, and
deployment environment of that logical service; they MUST NOT split one service
into unrelated names. Distinct clients that send to one Hexclave project MUST
choose distinct logical service identities (normally distinct service.name
values, optionally grouped by a shared namespace), for example
`stack-dashboard` for the browser/dashboard and `stack-backend` for its API.
Changing the user, session, host, route, or request does not change the app
resource.

`telemetry.waitUntil` owns the shared serverless delivery lifecycle. Every
Analytics or Observability send is passed to it. It is function-valued and
therefore omitted from serialized app JSON. Server sends otherwise use the
per-request platform hook when one is available.

Validation at app construction (throw synchronously):
- telemetry.resource is required under the enablement rule above.
- resource.service must be an object and resource.service.name must be a
  non-empty string.
- service.name, service.namespace, service.version, service.instanceId, and
  deploymentEnvironmentName are non-empty strings when present, each at most
  255 characters.
- resource.attributes, when present, is a plain JSON-serializable object whose
  serialized UTF-8 form is at most 16 KiB.
- network.allowOrigins and network.denyOrigins are mutually exclusive.
- observability.traceSampleRate must be a number in [0, 1].


## Signal wire formats and compatibility

New SDK versions export traces and logs with the official OTLP/HTTP exporter to
the standard `/v1/traces` and `/v1/logs` signal suffixes. Do not define a second
SDK-owned envelope or serialize spans/events/logs into
`/analytics/events/batch`.

The released `/analytics/events/batch` endpoint remains available for older
SDKs. Treat it as a receiver-side compatibility adapter: validate the released
event shape, normalize it into the canonical storage model, and never make its
custom JSON schema a dependency of new SDK code.

The replay uploader uses its existing dedicated route. Its body version remains
independent from the events/spans batch because rrweb chunks have a separate
wire format. New replay batches begin with:

  {
    schema_version: 2,
    resource: TelemetryResource,
    browser_session_id: uuid,
    session_replay_segment_id: uuid,
    batch_id: uuid,
    started_at_ms: number,
    sent_at_ms: number,
    events: [...]
  }

On ingestion, copy the structured resource fields to the corresponding
service_namespace, service_name, service_version, service_instance_id, and
deployment_environment_name columns, and store only the remaining custom
attributes in resource_attributes. Missing/invalid resource or an empty
service.name rejects the entire replay batch. Never infer a value during ingestion
and never place such rows into an "unknown" or generic service bucket.

In a browser the current `$page-view` span is the enclosing span of last resort
(see "Trace boundaries"), so a bare trackEvent and every auto-captured event
carry the page view's standard OTel span context. `app.logger` uses the active
OTel Context. Page/replay correlation is also retained as namespaced OTel
attributes so it remains queryable even when no span is recording.

Auto-captured events take the page view DIRECTLY rather than through ambient
resolution — they fire from DOM listeners, where whatever `withSpan` frame
happens to be open elsewhere on the page is not the operation the user's click
belongs to. Events recorded before the tab's first $page-view span (the pre-load
window) or under `root: true` still carry no trace.

OTLP identity fields are final: what the OTel SDK generates is what the
dashboard and any external OTel-compatible consumer sees. The authenticated
gateway validates the OTLP model and stamps tenant columns; it never rewrites,
prefixes, or namespaces trace/span IDs.

`page_view_span_id`, `session_replay_id`, `session_replay_segment_id` and
`refresh_token_id` remain correlation columns for direct filtering. The same
lifecycle is also represented structurally: `default.spans` projects the
synced refresh token as `$refresh-token`, and the replay batch route writes
`$session-replay` and `$session-replay-segment` rows. Their ids and immediate
parents must match the deterministic UUID-to-W3C mapping used by the browser's
page-view parent. The browser may use the segment as a scalar parent only after
that replay write has returned successfully for the same tab segment.

Buffering, export, and sampling:

- The configured OTel `BatchSpanProcessor` and `BatchLogRecordProcessor` own
  batching, queue bounds, scheduling, retries, and OTLP serialization. Hexclave
  does not maintain a parallel trace/log transport or schema-versioned batch.
- `flush()` force-flushes both providers only in managed-provider mode. In
  existing-provider mode the application owns processor/exporter lifecycle.
- Browser autocapture may briefly retain a DOM-derived event locally only when
  its final meaning is not yet known (dead-click classification and keystroke
  coalescing). Once classified it becomes a named OTel LogRecord; it never
  becomes a legacy analytics-batch row in new SDK versions.
- Session replay remains a separate transport because replay chunks are not an
  OpenTelemetry signal. The released `/analytics/events/batch` route remains a
  receiver-side compatibility adapter for already-deployed SDKs only.
- Authentication replacement is a hard replay boundary. Before sign-out or a
  direct signed-out/anonymous-to-authenticated transition can await network
  I/O, rotate the per-tab segment and clear its queued replay events. Merely
  replacing the access token for the same refresh token is not a boundary.
  Suppress subsequent incremental rrweb events until the next authenticated
  token set has been published; then take a new FullSnapshot before accepting
  increments. The suppression window must still admit Meta events alongside
  the FullSnapshot: rrweb emits the Meta immediately before every snapshot,
  and the replayer keeps its iframe hidden until the first Meta sizes it, so a
  segment whose Meta was suppressed plays back as a blank frame. This prevents
  both cross-user DOM attribution and mutation-only replay streams that the
  player cannot reconstruct.
- A replay segment is not materialized until a batch containing its
  FullSnapshot succeeds. If that first upload fails, discard mutations that
  depend on the missing snapshot and capture a replacement FullSnapshot before
  attempting another upload. Never persist a mutations-only segment after a
  transient transport failure.
- `observability.traceSampleRate` defaults to 0.1 and configures the managed
  provider's standard parent-aware root sampler. Existing-provider mode leaves
  sampling entirely to the application's provider. This rate samples traces
  only.
- Error/latency-aware retention is tail sampling. It must run after ingestion
  in a Collector or authenticated backend buffering boundary; an SDK cannot
  resurrect a head-dropped span after its outcome becomes known. Session
  replays, product events, logs, and errors are retained independently of
  trace sampling. HTTP client metrics are derived from recorded CLIENT spans
  (spanmetrics), so they follow the same head-sampling decision as the
  request span.

## Managed browser OTLP delivery (offline queue, retries, client reports)

The managed browser exporter wraps the official OTLP/HTTP exporters with one
delivery layer per signal (`traces` | `logs` | `metrics`). All signals share
these constants:

    export attempts per batch:            3
    retry base delay:                     1_000 ms
    retry max delay:                      30_000 ms
    max request body:                     1 MiB (1_048_576 bytes)
    retryable HTTP statuses:              408, 429, 500, 502, 503, 504
    flush deadline (default):             5_000 ms
    shutdown deadline (default):          2_000 ms
    page-unload flush deadline:           250 ms
    offline queue max entries:            30
    offline queue max bytes:              5 MiB (5 * 1_024 * 1_024)
    unload keepalive per-request cap:     30_000 bytes
    unload keepalive per-page budget:     64 KiB (65_536 bytes)

Retry/backoff: a failed attempt is retried up to 3 attempts total. Delay for
attempt N > 1 is the server's `Retry-After` header when present and parseable
(integer seconds or an HTTP date, clamped to the 30 s max), otherwise
exponential with jitter: `min(30_000, 1_000 * 2^(N-1))` scaled by a uniform
0.5–1.0 factor. Deadline expiry mid-retry returns a retryable "deadline"
outcome instead of throwing. Non-retryable statuses classify as `rejected`
(generic), `oversized` (413), or permanent failure; network errors are always
retryable. Exhausted retries surface a delivery outcome (with reason such as
`retry_exhausted`, including attempt count and status code) through the
`onOutcome` hook — data is never silently lost without an outcome record.

Offline persistence: when configured, undelivered batches persist to IndexedDB
so telemetry survives page reloads while offline. One database per signal,
named `${dbName}-${signal}` where `dbName` defaults to
`hexclave-otlp-offline-<projectKey>` (preserving the naming of older SDKs).
Bounds are enforced on enqueue: oldest entries are evicted first when the queue
would exceed 30 entries or 5 MiB. Each entry carries its serialized body,
item count, byte size, scheduled `nextAttemptAt`, and the authentication
generation it was captured under. Queue bounds are tracked in a metadata store
(`queue-bytes`, `auth-generation`; database version 1).

Authentication-generation isolation: every batch is stamped with the current
generation and re-checked immediately before each send attempt and again after
the response arrives; a mismatch aborts delivery with an
`auth_generation_mismatch` outcome so buffered telemetry can never be
attributed to the wrong user. Advancing the generation (authentication change)
flushes first; if that fails, providers shut down within the shutdown deadline
and the whole managed registration is replaced rather than letting spans cross
users. Once generation advancement succeeds, a provider shutdown rejection is
reported but does not abort the authentication change: shutdown is one-way, and
the old instrumentation and page-global providers are detached before the
replacement is installed. Client reports are never emitted for
`auth_generation_mismatch`, `queue_overflow`, or `persistence_failure`
outcomes.

Page-unload path: on `visibilitychange → hidden` / `pagehide` a single
microtask flush runs under the 250 ms unload deadline. Requests may use
`fetch(..., { keepalive: true })` only when the body is ≤ 30,000 bytes AND the
page-wide in-flight keepalive budget (64 KiB, tracked across all signals)
has room; otherwise the normal (non-keepalive) fetch is used and the data
rides the offline queue.

Client reports (self-telemetry about dropped telemetry): whenever a full
outcome records drops — except the auth/queue/persistence reasons above — the
exporter enqueues one JSON report to
`POST /api/v1/analytics/client-reports` through the same offline queue and
retry rules as ordinary batches:

    {
      discarded_events: [{
        reason,        // the outcome reason string
        category,      // "span" | "log_item" | "metric" by signal
        quantity,      // dropped item count (falls back to item count)
      }],
      rate_limited_events: [],
      filtered_events: [],
      filtered_sampling_events: [],
      idempotency_key, // `hexclave-client-report-<signal>-` + 4 random u32 hex
                       // (crypto.getRandomValues) or timestamp-sequence fallback
    }

The receiver deduplicates on the idempotency key. Reports are queued at
`nextAttemptAt = now` and drained opportunistically; a full queue drops the
report with a console warning instead of blocking telemetry.


## trackEvent(eventType, data?, options?)

Emits one named OpenTelemetry LogRecord with
`hexclave.signal.type = "event"` and the structured payload in
`hexclave.data`. In managed-provider mode the returned promise force-flushes
the managed trace and logger providers, preserving the released remote-
acknowledgement behavior. In existing-provider mode Hexclave does not own the
provider lifecycle, so the promise acknowledges synchronous provider
acceptance. Invalid input and disabled/unavailable analytics reject pre-caught.

TrackOptions:
  parent: ParentRef?           - the ONE span this item belongs under; overrides
                                 ambient context entirely (see "Parent resolution")
  root: bool?                  - drop the AMBIENT parent: start a new trace

Events do not accept `links`: OpenTelemetry links are owned by spans.

Server-side additionally:
  userId: uuid?    - explicit attribution (validated as uuid)
  request: RequestLike? - resolve attribution, the caller's trace, and the
    session correlation ids from an incoming request (see "Server request
    linking")


## logger (both app classes)

`app.logger` is an eagerly-available facade over the active OpenTelemetry
LoggerProvider with five methods:

  logger.trace(message, data?)   level "trace"
  logger.debug(message, data?)   level "debug"
  logger.info(message, data?)    level "info"
  logger.warn(message, data?)    level "warn"
  logger.error(message, data?)   level "error"

Each call emits one OTel LogRecord whose body is the message, whose standard
severity number/text correspond to the chosen method, and whose structured
payload is the `hexclave.data` attribute. Contract:

- Fire-and-forget; NEVER throws into user code.
- Non-string messages are coerced to a bounded string representation (depth-
  limited, circular-safe) rather than dropped.
- message is truncated to 8,192 UTF-8 bytes BEFORE emission.
- `data` follows the normal event-data validation; invalid data drops the log
  with a console warning.
- Environments with no delivery path (analytics disabled; non-browser client
  app) warn ONCE per app instance and silently drop further logs.
- The OTel Logs SDK reads the active OTel Context, so logs inside a span carry
  the standard trace_id/span_id/flags correlation. Hexclave replay/page
  correlation remains namespaced attributes copied from allowlisted baggage.
- The client-side-only origin marker ("logger" or "console") controls local
  validation/rate limiting only and never leaves the process.

### Console capture (observability.logs.captureConsole)

When observability is enabled, capture defaults to levels ["warn", "error"].
Users widen with the full level list or opt out with []. Capture only INSTALLS
when `observability.enabled: true` and the app has a real delivery path:

- Browser: an active client observability facade (browser + a refreshable
  client session). Owner-session admin apps never install.
- Server: a non-browser server app with a secret server key (the same
  exclusions as the eager fetch/error instrumentation).

Patch those console methods GLOBALLY. ALL patch state (active sink, patched
methods, re-entrancy flag, rate buckets) lives in ONE globalThis slot keyed by
Symbol.for("hexclave.analytics.console-capture.v1"), shared across duplicate
SDK copies — two module-local copies would wrap each other's wrappers and an
uninstall could sever the chain into infinite recursion. Last installer wins
(replace, don't stack, so HMR cannot duplicate lines); replacing a sink whose
projectId differs logs ONE console warning naming both projects.

1. The original console method always runs FIRST, unconditionally — and is
   never rate limited, redacted, or otherwise altered.
2. Mirror the call through an origin:"console" logger at the mapped level
   (console.log maps to level info) with the args serialized to one string:
   string args verbatim; other values first pass a key-redaction walk (keys
   matching /authorization|cookie|passw|secret|token|api[-_]?key|
   session[-_]?id|private[-_]?key/i become "[redacted]", bounded depth 4,
   plain objects/arrays only) and then the bounded serializer. data is
   { console_level: <level> }.
3. If any arg is an actual Error, additionally set data.error_name and
   data.error_fingerprint — computed EXACTLY like the $error pipeline
   (truncate message/stack to the 8,192-byte cap, then fingerprint) — and emit
   a handled $error occurrence through the Issues pipeline while retaining the
   $log row for surrounding console context. Plain string console.error calls
   remain logs-only because they have no trustworthy exception stack or
   identity to group.
4. Skip messages whose first arg is a string starting with "Hexclave" (the
   SDK's own warnings must never report themselves). Additionally expose
   runWithoutConsoleCapture(fn) — sets the shared suppression flag around fn —
   as the SDK-internal diagnostics escape hatch.
5. Re-entrancy guard: the logger's own console use must not loop (same shared
   suppression flag).
6. Per-LEVEL token bucket (burst 100, refill 10/s) so a runaway info/log loop
   can never starve error capture. When a bucket first runs dry, emit exactly
   one $log (level warn, data { console_level, rate_limited: true }) saying
   mirrors are being dropped; stay silent until the bucket refills. Explicit
   app.logger.* calls are NEVER rate limited. Refill elapsed time uses a
   monotonic clock, never wall-clock time.
7. Uninstall restores a method only when it is still the SDK's patch.

Browser logger calls do not depend on the lazily-loaded EventTracker. The
managed OTel provider is installed when the analytics facade is constructed;
its official BatchLogRecordProcessor owns the bounded pre-export queue. Before
authentication changes, both trace and log processors force-flush. If that
flush fails, retire both providers before installing replacements so buffered
signals can never cross users.


## startSpan(spanType, options?) / the Span handle

StartSpanOptions: TrackOptions & { data?, startedAtMs?, links? }
  = { data?, startedAtMs?, parent?, root?, links? }
(server-side additionally userId?).

Behavior:
- Validate spanType/data/startedAtMs; invalid input THROWS synchronously with
  the same messages in every environment.
- Start one real span from the active OTel Tracer. The provider owns identity,
  parentage, sampling, processors, and export. Like standard OTel, an unended
  span is not exported as a fabricated open-row update.
- `setData(data)` shallow-merges validated data into the namespaced
  `hexclave.data` attribute. `end(options?)` is idempotent; `endedAtMs` must be
  an integer at or after the start.
- Handle members: traceId, spanId, spanType, isEnded, setData, end, trackEvent,
  startSpan, withSpan, run, spanContext(), getSpanPropagationHeaders(), fetch().
  spanContext() returns the serializable { traceId, spanId } identity — the one
  currency of span identity across every tier and boundary. It survives JSON
  (page props, headers, a job payload), and unlike a bare span id it is globally
  meaningful, because a span id only identifies a span WITHIN its trace. That is
  exactly why there is no bare-string ParentRef.

Inert spans (environment unavailability, NOT invalid input): when a CLIENT app
is used where telemetry cannot exist at all — e.g. server-side rendering /
non-browser — startSpan returns an INERT span instead of throwing, so
isomorphic code needs no environment branches:
- Input validation still throws exactly like the real path (malformed data,
  endedAtMs before start, setData after end, invalid child input).
- Lifecycle methods resolve immediately and never emit a row; trackEvent on
  the inert handle RESOLVES (knowingly dropped); spanContext() returns the
  { traceId, spanId } the span would have had; getSpanPropagationHeaders()
  returns {}; fetch() passes through to global fetch.
(Note: app.trackEvent in the same environment REJECTS instead — an event has
no handle to be inert through.)

## withSpan(spanType, optionsOrFn, fn?)

Starts the span, runs fn with the span as an ambient parent for everything
created inside (AsyncLocalStorage-exact on servers; synchronous-window-only in
browsers), ends it when fn settles. On throw: setData({ error: message }) then
end, then rethrow. Telemetry acks never block fn's result.

## setGlobalSpan(span) / clearGlobalSpan(span)

Registers/unregisters a span as an ambient parent for all subsequently tracked
items. Ending a span auto-unregisters it. Ambient contexts are ordered
OUTERMOST-FIRST; a span has exactly one parent, so the resolver takes the LAST
(innermost) one as the parent rather than merging them (see below).

## Parent resolution

  SpanContext = { traceId: string, spanId: string }
  ParentRef   = SpanContext | Span

There is deliberately NO bare-string ParentRef: a span id alone does not
identify a span, because span ids are only unique within a trace. Anything you
can hand the SDK as a parent therefore carries its trace id with it.

  resolveSpanParent({ explicit?, ambient?, links?, root? })
    -> { traceId, parentSpanId: string | null, links: SpanContext[] }
     | { error }

Resolution order:
1. `explicit` (the `parent` option) wins outright — a span has one parent, so an
   explicit parent is never merged with, or reconciled against, the enclosing
   scope. It is normalized via `spanContext()` when it is a live handle.
2. Otherwise, if `root` is not true, the LAST entry of `ambient` (the innermost
   enclosing withSpan frame / most recently registered global span) is the
   parent.
3. Otherwise there is no parent: mint a FRESH trace id and set
   `parentSpanId = null`. This is what `root: true` means, and W3C strengthens
   it — it is a genuinely new trace, not a subtree that merely forgot its
   ancestors.

The chosen parent's `traceId` becomes the new span's `traceId`; children always
live in their parent's trace.

`links` are non-hierarchical references: causally related spans that are NOT
this span's parent. Ambient contexts that belong to a DIFFERENT trace than the
chosen parent are automatically demoted to links rather than being dropped or
forced into a false parent relationship. This is the honest home for the case a
single-path model had to reject outright — a span joining two flows (a queued
message consumed inside an unrelated request, a batch job triggered by several
users' actions) records the extra flows as links and keeps exactly one parent.
Deduplicate by (traceId, spanId) and reject more than 32 links. The owner trace's
sampling decision governs whether link rows persist; linked traces are sampled
independently and a link never promotes either trace.

Any malformed context (bad hex shape, all-zero id, `parentSpanId === spanId`)
returns `{ error }` with a message naming the role ("parent", "ambient parent",
"link") — never a silently corrected id.


## Cross-tier propagation (`traceparent`, `tracestate`, and `baggage`)

Three standard headers with strictly separated jobs:

- `traceparent` (W3C standard) is the ONE hierarchy carrier. It, and only it,
  tells the receiver which trace to join and which span to nest under.
- `tracestate` carries opaque vendor-specific trace state and sampling hints.
  Preserve and forward it through the official propagator without interpreting
  it as Hexclave product metadata.
- `baggage` carries only NON-HIERARCHICAL correlation that W3C
  has no field for.

Splitting them this way is what buys interop: the hierarchy travels in the
standard header every OTel-compatible service and collector already understands,
so a Hexclave-instrumented frontend and a non-Hexclave backend (or vice versa)
still end up in one trace, and Hexclave's own extras degrade to a header the
other side simply ignores.

### traceparent

Value: "00-<32hex traceId>-<16hex spanId>-<flags>" for the active OTel context,
normally the OTel HTTP client span opened for this request. The official W3C
propagator serializes the provider's real trace flags and `tracestate`; the SDK
must not recalculate or overwrite the provider's sampling decision.

An explicitly caller-set `traceparent` is never overwritten.

### baggage

Header name: `baggage` (W3C standard). Use the OpenTelemetry W3C baggage
propagator for parsing, validation, escaping, merging, and serialization.

Hexclave owns only these namespaced entries:

- `hexclave.session_replay.id`: replay UUID
- `hexclave.session_replay.segment.id`: replay-segment UUID
- `hexclave.page_view.span_id`: 16-hex W3C span id for page correlation

Nothing in baggage is ancestry or tenant identity. The receiver stamps valid
allowlisted values onto spans as attributes/correlation columns. It preserves
unrelated vendors' baggage when injecting and ignores malformed Hexclave
entries without rejecting the request.

Never propagate `projectId` in baggage. Project/branch authorization and
billing come exclusively from authenticated credentials. Any baggage value is
client-controlled and may be used only for telemetry correlation, never for
authorization, billing, or security decisions.

Managed browser mode registers the official OTel fetch and XMLHttpRequest
instrumentations with the managed WebTracerProvider. Existing-provider mode
does not patch globals; the host application owns its instrumentations.

`traceparent` rides when instrumentation opened a sampled HTTP client span
and the origin policy below allows it. The provider's trace flags are the sole
sampling authority. Correlation baggage may still ride without `traceparent`.

Attach `baggage` when ALL of:
- spanPropagation.enabled !== false and there is at least one allowlisted
  Hexclave correlation value to say;
- target is http(s) and same-origin OR in the propagation origin policy: the
  union of spanPropagation.allowedOrigins and (unless useTrustedDomains is
  false) the trusted-domain-derived origins, all exact origin matches — plus
  localhost/loopback targets (any port) when the project allows localhost;
- the request is not mode: "no-cors" (fetch);
- for fetch, merge Hexclave's namespaced entries into caller baggage while
  preserving unrelated entries; XHR cannot replace a previously appended
  header, so caller-set baggage remains untouched there;
- across ALL registered providers there is exactly ONE candidate header value
  (ambiguous multi-project same-origin requests fail closed).

All propagation header values go through the same gate: the origin policy above (they leak
information about the caller, so neither escapes it) AND the single-candidate
rule. Two registered providers wanting to attach different traces means the
request goes out with NEITHER header — fail closed rather than join an arbitrary
trace.

### Manual propagation

app.getSpanPropagationHeaders(options?: { parent?, root? }) [client]
  Returns the propagation headers — `traceparent`/`tracestate` for the resolved span plus
  `baggage` — carrying the same context an item tracked right
  now would get, or {} when there is nothing to propagate. For transports the
  SDK cannot instrument (sendBeacon, WebSocket handshakes, manually-built
  requests).

span.getSpanPropagationHeaders()
  Same, but pinned to exactly this span. For a sampled trace, `traceparent`
  names this span's { traceId, spanId }, so the receiving backend span becomes
  its direct child with no ambient-context ambiguity. A non-sampled context is
  not rewritten as sampled; correlation baggage remains independent.

span.fetch(input, init?)
  fetch with the propagation headers pinned to this span. Browser: follows the
  same same-origin/allowedOrigins policy as automatic instrumentation and never
  overwrites explicitly-set headers. SERVER: fails closed — there is no
  self-origin, so no headers are attached; use getSpanPropagationHeaders()
  explicitly for trusted targets.


## HTTP client spans (network capture)

Use `@opentelemetry/instrumentation-fetch` and
`@opentelemetry/instrumentation-xml-http-request` in managed browsers and
`@opentelemetry/instrumentation-undici` in managed Node runtimes. These official
instrumentations own span naming, semantic HTTP attributes, lifecycle, status,
errors, and W3C propagation. Hexclave supplies only URL/privacy policy hooks and
the authenticated exporter.

Sampling:
- Each request is a real OTel client span. The configured parent-aware OTel
  sampler makes the trace decision and the official exporter serializes it.
- HTTP client metrics (`hexclave.http.client.request.count` /
  `hexclave.http.client.request.duration`) are recorded by
  `createHexclaveHttpMetricSpanProcessor` from those same recorded CLIENT
  spans. A head-dropped request produces neither a span nor a metric.
- A recorded sampled request propagates its own standard W3C context. There is
  no deferred custom-row mode: failure/latency retention requires backend tail
  sampling because those facts do not exist at span start.
- Export requests are excluded to prevent recursive telemetry.


## $error LogRecords (global error capture)

Errors are instants → OTel LogRecords, never spans. Emit `eventName = "$error"`,
standard ERROR severity, the message as body, `hexclave.signal.type = "error"`,
and the structured payload in `hexclave.data`. A failure inside a span interval
also sets the span's standard error status/exception event. Structured error
data shared by all capture paths:

  {
    message,                    // truncated to 8,192 UTF-8 bytes
    name,
    stack?,                     // raw stack string, truncated to 8,192 bytes;
                                // no client-side frame parsing/sourcemapping
    mechanism_type,             // automatic captures:
                                //   "global.onerror" | "global.unhandledrejection"
                                //   | "node.uncaughtexception" | "next.onRequestError"
                                // manual/promoted captures:
                                //   "captured.exception" (captureException default)
                                //   | "captured.message" (captureMessage default)
                                //   | "captured.event" (captureEvent default)
                                //   | "console.error" (console.error promotion)
                                //   | caller-supplied `mechanism` override
    handled: false,
    synthetic?: 1,              // non-Error throw / synthesized message
    fingerprint,                // hex of djb2-xor over
                                // `${name}\n${message}\n${firstStackLine}`
                                // computed from the TRUNCATED values
    release?, environment?,     // from ObservabilityOptions
    sdk_version,
    // client extras: url (origin + pathname only; query/hash stripped), path,
    //   filename?, lineno?, colno?
    // next.onRequestError extras: path?, method?, router_kind?, route_path?,
    //   route_type?, digest?
  }

Client capture (browser; observability.enabled and errorCapture.enabled):
- Patch the window.onerror and window.onunhandledrejection PROPERTY slots
  (never addEventListener): chain to any previous handler and forward its
  return value; restore on uninstall only if the slot is still ours.
- Rejection reason extraction: primitive event IS the reason, else .reason,
  else .detail.reason. Primitive reasons become a synthetic Error
  ("Non-Error promise rejection captured with value: ...").
- Non-Error objects: message "Object captured as exception with keys: ...",
  synthetic, capture-site stack. Primitives stay stackless.
- Raise Error.stackTraceLimit to 50 if lower (restore on uninstall).
- Drop when message CONTAINS any ignoreErrors substring (defaults included).
- Dedupe: a non-enumerable captured-marker on the error object, plus a
  single-slot last-captured signature check.
- Flood control per $page-view: max 10 per fingerprint, 100 total; warn once
  when capping. Reset the caps when the current $page-view span id changes.
- Capture failures must never recurse through the patched handlers (ignore-
  next counter + re-entrancy flag).

Server capture:
- process.on("uncaughtExceptionMonitor") ONLY — observation-only; never a
  plain uncaughtException listener (that would change Node's crash semantics).
  Replace-keyed per project on globalThis (HMR). Delivery is best-effort (the
  process may exit before the flush lands).
- Installed EAGERLY at server-app construction (plus redundantly on the first
  { request }-scoped telemetry call and by hexclaveInstrumentation().register()
  — all idempotent). Construction happens in customer module scope, after
  frameworks have applied their own fetch patches at runtime startup.

The authenticated OTLP Logs receiver preserves the complete canonical record,
then derives the existing error/issue columns server-side. The exact marker is
required before interpreting `hexclave.data`; vanilla OTel errors remain
ordinary logs. Grouping, deterministic occurrence/batch identity, the issue
materialization ledger, and reconciliation retain the released behavior.

### Public manual capture and scopes

Every client and server app exposes framework-neutral manual error capture. The
methods return the event identity immediately; the identity is 32 lowercase
hexadecimal characters and is also emitted as `hexclave.event.id` in the OTel
record:

  captureException(error, options?): ErrorEventId
  captureMessage(message, options?): ErrorEventId
  captureEvent(event): ErrorEventId
  lastEventId(): ErrorEventId | undefined

`captureException` accepts an arbitrary thrown value and optional `handled` and
`mechanism` fields (default `mechanism_type` "captured.exception").
`captureMessage` rejects an empty message and defaults `mechanism_type` to
"captured.message". `captureEvent` accepts a normalized message or exception
chain with optional stack frames, platform, release, and environment fields,
and defaults `mechanism_type` to "captured.event". A caller-supplied `mechanism`
string overrides the default on any path. console.error promotion (client and
server) emits `mechanism_type = "console.error"` with `handled: true` while the
original `$log` row is retained. All three paths preserve the current bounded
`$error` projection while retaining the normalized exception chain under
`exception` when one is supplied.

`withErrorScope(fn)` creates an isolated scope inherited from the current
scope, passes it to `fn`, and restores the parent scope even when `fn` throws.
Scope fields are user, tags, contexts, extras, breadcrumbs, level, attachments,
a fingerprint override, and event processors. Tags/contexts/extras are merged by
key; the most recent level/fingerprint/user wins; breadcrumbs are kept in
insertion order and bounded to the most recent 100 entries. Empty scope keys
are rejected. Processors run before the configured `beforeSend`, may replace or
drop an event, cannot change its event ID, and are bounded to 20 callbacks and
250ms per capture. Processor failures and timeouts drop the event with an
audit-safe diagnostic rather than re-emitting it recursively.
Automatic browser/server captures snapshot the active scope. Async framework
integrations use the host OTel context manager or the SDK's server async-local
fallback; the synchronous fallback is restored at the end of the synchronous
callback and is not used as a process-global async scope.

Attachments follow the Sentry scope/envelope boundary without making binary
data part of the OTel `$error` record. An attachment is bounded to 2 MiB and
has a filename, optional media/attachment type, and optional occurrence and
idempotency keys. Processors inspect the attachment list through
`ErrorEventHint.attachments`. The default browser transport calls the existing
authenticated `/analytics/attachments` request path; an injected
`ErrorAttachmentTransport` can target another compatible receiver. Failed or
unconfigured uploads are surfaced through `PendingErrorAttachment` and
`onAttachmentPending`, and a capture with neither delivery seam fails loudly.

When `automaticSideEffects` is false, app construction does not install
automatic global handlers or instrumentation, but explicit manual capture
remains available and initializes only the delivery facade it needs. `flush()`
waits for queued server manual captures before force-flushing managed OTel
providers.

### v1 error envelope normalization (shared wire contract)

Manual captures and ingest-side projections share one normalizer (the
`error-envelope` module in the shared package) so client capture and server
scrubbing cannot drift. Every normalized envelope carries stable markers:

    schema: "hexclave.error-envelope"
    version: 1

and a `kind` of `"exception" | "message" | "event"` plus a `level` of
`"fatal" | "error" | "warning" | "info" | "debug" | "log"`.

Normalization limits (defaults; callers may pass stricter overrides):

    maxDepth: 8                  maxEventBytes: 256 * 1024 (256 KiB)
    maxStringBytes: 8 * 1024     maxExceptionValues: 10
    maxFrames: 50                maxBreadcrumbs: 100
    maxTags: 100                 maxContexts: 50
    maxExtraFields: 100          maxAttachmentItems: 20
    maxDebugImages: 20           maxCollectionEntries: 100

Strings are truncated on UTF-8 byte boundaries (never mid-codepoint) to
`maxStringBytes`; keys are additionally bounded to 256 bytes. Oversized
collections keep the first N entries.

Sensitive-key redaction replaces values whose key matches either regex with an
empty object:

    /^(authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|credential|signature|body|query|search|raw[-_]?body)$/i
    /(^|[-_.])(authorization|cookie|token|secret|password|credential)([-_.]|$)/i

(the second catches embedded occurrences like `headers.authorization` or
`user.password_hash`). Request URLs are reduced to `origin + pathname`
(query/hash stripped).

Every value that is dropped or truncated records a reason into the
normalization state; the envelope then reports `normalization.truncated`
(whether anything was cut) and `normalization.dropped`: all reasons sorted,
deduplicated, capped at 32 entries with the 32nd replaced by `"more-drops"`.
Reason strings are dotted paths plus a cause suffix — e.g. `<path>.string`,
`<path>.depth`, `<path>.cycle`, `<path>.items`, `<path>.fields`,
`<path>.key`, `<path>.frames`, `<path>.values`, `request.url.string`,
`tags.fields`, `tags.key`, `breadcrumbs.items`, `attachments.items`,
`debug_meta.images`, `event.exception.values`, `event.exception.stacktrace`.

Deterministic fallback identity: when an input has no valid event ID (32
lowercase hex characters; dashes are stripped before matching), the ID is
derived as four concatenations of an FNV-1a-style 32-bit hash over the stable
serialization of the input — `hash = (2166136261 ^ seed) >>> 0`, then per code
point `hash ^= codePoint; hash = Math.imul(hash, 16777619) >>> 0` — for seeds
0..3, each rendered as zero-padded 8-character lowercase hex (32 chars total).
This is an identity function, not a security hash.

## Server request linking (withSpan({ request }) etc.)

Passing `request` (anything whose .headers has a get(name) method or is a
plain string-valued record) to server trackEvent/withSpan:

1. Resolve the caller's session from the request's auth tokens (TRUSTED):
   refresh_token_id + user_id. userId is derived from the session unless
   explicitly overridden. refresh_token_id is also the identity from which an
   authenticated browser trace's root W3C context is derived.
2. Parse the incoming `traceparent` (UNTRUSTED, but this is the only hierarchy
   input). Accept any valid sampled context; it does not require Hexclave
   baggage. Its trace id becomes the scope's trace and its span id the immediate
   parent. Without a valid sampled context, mint a fresh root.
3. Decode the baggage header (UNTRUSTED labels): session
   replay/segment ids and pageViewSpanId, all stamped as scalar correlation
   columns. Baggage contributes no ancestry or tenant identity.
4. Run the callback inside the configured OTel ContextManager scope;
   everything created inside (spans, events, logs, outbound-fetch spans)
   inherits the trace id and nests under the scope's root span.

Because the hierarchy arrives as a single (trace id, parent span id) pair, there
is no per-item ancestry decision to make: only the scope's root span uses the
incoming span id as its parent, and everything deeper parents to its own
enclosing span in the ordinary way.

Server outbound fetch uses the official Undici instrumentation registered with
the managed provider. Its privacy hook instruments and propagates only to the
configured origin policy; W3C propagation names the new client span on each hop.
`span.fetch` remains an explicit facade convenience and follows the same policy.

Server delivery coalesces at most 400 items per batch and permits at most 32
batch requests in flight per app instance. When the collector is slow or
unavailable, a batch beyond that limit is dropped: its returned telemetry
promises reject and one warning is emitted for the overload episode. Delivery
must never open unbounded sockets or queue unbounded payloads in the host
application. Every collector delivery runs inside OTel's standard
telemetry-suppression context. Consequently the
Next/undici spans opened by the collector POST neither inherit the request being
exported nor emit another batch; runtimes where the bridge backed off still
send normally.

### Ambient request provider (zero-threading attribution)

A framework integration may register ONE ambient request provider per app
(replace semantics) via the internal instrumentation seam:
setAmbientRequestProvider(async () => RequestLike | null). Returning null
means "not inside a request scope" — a normal state, never an error.

With a provider registered, server trackEvent / withSpan / logger calls made
WITHOUT an explicit `request`, and OUTSIDE any existing { request } ALS scope,
resolve the ambient request and behave exactly as if `{ request }` had been
passed (session resolution, header decode, ALS scope). Rules:
- An existing ambient ALS scope always wins — nested calls never re-resolve.
- startSpan stays synchronous and never consults the provider.
- Failures degrade: a throwing provider or failing session resolution warns
  ONCE per app instance and falls back to context-free telemetry — a bare
  call must never fail harder than it did before ambient attribution existed.
- Next.js registers a next/headers-based provider in
  hexclaveInstrumentation().register(); the RequestLike wrapper is memoized
  per Headers instance so repeated bare calls in one request reuse the app's
  per-request-object session memoization (one token round-trip per request).


## Official OpenTelemetry SDK integration (server)

The server SDK never implements the OpenTelemetry API itself. In managed mode
it installs the official NodeTracerProvider and LoggerProvider, an
AsyncLocalStorageContextManager, the W3C trace-context+baggage propagators,
parent-aware sampling, BatchSpanProcessor/BatchLogRecordProcessor, and the
official OTLP/HTTP JSON exporters. Trace/span identity, async context,
sampling, resources, scopes, events, links, severity, and serialization remain
owned by OpenTelemetry.

Registration is synchronous and process-global. It is idempotent only for the
same project/resource/config signature. Any conflicting tracer, context,
propagator, or logger provider throws an actionable setup error; never silently
back off or install a partial provider. Shutdown disables instrumentations and
shuts down both providers. forceFlush flushes both signal pipelines.

In `existing-provider` mode Hexclave registers no globals. Applications add
`createHexclaveOtlpTraceExporter`, `createHexclaveOtlpLogExporter`, and
`createHexclaveOtlpMetricExporter`, plus
`createHexclaveCorrelationSpanProcessor` and
`createHexclaveHttpMetricSpanProcessor` from the Node-only `/otel` entrypoint
to their own official providers. Existing-provider applications own
registration, instrumentation, sampling, flush, and shutdown. Browser
existing-provider integrations use the `/otel/browser` exporters, whose async
header factories resolve fresh credentials for every export.

Hexclave custom spans are thin facades over the active OTel tracer. Library and
framework instrumentations are normal typed `Instrumentation[]` registered
against the official provider. Collector requests run in OTel's standard
suppressed-tracing Context so HTTP instrumentation cannot recursively export
the exporter request.

The managed browser registration follows the same ownership model with
WebTracerProvider, LoggerProvider, StackContextManager, and official OTLP
exporters. Authentication rotation force-flushes both processors before token
replacement. If that flush fails, both providers are shut down and replaced
before the new identity becomes active, preventing queued spans or logs from
crossing users.

## Framework integrations

All adapters share one factory shape: createHexclaveX(app, factoryOptions?) —
tRPC (createHexclaveTRPC), oRPC (createHexclaveORPC), Next.js
(createHexclaveNext), TanStack Start (createHexclaveTanStackStart), Elysia
(createHexclaveElysia), Convex (createHexclaveConvex). Common contracts:

- factoryOptions.unauthorized: default rejection factory for every wrapped
  surface; a per-handler/per-route `unauthorized` option always wins. HTTP
  response surfaces send a returned Response; throwing surfaces throw the
  returned Error.
- telemetry option everywhere spans are created:
  bool | { spanType?, data? }; false disables the span but still resolves the
  user and enforces `required`.
- Every wrapped handler receives BOTH `user` (the resolved caller or null) and
  `hexclave` (the per-request context: { request, getUser() } for HTTP
  adapters; { getUser() } for Convex). User resolution is lazy and memoized
  per request.
- HTTP adapters wrap handlers in withSpan(type, { request }, ...) with
  low-cardinality span types (next.route, next.server-action,
  tanstack-start.server-function, tanstack-start.route, trpc.procedure,
  orpc.procedure, elysia.route, convex.function); variable bits (path, method,
  name, kind) go in span data.

Next.js specifics (`@hexclave/next` only):
- createHexclaveNext(app, factoryOptions?) → { routeHandler, serverAction }.
- hexclaveInstrumentation(app, options?) →
  { register, onRequestError, runWithTelemetrySuppressed } for
  the customer's instrumentation.ts; options = { instrumentations?:
  Instrumentation[], requestAttribution?: boolean,
  isTelemetrySuppressed?: () => boolean }.
  requestAttribution defaults true; false is for control planes whose incoming
  customer requests must not be resolved against a separate internal telemetry
  project. isTelemetrySuppressed is an advanced collector/control-plane hook:
  when it returns true, automatic SDK-native fetch, library, log, and error
  capture is suppressed alongside the runtime's instrumentations. register()
  is ASYNC. runWithTelemetrySuppressed(asyncCallback) is the stronger
  collector/control-plane boundary: it runs the callback inside OTel's
  suppressed-tracing async Context and suppresses SDK-native fetch,
  library, log, and error capture for its full async extent. It throws when
  called before managed OTel registration succeeds. Next awaits the
  async register(); it installs the managed OTel provider/instrumentations + the
  uncaught-exception monitor (both idempotent/HMR-safe;
  both also self-install at app construction), registers the next/headers
  ambient request provider (see "Ambient request provider") — after register(),
  bare trackEvent/withSpan/logger calls in route handlers, server actions, and
  RSCs attribute to the caller's session with no { request } threading — and
  registers the typed instrumentations against the official managed provider.
  onRequestError(error, request, context) reports a $error event
  (mechanism_type "next.onRequestError") linked to the caller's session via
  the request headers when requestAttribution is enabled, and records it
  without caller attribution otherwise; it must never throw (warn instead).
  Throw at SETUP time if `app` is not a real HexclaveServerApp instance.
- register()/onRequestError do NOT create per-route spans — Next.js has no
  hook wrapping a route's async extent; per-route spans require the wrappers.

Elysia specifics:
- createHexclaveElysia(app, factoryOptions?) → { plugin, resolveUser,
  requireUser, requireUserWith, handler }.
- plugin: `.use()`-able; spans EVERY route (including 404s) via global
  lifecycle hooks (onRequest → onAfterResponse/onError; requires Elysia >= 1.0
  `{ as: "global" }`). The span is materialized retroactively at the terminal
  hook with startedAtMs backdated to request receipt, and records
  { path, method, status, error? }. Because hooks cannot wrap the handler's
  async extent, telemetry created inside the handler does not ambiently nest
  under a plugin span — handler() remains the full-fidelity path, and the
  plugin detects handler()-wrapped requests and skips its own span.
- factoryOptions: { unauthorized?, telemetry? } (telemetry applies to the
  plugin's spans).

Convex specifics:
- createHexclaveConvex(app, factoryOptions?) → { function: (handler,
  options?) => convexHandler }. Handler receives { ctx, args, user, hexclave }.
  Options: { required?, kind?, name?, telemetry?, unauthorized? }.
- Convex functions receive no Request (WebSockets), so spans are attributed by
  userId only ({ userId } span link) — no session-segment nesting.
