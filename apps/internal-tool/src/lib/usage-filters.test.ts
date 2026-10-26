import { describe, expect, it, vi } from "vitest";
import { emptyUsageFilters, matchesUsageFilters, parseUsageRow, type UsageFilters } from "./usage-filters";

vi.mock("@hexclave/shared/dist/utils/errors", () => ({ captureError: vi.fn() }));
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { loadHistory } from "./load-history";

function row(overrides: Partial<Parameters<typeof matchesUsageFilters>[0]> = {}) {
  return {
    requestedToolsJson: '["sql-query"]',
    stepsJson: JSON.stringify([{
      toolCalls: [{ toolName: "queryAnalytics", toolCallId: "call-1", args: { sql: "SELECT fixture FROM example" } }],
      toolResults: [{ toolName: "queryAnalytics", toolCallId: "call-1", result: { success: true } }],
    }]),
    projectId: "project-1", userId: "user-1", correlationId: "correlation-1",
    messagesJson: "[]", finalText: "", errorMessage: undefined,
    ...overrides,
  };
}
function matches(overrides: Partial<UsageFilters>, fixture = row()) {
  return matchesUsageFilters(fixture, { ...emptyUsageFilters(), ...overrides });
}

describe("usage-filters", () => {
  it("keeps requested names separate from model-facing called names and uses OR selections", () => {
    expect(matches({ requestedTools: new Set(["sql-query", "docs"]) })).toBe(true);
    expect(matches({ calledTools: new Set(["sql-query"]) })).toBe(false);
    expect(matches({ calledTools: new Set(["queryAnalytics"]) })).toBe(true);
    const unused = row({ stepsJson: "[]" });
    expect(matches({ requestedTools: new Set(["sql-query"]) }, unused)).toBe(true);
    expect(matches({ calledTools: new Set(["queryAnalytics"]) }, unused)).toBe(false);
    expect(matches({ toolCalls: new Set(["called"]) }, unused)).toBe(false);
  });

  it.each([
    [{ success: true }, true, false],
    [{ success: false }, false, true],
    [{ error: "Authentication required" }, false, true],
    [{ _truncated: true, preview: '{"success":true,"data":' }, true, false],
    [{ _truncated: true, preview: '{"success":false,"data":' }, false, false],
    [{ _truncated: true, preview: '{"success":trueish' }, false, false],
    ["success", false, false],
    [null, false, false],
  ])("classifies results %j", (result, success, failure) => {
    const fixture = row({ stepsJson: JSON.stringify([
      { toolCalls: [{ toolName: "queryAnalytics", toolCallId: "call-1" }] },
      { toolResults: [{ toolName: "queryAnalytics", toolCallId: "call-1", result }] },
    ]) });
    expect(matches({ toolCalls: new Set(["succeeded"]) }, fixture)).toBe(success);
    expect(matches({ toolCalls: new Set(["failed"]) }, fixture)).toBe(failure);
    expect(matches({ toolCalls: new Set(["none"]) }, fixture)).toBe(false);
  });

  it("only classifies results belonging to selected calls", () => {
    const fixture = row({ stepsJson: JSON.stringify([{
      toolCalls: [{ toolName: "queryAnalytics", toolCallId: "a" }, { toolName: "readBranchConfig", toolCallId: "b" }],
      toolResults: [
        { toolName: "queryAnalytics", toolCallId: "a", result: { success: false } },
        { toolName: "readBranchConfig", toolCallId: "b", result: { success: true } },
        { toolName: "queryAnalytics", toolCallId: "orphan", result: { success: true } },
      ],
    }]) });
    expect(matches({ toolCalls: new Set(["succeeded"]), calledTools: new Set(["queryAnalytics"]) }, fixture)).toBe(false);
    expect(matches({ toolCalls: new Set(["failed"]), calledTools: new Set(["queryAnalytics"]) }, fixture)).toBe(true);
    expect(matches({ toolCalls: new Set(["succeeded"]) }, fixture)).toBe(true);
    expect(matches({ toolCalls: new Set(["none"]) }, row({ stepsJson: "[]" }))).toBe(true);
  });

  it("matches project and user presence and exact IDs", () => {
    expect(matches({ projectPresence: new Set(["present"]), userPresence: new Set(["present"]), projectId: "project-1", userId: "user-1" })).toBe(true);
    expect(matches({ projectPresence: new Set(["missing"]) })).toBe(false);
    expect(matches({ userPresence: new Set(["missing"]) })).toBe(false);
    expect(matches({ projectId: "project" })).toBe(false);
    expect(matches({ userId: "USER-1" })).toBe(false);
    for (const missing of [undefined, ""]) {
      expect(matches({ projectPresence: new Set(["missing"]), userPresence: new Set(["missing"]) }, row({ projectId: missing, userId: missing }))).toBe(true);
      expect(matches({ projectPresence: new Set(["present"]) }, row({ projectId: missing }))).toBe(false);
      expect(matches({ userPresence: new Set(["present"]) }, row({ userId: missing }))).toBe(false);
    }
  });

  it.each(["SELECT FIXTURE", "CORRELATION-1", "USER-1", "project-1", "SQL-QUERY", "queryAnalytics"])("searches %s", search => {
    expect(matches({ search })).toBe(true);
  });

  it("searches messages, final text and errors", () => {
    const fixture = row({ messagesJson: '["hello"]', finalText: "world", errorMessage: "example failure" });
    for (const search of ["HELLO", "WORLD", "FAILURE"]) expect(matches({ search }, fixture)).toBe(true);
    expect(matches({ search: "not there" }, fixture)).toBe(false);
  });

  it.each(["{", "null", "{}", "[3]"])("reports malformed JSON or shapes once per row: %s", json => {
    vi.mocked(captureError).mockClear();
    const fixture = row({ stepsJson: json, requestedToolsJson: json });
    expect(matches({ toolCalls: new Set(["none"]) }, fixture)).toBe(true);
    expect(matches({ requestedTools: new Set(["sql-query"]) }, fixture)).toBe(false);
    expect(matches({ toolCalls: new Set(["succeeded"]) }, fixture)).toBe(false);
    expect(parseUsageRow(fixture)).toBe(parseUsageRow(fixture));
    expect(captureError).toHaveBeenCalledTimes(2);
  });

  it("requires valid nested tool shapes", () => {
    const fixture = row({ stepsJson: '[{"toolCalls":[{"toolName":3}]}]' });
    expect(matches({ toolCalls: new Set(["none"]) }, fixture)).toBe(true);
  });

  it("ORs tool-call outcomes and treats both presence values as no filter", () => {
    const unused = row({ stepsJson: "[]" });
    expect(matches({ toolCalls: new Set(["called", "none"]) }, unused)).toBe(true);
    expect(matches({ toolCalls: new Set(["called", "failed"]) }, unused)).toBe(false);
    expect(matches({ toolCalls: new Set(["failed", "succeeded"]) })).toBe(true);
    expect(matches({ projectPresence: new Set(["present", "missing"]) }, row({ projectId: undefined }))).toBe(true);
  });

  it("loads pages until history is exhausted", async () => {
    let remaining = 3;
    const loadOlder = vi.fn(async () => {
      remaining--;
    });
    await loadHistory({ loadOlder, hasMoreHistory: () => remaining > 0 });
    expect(loadOlder).toHaveBeenCalledTimes(3);
  });

  it("stops after the in-flight page when cancelled", async () => {
    const controller = new AbortController();
    const loadOlder = vi.fn(async () => {
      controller.abort();
    });
    await loadHistory({ loadOlder, hasMoreHistory: () => true, signal: controller.signal });
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("does not start an exhausted or cancelled load", async () => {
    const loadOlder = vi.fn(async () => {});
    await loadHistory({ loadOlder, hasMoreHistory: () => false });
    const controller = new AbortController();
    controller.abort();
    await loadHistory({ loadOlder, hasMoreHistory: () => true, signal: controller.signal });
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it("propagates a failed page to the caller's alert handler and stops", async () => {
    const loadOlder = vi.fn(async () => {
      throw new Error("Page failed");
    });
    await expect(loadHistory({ loadOlder, hasMoreHistory: () => true })).rejects.toThrow("Page failed");
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });
});
