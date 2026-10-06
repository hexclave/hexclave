"use client";

import { useStackApp } from "@hexclave/next";
import { Button, Card, CardContent, CardHeader, Input, Tabs, TabsContent, TabsList, TabsTrigger, Typography } from "@hexclave/ui";
import { useState, type ReactNode } from "react";
import { deliverErrorCapture } from "./error-capture-delivery";
import {
  OBSERVABILITY_DEMO_BUNDLE_PATH,
  OBSERVABILITY_DEMO_CODE_FILE,
  OBSERVABILITY_DEMO_ERROR_MESSAGE,
  OBSERVABILITY_DEMO_RELEASE,
  OBSERVABILITY_DEMO_THROWER_GLOBAL_KEY,
} from "../../observability-lab-contract";

type ActivityKind = "event" | "log" | "span" | "error" | "network" | "autocapture" | "flush";
type ActionKey = "event" | "span" | "error" | "network" | "framework-error" | "flush" | "prepare";
type DemoLogLevel = "trace" | "debug" | "info" | "warn" | "error";

type ActivityRecord = {
  id: string,
  kind: ActivityKind,
  title: string,
  detail: string,
  recordedAt: string,
};

type CaptureRecord = {
  eventId: string,
  label: string,
  detail: string,
  recordedAt: string,
};

type PendingCaptureRecord = Omit<CaptureRecord, "recordedAt">;

type ServerTelemetryResult = {
  status: number,
  ok: boolean,
  traceId: string | null,
  spanId: string | null,
  body: string,
};

type PreparedLabState = {
  release: string,
  releaseId: string,
  debugId: string,
  codeFile: string,
  sourceMaps: string,
};

type FrameworkErrorResult = {
  status: number,
  body: string,
};

const MAX_ACTIVITY_RECORDS = 24;
const MAX_CAPTURE_RECORDS = 12;
const DEMO_ERROR_USER = { id: "demo-user-001", username: "observability-tester" };
const DEMO_LOG_LEVELS: DemoLogLevel[] = ["trace", "debug", "info", "warn", "error"];
const LAB_SECTIONS = [
  { id: "events", label: "Events" },
  { id: "logs", label: "Logs" },
  { id: "traces", label: "Traces" },
  { id: "errors", label: "Errors" },
  { id: "network", label: "Network" },
  { id: "browser", label: "Browser" },
] as const;
const DASHBOARD_LINKS = [
  ["Observability overview", "/observability"],
  ["Issues + grouping", "/observability/issues"],
  ["Issue alerts + deliveries", "/observability/issues/alerts"],
  ["Releases", "/observability/releases"],
  ["Source maps", "/observability/source-maps"],
  ["Logs", "/observability/logs"],
  ["Traces", "/observability/traces"],
  ["Performance", "/observability/performance"],
  ["Services", "/observability/services"],
  ["Session replays", "/session-replays"],
  ["Analytics events", "/analytics/events"],
] as const;

