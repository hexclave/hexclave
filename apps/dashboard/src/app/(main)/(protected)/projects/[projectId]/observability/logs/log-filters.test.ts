import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOG_FILTERS,
  DEFAULT_LOG_TIME_RANGE_HOURS,
  parseLogFilters,
  serializeLogFilters,
  type LogFilters,
} from "./log-filters";

describe("log filters URL state", () => {
  it("defaults to the 30d archive window", () => {
    expect(DEFAULT_LOG_FILTERS.hours).toBe(DEFAULT_LOG_TIME_RANGE_HOURS);
    expect(serializeLogFilters(DEFAULT_LOG_FILTERS, new URLSearchParams()).toString()).toBe("");
  });

  it("round-trips a non-default level and service", () => {
    const filters: LogFilters = {
      hours: 24,
      level: "warn",
      service: { namespace: "web", name: "storefront" },
    };
    expect(parseLogFilters(serializeLogFilters(filters, new URLSearchParams()))).toEqual(filters);
  });
});
