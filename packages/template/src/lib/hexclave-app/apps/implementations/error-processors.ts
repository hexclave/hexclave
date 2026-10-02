import type {
  CapturedErrorEvent,
  ErrorBeforeSend,
  ErrorEventHint,
  ErrorEventProcessor,
  ErrorProcessorResult,
} from "../interfaces/error-capture";

/**
 * Maximum number of processors PER SOURCE (the configured app-level list and
 * the capture-scope list each get this budget; `beforeSend` never counts).
 * A combined budget would drop captures from perfectly legitimate setups —
 * e.g. a framework that accumulated the full scope allowance plus one
 * configured processor — even though each source obeys its own bound.
 */
export const MAX_ERROR_PROCESSORS = 20;

/** Total wall-clock budget for one capture's processor pipeline. */
export const MAX_ERROR_PROCESSING_TIME_MS = 250;

export type ErrorProcessingDropReason =
  | "event_processor"
  | "before_send"
  | "processor_failure"
  | "processor_timeout"
  | "processor_limit";

export type ErrorProcessingResult =
  | { status: "accepted", event: CapturedErrorEvent }
  | { status: "dropped", reason: ErrorProcessingDropReason, detail?: string };

export type ErrorProcessingFailure = {
  stage: "event_processor" | "before_send",
  reason: "processor_failure" | "processor_timeout" | "processor_limit",
  processorName: string,
  error?: unknown,
};

export type ErrorProcessingOptions = {
  /** App-level processors. These run before the capture scope's processors. */
  eventProcessors?: readonly ErrorEventProcessor[],
  /** Processors copied from the effective scope at capture time. */
  scopeProcessors?: readonly ErrorEventProcessor[],
  /** Final app-level privacy/filter hook. */
  beforeSend?: ErrorBeforeSend,
  hint: ErrorEventHint,
  onFailure?: (failure: ErrorProcessingFailure) => void,
};

type ProcessorStage = "event_processor" | "before_send";

type ProcessorStep = {
  stage: ProcessorStage,
  processor: ErrorEventProcessor,
};

type ProcessorDecision =
  | { kind: "continue", event: CapturedErrorEvent }
  | { kind: "drop", result: ErrorProcessingResult };

type ProcessorWaitResult =
  | { kind: "value", value: ErrorProcessorResult }
  | { kind: "error", error: unknown }
  | { kind: "timeout" };

const EVENT_ID_PATTERN = /^[0-9a-f]{32}$/;

function now(): number {
  return performance.now();
}

function isThenable<T>(value: unknown): value is PromiseLike<T> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof value.then === "function";
}

function isCapturedErrorEvent(value: unknown): value is CapturedErrorEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("event_id" in value)) return false;
  return typeof value.event_id === "string" && EVENT_ID_PATTERN.test(value.event_id);
}

function processorName(processor: ErrorEventProcessor): string {
  return processor.name === "" ? "anonymous" : processor.name;
}

function reportFailure(failure: ErrorProcessingFailure, onFailure: ErrorProcessingOptions["onFailure"]): void {
  if (onFailure !== undefined) {
    onFailure(failure);
    return;
  }
  console.warn(
    `Hexclave error processing ${failure.reason} in ${failure.stage} "${failure.processorName}"; the event was dropped`,
  );
}

function dropped(
  stage: ProcessorStage,
  detail?: string,
): ProcessorDecision {
  return {
    kind: "drop",
    result: {
      status: "dropped",
      reason: stage,
      ...detail === undefined ? {} : { detail },
    },
  };
}

function failure(
  stage: ProcessorStage,
  reason: "processor_failure" | "processor_timeout" | "processor_limit",
  processor: ErrorEventProcessor,
  error: unknown,
  onFailure: ErrorProcessingOptions["onFailure"],
): ProcessorDecision {
  const processorNameValue = processorName(processor);
  reportFailure({
    stage,
    reason,
    processorName: processorNameValue,
    error,
  }, onFailure);
  return {
    kind: "drop",
    result: {
      status: "dropped",
      reason,
      detail: processorNameValue,
    },
  };
}

function preserveEventId(event: CapturedErrorEvent, eventId: string): CapturedErrorEvent {
  return event.event_id === eventId ? event : { ...event, event_id: eventId };
}