function getActivityColor(kind: ActivityKind): string {
  switch (kind) {
    case "event": {
      return "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200";
    }
    case "log": {
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
    }
    case "span": {
      return "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200";
    }
    case "error": {
      return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200";
    }
    case "network": {
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
    }
    case "autocapture": {
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200";
    }
    case "flush": {
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200";
    }
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Unexpected failure: ${String(error)}`;
}

function readStringProperty(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const property = value[key];
  return typeof property === "string" ? property : null;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function dashboardHostForPrefix(prefix: string | undefined): string {
  if (prefix === "91") return "a.localhost";
  if (prefix === "92") return "b.localhost";
  if (prefix === "93") return "c.localhost";
  return "localhost";
}

export default function ObservabilityPage() {
  const app = useStackApp();
  const [activity, setActivity] = useState<ActivityRecord[]>([]);
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [busy, setBusy] = useState<ActionKey | null>(null);
  const [lastActionError, setLastActionError] = useState<string | null>(null);
  const [lastEventId, setLastEventId] = useState<string | undefined>();
  const [eventType, setEventType] = useState("demo.checkout.completed");
  const [eventValue, setEventValue] = useState("49.99");
  const [eventAsRoot, setEventAsRoot] = useState(false);
  const [traceAsRoot, setTraceAsRoot] = useState(false);
  const [propagationHeaders, setPropagationHeaders] = useState<Record<string, string>>({});
  const [serverResult, setServerResult] = useState<ServerTelemetryResult | null>(null);
  const [frameworkErrorResult, setFrameworkErrorResult] = useState<FrameworkErrorResult | null>(null);
  const [preparedLab, setPreparedLab] = useState<PreparedLabState | null>(null);
  const [interactionCount, setInteractionCount] = useState(0);
  const [aliveClickCount, setAliveClickCount] = useState(0);
  const [formSubmissionCount, setFormSubmissionCount] = useState(0);
  const [syntheticRoute, setSyntheticRoute] = useState("initial");
  const [keyboardSandboxValue, setKeyboardSandboxValue] = useState("");

  const projectPath = `/projects/${encodeURIComponent(app.projectId)}`;
  const dashboardPort = process.env.NEXT_PUBLIC_HEXCLAVE_LOCAL_DASHBOARD_PORT
    ?? `${process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX ?? "81"}01`;
  const dashboardBaseUrl = `http://${dashboardHostForPrefix(process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX)}:${dashboardPort}`;

  const addActivity = (kind: ActivityKind, title: string, detail: string) => {
    setActivity((current) => [{
      id: crypto.randomUUID(),
      kind,
      title,
      detail,
      recordedAt: new Date().toLocaleTimeString(),
    }, ...current].slice(0, MAX_ACTIVITY_RECORDS));
  };

  const addCapture = (label: string, eventId: string, detail: string) => {
    setLastEventId(eventId);
    setCaptures((current) => [{
      eventId,
      label,
      detail,
      recordedAt: new Date().toLocaleTimeString(),
    }, ...current].slice(0, MAX_CAPTURE_RECORDS));
    addActivity("error", label, `event_id=${eventId}\n${detail}`);
  };

  const runAction = async (key: ActionKey, action: () => Promise<void>): Promise<void> => {
    if (busy !== null) return;
    setBusy(key);
    setLastActionError(null);
    try {
      await action();
    } catch (error) {
      const message = getErrorMessage(error);
      setLastActionError(message);
      addActivity("error", `${key} action failed`, message);
    } finally {
      setBusy(null);
    }
  };

  const emitEvent = async () => {
    await runAction("event", async () => {
      const options = eventAsRoot ? { root: true } : undefined;
      await app.trackEvent(eventType, {
        order_id: "demo-order-001",
        value: eventValue,
        currency: "USD",
        source: "observability-lab",
      }, options);
      addActivity("event", `Tracked ${eventType}`, formatJson({
        order_id: "demo-order-001",
        value: eventValue,
        root: eventAsRoot,
      }));
    });
  };

  const emitStructuredLog = (level: DemoLogLevel) => {
    app.logger[level](`demo ${level} log`, {
      route: "observability-lab",
      request_id: "demo-request-001",
      redaction_fixture: {
        token: "demo-value",
        visible_value: "safe-to-display",
      },
    });
    addActivity("log", `Logger.${level} emitted`, "Structured data includes a redaction fixture and a request id.");
  };

  const emitConsoleMirror = () => {
    console.warn("Hexclave observability demo console mirror", {
      authorization: "demo-value",
      visible_value: "safe-to-display",
    });
    console.error(new Error("Hexclave observability demo console exception"), {
      session_id: "demo-value",
      route: "/error-tracking-demo",
    });
    addActivity("log", "Console mirror emitted", "console.warn becomes a log; console.error(Error) becomes a log plus an issue occurrence.");
  };

  const runNestedTrace = async () => {
    await runAction("span", async () => {
      let traceId = "";
      await app.withSpan("demo.checkout", {
        root: traceAsRoot,
        data: {
          cart_id: "demo-cart-001",
          customer_tier: "trial",
        },
      }, async (checkoutSpan) => {
        traceId = checkoutSpan.traceId;
        setPropagationHeaders(checkoutSpan.getSpanPropagationHeaders());
        await checkoutSpan.trackEvent("demo.checkout.started", {
          cart_id: "demo-cart-001",
        });
        await checkoutSpan.withSpan("demo.inventory.lookup", {
          data: { sku: "demo-widget", replica: "read-01" },
        }, async (inventorySpan) => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 80);
          });
          await inventorySpan.setData({ available: true, quantity: 3 });
          await inventorySpan.trackEvent("demo.inventory.available", { quantity: 3 });
        });
        await checkoutSpan.withSpan("demo.payment.charge", {
          data: { provider: "demo-payments", attempt: 1 },
        }, async (paymentSpan) => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 120);
          });
          await paymentSpan.setData({ outcome: "approved", amount: eventValue });
          await paymentSpan.trackEvent("demo.payment.approved", {
            amount: eventValue,
          });
        });
        await checkoutSpan.trackEvent("demo.checkout.completed", {
          outcome: "approved",
        });
      });
      addActivity("span", "Nested checkout trace completed", `trace_id=${traceId}\nchildren=inventory.lookup, payment.charge`);
    });
  };

  const runLinkedTrace = async () => {
    await runAction("span", async () => {
      const producerSpan = app.startSpan("demo.queue.producer", {
        root: true,
        data: { queue: "demo-orders", message_id: "demo-message-001" },
      });
      const consumerRootSpan = app.startSpan("demo.queue.consumer", {
        root: true,
        data: { queue: "demo-orders", worker: "demo-worker-01" },
      });
      const processingSpan = consumerRootSpan.startSpan("demo.queue.process", {
        links: [producerSpan],
        data: { message_id: "demo-message-001", linked_producer: true },
      });
      await processingSpan.trackEvent("demo.queue.message.processed", { ok: true });
      await producerSpan.end();
      await processingSpan.end();
      await consumerRootSpan.end();
      addActivity("span", "Linked queue trace completed", `producer_trace=${producerSpan.traceId}\nconsumer_trace=${consumerRootSpan.traceId}\nlinks=1`);
    });
  };

  const runAmbientTrace = async () => {
    await runAction("span", async () => {
      const ambientSpan = app.startSpan("demo.ambient.parent", {
        data: { parenting: "global-span" },
      });
      app.setGlobalSpan(ambientSpan);
      try {
        await app.trackEvent("demo.ambient.event", { parent: "global-span" });
        await app.withSpan("demo.ambient.child", async (childSpan) => {
          await childSpan.trackEvent("demo.ambient.child.event", { parent: childSpan.spanId });
        });
      } finally {
        app.clearGlobalSpan(ambientSpan);
        await ambientSpan.end();
      }
      addActivity("span", "Ambient parent trace completed", `trace_id=${ambientSpan.traceId}\nambient_span=${ambientSpan.spanId}`);
    });
  };

  const inspectPropagation = () => {
    const headers = app.getSpanPropagationHeaders();
    setPropagationHeaders(headers);
    addActivity("span", "Read propagation headers", formatJson(headers));
  };

  const captureRepeatedError = (): PendingCaptureRecord => {
    const eventId = app.withErrorScope((scope) => {
      scope
        .setUser(DEMO_ERROR_USER)
        .setTags({ demo: "observability", grouping_mode: "same" })
        .setContext("checkout", { cart_id: "demo-cart-001", step: "payment" })
        .setExtra("fixture", "repeatable")
        .addBreadcrumb({
          category: "demo",
          message: "Tester clicked repeatable error",
          level: "info",
        })
        .setFingerprint(["hexclave-observability-demo", "repeatable-payment-error"]);
      return app.captureException(new Error("Hexclave observability demo: repeatable payment error"), {
        handled: true,
        mechanism: "demo.manual.repeatable",
      });
    });
    return {
      eventId,
      label: "Repeatable scoped exception",
      detail: "Same fingerprint on every click; issue occurrence count should increase.",
    };
  };

  const captureUniqueError = (): PendingCaptureRecord => {
    const instanceKey = crypto.randomUUID();
    const eventId = app.withErrorScope((scope) => {
      scope.setUser(DEMO_ERROR_USER);
      return app.captureException(new Error(`Hexclave observability demo: unique error ${instanceKey}`), {
        handled: true,
        mechanism: "demo.manual.unique",
        fingerprint: ["hexclave-observability-demo", "unique-error", instanceKey],
        tags: {
          demo: "observability",
          grouping_mode: "unique",
        },
        extra: {
          instance_key: instanceKey,
        },
      });
    });
    return {
      eventId,
      label: "Unique fingerprint exception",
      detail: `instance_key=${instanceKey}\nA fresh issue group is expected for every click.`,
    };
  };

  const captureMessage = (): PendingCaptureRecord => {
    const eventId = app.captureMessage("Hexclave observability demo: degraded payment provider", {
      level: "warning",
      mechanism: "demo.manual.message",
      tags: {
        demo: "observability",
        signal: "message",
      },
    });
    return {
      eventId,
      label: "First-class message event",
      detail: "captureMessage creates a grouped issue without requiring an Error object.",
    };
  };

  const captureNormalizedEvent = (): PendingCaptureRecord => {
    const stack = new Error("normalized fixture").stack;
    const eventId = app.captureEvent({
      name: "DemoNormalizedError",
      message: "A normalized exception chain with an explicit frame",
      stack,
      exception: {
        values: [{
          type: "DemoNormalizedError",
          value: "A normalized exception chain with an explicit frame",
          stacktrace: {
            raw: stack,
            frames: [{
              filename: "src/demo/payment.ts",
              function: "chargeDemoCard",
              lineno: 42,
              colno: 9,
              in_app: true,
              context_line: "return provider.charge(order);",
            }],
          },
        }],
      },
      handled: true,
      mechanism: "demo.manual.normalized",
      platform: "javascript",
      release: OBSERVABILITY_DEMO_RELEASE,
      environment: "development",
      tags: {
        demo: "observability",
        signal: "normalized-event",
      },
    });
    return {
      eventId,
      label: "Normalized exception event",
      detail: "Includes an explicit exception chain and stack frame for issue detail rendering.",
    };
  };

  const captureProcessedError = (): PendingCaptureRecord => {
    const eventId = app.withErrorScope((scope) => {
      scope
        .setTag("processor_fixture", "true")
        .addEventProcessor((event) => ({
          ...event,
          message: `${event.message ?? "processed error"} [scope processor]`,
          extra: {
            ...event.extra,
            processed_by: "scope event processor",
          },
        }));
      return app.captureException(new Error("Hexclave observability demo: processor input"), {
        handled: true,
        mechanism: "demo.manual.processor",
      });
    });
    return {
      eventId,
      label: "Scope-processed exception",
      detail: "A scope event processor rewrites the message before beforeSend and delivery.",
    };
  };

  const captureIgnoredMessage = (): PendingCaptureRecord => {
    const eventId = app.captureMessage("Hexclave observability demo: ignored by policy", {
      mechanism: "demo.manual.ignore-policy",
    });
    return {
      eventId,
      label: "Policy-ignored message",
      detail: "The SDK generated this event ID, but observability.errorCapture.ignoreErrors dropped the message before delivery. No issue is expected.",
    };
  };

  const captureAttachment = (): PendingCaptureRecord => {
    const eventId = app.withErrorScope((scope) => {
      scope
        .setTag("demo_attachment", "true")
        .addAttachment({
          data: JSON.stringify({
            source: "observability-lab",
            order_id: "demo-order-001",
            note: "This is a tiny, non-sensitive fixture attachment.",
          }),
          filename: "demo-order-context.json",
          contentType: "application/json",
          attachmentType: "event.attachment",
          idempotencyKey: crypto.randomUUID(),
        });
      return app.captureException(new Error("Hexclave observability demo: error with attachment"), {
        handled: true,
        mechanism: "demo.manual.attachment",
      });
    });
    return {
      eventId,
      label: "Exception with attachment",
      detail: "Attachment upload uses the authenticated /analytics/attachments path.",
    };
  };

  const captureAsyncScopedMessage = async () => {
    await runAction("error", async () => {
      const eventId = await app.withErrorScopeAsync(async (scope) => {
        scope
          .setTag("scope_mode", "async")
          .setContext("async_scope", { boundary: "promise-chain" })
          .addBreadcrumb({
            category: "demo",
            message: "Async scope crossed an await",
            level: "info",
          });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 40);
        });
        return app.captureMessage("Hexclave observability demo: async scoped message", {
          level: "info",
          mechanism: "demo.manual.async-scope",
        });
      });
      await app.flush();
      addCapture("Async scoped message", eventId, "withErrorScopeAsync preserves scope data across the promise boundary.");
    });
  };

  const prepareLab = async (): Promise<PreparedLabState> => {
    const response = await fetch("/error-tracking-demo/api/observability-lab/prepare", {
      method: "POST",
      cache: "no-store",
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      throw new Error(readStringProperty(body, "message") ?? `Prepare failed with status ${response.status}`);
    }
    const release = readStringProperty(body, "release");
    const releaseId = readStringProperty(body, "releaseId");
    const debugId = readStringProperty(body, "debugId");
    const codeFile = readStringProperty(body, "codeFile");
    const sourceMaps = readStringProperty(body, "sourceMaps");
    if (release === null || releaseId === null || debugId === null || codeFile === null || sourceMaps === null) {
      throw new Error("Prepare returned an incomplete release/source-map payload.");
    }
    const prepared = { release, releaseId, debugId, codeFile, sourceMaps };
    setPreparedLab(prepared);
    addActivity("error", "Registered release and source maps", formatJson(prepared));
    return prepared;
  };

  const captureSymbolicatedError = async () => {
    await runAction("error", async () => {
      const prepared = preparedLab ?? await prepareLab();
      await loadSymbolicatedBundle();
      try {
        readDemoThrower()();
      } catch (error) {
        const eventId = app.captureException(error, {
          handled: true,
          mechanism: "demo.manual.symbolicated",
          fingerprint: ["hexclave-observability-demo", "symbolicated-charge-error"],
          tags: {
            demo: "observability",
            signal: "symbolicated",
            release: prepared.release,
          },
          extra: {
            debug_id: prepared.debugId,
            code_file: prepared.codeFile,
          },
        });
        await app.flush();
        addCapture(
          "Symbolicated charge error",
          eventId,
          `release=${prepared.release}\ndebug_id=${prepared.debugId}\ncode_file=${prepared.codeFile}\nIssue detail should symbolicate the top frame to ${OBSERVABILITY_DEMO_ERROR_MESSAGE} in src/demo-charge.ts.`,
        );
        return;
      }
      throw new Error("The symbolicated demo thrower returned without throwing.");
    });
  };

  const runErrorCapture = async (capture: () => PendingCaptureRecord): Promise<void> => {
    await runAction("error", async () => {
      const captured = await deliverErrorCapture(capture, async () => await app.flush());
      addCapture(captured.label, captured.eventId, captured.detail);
    });
  };

  const triggerFrameworkError = async () => {
    await runAction("framework-error", async () => {
      const response = await fetch("/error-tracking-demo/api/server-error", {
        method: "POST",
        cache: "no-store",
      });
      const body = await response.text();
      setFrameworkErrorResult({ status: response.status, body });
      addActivity("network", "Next onRequestError route triggered", `status=${response.status}\nPOST /error-tracking-demo/api/server-error`);
    });
  };

  const runServerTelemetry = async (failure: boolean) => {
    await runAction("network", async () => {
      const clientSpan = app.startSpan("demo.client.http", {
        data: {
          route: "/error-tracking-demo/api/telemetry",
          failure_requested: failure,
        },
      });
      try {
        const params = new URLSearchParams({ delay: failure ? "180" : "420" });
        if (failure) params.set("failure", "1");
        const response = await clientSpan.fetch(`/error-tracking-demo/api/telemetry?${params.toString()}`, {
          method: "POST",
          cache: "no-store",
        });
        const body: unknown = await response.json();
        const traceId = readStringProperty(body, "traceId");
        const spanId = readStringProperty(body, "spanId");
        setServerResult({
          status: response.status,
          ok: response.ok,
          traceId,
          spanId,
          body: formatJson(body),
        });
        await clientSpan.setData({
          status: response.status,
          response_ok: response.ok,
        });
        addActivity("network", `Cross-tier server trace ${response.ok ? "completed" : "failed"}`, `browser_trace_id=${clientSpan.traceId}\nserver_trace_id=${traceId ?? "not returned"}\nserver_span_id=${spanId ?? "not returned"}\nstatus=${response.status}`);
      } finally {
        await clientSpan.end();
      }
    });
  };

  const triggerAutocaptureSignal = (signal: "resize" | "beforeprint" | "offline" | "online" | "blur" | "focus") => {
    window.dispatchEvent(new Event(signal));
    addActivity("autocapture", `Dispatched ${signal}`, "The browser tracker records this as a system signal when the matching integration is enabled.");
  };

  const simulateRouteChange = () => {
    const nextRoute = `surface-${interactionCount + 1}`;
    window.history.pushState({ demoRoute: nextRoute }, "", `${window.location.pathname}?demo_view=${nextRoute}`);
    setSyntheticRoute(nextRoute);
    addActivity("autocapture", "Synthetic SPA navigation", `$page-view should restart with entry_type=push\nview=${nextRoute}`);
  };

  const clearActivity = () => {
    setActivity([]);
    setLastActionError(null);
  };

  return (
    <main className="w-full bg-gray-50 p-4 dark:bg-neutral-950 md:p-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <header className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <Typography type="h1">Observability Lab</Typography>
              <Typography className="max-w-3xl text-gray-600 dark:text-gray-400">
                Fire SDK signals from this tab, then inspect grouping, traces, logs, and replay in the dashboard.
              </Typography>
            </div>
            <div className="rounded-md border bg-white px-3 py-2 text-sm dark:bg-black">
              <div><span className="font-medium">Project:</span> <span className="font-mono">{app.projectId}</span></div>
              <div><span className="font-medium">Release:</span> {OBSERVABILITY_DEMO_RELEASE}</div>
              <div><span className="font-medium">Replay:</span> enabled, inputs masked</div>
            </div>
          </div>
          {activity.length > 0 && (
            <div className="rounded-md border bg-white px-3 py-2 text-sm dark:bg-black">
              <span className="text-gray-500 dark:text-gray-400">Last action:</span>{" "}
              <span className="font-medium">{activity[0].title}</span>
            </div>
          )}
          {lastActionError !== null && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950">
              <div className="font-medium">Action failed</div>
              <div className="mt-1">{lastActionError}</div>
            </div>
          )}
        </header>

        <Tabs defaultValue="events" className="flex flex-col gap-5">
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
            {LAB_SECTIONS.map((section) => (
              <TabsTrigger
                key={section.id}
                value={section.id}
                className="transition-colors duration-150 hover:transition-none"
              >
                {section.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
            <div>
              <TabsContent value="events" className="mt-0">
                <LabCard
                  title="Named events"
                  description="Send a custom event through the public SDK. It is a named OTel LogRecord and inherits the current page view unless you start a new root."
                >
                  <div className="grid gap-3 md:grid-cols-[1fr_8rem]">
                    <label className="grid gap-1 text-sm">
                      <span className="font-medium">Event type</span>
                      <Input value={eventType} onChange={(event) => setEventType(event.target.value)} aria-label="Custom event type" />
                    </label>
                    <label className="grid gap-1 text-sm">
                      <span className="font-medium">Value</span>
                      <Input value={eventValue} onChange={(event) => setEventValue(event.target.value)} aria-label="Custom event value" />
                    </label>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={eventAsRoot} onChange={(event) => setEventAsRoot(event.target.checked)} />
                    Start this event as a new trace root
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy !== null} onClick={async () => await emitEvent()}>
                      {busy === "event" ? "Flushing event…" : "Track custom event"}
                    </Button>
                  </div>
                  <CodeNote>app.trackEvent(&quot;{eventType || "event.type"}&quot;, &#123; order_id, value, currency &#125;)</CodeNote>
                </LabCard>
              </TabsContent>

              <TabsContent value="logs" className="mt-0">
                <LabCard
                  title="Structured logs"
                  description="Explicit logger calls never throw. Console capture is also enabled, so the mirror action exercises redaction and Error promotion."
                >
                  <div className="flex flex-wrap gap-2">
                    {DEMO_LOG_LEVELS.map((level) => (
                      <Button key={level} size="sm" variant="secondary" onClick={() => emitStructuredLog(level)}>
                        logger.{level}
                      </Button>
                    ))}
                    <Button size="sm" onClick={emitConsoleMirror}>
                      Mirror console
                    </Button>
                  </div>
                  <CodeNote>
                    console.warn → $log / warn{"\n"}
                    console.error(Error) → $log + $error{"\n"}
                    secret-shaped keys → [redacted]
                  </CodeNote>
                </LabCard>
              </TabsContent>

              <TabsContent value="traces" className="mt-0">
                <LabCard
                  title="Traces"
                  description="Nested checkout creates parent/child spans. Linked queue opens two traces. Ambient parent sets a global span for following work."
                >
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={traceAsRoot} onChange={(event) => setTraceAsRoot(event.target.checked)} />
                    Make the checkout span a new root trace
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy !== null} onClick={async () => await runNestedTrace()}>
                      {busy === "span" ? "Running…" : "Nested checkout"}
                    </Button>
                    <Button variant="secondary" disabled={busy !== null} onClick={async () => await runLinkedTrace()}>
                      Linked queue
                    </Button>
                    <Button variant="secondary" disabled={busy !== null} onClick={async () => await runAmbientTrace()}>
                      Ambient parent
                    </Button>
                    <Button variant="outline" size="sm" onClick={inspectPropagation}>
                      Read propagation headers
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={async () => await runAction("flush", async () => {
                        await app.flush();
                    addActivity("flush", "Telemetry providers flushed", "Pending logs, events, errors, and ended spans were force-flushed.");
                      })}
                    >
                      {busy === "flush" ? "Flushing…" : "Force flush"}
                    </Button>
                  </div>
                  <div className="rounded-md border bg-white p-3 dark:bg-black">
                    <div className="text-sm font-medium">Propagation headers</div>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-gray-600 dark:text-gray-400">
                      {formatJson(propagationHeaders)}
                    </pre>
                  </div>
                </LabCard>
              </TabsContent>

              <TabsContent value="errors" className="mt-0">
                <div className="grid gap-5">
                  <LabCard
                    title="Error capture"
                    description="Each control waits for telemetry delivery before confirming the capture. Issue grouping can take a few seconds after delivery."
                  >
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" disabled={busy !== null} onClick={async () => await runErrorCapture(captureRepeatedError)}>Same issue</Button>
                      <Button size="sm" disabled={busy !== null} onClick={async () => await runErrorCapture(captureUniqueError)}>New issue</Button>
                      <Button size="sm" variant="secondary" disabled={busy !== null} onClick={async () => await runErrorCapture(captureMessage)}>Capture message</Button>
                      <Button size="sm" variant="secondary" disabled={busy !== null} onClick={async () => await runErrorCapture(captureNormalizedEvent)}>Normalized event</Button>
                      <Button size="sm" variant="secondary" disabled={busy !== null} onClick={async () => await runErrorCapture(captureProcessedError)}>Scope processor</Button>
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={async () => await runErrorCapture(captureIgnoredMessage)}>Ignored by policy</Button>
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={async () => await captureAsyncScopedMessage()}>Async scope</Button>
                      <Button size="sm" disabled={busy !== null} onClick={async () => await runErrorCapture(captureAttachment)}>Error + attachment</Button>
                    </div>
                    <CodeNote>last_event_id: {lastEventId ?? "none yet"}</CodeNote>
                    {captures.length > 0 && (
                      <ol className="divide-y rounded-md border bg-white dark:bg-black">
                        {captures.map((capture) => (
                          <li key={capture.eventId} className="grid gap-1 p-3 sm:grid-cols-[1fr_auto]">
                            <div className="min-w-0">
                              <div className="text-sm font-medium">{capture.label}</div>
                              <div className="break-all font-mono text-xs text-gray-600 dark:text-gray-400">{capture.eventId}</div>
                              <div className="mt-1 whitespace-pre-wrap text-xs text-gray-500">{capture.detail}</div>
                            </div>
                            <div className="flex items-start gap-3 text-xs">
                              <a
                                className="text-blue-600 underline-offset-2 transition-colors duration-150 hover:text-blue-800 hover:transition-none hover:underline dark:text-blue-400 dark:hover:text-blue-200"
                                href={`${dashboardBaseUrl}${projectPath}/observability/issues`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open issues
                              </a>
                              <time className="text-gray-500">{capture.recordedAt}</time>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </LabCard>
                  <LabCard
                    title="Source maps + release"
                    description={`Registers ${OBSERVABILITY_DEMO_RELEASE}, uploads a minified bundle with a debug-ID snippet and sourcesContent map, then throws from that file so issue detail can symbolicate.`}
                  >
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={async () => await runAction("prepare", async () => {
                          await prepareLab();
                        })}
                      >
                        {busy === "prepare" ? "Registering…" : "Register release + source maps"}
                      </Button>
                      <Button size="sm" disabled={busy !== null} onClick={async () => await captureSymbolicatedError()}>
                        {busy === "error" ? "Capturing…" : "Throw symbolicated error"}
                      </Button>
                    </div>
                    <CodeNote>
                      release: {preparedLab?.release ?? OBSERVABILITY_DEMO_RELEASE}{"\n"}
                      debug_id: {preparedLab?.debugId ?? "register to mint"}{"\n"}
                      code_file: {preparedLab?.codeFile ?? OBSERVABILITY_DEMO_CODE_FILE}{"\n"}
                      bundle: {OBSERVABILITY_DEMO_BUNDLE_PATH}
                    </CodeNote>
                  </LabCard>
                </div>
              </TabsContent>

              <TabsContent value="network" className="mt-0">
                <LabCard
                  title="Cross-tier request"
                  description="Uses a client span and span.fetch. The Next route receives traceparent, opens a server span, then creates a child database span."
                >
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy !== null} onClick={async () => await runServerTelemetry(false)}>
                      {busy === "network" ? "Requesting…" : "Successful server trace"}
                    </Button>
                    <Button variant="destructive" disabled={busy !== null} onClick={async () => await runServerTelemetry(true)}>
                      Server failure
                    </Button>
                    <Button variant="outline" disabled={busy !== null} onClick={async () => await triggerFrameworkError()}>
                      {busy === "framework-error" ? "Sending…" : "Trigger Next 500"}
                    </Button>
                  </div>
                  <CodeNote>POST /error-tracking-demo/api/telemetry?delay=420</CodeNote>
                  <div className="rounded-md border bg-white p-3 text-sm dark:bg-black">
                    {serverResult === null ? (
                      <div className="text-gray-600 dark:text-gray-400">Run a request to see the server span identity.</div>
                    ) : (
                      <div className="grid gap-2 font-mono text-xs">
                        <div>status={serverResult.status} ok={String(serverResult.ok)}</div>
                        <div className="break-all">server_trace_id={serverResult.traceId ?? "not returned"}</div>
                        <div className="break-all">server_span_id={serverResult.spanId ?? "not returned"}</div>
                        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-gray-600 dark:text-gray-400">{serverResult.body}</pre>
                      </div>
                    )}
                  </div>
                  {frameworkErrorResult !== null && (
                    <CodeNote>
                      Next 500 observed status={frameworkErrorResult.status}
                      {frameworkErrorResult.body !== "" ? ` body=${frameworkErrorResult.body}` : " body=<empty>"}
                    </CodeNote>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <CodeNote>
                      POST /api/v1/analytics/otlp/v1/logs{"\n"}
                      POST /api/v1/analytics/otlp/v1/traces{"\n"}
                      POST /api/v1/analytics/otlp/v1/metrics
                    </CodeNote>
                    <CodeNote>
                      POST /api/v1/analytics/attachments{"\n"}
                      POST /api/v1/session-replays/batch{"\n"}
                      POST /api/v1/analytics/events/batch
                    </CodeNote>
                  </div>
                </LabCard>
              </TabsContent>

              <TabsContent value="browser" className="mt-0">
                <LabCard
                  title="Autocapture and replay"
                  description="Click, form, keyboard, and integrity fixtures for replay and autocapture. Stay on this tab while exercising them."
                >
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      className="rounded-md border bg-white px-3 py-3 text-left text-sm transition-colors duration-150 hover:bg-gray-50 hover:transition-none dark:bg-black dark:hover:bg-neutral-900"
                      onClick={() => {
                    setAliveClickCount((current) => current + 1);
                    setInteractionCount((current) => current + 1);
                    addActivity("autocapture", "Alive click", "$click should remain alive because React mutates this counter.");
                      }}
                    >
                      <div className="font-medium">Alive click</div>
                      <div className="text-xs text-gray-500">clicked {aliveClickCount} times</div>
                    </button>
                    <button
                      type="button"
                      className="rounded-md border bg-white px-3 py-3 text-left text-sm dark:bg-black"
                      onClick={() => {
                      }}
                    >
                      <div className="font-medium">Dead click candidate</div>
                      <div className="text-xs text-gray-500">no DOM mutation</div>
                    </button>
                    <button
                      type="button"
                      className="rounded-md border bg-white px-3 py-3 text-left text-sm transition-colors duration-150 hover:bg-gray-50 hover:transition-none dark:bg-black dark:hover:bg-neutral-900"
                      onClick={() => {
                    setAliveClickCount((current) => current + 1);
                    setInteractionCount((current) => current + 1);
                    addActivity("autocapture", "Rage-click fixture", "Click this control three times quickly in one small area to set data.rage=1.");
                      }}
                    >
                      <div className="font-medium">Rage-click fixture</div>
                      <div className="text-xs text-gray-500">click rapidly in one spot</div>
                    </button>
                    <button
                      type="button"
                      className="rounded-md border bg-white px-3 py-3 text-left text-sm transition-colors duration-150 hover:bg-gray-50 hover:transition-none dark:bg-black dark:hover:bg-neutral-900"
                      onClick={simulateRouteChange}
                    >
                      <div className="font-medium">Push synthetic route</div>
                      <div className="text-xs text-gray-500">view={syntheticRoute}</div>
                    </button>
                  </div>
                  <form
                    className="grid gap-3 rounded-md border bg-white p-3 dark:bg-black"
                    onSubmit={(event) => {
                  event.preventDefault();
                  setFormSubmissionCount((current) => current + 1);
                  addActivity("autocapture", "Demo form submitted", "$form-submit contains field names only; input values are not captured.");
                    }}
                  >
                    <div className="text-sm font-medium">Form + keystroke boundary</div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Input name="demo_email" type="email" placeholder="masked email input" aria-label="Demo email" />
                      <Input name="demo_password" type="password" placeholder="password always masked" aria-label="Demo password" />
                    </div>
                    <Button type="submit" size="sm" variant="secondary">
                      Submit form ({formSubmissionCount})
                    </Button>
                  </form>
                  <div className="grid gap-2">
                    <label className="text-sm font-medium" htmlFor="keyboard-sandbox">Keyboard sandbox</label>
                    <div
                      id="keyboard-sandbox"
                      role="textbox"
                      aria-label="Keyboard activity sandbox"
                      tabIndex={0}
                      contentEditable
                      suppressContentEditableWarning
                      className="rr-mask min-h-14 rounded-md border bg-white p-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring dark:bg-black"
                      onInput={(event) => setKeyboardSandboxValue(event.currentTarget.textContent)}
                    />
                    <div className="text-xs text-gray-500">
                      Keystroke capture sends count + duration only. Local text length: {keyboardSandboxValue.length}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => triggerAutocaptureSignal("resize")}>Resize</Button>
                    <Button size="sm" variant="outline" onClick={() => triggerAutocaptureSignal("beforeprint")}>Print</Button>
                    <Button size="sm" variant="outline" onClick={() => triggerAutocaptureSignal("offline")}>Offline</Button>
                    <Button size="sm" variant="outline" onClick={() => triggerAutocaptureSignal("online")}>Online</Button>
                    <Button size="sm" variant="outline" onClick={() => triggerAutocaptureSignal("blur")}>Blur</Button>
                    <Button size="sm" variant="outline" onClick={() => triggerAutocaptureSignal("focus")}>Focus</Button>
                  </div>
                  <div className="rounded-md border bg-white p-3 text-sm dark:bg-black">
                    <div className="font-medium">Manual gestures</div>
                    <div className="mt-2 text-gray-600 dark:text-gray-400">Select and copy this fixture, then right-click it.</div>
                    <div
                      className="mt-3 select-text rounded-md border border-dashed p-3"
                      onContextMenu={() => addActivity("autocapture", "Context-menu fixture", "$context-menu should include target geometry, never clipboard content.")}
                    >
                      clipboard fixture / no sensitive content
                    </div>
                    <a
                      className="mt-3 inline-block text-sm underline underline-offset-4 transition-opacity duration-150 hover:opacity-60 hover:transition-none"
                      download="observability-demo.txt"
                      href="data:text/plain,Hexclave%20observability%20demo"
                    >
                      Download fixture
                    </a>
                  </div>
                </LabCard>
              </TabsContent>
            </div>

            <aside className="flex flex-col gap-5 lg:sticky lg:top-16">
              <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                  <div>
                    <Typography type="h3">Activity</Typography>
                    <Typography type="footnote" variant="secondary">{activity.length}/{MAX_ACTIVITY_RECORDS}</Typography>
                  </div>
                  <Button size="sm" variant="ghost" onClick={clearActivity}>Clear</Button>
                </CardHeader>
                <CardContent className="p-6">
                  {activity.length === 0 ? (
                    <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-gray-500">
                      Trigger a signal to populate the feed
                    </div>
                  ) : (
                    <ol className="max-h-[min(28rem,calc(100vh-16rem))] divide-y overflow-auto rounded-md border">
                      {activity.map((entry) => (
                        <li key={entry.id} className="grid gap-2 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className={`${getActivityColor(entry.kind)} rounded px-1.5 py-0.5 text-[11px] font-medium`}>{entry.kind}</span>
                            <time className="text-xs text-gray-500">{entry.recordedAt}</time>
                          </div>
                          <div className="text-sm font-medium">{entry.title}</div>
                          <pre className="max-h-20 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-gray-500">{entry.detail}</pre>
                        </li>
                      ))}
                    </ol>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <Typography type="h3">Inspect in dashboard</Typography>
                  <Typography type="footnote" variant="secondary">
                    Local acknowledgements are not ingestion. Open the project to verify records.
                  </Typography>
                </CardHeader>
                <CardContent className="grid gap-1 p-6 pt-4">
                  {DASHBOARD_LINKS.map(([label, path]) => (
                    <a
                      key={label}
                      className="flex items-center justify-between rounded-md px-2 py-2 text-sm transition-colors duration-150 hover:bg-gray-100 hover:transition-none dark:hover:bg-neutral-900"
                      href={`${dashboardBaseUrl}${projectPath}${path}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span>{label}</span>
                      <span aria-hidden="true">↗</span>
                    </a>
                  ))}
                </CardContent>
              </Card>
            </aside>
          </div>
        </Tabs>
      </div>
    </main>
  );
}

function LabCard(props: {
  title: string,
  description: string,
  children: ReactNode,
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <Typography type="h3">{props.title}</Typography>
        <Typography className="text-sm text-gray-600 dark:text-gray-400">{props.description}</Typography>
      </CardHeader>
      <CardContent className="grid gap-4 p-6">
        {props.children}
      </CardContent>
    </Card>
  );
}

function CodeNote(props: { children: ReactNode }) {
  return (
    <pre className="overflow-auto whitespace-pre-wrap rounded-md border bg-white p-3 font-mono text-xs text-gray-600 dark:bg-black dark:text-gray-400">
      {props.children}
    </pre>
  );
}

let symbolicatedBundleLoad: Promise<void> | null = null;

function loadSymbolicatedBundle(): Promise<void> {
  if (symbolicatedBundleLoad !== null) return symbolicatedBundleLoad;
  symbolicatedBundleLoad = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-hexclave-demo-bundle="charge"]`);
    if (existing !== null) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = OBSERVABILITY_DEMO_BUNDLE_PATH;
    script.async = false;
    script.dataset.hexclaveDemoBundle = "charge";
    script.onload = () => resolve();
    script.onerror = () => {
      symbolicatedBundleLoad = null;
      reject(new Error(`Failed to load the symbolicated demo bundle from ${OBSERVABILITY_DEMO_BUNDLE_PATH}`));
    };
    document.head.appendChild(script);
  });
  return symbolicatedBundleLoad;
}

function readDemoThrower(): () => void {
  // SAFETY: the side-loaded demo bundle registers its thrower on globalThis
  // under this key, which TypeScript cannot know about; reading the property as
  // `unknown` is sound for any object, and the function check below validates it.
  const value: unknown = (globalThis as typeof globalThis & { [OBSERVABILITY_DEMO_THROWER_GLOBAL_KEY]?: unknown })[OBSERVABILITY_DEMO_THROWER_GLOBAL_KEY];
  if (typeof value !== "function") {
    throw new Error("The symbolicated demo bundle did not register throwSymbolicatedChargeError.");
  }
  return () => {
    value();
  };
}
