"use client";

import { useCallback, useRef } from "react";
import type { StackAdminApp } from "@hexclave/next";
import type { RowData } from "../analytics/shared";
import { parseServiceIdentityRow, type ServiceIdentity } from "./service-identity";


export const OBSERVABILITY_TIME_RANGES = [
  { label: "1h", hours: 1 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
] as const;

export type ObservabilityTimeRangeHours = (typeof OBSERVABILITY_TIME_RANGES)[number]["hours"];

export const DEFAULT_OBSERVABILITY_TIME_RANGE_HOURS: ObservabilityTimeRangeHours = 24;

export function isObservabilityTimeRangeHours(hours: number): hours is ObservabilityTimeRangeHours {
  return OBSERVABILITY_TIME_RANGES.some((range) => range.hours === hours);
}

export const OBSERVABILITY_TIME_RANGE_OPTIONS = OBSERVABILITY_TIME_RANGES.map((range) => ({
  label: range.label,
  id: String(range.hours),
}));

export function observabilityTimeRangeLabel(hours: ObservabilityTimeRangeHours): string {
  const range = OBSERVABILITY_TIME_RANGES.find((candidate) => candidate.hours === hours);
  if (range == null) throw new Error(`Unknown observability time range: ${hours}`);
  return range.label;
}

export function parseObservabilityTimeRangeId(id: string): ObservabilityTimeRangeHours {
  const hours = Number(id);
  if (!isObservabilityTimeRangeHours(hours)) {
    throw new Error(`Unknown observability time range: ${id}`);
  }
  return hours;
}

export const ALL_SERVICES_SELECT_VALUE = "all";

export function useServiceIdentityLoader(adminApp: StackAdminApp<false>, query: string) {
  const requestRef = useRef<{ adminApp: StackAdminApp<false>, promise: Promise<ServiceIdentity[]> } | null>(null);

  return useCallback((refresh = false) => {
    const currentRequest = requestRef.current;
    if (!refresh && currentRequest?.adminApp === adminApp) return currentRequest.promise;

    const promise = (async () => {
      try {
        const response = await queryObservability(adminApp, { query, params: {} });
        return response.result.map(parseServiceIdentityRow);
      } catch (error) {
        if (requestRef.current?.adminApp === adminApp) {
          requestRef.current = null;
        }
        throw error;
      }
    })();
    requestRef.current = { adminApp, promise };
    return promise;
  }, [adminApp, query]);
}

export type ObservabilityQueryParams = Record<string, string | number | readonly string[]>;

export async function queryObservability(
  adminApp: StackAdminApp<false>,
  options: { query: string, params: ObservabilityQueryParams },
): Promise<{ result: RowData[], query_id: string }> {
  const response = await adminApp.queryAnalytics({
    query: options.query,
    params: options.params,
    include_all_branches: false,
    timeout_ms: 30000,
  });
  // SAFETY: queryAnalytics hands back the deserialized JSON response body, so
  // every column value is a Json by construction. The SDK types the columns as
  // unknown only because it cannot know each query's result schema.
  return response as { result: RowData[], query_id: string };
}

export function replaceLocationSearch(params: URLSearchParams): void {
  if (typeof window === "undefined") return;
  const next = params.toString();
  if (next === window.location.search.replace(/^\?/, "")) return;
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${next === "" ? "" : `?${next}`}${window.location.hash}`,
  );
}

export function readLocationSearch(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}