function normalizeResult(
  value: unknown,
  stage: ProcessorStage,
  eventId: string,
  processor: ErrorEventProcessor,
  onFailure: ErrorProcessingOptions["onFailure"],
): ProcessorDecision {
  if (value === null) return dropped(stage);

  if (isCapturedErrorEvent(value)) {
    return { kind: "continue", event: preserveEventId(value, eventId) };
  }

  if (typeof value === "object" && "action" in value) {
    if (value.action === "drop") {
      const detail = "reason" in value && typeof value.reason === "string" ? value.reason : undefined;
      return dropped(stage, detail);
    }
    if (value.action === "replace" && "event" in value && isCapturedErrorEvent(value.event)) {
      return { kind: "continue", event: preserveEventId(value.event, eventId) };
    }
  }

  return failure(stage, "processor_failure", processor, new Error("processor returned an invalid decision"), onFailure);
}

function waitForProcessor(
  result: PromiseLike<ErrorProcessorResult>,
  timeoutMs: number,
): Promise<ProcessorWaitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "timeout" });
    }, Math.max(1, Math.ceil(timeoutMs)));

    Promise.resolve(result).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "value", value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "error", error });
      },
    );
  });
}

function invokeProcessor(
  step: ProcessorStep,
  event: CapturedErrorEvent,
  hint: ErrorEventHint,
  eventId: string,
  deadline: number,
  onFailure: ErrorProcessingOptions["onFailure"],
): ProcessorDecision | PromiseLike<ProcessorDecision> {
  const remaining = deadline - now();
  if (remaining <= 0) {
    return failure(step.stage, "processor_timeout", step.processor, new Error("processor time budget exceeded"), onFailure);
  }

  let result: ErrorProcessorResult | PromiseLike<ErrorProcessorResult>;
  try {
    result = step.processor({ ...event }, hint);
  } catch (error) {
    return failure(step.stage, "processor_failure", step.processor, error, onFailure);
  }

  if (!isThenable(result)) {
    if (now() > deadline) {
      return failure(step.stage, "processor_timeout", step.processor, new Error("processor time budget exceeded"), onFailure);
    }
    return normalizeResult(result, step.stage, eventId, step.processor, onFailure);
  }

  return waitForProcessor(result, remaining).then((waitResult) => {
    if (waitResult.kind === "timeout") {
      return failure(step.stage, "processor_timeout", step.processor, new Error("processor time budget exceeded"), onFailure);
    }
    if (waitResult.kind === "error") {
      return failure(step.stage, "processor_failure", step.processor, waitResult.error, onFailure);
    }
    return normalizeResult(waitResult.value, step.stage, eventId, step.processor, onFailure);
  });
}

/**
 * Runs the canonical SDK error pipeline. Configured processors run first,
 * capture-time scope processors run second, and `beforeSend` runs last.
 *
 * The function deliberately returns a typed outcome instead of throwing into a
 * capture handler: a user callback cannot make the SDK re-emit its own error,
 * and a rejected or over-budget callback cannot accidentally send the original
 * event without the caller's intended privacy/filter decision.
 */
export function processErrorEvent(
  event: CapturedErrorEvent,
  options: ErrorProcessingOptions,
): ErrorProcessingResult | PromiseLike<ErrorProcessingResult> {
  for (const [source, processors] of [
    ["configured", options.eventProcessors ?? []],
    ["scope", options.scopeProcessors ?? []],
  ] as const) {
    if (processors.length > MAX_ERROR_PROCESSORS) {
      const detail = `${source} pipeline has ${processors.length} processors; maximum is ${MAX_ERROR_PROCESSORS} per source`;
      reportFailure({
        stage: "event_processor",
        reason: "processor_limit",
        processorName: "pipeline",
        error: new Error(detail),
      }, options.onFailure);
      return { status: "dropped", reason: "processor_limit", detail };
    }
  }

  const steps: ProcessorStep[] = [
    ...(options.eventProcessors ?? []).map((processor) => ({ stage: "event_processor" as const, processor })),
    ...(options.scopeProcessors ?? []).map((processor) => ({ stage: "event_processor" as const, processor })),
    ...options.beforeSend === undefined ? [] : [{ stage: "before_send" as const, processor: options.beforeSend }],
  ];

  const deadline = now() + MAX_ERROR_PROCESSING_TIME_MS;
  const run = (index: number, current: CapturedErrorEvent): ErrorProcessingResult | PromiseLike<ErrorProcessingResult> => {
    if (index >= steps.length) return { status: "accepted", event: current };
    const step = steps[index];

    const decision = invokeProcessor(step, current, options.hint, event.event_id, deadline, options.onFailure);
    const continueProcessing = (next: ProcessorDecision): ErrorProcessingResult | PromiseLike<ErrorProcessingResult> => {
      if (next.kind === "drop") return next.result;
      return run(index + 1, next.event);
    };

    return isThenable(decision) ? decision.then(continueProcessing) : continueProcessing(decision);
  };

  return run(0, event);
}
