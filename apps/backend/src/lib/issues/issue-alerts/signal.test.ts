import { describe, expect, it } from "vitest";
import { buildIssueAlertSignal, type IssueAlertSignalInput } from "./signal";

const scope = {
  tenancyId: "00000000-0000-4000-8000-000000000001",
  projectId: "project-alerts",
  branchId: "branch-main",
};

function makeInput(overrides: Partial<IssueAlertSignalInput> = {}): IssueAlertSignalInput {
  return {
    scope,
    outcome: {
      issueId: "00000000-0000-4000-8000-000000000002",
      shortId: 7n,
      ownerHash: "a".repeat(32),
      isNew: true,
      isRegression: false,
    },
    input: {
      ownerHash: "a".repeat(32),
      aliasHashes: [],
      occurrenceId: "event-alert-1",
      groupingConfigId: "hexclave-js:2026-08-01",
      groupingProvenance: [{
        hash: "a".repeat(32),
        role: "primary",
        configId: "hexclave-js:2026-08-01",
        variant: "app",
        fingerprint: { type: "default", source: "default", tokens: [], resolvedTokens: [] },
      }],
      type: "TypeError",
      value: "bad input",
      culprit: "app.ts",
      platform: "node",
      count: 1,
      firstEventAt: new Date("2026-08-06T12:00:00.000Z"),
      lastEventAt: new Date("2026-08-06T12:00:01.000Z"),
      serviceName: "api",
      deploymentEnvironmentName: "production",
      release: "2026.08.06",
      level: "error",
      handled: true,
      synthetic: false,
    },
    issue: {
      id: "00000000-0000-4000-8000-000000000002",
      shortId: 7n,
      type: "TypeError",
      value: "bad input",
      culprit: "app.ts",
      status: "UNRESOLVED",
    },
    errorEnvelope: {
      tags: { browser: "chrome", secret: "should remain bounded" },
      extra: { attempt: 3, token: "authorization secret" },
      contexts: { browser: { version: "1" } },
      attributes: { feature: "checkout" },
      request: { url: "https://example.test/?token=private" },
    },
    frequencyCounts: new Map([[60, 4]]),
    ...overrides,
  };
}

describe("buildIssueAlertSignal", () => {
  it("projects lifecycle, occurrence, tags, attributes, and exact frequency snapshots", () => {
    const signal = buildIssueAlertSignal(makeInput());
    expect(signal.issue).toMatchObject({
      shortId: "7",
      status: "unresolved",
      isNew: true,
      isRegression: false,
    });
    expect(signal.occurrence).toMatchObject({ id: "event-alert-1" });
    expect(signal.level).toBe("error");
    expect(signal.environment).toBe("production");
    expect(signal.release).toBe("2026.08.06");
    expect(signal.tags).toEqual(new Map([["browser", "chrome"]]));
    expect(signal.tags.get("secret")).toBeUndefined();
    expect(signal.attributes.get("extra.attempt")).toBe(3);
    expect(signal.attributes.get("contexts.browser.version")).toBe("1");
    expect(signal.attributes.get("attributes.feature")).toBe("checkout");
    expect(signal.attributes.get("extra.token")).toBeUndefined();
    expect(signal.frequencyCounts).toEqual(new Map([[60, 4]]));
  });

  it("derives a stable per-batch occurrence identity for reconciler-aggregated deltas", () => {
    const input = { input: { ...makeInput().input, occurrenceId: undefined }, batchId: "batch-one" };
    const first = buildIssueAlertSignal(makeInput(input));
    const second = buildIssueAlertSignal(makeInput(input));
    const nextBatch = buildIssueAlertSignal(makeInput({ ...input, batchId: "batch-two" }));
    expect(first.occurrence.id).toMatch(/^[0-9a-f]{32}$/);
    expect(first.occurrence.id).toBe(second.occurrence.id);
    expect(nextBatch.occurrence.id).not.toBe(first.occurrence.id);
  });

  it("normalizes Sentry warning and fatal spellings at the materialization boundary", () => {
    expect(buildIssueAlertSignal(makeInput({ input: { ...makeInput().input, level: "warning" } })).level).toBe("warn");
    expect(buildIssueAlertSignal(makeInput({ input: { ...makeInput().input, level: "fatal" } })).level).toBe("error");
  });

  it("rejects a mismatched issue snapshot instead of constructing a cross-issue signal", () => {
    expect(() => buildIssueAlertSignal(makeInput({ issue: { ...makeInput().issue, id: "00000000-0000-4000-8000-000000000003" } }))).toThrow(
      "Issue alert snapshot does not match materialization outcome",
    );
  });
});
