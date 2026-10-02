import { describe, expect, it } from "vitest";
import {
  getLeadingUpToLogsQuery,
  LEADING_UP_TO_LIMIT,
  LEADING_UP_TO_WINDOW_MS,
  parseLeadingUpToLogRows,
  resolveCorrelationAnchor,
} from "./correlation";

describe("resolveCorrelationAnchor", () => {
  it("prefers the narrowest available id", () => {
    expect(resolveCorrelationAnchor({
      trace_id: "trace-1",
      page_view_span_id: "pv-1",
      session_replay_id: "sr-1",
    })).toEqual({ kind: "trace", value: "trace-1" });

    expect(resolveCorrelationAnchor({
      trace_id: null,
      page_view_span_id: "pv-1",
      session_replay_id: "sr-1",
    })).toEqual({ kind: "page_view_span", value: "pv-1" });

    expect(resolveCorrelationAnchor({
      trace_id: null,
      page_view_span_id: null,
      session_replay_id: "sr-1",
    })).toEqual({ kind: "session_replay", value: "sr-1" });
  });

  it("treats a blank id as absent rather than matching every row with a blank id", () => {
    expect(resolveCorrelationAnchor({
      trace_id: "",
      page_view_span_id: "   ",
      session_replay_id: "sr-1",
    })).toEqual({ kind: "session_replay", value: "sr-1" });
  });

  it("returns null when the occurrence carries no correlation id at all", () => {
    expect(resolveCorrelationAnchor({
      trace_id: null,
      page_view_span_id: null,
      session_replay_id: null,
    })).toBeNull();
  });
});

describe("getLeadingUpToLogsQuery", () => {
  const occurrenceAtMillis = 1_700_000_000_000;

  it("binds the anchor value as a parameter and never interpolates it", () => {
    const { query, params } = getLeadingUpToLogsQuery(
      { kind: "trace", value: "'; DROP TABLE logs; --" },
      occurrenceAtMillis,
    );
    expect(query).toContain("trace_id = {anchorValue:String}");
    expect(query).not.toContain("DROP TABLE");
    expect(params.anchorValue).toBe("'; DROP TABLE logs; --");
  });

  it("picks the column from a fixed set, one per anchor kind", () => {
    expect(getLeadingUpToLogsQuery({ kind: "trace", value: "x" }, occurrenceAtMillis).query)
      .toContain("trace_id = {anchorValue:String}");
    expect(getLeadingUpToLogsQuery({ kind: "page_view_span", value: "x" }, occurrenceAtMillis).query)
      .toContain("page_view_span_id = {anchorValue:String}");
    expect(getLeadingUpToLogsQuery({ kind: "session_replay", value: "x" }, occurrenceAtMillis).query)
      .toContain("session_replay_id = {anchorValue:String}");
  });

  it("bounds the scan to five minutes ending at the occurrence, with a hard limit", () => {
    const { query, params } = getLeadingUpToLogsQuery({ kind: "trace", value: "x" }, occurrenceAtMillis);
    expect(params.fromMillis).toBe(occurrenceAtMillis - LEADING_UP_TO_WINDOW_MS);
    expect(params.toMillis).toBe(occurrenceAtMillis);
    expect(LEADING_UP_TO_WINDOW_MS).toBe(300_000);
    expect(query).toContain(`LIMIT ${LEADING_UP_TO_LIMIT}`);
    expect(query).toContain("FROM default.logs");
  });

  it("throws on a non-finite occurrence timestamp", () => {
    expect(() => getLeadingUpToLogsQuery({ kind: "trace", value: "x" }, Number.NaN)).toThrow();
  });
});

describe("parseLeadingUpToLogRows", () => {
  it("parses ClickHouse timestamps as UTC", () => {
    const parsed = parseLeadingUpToLogRows([
      { event_at: "2026-07-31 12:00:00.000", level: "warn", message: "slow query", service_name: "web" },
    ]);
    expect(parsed).toEqual([{
      eventAtMillis: Date.parse("2026-07-31T12:00:00.000Z"),
      level: "warn",
      message: "slow query",
      serviceName: "web",
    }]);
  });

  it("throws on a malformed timestamp rather than rendering an Invalid Date", () => {
    expect(() => parseLeadingUpToLogRows([{ event_at: "not-a-date" }])).toThrow(/event_at/);
    expect(() => parseLeadingUpToLogRows([{}])).toThrow(/event_at/);
  });
});
