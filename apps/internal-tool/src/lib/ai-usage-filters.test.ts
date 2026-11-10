import { Timestamp } from "spacetimedb";
import { describe, expect, it } from "vitest";
import type { AiQueryLogRow } from "../types";
import {
  aiUsageScopeMatcher,
  type AiUsageScopeFilters,
  countActiveAiUsageScopeFilters,
  DEFAULT_AI_USAGE_SCOPE_FILTERS,
  toAiUsageTableFilters,
} from "./ai-usage-filters";

const NOW_MILLIS = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR_MILLIS = 60 * 60 * 1000;

function filters(overrides: Partial<AiUsageScopeFilters> = {}): AiUsageScopeFilters {
  return { ...DEFAULT_AI_USAGE_SCOPE_FILTERS, ...overrides };
}

/** Only the columns the scope predicate reads matter; cast because the generated row has ~30 more. */
function row(overrides: Partial<AiQueryLogRow> & { createdAtMillis?: number }): AiQueryLogRow {
  const { createdAtMillis = NOW_MILLIS, ...rest } = overrides;
  return {
    systemPromptId: "docs-ask-ai",
    modelId: "openai/gpt-test",
    mode: "generate",
    isAuthenticated: true,
    errorMessage: undefined,
    createdAt: new Timestamp(BigInt(createdAtMillis) * 1000n),
    ...rest,
  } as AiQueryLogRow;
}

describe("AI usage scope filters", () => {
  it("translate to server args, collapsing two-valued filters and sorting lists", () => {
    expect(toAiUsageTableFilters(filters({
      timeRange: "24h",
      modelIds: new Set(["z/model", "a/model"]),
      modes: new Set(["stream"]),
      auth: new Set(["authed", "anon"]),
      statuses: new Set(["error"]),
    }), NOW_MILLIS)).toEqual({
      createdAtOrAfterMicros: BigInt(NOW_MILLIS - 24 * HOUR_MILLIS) * 1000n,
      systemPromptIds: [],
      modelIds: ["a/model", "z/model"],
      mode: "stream",
      isAuthenticated: undefined,
      hasError: true,
    });
  });

  it("count only filters that actually narrow the rows", () => {
    expect(countActiveAiUsageScopeFilters(DEFAULT_AI_USAGE_SCOPE_FILTERS)).toBe(0);
    expect(countActiveAiUsageScopeFilters(filters({ statuses: new Set(["ok", "error"]) }))).toBe(0);
    expect(countActiveAiUsageScopeFilters(filters({ timeRange: "7d", modelIds: new Set(["a"]), auth: new Set(["anon"]) }))).toBe(3);
  });

  it("match rows the same way on the client as the module does on the server", () => {
    const rows = [
      row({ modelId: "a", createdAtMillis: NOW_MILLIS - HOUR_MILLIS }),
      row({ modelId: "b", isAuthenticated: false }),
      row({ modelId: "c", errorMessage: "boom" }),
      row({ modelId: "a", createdAtMillis: NOW_MILLIS - 48 * HOUR_MILLIS }),
    ];
    const kept = (f: AiUsageScopeFilters) => rows.filter(aiUsageScopeMatcher(f, NOW_MILLIS)).map(r => r.modelId);
    expect(kept(filters({ modelIds: new Set(["a", "b"]) }))).toEqual(["a", "b", "a"]);
    expect(kept(filters({ timeRange: "24h", modelIds: new Set(["a"]) }))).toEqual(["a"]);
    expect(kept(filters({ auth: new Set(["anon"]) }))).toEqual(["b"]);
    expect(kept(filters({ statuses: new Set(["error"]) }))).toEqual(["c"]);
  });
});
