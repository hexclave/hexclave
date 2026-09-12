"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTvSnapshotOrThrow, TvSnapshotRequestError } from "@/lib/hexclave-app-internals";
import {
  TV_SNAPSHOT_POLL_INTERVAL_MS,
  type TvSnapshot,
} from "@/lib/tv-mode/types";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

const TV_SNAPSHOT_REQUEST_TIMEOUT_MS = 12_000;

export type TvLiveSnapshotState = {
  snapshot: TvSnapshot | null,
  loading: boolean,
  unavailableReason: "offline" | "error" | "unauthorized" | null,
};

export function getRetainedSnapshotState(
  snapshot: TvSnapshot,
  now: Date,
  online: boolean,
): TvSnapshot {
  return {
    ...snapshot,
    connectionStatus: online
      ? now.getTime() >= new Date(snapshot.staleAfter).getTime() ? "stale" : "online"
      : "offline",
  };
}

export function useTvLiveSnapshot(options: {
  adminApp: object,
  projectId: string,
  profileId: string,
  enabled: boolean,
}): TvLiveSnapshotState {
  const loadSnapshot = useCallback(async (signal: AbortSignal) => {
    return await fetchTvSnapshotOrThrow(options.adminApp, options.profileId, signal);
  }, [options.adminApp, options.profileId]);
  return useTvSnapshotPolling({
    loadSnapshot,
    enabled: options.enabled,
    sourceKey: `${options.projectId}\u0000${options.profileId}`,
    failureProfileId: options.profileId,
  });
}

export function useTvSnapshotPolling(options: {
  loadSnapshot: (signal: AbortSignal) => Promise<TvSnapshot>,
  enabled: boolean,
  sourceKey: string,
  failureProfileId?: string,
}): TvLiveSnapshotState {
  const { enabled, failureProfileId, loadSnapshot, sourceKey } = options;
  const [snapshot, setSnapshot] = useState<TvSnapshot | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [unavailableReason, setUnavailableReason] = useState<"offline" | "error" | "unauthorized" | null>(null);
  const [publishedSourceKey, setPublishedSourceKey] = useState(sourceKey);
  const inFlightRef = useRef(false);
  const requestIdRef = useRef(0);
  const snapshotRef = useRef<TvSnapshot | null>(null);
  const activeRequestRef = useRef<AbortController | null>(null);
  const enabledRef = useRef(enabled);
  const failureProfileIdRef = useRef(failureProfileId);
  const loadSnapshotRef = useRef(loadSnapshot);
  const sourceKeyRef = useRef(sourceKey);
  enabledRef.current = enabled;
  failureProfileIdRef.current = failureProfileId;
  loadSnapshotRef.current = loadSnapshot;
  sourceKeyRef.current = sourceKey;

  const refresh = useCallback(async () => {
    if (!enabledRef.current || inFlightRef.current) return;
    inFlightRef.current = true;
    const requestSourceKey = sourceKeyRef.current;
    const requestId = ++requestIdRef.current;
    const requestController = new AbortController();
    activeRequestRef.current = requestController;
    let timeoutId: number | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = window.setTimeout(() => {
          requestController.abort();
          reject(new Error("TV snapshot request timed out."));
        }, TV_SNAPSHOT_REQUEST_TIMEOUT_MS);
      });
      const nextSnapshot = await Promise.race([
        loadSnapshotRef.current(requestController.signal),
        timeout,
      ]);
      if (requestId !== requestIdRef.current) return;
      const connectedSnapshot = navigator.onLine
        ? nextSnapshot
        : getRetainedSnapshotState(nextSnapshot, new Date(), false);
      snapshotRef.current = connectedSnapshot;
      setPublishedSourceKey(requestSourceKey);
      setSnapshot(connectedSnapshot);
      setUnavailableReason(null);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      captureError("tv-snapshot-refresh-failed", new HexclaveAssertionError(
        "Failed to refresh the TV presentation snapshot.",
        { cause, profileId: failureProfileIdRef.current },
      ));
      if (cause instanceof TvSnapshotRequestError && cause.status === 401) {
        snapshotRef.current = null;
        setSnapshot(null);
        setUnavailableReason("unauthorized");
        setPublishedSourceKey(requestSourceKey);
        return;
      }
      const retained = snapshotRef.current;
      setPublishedSourceKey(requestSourceKey);
      if (retained == null) {
        setUnavailableReason(navigator.onLine ? "error" : "offline");
      } else {
        const nextSnapshot = getRetainedSnapshotState(retained, new Date(), navigator.onLine);
        snapshotRef.current = nextSnapshot;
        setSnapshot(nextSnapshot);
      }
    } finally {
      if (timeoutId != null) window.clearTimeout(timeoutId);
      if (activeRequestRef.current === requestController) activeRequestRef.current = null;
      if (requestId === requestIdRef.current) {
        inFlightRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    // Route or display-principal changes can reuse this client component.
    // Invalidate the previous source so its response cannot cross boundaries.
    requestIdRef.current += 1;
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    inFlightRef.current = false;
    snapshotRef.current = null;
    setPublishedSourceKey(sourceKey);
    setSnapshot(null);
    setUnavailableReason(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);

    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        runAsynchronously(refresh());
      }
    };
    const updateConnectionState = () => {
      const retained = snapshotRef.current;
      if (retained == null) {
        if (navigator.onLine) {
          runAsynchronously(refresh());
        } else {
          setUnavailableReason("offline");
        }
        return;
      }
      const nextSnapshot = getRetainedSnapshotState(retained, new Date(), navigator.onLine);
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      if (navigator.onLine) runAsynchronously(refresh());
    };
    const updateFreshness = () => {
      const retained = snapshotRef.current;
      if (retained == null) return;
      const nextSnapshot = getRetainedSnapshotState(retained, new Date(), navigator.onLine);
      if (nextSnapshot.connectionStatus !== retained.connectionStatus) {
        snapshotRef.current = nextSnapshot;
        setSnapshot(nextSnapshot);
      }
    };
    const interval = window.setInterval(refreshIfVisible, TV_SNAPSHOT_POLL_INTERVAL_MS);
    const freshnessInterval = window.setInterval(updateFreshness, 5_000);
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("online", updateConnectionState);
    window.addEventListener("offline", updateConnectionState);
    runAsynchronously(refresh());

    return () => {
      requestIdRef.current += 1;
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
      inFlightRef.current = false;
      window.clearInterval(interval);
      window.clearInterval(freshnessInterval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("online", updateConnectionState);
      window.removeEventListener("offline", updateConnectionState);
    };
  }, [enabled, refresh, sourceKey]);

  // Effects run after render. Tagging state prevents the previous project's
  // snapshot from being observable during that otherwise unavoidable frame.
  if (publishedSourceKey !== sourceKey) {
    return { snapshot: null, loading: enabled, unavailableReason: null };
  }
  return { snapshot, loading, unavailableReason };
}
