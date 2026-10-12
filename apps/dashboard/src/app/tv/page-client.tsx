"use client";

import { TvPresentation } from "@/components/tv-mode/tv-presentation";
import { DesignCard } from "@/components/design-components/card";
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
import { withTvRequestDeadline } from "../../../public/tv-box/request.mjs";
import styles from "./pairing-screen.module.css";

const PAIRING_RETRY_INTERVAL_MS = 5_000;
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

async function jsonRequestWithTimeout(path: string, options: RequestInit): Promise<{ response: Response, body: unknown }> {
  return await withTvRequestDeadline(async (signal) => {
    const response = await jsonRequest(path, { ...options, signal });
    const body: unknown = response.ok ? await response.json() : null;
    return { response, body };
  }, PAIRING_REQUEST_TIMEOUT_MS, options.signal);
}

export function PairingScreen({ challenge, error }: { challenge: TvDisplayPairingChallenge | null, error: boolean }) {
  const code = challenge?.pairingCode;
  return (
    <main className={styles.stage}>
      <DesignCard glassmorphic={false} className={`${styles.card} bg-transparent text-foreground`} contentClassName={styles.content}>
        <div className={styles.icon} aria-hidden="true">
          {error ? <LinkBreakIcon weight="fill" /> : <MonitorPlayIcon weight="fill" />}
        </div>
        <p className={styles.kicker}>Hexclave TV Mode</p>
        <h1 className={styles.title}>Launch TV Mode</h1>
        <p className={styles.copy}>
          Open TV Mode in the Hexclave dashboard, choose Pair Display, and enter this secure code to connect the screen.
        </p>
        <div className={styles.codePanel} aria-live="polite" aria-atomic="true">
          {code == null ? (
            <div className={styles.pending}>
              <BroadcastIcon className="h-5 w-5 shrink-0" weight="fill" aria-hidden="true" />
              {error ? "We couldn’t create a pairing code. Retrying automatically…" : "Preparing a secure pairing code…"}
            </div>
          ) : (
            <>
              <p className={styles.code}>
                {code.slice(0, 4)}-{code.slice(4)}
              </p>
              {error ? <p className={styles.warning}>Connection interrupted. Retrying automatically…</p> : null}
            </>
          )}
        </div>
        <p className={styles.footnote}>Codes expire after 10 minutes. Project data stays unavailable until an administrator approves this display.</p>
      </DesignCard>
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
  const pairingCreationInFlight = useRef<Promise<TvDisplayPairingChallenge | null> | null>(null);
  const pairingGeneration = useRef(0);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

  const refreshAccess = useCallback(async (signal?: AbortSignal): Promise<string | null> => {
    const { response, body } = await jsonRequestWithTimeout("/tv-displays/auth/refresh", { method: "POST", signal });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error("TV display credential could not be refreshed.");
    if (typeof body !== "object" || body == null || !("accessToken" in body) || typeof body.accessToken !== "string") {
      throw new Error("TV display refresh response is invalid.");
    }
    setAccessToken(body.accessToken);
    return body.accessToken;
  }, []);

  const createChallenge = useCallback(async () => {
    if (pairingCreationInFlight.current != null) return await pairingCreationInFlight.current;
    const generation = pairingGeneration.current;
    const creation = (async () => {
      setPairingError(false);
      const { response, body } = await jsonRequestWithTimeout("/tv-displays/pairing-challenges", { method: "POST" });
      if (!response.ok) throw new Error("TV display pairing challenge could not be created.");
      const next = await TvDisplayPairingChallengeSchema.validate(body, { strict: true });
      if (generation !== pairingGeneration.current) return null;
      setChallenge(next);
      return next;
    })();
    pairingCreationInFlight.current = creation;
    try {
      return await creation;
    } finally {
      if (pairingCreationInFlight.current === creation) pairingCreationInFlight.current = null;
    }
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
    const generation = pairingGeneration.current;
    let activePollController: AbortController | null = null;
    const poll = async () => {
      if (pairingPollInFlight.current) return;
      pairingPollInFlight.current = true;
      const controller = new AbortController();
      activePollController = controller;
      try {
        const { response, body } = await jsonRequestWithTimeout(`/tv-displays/pairing-challenges/${encodeURIComponent(challenge.challengeId)}/status`, {
          method: "POST",
          body: JSON.stringify({ deviceSecret: challenge.deviceSecret }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("TV display pairing status could not be loaded.");
        const result = await TvDisplayPairingStatusSchema.validate(body, { strict: true });
        if (!active || generation !== pairingGeneration.current) return;
        setPairingError(false);
        if (result.status === "paired") {
          pairingGeneration.current += 1;
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
      const refreshed = await refreshAccess(signal);
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
