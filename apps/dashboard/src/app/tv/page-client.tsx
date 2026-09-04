"use client";

import { TvPresentation } from "@/components/tv-mode/tv-presentation";
import { getPublicEnvVar } from "@/lib/env";
import { TvSnapshotRequestError } from "@/lib/hexclave-app-internals";
import { useTvSnapshotPolling } from "@/lib/tv-mode/live-snapshot";
import {
  TvDisplayPairingChallengeSchema,
  TvDisplayPairingStatusSchema,
  TvSnapshotSchema,
  type TvDisplayPairingChallenge,
} from "@hexclave/shared/dist/interface/admin-tv-mode";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { BroadcastIcon, LinkBreakIcon, MonitorPlayIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

const PAIRING_RETRY_INTERVAL_MS = 5_000;
const PAIRING_STATUS_TIMEOUT_MS = 12_000;
const PAIRING_REQUEST_TIMEOUT_MS = 12_000;

export function resolveTvDisplayApiBase({
  browserOrigin,
  configuredApiUrl,
  configuredBrowserApiUrl,
  nodeEnvironment,
  quickTunnelEnabled,
}: {
  browserOrigin: string | null,
  configuredApiUrl: string | undefined,
  configuredBrowserApiUrl: string | undefined,
  nodeEnvironment: string | undefined,
  quickTunnelEnabled: boolean,
}): string {
  if (quickTunnelEnabled) {
    if (nodeEnvironment !== "development") {
      throw new Error("The TV Quick Tunnel transport cannot be used outside development.");
    }
    if (browserOrigin == null) {
      throw new Error("The TV Quick Tunnel transport requires a browser origin.");
    }
    return browserOrigin;
  }

  const configuredBase = configuredBrowserApiUrl ?? configuredApiUrl;
  if (configuredBase == null) throw new Error("TV display API URL is not configured.");
  return configuredBase;
}

function apiUrl(path: string): string {
  const base = resolveTvDisplayApiBase({
    browserOrigin: typeof window === "undefined" ? null : window.location.origin,
    configuredApiUrl: getPublicEnvVar("NEXT_PUBLIC_STACK_API_URL"),
    configuredBrowserApiUrl: getPublicEnvVar("NEXT_PUBLIC_BROWSER_STACK_API_URL"),
    nodeEnvironment: process.env.NODE_ENV,
    quickTunnelEnabled: getPublicEnvVar("NEXT_PUBLIC_HEXCLAVE_TV_QUICK_TUNNEL_ENABLED") === "true",
  });
  return new URL(`/api/latest${path}`, base).toString();
}

export function getTvDisplayRequestHeaders(options: RequestInit): Headers {
  const headers = new Headers(options.headers);
  if (options.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
}

async function jsonRequest(path: string, options: RequestInit): Promise<Response> {
  return await fetch(apiUrl(path), {
    ...options,
    credentials: "include",
    headers: getTvDisplayRequestHeaders(options),
    cache: "no-store",
  });
}

async function jsonRequestWithTimeout(path: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), PAIRING_REQUEST_TIMEOUT_MS);
  try {
    return await jsonRequest(path, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function PairingScreen({ challenge, error }: { challenge: TvDisplayPairingChallenge | null, error: boolean }) {
  const code = challenge?.pairingCode;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#070910] p-8 text-white">
      <div className="w-full max-w-3xl rounded-[2.5rem] border border-white/10 bg-white/[0.035] p-10 text-center shadow-2xl backdrop-blur-2xl sm:p-16">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl border border-cyan-300/15 bg-cyan-300/10 text-cyan-200">
          {error ? <LinkBreakIcon className="h-10 w-10" weight="fill" /> : <MonitorPlayIcon className="h-10 w-10" weight="fill" />}
        </div>
        <p className="mt-8 text-sm font-semibold uppercase tracking-[0.24em] text-cyan-200/70">Hexclave TV Mode</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-[-0.045em] sm:text-6xl">Launch TV Mode</h1>
        <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-white/45 sm:text-lg">
          Open TV Mode in the Hexclave dashboard, choose Pair Display, and enter this secure code to connect the screen.
        </p>
        <div className="mt-10 rounded-3xl border border-white/10 bg-black/30 px-6 py-8">
          {code == null ? (
            <div className="flex items-center justify-center gap-3 text-white/55">
              <BroadcastIcon className="h-5 w-5 animate-pulse motion-reduce:animate-none" weight="fill" />
              {error ? "We couldn’t create a pairing code. Retrying automatically…" : "Preparing a secure pairing code…"}
            </div>
          ) : (
            <>
              <p className="font-mono text-[clamp(2.5rem,8vw,5.5rem)] font-semibold tracking-[0.12em] text-white">
                {code.slice(0, 4)}-{code.slice(4)}
              </p>
              {error ? <p className="mt-3 text-sm text-amber-200/70">Connection interrupted. Retrying automatically…</p> : null}
            </>
          )}
        </div>
        <p className="mt-6 text-sm text-white/30">Codes expire after 10 minutes. Project data stays unavailable until an administrator approves this display.</p>
      </div>
    </main>
  );
}

export default function IndependentTvPageClient() {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<TvDisplayPairingChallenge | null>(null);
  const [pairingError, setPairingError] = useState(false);
  const [pairingRetryAttempt, setPairingRetryAttempt] = useState(0);
  const pairingPollInFlight = useRef(false);
  const pairingRestoreInFlight = useRef<Promise<void> | null>(null);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

  const refreshAccess = useCallback(async (): Promise<string | null> => {
    const response = await jsonRequestWithTimeout("/tv-displays/auth/refresh", { method: "POST" });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error("TV display credential could not be refreshed.");
    const body = await response.json();
    if (typeof body !== "object" || body == null || !("accessToken" in body) || typeof body.accessToken !== "string") {
      throw new Error("TV display refresh response is invalid.");
    }
    setAccessToken(body.accessToken);
    return body.accessToken;
  }, []);

  const createChallenge = useCallback(async () => {
    setPairingError(false);
    const response = await jsonRequestWithTimeout("/tv-displays/pairing-challenges", { method: "POST" });
    if (!response.ok) throw new Error("TV display pairing challenge could not be created.");
    const next = await TvDisplayPairingChallengeSchema.validate(await response.json(), { strict: true });
    setChallenge(next);
    return next;
  }, []);

  const restoreOrCreatePairing = useCallback(async () => {
    if (pairingRestoreInFlight.current != null) {
      return await pairingRestoreInFlight.current;
    }
    const restore = (async () => {
      const refreshed = await refreshAccess();
      if (refreshed == null) await createChallenge();
    })();
    pairingRestoreInFlight.current = restore;
    try {
      await restore;
    } finally {
      if (pairingRestoreInFlight.current === restore) pairingRestoreInFlight.current = null;
    }
  }, [createChallenge, refreshAccess]);

  useEffect(() => {
    let active = true;
    runAsynchronously(async () => {
      try {
        await restoreOrCreatePairing();
      } catch {
        if (active) {
          setPairingError(true);
          setPairingRetryAttempt((attempt) => attempt + 1);
        }
      }
    });
    return () => {
      active = false;
    };
  }, [restoreOrCreatePairing]);

  useEffect(() => {
    if (!pairingError || challenge != null || accessToken != null) return;
    const retry = async () => {
      try {
        await restoreOrCreatePairing();
      } catch {
        setPairingError(true);
        setPairingRetryAttempt((attempt) => attempt + 1);
      }
    };
    const timeout = window.setTimeout(() => runAsynchronously(retry()), PAIRING_RETRY_INTERVAL_MS);
    return () => window.clearTimeout(timeout);
  }, [accessToken, challenge, pairingError, pairingRetryAttempt, restoreOrCreatePairing]);

  useEffect(() => {
    if (challenge == null || accessToken != null) return;
    let active = true;
    let activePollController: AbortController | null = null;
    const poll = async () => {
      if (pairingPollInFlight.current) return;
      pairingPollInFlight.current = true;
      const controller = new AbortController();
      activePollController = controller;
      const timeout = window.setTimeout(() => controller.abort(), PAIRING_STATUS_TIMEOUT_MS);
      try {
        const response = await jsonRequest(`/tv-displays/pairing-challenges/${encodeURIComponent(challenge.challengeId)}/status`, {
          method: "POST",
          body: JSON.stringify({ deviceSecret: challenge.deviceSecret }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("TV display pairing status could not be loaded.");
        const result = await TvDisplayPairingStatusSchema.validate(await response.json(), { strict: true });
        if (!active) return;
        setPairingError(false);
        if (result.status === "paired") {
          setAccessToken(result.accessToken);
          setChallenge(null);
        } else if (result.status !== "waiting") {
          setChallenge(null);
          try {
            await createChallenge();
          } catch (cause) {
            setPairingError(true);
            setPairingRetryAttempt((attempt) => attempt + 1);
            throw cause;
          }
        }
      } catch {
        if (active) setPairingError(true);
      } finally {
        window.clearTimeout(timeout);
        if (activePollController === controller) activePollController = null;
        if (active) pairingPollInFlight.current = false;
      }
    };
    const interval = window.setInterval(() => runAsynchronously(poll()), challenge.pollingIntervalSeconds * 1000);
    runAsynchronously(poll());
    return () => {
      active = false;
      activePollController?.abort();
      pairingPollInFlight.current = false;
      window.clearInterval(interval);
    };
  }, [accessToken, challenge, createChallenge]);

  const loadSnapshot = useCallback(async (signal: AbortSignal) => {
    const currentAccessToken = accessTokenRef.current;
    if (currentAccessToken == null) throw new Error("TV display access token is unavailable.");
    let token = currentAccessToken;
    let response = await jsonRequest("/tv-displays/snapshot", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (response.status === 401) {
      const refreshed = await refreshAccess();
      if (refreshed == null) {
        setAccessToken(null);
        // Clearing the credential disables polling and aborts this snapshot
        // request. Pairing recovery must outlive that poll-owned signal.
        try {
          await createChallenge();
        } catch (cause) {
          setPairingError(true);
          setPairingRetryAttempt((attempt) => attempt + 1);
          throw cause;
        }
        throw new Error("TV display credential was revoked or expired.");
      }
      token = refreshed;
      response = await jsonRequest("/tv-displays/snapshot", {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal,
      });
    }
    if (!response.ok) {
      if (response.status === 401) throw new TvSnapshotRequestError(401);
      throw new Error(`TV display snapshot failed with ${response.status}.`);
    }
    const next = await TvSnapshotSchema.validate(await response.json(), { strict: true });
    return next;
  }, [createChallenge, refreshAccess]);

  const liveSnapshot = useTvSnapshotPolling({
    loadSnapshot,
    enabled: accessToken != null,
    sourceKey: "independent-display",
  });

  if (accessToken == null) return <PairingScreen challenge={challenge} error={pairingError} />;
  return (
    <TvPresentation
      snapshot={liveSnapshot.snapshot}
      loading={liveSnapshot.loading}
      unavailableReason={liveSnapshot.unavailableReason}
    />
  );
}
