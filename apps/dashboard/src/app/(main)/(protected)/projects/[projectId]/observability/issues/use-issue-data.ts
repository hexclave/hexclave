"use client";

import type { StackAdminApp } from "@hexclave/next";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EventSparklineBucket } from "../event-sparkline";
import { queryObservability } from "../filters";
import type { ObservabilityTimeRangeHours } from "../filters";
import {
  getIssueFacetsQuery,
  getIssueSparklineQuery,
  parseIssueFacetRows,
  parseIssueSparklineRows,
  type IssueFacets,
  type IssueListItem,
} from "./issues-data";


const EMPTY_FACETS: IssueFacets = { services: [], environments: [] };

export function useIssueFacetsLoader(adminApp: StackAdminApp<false>) {
  const cacheRef = useRef<{ adminApp: StackAdminApp<false>, byHours: Map<number, Promise<IssueFacets>> } | null>(null);

  return useCallback((hours: ObservabilityTimeRangeHours) => {
    if (cacheRef.current?.adminApp !== adminApp) {
      cacheRef.current = { adminApp, byHours: new Map() };
    }
    const cache = cacheRef.current;
    const cached = cache.byHours.get(hours);
    if (cached != null) return cached;

    const promise = (async () => {
      try {
        const { query, params } = getIssueFacetsQuery(hours);
        const response = await queryObservability(adminApp, { query, params });
        return parseIssueFacetRows(response.result);
      } catch (error) {
        if (cacheRef.current === cache) cache.byHours.delete(hours);
        throw error;
      }
    })();
    cache.byHours.set(hours, promise);
    return promise;
  }, [adminApp]);
}

export function useIssueFacets(adminApp: StackAdminApp<false>, hours: ObservabilityTimeRangeHours) {
  const loadFacets = useIssueFacetsLoader(adminApp);
  const [facets, setFacets] = useState<IssueFacets>(EMPTY_FACETS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const reload = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    runAsynchronously(async () => {
      try {
        const next = await loadFacets(hours);
        if (cancelled) return;
        setFacets(next);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadFacets, hours]);

  useEffect(() => reload(), [reload]);

  return { facets, loading, error };
}


const EMPTY_SPARKLINES: ReadonlyMap<string, readonly EventSparklineBucket[]> = new Map();

export type IssueSparklines = {
  byHash: ReadonlyMap<string, readonly EventSparklineBucket[]>,
  error: Error | null,
  retry: () => void,
};

export function useIssueSparklines(
  adminApp: StackAdminApp<false>,
  hours: ObservabilityTimeRangeHours,
  rows: readonly IssueListItem[],
): IssueSparklines {
  const [cache, setCache] = useState<{
    hours: ObservabilityTimeRangeHours,
    byHash: ReadonlyMap<string, readonly EventSparklineBucket[]>,
  }>({ hours, byHash: EMPTY_SPARKLINES });
  const [error, setError] = useState<Error | null>(null);
  const inFlightRef = useRef<{ hours: ObservabilityTimeRangeHours, hashes: Set<string> }>({ hours, hashes: new Set() });
  const [retryToken, setRetryToken] = useState(0);

  const byHash = cache.hours === hours ? cache.byHash : EMPTY_SPARKLINES;

  const visibleHashesKey = useMemo(
    () => [...new Set(rows.flatMap((row) => row.issue_hashes))].join("\n"),
    [rows],
  );
  const visibleHashes = useMemo(
    () => (visibleHashesKey === "" ? [] : visibleHashesKey.split("\n")),
    [visibleHashesKey],
  );

  useEffect(() => {
    void retryToken;
    if (inFlightRef.current.hours !== hours) {
      inFlightRef.current = { hours, hashes: new Set() };
    }
    const inFlight = inFlightRef.current.hashes;

    const wanted = visibleHashes.filter((hash) => !byHash.has(hash) && !inFlight.has(hash));
    if (wanted.length === 0) return;
    for (const hash of wanted) inFlight.add(hash);

    let cancelled = false;
    runAsynchronously(async () => {
      try {
        const { query, params } = getIssueSparklineQuery(hours, wanted);
        const response = await queryObservability(adminApp, { query, params });
        const parsed = parseIssueSparklineRows(response.result, wanted, hours, performance.timeOrigin + performance.now());
        if (cancelled) return;
        setError(null);
        setCache((current) => {
          const base = current.hours === hours ? current.byHash : EMPTY_SPARKLINES;
          const next = new Map(base);
          for (const [hash, buckets] of parsed) {
            next.set(hash, buckets.map((bucket) => ({ key: bucket.bucketMs, value: bucket.occurrences })));
          }
          return { hours, byHash: next };
        });
      } catch (caught) {
        for (const hash of wanted) inFlight.delete(hash);
        if (cancelled) return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      }
    });

    return () => {
      cancelled = true;
      for (const hash of wanted) inFlight.delete(hash);
    };
  }, [adminApp, hours, visibleHashes, byHash, retryToken]);

  const retry = useCallback(() => {
    setError(null);
    setRetryToken((token) => token + 1);
  }, []);

  return { byHash, error, retry };
}
