import { decodeCorrelationBaggage, readBaggageHeader } from "@hexclave/shared/dist/utils/span-context-codec";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { isSpanContextValid, ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { RandomIdGenerator } from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorage } from "node:async_hooks";
import { getClickhouseWriteAvailability, getSharedClickhouseAdminClient } from "./clickhouse";
import { insertSpans, type SpanInsertRow } from "./spans";
import { isTelemetryIngestionPath } from "./telemetry/ingestion-paths";

const idGenerator = new RandomIdGenerator();
const traceContextPropagator = new W3CTraceContextPropagator();

type CustomerRequestTenancy = {
  projectId: string,
  branchId: string,
  userId: string | null,
  refreshTokenId: string | null,
  sessionReplayId: string | null,
  sessionReplaySegmentId: string | null,
  pageViewSpanId: string | null,
  observabilityEnabled: boolean,
};

type CustomerRequestObservabilityHolder = {
  incomingTraceId: string | null,
  rootTraceId: string,
  spanId: string,
  incomingParentSpanId: string | null,
  startedAt: Date,
  method: string,
  tenancy: CustomerRequestTenancy | null,
};

export type VerifiedCustomerRequestLinkTarget = {
  traceId: string,
  spanId: string,
  projectId: string,
  branchId: string,
};

type CustomerRequestSpanWriter = (row: SpanInsertRow) => Promise<void>;

const customerRequestStorage = new AsyncLocalStorage<CustomerRequestObservabilityHolder>();

function mergeTrustedIdentity(
  current: CustomerRequestTenancy | null,
  incoming: Pick<CustomerRequestTenancy, "userId" | "refreshTokenId">,
): Pick<CustomerRequestTenancy, "userId" | "refreshTokenId"> {
  if (current === null) return incoming;

  const userConflict = current.userId !== null
    && incoming.userId !== null
    && current.userId !== incoming.userId;
  const refreshTokenConflict = current.refreshTokenId !== null
    && incoming.refreshTokenId !== null
    && current.refreshTokenId !== incoming.refreshTokenId;
  if (userConflict || refreshTokenConflict) {
    return {
      userId: current.userId,
      refreshTokenId: current.refreshTokenId,
    };
  }
  return {
    userId: current.userId ?? (
      current.refreshTokenId === null || incoming.refreshTokenId === current.refreshTokenId
        ? incoming.userId
        : null
    ),
    refreshTokenId: current.refreshTokenId ?? (
      current.userId === null || incoming.userId === current.userId
        ? incoming.refreshTokenId
        : null
    ),
  };
}

export function resolveCustomerRequestObservability(options: {
  projectId: string,
  branchId: string,
  userId: string | null,
  refreshTokenId: string | null,
  observabilityEnabled?: boolean,
  headers?: { get: (name: string) => string | null },
}): void {
  const holder = customerRequestStorage.getStore();
  if (holder === undefined) return;

  const current = holder.tenancy;
  if (current !== null && (current.projectId !== options.projectId || current.branchId !== options.branchId)) {
    throw new Error("Customer request observability tenancy changed within one request");
  }

  const labels = options.headers === undefined
    ? null
    : decodeCorrelationBaggage(readBaggageHeader(options.headers));
  const identity = mergeTrustedIdentity(current, {
    userId: options.userId,
    refreshTokenId: options.refreshTokenId,
  });

  holder.tenancy = {
    projectId: options.projectId,
    branchId: options.branchId,
    userId: identity.userId,
    refreshTokenId: identity.refreshTokenId,
    sessionReplayId: current?.sessionReplayId ?? labels?.sessionReplayId ?? null,
    sessionReplaySegmentId: current?.sessionReplaySegmentId ?? labels?.sessionReplaySegmentId ?? null,
    pageViewSpanId: current?.pageViewSpanId ?? labels?.pageViewSpanId ?? null,
    observabilityEnabled: current?.observabilityEnabled === true || options.observabilityEnabled === true,
  };
}

export function getVerifiedCustomerRequestLinkTarget(): VerifiedCustomerRequestLinkTarget | null {
  const holder = customerRequestStorage.getStore();
  if (
    holder === undefined
    || holder.tenancy === null
    || holder.incomingTraceId === null
    || holder.incomingParentSpanId === null
  ) return null;
  return {
    traceId: holder.incomingTraceId,
    spanId: holder.incomingParentSpanId,
    projectId: holder.tenancy.projectId,
    branchId: holder.tenancy.branchId,
  };
}

function buildCustomerRequestSpan(
  holder: CustomerRequestObservabilityHolder,
  tenancy: CustomerRequestTenancy,
  response: Response,
  endedAt: Date,
): SpanInsertRow {
  return {
    trace_id: holder.incomingParentSpanId !== null
      ? holder.incomingTraceId ?? throwErr("An incoming parent must carry an incoming trace id")
      : holder.rootTraceId,
    span_id: holder.spanId,
    parent_span_id: holder.incomingParentSpanId,
    span_type: "hexclave.api.request",
    billing_item: null,
    started_at: holder.startedAt,
    ended_at: endedAt,
    data: JSON.stringify({
      method: holder.method,
      status_code: response.status,
    }),
    kind: "server",
    status_code: response.status >= 400 ? "error" : "ok",
    status_message: null,
    service_namespace: null,
    service_name: "hexclave-backend",
    service_version: null,
    service_instance_id: null,
    deployment_environment_name: null,
    resource_attributes: "{}",
    scope_name: null,
    scope_version: null,
    producer: "hexclave-backend",
    project_id: tenancy.projectId,
    branch_id: tenancy.branchId,
    user_id: tenancy.userId,
    team_id: null,
    refresh_token_id: tenancy.refreshTokenId,
    session_replay_id: tenancy.sessionReplayId,
    session_replay_segment_id: tenancy.sessionReplaySegmentId,
    page_view_span_id: tenancy.pageViewSpanId,
    version: endedAt.getTime(),
  };
}

async function writeCustomerRequestSpan(row: SpanInsertRow): Promise<void> {
  if (getClickhouseWriteAvailability() === "absent") return;
  await insertSpans(getSharedClickhouseAdminClient(), [row]);
}

export async function runWithCustomerRequestObservability(
  request: Request,
  fn: () => Promise<Response>,
  writer: CustomerRequestSpanWriter = writeCustomerRequestSpan,
): Promise<Response> {
  if (isTelemetryIngestionPath(new URL(request.url).pathname)) return await fn();

  const extractedContext = traceContextPropagator.extract(ROOT_CONTEXT, request.headers, {
    keys: () => ["traceparent", "tracestate"],
    get: (carrier, key) => carrier.get(key) ?? undefined,
  });
  const extractedSpanContext = trace.getSpanContext(extractedContext);
  const incomingParent = extractedSpanContext !== undefined
    && isSpanContextValid(extractedSpanContext)
    && (extractedSpanContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED
    ? extractedSpanContext
    : null;
  const holder: CustomerRequestObservabilityHolder = {
    incomingTraceId: incomingParent?.traceId ?? null,
    rootTraceId: idGenerator.generateTraceId(),
    spanId: idGenerator.generateSpanId(),
    incomingParentSpanId: incomingParent?.spanId ?? null,
    startedAt: new Date(),
    method: request.method,
    tenancy: null,
  };

  return await customerRequestStorage.run(holder, async () => {
    const response = await fn();
    const tenancy = holder.tenancy;
    if (tenancy !== null && tenancy.projectId !== "internal" && tenancy.observabilityEnabled) {
      const row = buildCustomerRequestSpan(holder, tenancy, response, new Date());
      runAsynchronously(writer(row));
    }
    return response;
  });
}
