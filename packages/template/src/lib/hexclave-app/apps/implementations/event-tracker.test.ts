// @vitest-environment jsdom

import { KnownErrors } from "@hexclave/shared/dist/known-errors";
import { Result } from "@hexclave/shared/dist/utils/results";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventTracker } from "./event-tracker";

async function advancePastFlush() {
  await vi.advanceTimersByTimeAsync(10_000);
  await Promise.resolve();
}

function getSentEventTypes(sentBodies: string[]) {
  const [body] = sentBodies;

  const payload = JSON.parse(body);
  if (typeof payload !== "object" || payload === null || !("events" in payload) || !Array.isArray(payload.events)) {
    throw new Error("Expected analytics batch payload to include an events array.");
  }

  return (payload.events as { event_type: string }[]).map((event) => event.event_type);
}

describe("EventTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries the exact failed batch before sending newer events", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sentBodies: string[] = [];
    let attempts = 0;
    const tracker = new EventTracker({
      projectId: "internal",
      sendBatch: async (body) => {
        sentBodies.push(body);
        attempts += 1;
        return attempts === 1 ? Result.error(new Error("offline")) : Result.ok(new Response());
      },
    });

    try {
      tracker.start();
      await tracker.trackEvent("checkout.completed", { properties: { plan: "pro" }, value: 49 });
      await advancePastFlush();
      await tracker.trackEvent("checkout.follow-up");
      await advancePastFlush();
      await advancePastFlush();

      expect(attempts).toBe(3);
      expect(sentBodies[1]).toBe(sentBodies[0]);
      expect(getSentEventTypes(sentBodies.slice(0, 1))).toContain("checkout.completed");
      expect(getSentEventTypes(sentBodies.slice(1, 2))).not.toContain("checkout.follow-up");
      expect(getSentEventTypes(sentBodies.slice(2))).toEqual(["checkout.follow-up"]);
    } finally {
      tracker.stop();
      warnSpy.mockRestore();
    }
  });

  it("retries a pending batch even when no newer events arrive", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sentBodies: string[] = [];
    const tracker = new EventTracker({
      projectId: "internal",
      sendBatch: async (body) => {
        sentBodies.push(body);
        return sentBodies.length === 1 ? Result.error(new Error("offline")) : Result.ok(new Response());
      },
    });

    try {
      tracker.start();
      await advancePastFlush();
      await advancePastFlush();

      expect(sentBodies).toHaveLength(2);
      expect(sentBodies[1]).toBe(sentBodies[0]);
    } finally {
      tracker.stop();
      warnSpy.mockRestore();
    }
  });

  it("rejects reserved and non-serializable customer events", async () => {
    const tracker = new EventTracker({
      projectId: "internal",
      sendBatch: async () => Result.ok(new Response()),
    });

    await expect(tracker.trackEvent("$feature-flag-exposure")).rejects.toThrowError("reserved");
    await expect(tracker.trackEvent("checkout", { value: Number.NaN })).rejects.toThrowError("finite");
  });

  it("attaches verified team context to subsequent automatic and custom events", async () => {
    vi.useFakeTimers();
    const sentBodies: string[] = [];
    const tracker = new EventTracker({
      projectId: "internal",
      sendBatch: async (body) => {
        sentBodies.push(body);
        return Result.ok(new Response());
      },
    });

    try {
      tracker.setTeamContext("00000000-0000-4000-8000-000000000001");
      tracker.start();
      await tracker.trackEvent("checkout.completed");
      await advancePastFlush();

      const payload: unknown = JSON.parse(sentBodies[0] ?? "{}");
      if (typeof payload !== "object" || payload === null || !("events" in payload) || !Array.isArray(payload.events)) {
        throw new Error("Expected analytics batch payload to include events.");
      }
      expect(payload.events).toHaveLength(2);
      expect(payload.events.every((event) => typeof event === "object" && event !== null && "team_id" in event && event.team_id === "00000000-0000-4000-8000-000000000001")).toBe(true);
    } finally {
      tracker.stop();
    }
  });

  it("captures events when browser globals are exposed as accessor descriptors", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<button>Open project</button>";

    const screenDescriptor = Object.getOwnPropertyDescriptor(window, "screen");
    const historyDescriptor = Object.getOwnPropertyDescriptor(window, "history");
    expect(screenDescriptor?.value).toBeUndefined();
    expect(historyDescriptor?.value).toBeUndefined();
    expect(screenDescriptor?.get).toBeTypeOf("function");
    expect(historyDescriptor?.get).toBeTypeOf("function");

    const sentBodies: string[] = [];
    const tracker = new EventTracker({
      projectId: "internal",
      sendBatch: async (body) => {
        sentBodies.push(body);
        return Result.ok(new Response());
      },
    });

    try {
      tracker.start();
      document.querySelector("button")?.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        clientX: 12,
        clientY: 34,
      }));

      await advancePastFlush();

      // Dead-click classification marks the buffered $click in place —
      // exactly one click event either way.
      expect(getSentEventTypes(sentBodies)).toMatchInlineSnapshot(`
        [
          "$page-view",
          "$click",
        ]
      `);
    } finally {
      tracker.stop();
    }
  });

  it("emits a PostHog-style elements_chain plus scaled pointer coords for $click", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main>
        <section class="card panel">
          <button id="save-btn" data-testid="save" aria-label="Save project">Save changes</button>
        </section>
      </main>
    `;

    const sentBodies: string[] = [];
    const tracker = new EventTracker({
      projectId: "internal",
      sendBatch: async (body) => {
        sentBodies.push(body);
        return Result.ok(new Response());
      },
    });

    try {
      tracker.start();
      const button = document.querySelector("#save-btn");
      if (button == null) throw new Error("button missing");
      button.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        clientX: 100,
        clientY: 200,
      }));

      await advancePastFlush();

      const payload = JSON.parse(sentBodies[0] ?? "{}") as { events: { event_type: string, data: Record<string, unknown> }[] };
      const click = payload.events.find((event) => event.event_type === "$click");
      if (click == null) throw new Error("no $click event captured");

      // elements_chain encodes the target leaf plus a few ancestors. Leaf is
      // first; segments are `;`-delimited. Assert against substrings rather
      // than the full string so jsdom layout quirks don't make this flaky.
      const chain = click.data.elements_chain;
      expect(typeof chain).toBe("string");
      expect(chain).toContain('button');
      expect(chain).toContain('attr__id="save-btn"');
      expect(chain).toContain('attr__data-testid="save"');
      expect(chain).toContain('attr__aria-label="Save project"');
      expect(chain).toContain('text="Save changes"');
      // Ancestor section is in the chain too.
      expect(chain).toContain("section");

      // Pre-scaled coords land in clickmap_events.pointer_*. SCALE_FACTOR=16.
      expect(click.data.x_scaled).toBe(Math.round(100 / 16));
      expect(click.data.y_scaled).toBe(Math.round(200 / 16));
      expect(click.data.client_y_scaled).toBe(Math.round(200 / 16));
      expect(click.data.scale_factor).toBe(16);
      expect(click.data.pointer_relative_x).toBeCloseTo(100 / window.innerWidth, 4);
      expect(click.data.pointer_target_fixed).toBe(0);

      // Legacy CSS selector still emitted for back-compat. The builder prefers
      // data-testid over id, so we assert against that anchor rather than #id.
      expect(click.data.selector).toContain('data-testid="save"');
      expect(click.data.tag_name).toBe("button");
    } finally {
      tracker.stop();
    }
  });

  it("ignores clicks inside the Hexclave dev tool", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div id="__hexclave-dev-tool-root">
        <button>Clickmap toolbar control</button>
      </div>
    `;

    const sentBodies: string[] = [];
    const tracker = new EventTracker({
      projectId: "internal",
      sendBatch: async (body) => {
        sentBodies.push(body);
        return Result.ok(new Response());
      },
    });

    try {
      tracker.start();
      document.querySelector("button")?.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        clientX: 100,
        clientY: 200,
      }));

      await advancePastFlush();

      expect(getSentEventTypes(sentBodies)).toMatchInlineSnapshot(`
        [
          "$page-view",
        ]
      `);
    } finally {
      tracker.stop();
    }
  });

  it("flags pointer_target_fixed when the target sits under a fixed-position ancestor", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <header style="position: fixed; top: 0">
        <button id="cta">Sign up</button>
      </header>
    `;

    const sentBodies: string[] = [];
    const tracker = new EventTracker({
      projectId: "internal",
      sendBatch: async (body) => {
        sentBodies.push(body);
        return Result.ok(new Response());
      },
    });

    try {
      tracker.start();
      document.querySelector("#cta")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await advancePastFlush();

      const payload = JSON.parse(sentBodies[0] ?? "{}") as { events: { event_type: string, data: Record<string, unknown> }[] };
      const click = payload.events.find((event) => event.event_type === "$click");
      expect(click?.data.pointer_target_fixed).toBe(1);
    } finally {
      tracker.stop();
    }
  });

  it("flags a click with no observable effect as dead on its single $click event", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<button id=\"dead\">Does nothing</button>";

    const sentBodies: string[] = [];
    const tracker = new EventTracker({
      projectId: "internal",
      sendBatch: async (body) => {
        sentBodies.push(body);
        return Result.ok(new Response());
      },
    });

    try {
      tracker.start();
      const clickAtMs = Date.now();
      document.querySelector("#dead")?.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        clientX: 10,
        clientY: 20,
      }));

      await advancePastFlush();

      const payload = JSON.parse(sentBodies[0] ?? "{}") as { events: { event_type: string, event_at_ms: number, data: Record<string, unknown> }[] };
      const clicks = payload.events.filter((event) => event.event_type === "$click");
      expect(clicks).toHaveLength(1);
      const click = clicks[0];

      // One event per physical click: the buffered $click is marked dead in
      // place, still timestamped at the original click rather than at
      // classification time (~3s later).
      expect(click.data.dead).toBe(1);
      expect(click.event_at_ms).toBe(clickAtMs);
    } finally {
      tracker.stop();
    }
  });

  it("does not flag a click as dead when it mutates the DOM", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<button id=\"live\">Adds content</button><div id=\"out\"></div>";

    const sentBodies: string[] = [];
    const tracker = new EventTracker({
      projectId: "internal",
      sendBatch: async (body) => {
        sentBodies.push(body);
        return Result.ok(new Response());
      },
    });

    try {
      tracker.start();
      const button = document.querySelector("#live");
      if (button == null) throw new Error("button missing");
      button.addEventListener("click", () => {
        document.querySelector("#out")?.appendChild(document.createElement("p"));
      });
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      // Let the MutationObserver microtask run so the mutation is recorded
      // before the dead-click sweeps start.
      await Promise.resolve();

      await advancePastFlush();

      const payload = JSON.parse(sentBodies[0] ?? "{}") as { events: { event_type: string, data: Record<string, unknown> }[] };
      const clicks = payload.events.filter((event) => event.event_type === "$click");
      expect(clicks).toHaveLength(1);
      expect(clicks[0].data.dead).toBeUndefined();
    } finally {
      tracker.stop();
    }
  });

  it("drains held clicks as alive on pagehide so navigation clicks are never lost", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<a id=\"nav\" href=\"/pricing\">Pricing</a>";

    const sentBodies: string[] = [];
    const tracker = new EventTracker({
      projectId: "internal",
      sendBatch: async (body) => {
        sentBodies.push(body);
        return Result.ok(new Response());
      },
    });

    try {
      tracker.start();
      const clickAtMs = Date.now();
      document.querySelector("#nav")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      // Navigation fires pagehide well before any classification sweep — the
      // keepalive flush ships the still-unclassified click as a plain (alive)
      // $click.
      window.dispatchEvent(new Event("pagehide"));
      await Promise.resolve();
      await Promise.resolve();

      const payload = JSON.parse(sentBodies[0] ?? "{}") as { events: { event_type: string, event_at_ms: number, data: Record<string, unknown> }[] };
      const clicks = payload.events.filter((event) => event.event_type === "$click");
      expect(clicks).toHaveLength(1);
      expect(clicks[0].data.dead).toBeUndefined();
      expect(clicks[0].event_at_ms).toBe(clickAtMs);
    } finally {
      tracker.stop();
    }
  });

  it("holds an unclassified click out of a flush and ships it on the next one", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<button id=\"late\">Late click</button>";

    const sentBodies: string[] = [];
    const tracker = new EventTracker({
      projectId: "internal",
      sendBatch: async (body) => {
        sentBodies.push(body);
        return Result.ok(new Response());
      },
    });

    try {
      tracker.start();
      // Click 500ms before the 10s flush tick: classification cannot finish
      // in time, so the flush must hold the click back rather than send it
      // unclassified.
      await vi.advanceTimersByTimeAsync(9_500);
      document.querySelector("#late")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(500);

      expect(getSentEventTypes(sentBodies)).toMatchInlineSnapshot(`
        [
          "$page-view",
        ]
      `);

      // By the next flush the sweep has classified it (dead — nothing
      // observable happened) and it ships marked.
      await vi.advanceTimersByTimeAsync(10_000);
      const second = JSON.parse(sentBodies[1] ?? "{}") as { events: { event_type: string, data: Record<string, unknown> }[] };
      expect(second.events.map((event) => event.event_type)).toMatchInlineSnapshot(`
        [
          "$click",
        ]
      `);
      expect(second.events[0].data.dead).toBe(1);
    } finally {
      tracker.stop();
    }
  });

  it("captures client-side navigations when history is exposed as an accessor descriptor", async () => {
    vi.useFakeTimers();

    const historyDescriptor = Object.getOwnPropertyDescriptor(window, "history");
    expect(historyDescriptor?.value).toBeUndefined();
    expect(historyDescriptor?.get).toBeTypeOf("function");

    const sentBodies: string[] = [];
    const tracker = new EventTracker({
      projectId: "internal",
      sendBatch: async (body) => {
        sentBodies.push(body);
        return Result.ok(new Response());
      },
    });

    try {
      tracker.start();
      window.history.pushState({}, "", "/projects/test-project");

      await advancePastFlush();

      expect(getSentEventTypes(sentBodies)).toMatchInlineSnapshot(`
        [
          "$page-view",
          "$page-view",
        ]
      `);
    } finally {
      tracker.stop();
    }
  });

  it("silently ignores network errors caused by ad blockers", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<button>Click me</button>";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sentBodies: string[] = [];
    const tracker = new EventTracker({
      projectId: "internal",
      sendBatch: async (body) => {
        sentBodies.push(body);
        return Result.error(new TypeError("Failed to fetch"));
      },
    });

    try {
      tracker.start();

      await advancePastFlush();
      expect(sentBodies).toHaveLength(1);
      expect(warnSpy).not.toHaveBeenCalled();

      // Unlike ANALYTICS_NOT_ENABLED, ad blocker errors do NOT disable the
      // tracker — subsequent flushes continue attempting delivery.
      document.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await advancePastFlush();
      expect(sentBodies).toHaveLength(2);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      tracker.stop();
      warnSpy.mockRestore();
    }
  });

  it("silently disables when client interface returns ANALYTICS_NOT_ENABLED as an error", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<button>Click me</button>";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sentBodies: string[] = [];
    const tracker = new EventTracker({
      projectId: "internal",
      sendBatch: async (body) => {
        sentBodies.push(body);
        return Result.error(new KnownErrors.AnalyticsNotEnabled());
      },
    });

    try {
      tracker.start();

      await advancePastFlush();
      expect(sentBodies).toHaveLength(1);
      expect(warnSpy).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect((tracker as any)._flushTimer).toBeNull();

      document.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await advancePastFlush();
      expect(sentBodies).toHaveLength(1);
    } finally {
      tracker.stop();
      warnSpy.mockRestore();
    }
  });
});
