import { describe, expect, it, vi } from "vitest";
import { buildCapturedEventData, buildErrorEventData } from "./error-capture";
import { processErrorEvent } from "./error-processors";

function event() {
  return buildErrorEventData(new Error("processor input"), {
    mechanismType: "test",
    handled: true,
    release: null,
    environment: null,
    sdkVersion: "test",
    eventId: "0123456789abcdef0123456789abcdef",
  });
}

function options(overrides: Partial<Parameters<typeof processErrorEvent>[1]> = {}): Parameters<typeof processErrorEvent>[1] {
  return {
    hint: {
      eventId: event().event_id,
      mechanism: "test",
      handled: true,
      scope: {},
      attachments: [],
    },
    ...overrides,
  };
}

describe("error processor pipeline", () => {
  it("runs configured, scope, and beforeSend processors in order without allowing ID replacement", async () => {
    const order: string[] = [];
    const result = await processErrorEvent(event(), options({
      eventProcessors: [
        (input) => {
          order.push("configured");
          return { ...input, message: "configured" };
        },
      ],
      scopeProcessors: [
        async (input) => {
          order.push("scope");
          return { action: "replace", event: { ...input, message: "scope", event_id: "ffffffffffffffffffffffffffffffff" } };
        },
      ],
      beforeSend: (input) => {
        order.push("beforeSend");
        return { ...input, message: "before-sent", event_id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" };
      },
    }));

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(order).toEqual(["configured", "scope", "beforeSend"]);
    expect(result.event.message).toBe("before-sent");
    expect(result.event.event_id).toBe("0123456789abcdef0123456789abcdef");
  });

  it("exposes attachments through the hint while keeping binary data out of the event projection", async () => {
    const processor = vi.fn((input, hint) => {
      expect(hint.attachments).toHaveLength(1);
      expect(hint.attachments[0]?.filename).toBe("trace.txt");
      expect(input).not.toHaveProperty("attachments");
      return input;
    });
    const data = buildCapturedEventData({
      message: "with attachment",
      handled: true,
      attachments: [{ data: "trace", filename: "trace.txt" }],
    }, {
      eventId: event().event_id,
      release: null,
      environment: null,
      sdkVersion: "test",
    });

    const result = await processErrorEvent(data, options({
      eventProcessors: [processor],
      hint: {
        ...options().hint,
        attachments: [{ data: "trace", filename: "trace.txt" }],
      },
    }));
    expect(result.status).toBe("accepted");
    expect(processor).toHaveBeenCalledOnce();
  });

  it("supports explicit drop decisions and null beforeSend results", async () => {
    expect(await Promise.resolve(processErrorEvent(event(), options({
      eventProcessors: [() => ({ action: "drop", reason: "test-filter" })],
    })))).toEqual({ status: "dropped", reason: "event_processor", detail: "test-filter" });

    expect(await Promise.resolve(processErrorEvent(event(), options({
      beforeSend: () => null,
    })))).toEqual({ status: "dropped", reason: "before_send" });
  });

  it("reports callback failures without leaking the thrown value", async () => {
    const onFailure = vi.fn();
    const result = await processErrorEvent(event(), options({
      eventProcessors: [() => {
        throw new Error("secret processor failure");
      }],
      onFailure,
    }));

    expect(result).toMatchObject({ status: "dropped", reason: "processor_failure" });
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ reason: "processor_failure", stage: "event_processor" }));
  });

  it("enforces the callback budget before running user code", () => {
    const processor = () => event();
    const onFailure = vi.fn();
    const result = processErrorEvent(event(), options({
      eventProcessors: Array.from({ length: 21 }, () => processor),
      onFailure,
    }));

    expect(result).toEqual(expect.objectContaining({ status: "dropped", reason: "processor_limit" }));
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("runs a fully loaded legitimate pipeline (max per source + beforeSend) without dropping", async () => {
    const calls: string[] = [];
    const processor = (label: string) => (current: ReturnType<typeof event>) => {
      calls.push(label);
      return current;
    };
    const result = await Promise.resolve(processErrorEvent(event(), options({
      eventProcessors: Array.from({ length: 20 }, (_, index) => processor(`configured-${index}`)),
      scopeProcessors: Array.from({ length: 20 }, (_, index) => processor(`scope-${index}`)),
      beforeSend: processor("before-send"),
    })));

    expect(result).toMatchObject({ status: "accepted" });
    expect(calls).toHaveLength(41);
    expect(calls.at(-1)).toBe("before-send");
  });

  it("enforces the per-source budget for scope processors too", () => {
    const onFailure = vi.fn();
    const result = processErrorEvent(event(), options({
      scopeProcessors: Array.from({ length: 21 }, () => () => event()),
      onFailure,
    }));

    expect(result).toEqual(expect.objectContaining({ status: "dropped", reason: "processor_limit" }));
    expect(onFailure).toHaveBeenCalledOnce();
  });
});
