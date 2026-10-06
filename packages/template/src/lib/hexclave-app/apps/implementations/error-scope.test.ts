import { describe, expect, it } from "vitest";
import { createErrorScope, getActiveErrorScope, mergeErrorScopeData, runWithErrorScope } from "./error-scope";

describe("error scope", () => {
  it("keeps scope data bounded and merges per-capture overrides predictably", () => {
    const scope = createErrorScope();
    scope.setUser({ id: "scope-user" });
    scope.setTags({ area: "checkout" });
    scope.setContext("payment", { provider: "scope" });
    scope.setExtra("attempt", 1);
    scope.setExtras({ region: "us-west", attempt: 2 });
    scope.setLevel("info");
    scope.setFingerprint(["scope", "fingerprint"]);
    scope.addAttachment({ data: "scope bytes", filename: "scope.txt" });
    for (let index = 0; index < 101; index += 1) {
      scope.addBreadcrumb({ message: `breadcrumb-${index}` });
    }

    const merged = mergeErrorScopeData(scope.snapshot(), {
      user: { id: "capture-user" },
      tags: { source: "manual", area: "capture" },
      contexts: { payment: { method: "card" } },
      extra: { attempt: 3, region: "us-west" },
      level: "warning",
      attachments: [{ data: "capture bytes", filename: "capture.txt" }],
    });

    expect(merged.user).toEqual({ id: "capture-user" });
    expect(merged.tags).toEqual({ area: "capture", source: "manual" });
    expect(merged.contexts).toEqual({ payment: { provider: "scope", method: "card" } });
    expect(merged.extra).toEqual({ attempt: 3, region: "us-west" });
    expect(merged.level).toBe("warning");
    expect(merged.fingerprint).toEqual(["scope", "fingerprint"]);
    expect(merged.breadcrumbs).toHaveLength(100);
    expect(merged.breadcrumbs?.[0]?.message).toBe("breadcrumb-1");
    expect(merged.attachments?.map((attachment) => attachment.filename)).toEqual(["scope.txt", "capture.txt"]);
  });

  it("caps initial breadcrumbs like addBreadcrumb does, keeping the newest", () => {
    const initialBreadcrumbs = Array.from({ length: 150 }, (_, index) => ({ message: `initial-${index}` }));
    const scope = createErrorScope({ breadcrumbs: initialBreadcrumbs });
    const snapshot = scope.snapshot();
    expect(snapshot.breadcrumbs).toHaveLength(100);
    expect(snapshot.breadcrumbs?.[0]?.message).toBe("initial-50");
    expect(snapshot.breadcrumbs?.at(-1)?.message).toBe("initial-149");
  });

  it("restores nested ambient scopes and works without an OTel context manager", () => {
    const parent = createErrorScope({ tags: { parent: "yes" } });
    const child = createErrorScope({ tags: { child: "yes" } });

    expect(getActiveErrorScope()).toBeNull();
    runWithErrorScope(parent, () => {
      expect(getActiveErrorScope()).toBe(parent);
      runWithErrorScope(child, () => {
        expect(getActiveErrorScope()).toBe(child);
      });
      expect(getActiveErrorScope()).toBe(parent);
    });
    expect(getActiveErrorScope()).toBeNull();
  });

  it("rejects empty keys and can clear all mutable data", () => {
    const scope = createErrorScope();
    expect(() => scope.setTag("", "value")).toThrow("tag key must not be empty");
    expect(() => scope.setContext(" ", {})).toThrow("context key must not be empty");
    expect(() => scope.setExtra("", "value")).toThrow("extra key must not be empty");
    expect(() => scope.setExtras({ " ": "value" })).toThrow("extra key must not be empty");

    scope.setUser({ id: "user" }).setTag("key", "value").clear();
    expect(scope.snapshot()).toEqual({});
  });

  it("supports Sentry-style scope attachment lifecycle", () => {
    const scope = createErrorScope();
    scope.addAttachment({ data: "bytes", filename: "log.txt" });
    expect(scope.snapshot().attachments?.[0]?.filename).toBe("log.txt");
    scope.clearAttachments();
    expect(scope.snapshot().attachments).toEqual([]);
  });
});
