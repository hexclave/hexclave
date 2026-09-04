"use client";

import { DevErrorNotifier } from "@/components/dev-error-notifier";
import { RouterProvider } from "@/components/router";
import { SiteLoadingIndicatorDisplay } from "@/components/site-loading-indicator";
import { Toaster, TooltipProvider } from "@/components/ui";
import { VersionAlerter } from "@/components/version-alerter";
import { getPublicEnvVar } from "@/lib/env";
import { hexclaveClientApp } from "@/hexclave/client";
import { StackProvider, StackTheme } from "@hexclave/next";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { usePathname } from "next/navigation";
import React, { useSyncExternalStore } from "react";
import { BackgroundShine } from "./background-shine";
import { ClientPolyfill } from "./client-polyfill";
import { DevelopmentPortDisplay } from "./development-port-display";
import Loading from "./loading";
import { UserIdentity } from "./providers";
import { fetchWithRemoteDevelopmentEnvironmentBrowserSecret, RemoteDevelopmentEnvironmentBrowserSecretRedirectingError } from "./remote-development-environment-browser-secret-client";
import { RemoteDevelopmentEnvironmentAuthGate } from "./remote-development-environment-auth-gate";
import { WrongAddressScreen } from "./wrong-address-screen";
import { isTvPresentationPath } from "@/lib/tv-mode/routes";

const DEV_ENVIRONMENT_HEALTHCHECK_INTERVAL_MS = 2_000;
type DevEnvironmentHealthSnapshot =
  | { status: "checking" | "healthy" }
  | { status: "unhealthy", restartCommand: string }
  | { status: "wrong_address", suggestedUrl: string };

const CHECKING_DEV_ENVIRONMENT_HEALTH_SNAPSHOT: DevEnvironmentHealthSnapshot = { status: "checking" };
const HEALTHY_DEV_ENVIRONMENT_HEALTH_SNAPSHOT: DevEnvironmentHealthSnapshot = { status: "healthy" };

function isDevEnvironmentHealthResponse(value: unknown): value is { ok: boolean, restart_command: string } {
  return (
    value != null &&
    typeof value === "object" &&
    "ok" in value &&
    typeof value.ok === "boolean" &&
    "restart_command" in value &&
    typeof value.restart_command === "string"
  );
}

let devEnvironmentHealthSnapshot: DevEnvironmentHealthSnapshot = CHECKING_DEV_ENVIRONMENT_HEALTH_SNAPSHOT;
const devEnvironmentHealthSubscribers = new Set<() => void>();
let devEnvironmentHealthTimer: ReturnType<typeof setInterval> | undefined;
let devEnvironmentHealthRequestSequence = 0;

function setDevEnvironmentHealthSnapshot(snapshot: DevEnvironmentHealthSnapshot) {
  devEnvironmentHealthSnapshot = snapshot;
  for (const subscriber of devEnvironmentHealthSubscribers) {
    subscriber();
  }
}

async function refreshDevEnvironmentHealth() {
  const requestSequence = ++devEnvironmentHealthRequestSequence;
  const setSnapshotIfCurrent = (snapshot: DevEnvironmentHealthSnapshot) => {
    if (requestSequence === devEnvironmentHealthRequestSequence) {
      setDevEnvironmentHealthSnapshot(snapshot);
    }
  };

  try {
    const response = await fetchWithRemoteDevelopmentEnvironmentBrowserSecret("/api/development-environment/health", {
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    });
    const body: unknown = await response.json();

    // If the health endpoint returns a 403, the user is likely accessing via
    // an unsupported address (e.g. localhost instead of 127.0.0.1). Extract
    // the suggested URL from the error and show a dedicated screen.
    if (response.status === 403 && body != null && typeof body === "object" && "error" in body && typeof body.error === "string") {
      const match = body.error.match(/http:\/\/127\.0\.0\.1(?::\d+)?/);
      if (match != null) {
        setSnapshotIfCurrent({ status: "wrong_address", suggestedUrl: match[0] });
        return;
      }
    }

    if (!isDevEnvironmentHealthResponse(body)) {
      throw new Error("Development environment health endpoint returned an invalid response.");
    }

    setSnapshotIfCurrent(body.ok && response.ok
      ? HEALTHY_DEV_ENVIRONMENT_HEALTH_SNAPSHOT
      : { status: "unhealthy", restartCommand: body.restart_command });
  } catch (error) {
    if (error instanceof RemoteDevelopmentEnvironmentBrowserSecretRedirectingError) {
      return;
    }
    setSnapshotIfCurrent({
      status: "unhealthy",
      restartCommand: "hexclave dev --config-file <path-to-hexclave.config.ts> -- <your app command>",
    });
  }
}

function subscribeDevEnvironmentHealth(callback: () => void) {
  devEnvironmentHealthSubscribers.add(callback);
  if (devEnvironmentHealthSubscribers.size === 1) {
    setDevEnvironmentHealthSnapshot(CHECKING_DEV_ENVIRONMENT_HEALTH_SNAPSHOT);
    runAsynchronouslyWithAlert(refreshDevEnvironmentHealth());
    devEnvironmentHealthTimer = setInterval(() => {
      runAsynchronouslyWithAlert(refreshDevEnvironmentHealth());
    }, DEV_ENVIRONMENT_HEALTHCHECK_INTERVAL_MS);
  }

  return () => {
    devEnvironmentHealthSubscribers.delete(callback);
    if (devEnvironmentHealthSubscribers.size === 0 && devEnvironmentHealthTimer !== undefined) {
      clearInterval(devEnvironmentHealthTimer);
      devEnvironmentHealthTimer = undefined;
    }
  };
}

function getDevEnvironmentHealthSnapshot() {
  return devEnvironmentHealthSnapshot;
}

function getServerDevEnvironmentHealthSnapshot(): DevEnvironmentHealthSnapshot {
  return CHECKING_DEV_ENVIRONMENT_HEALTH_SNAPSHOT;
}

function subscribeHealthyDevEnvironment(_callback: () => void) {
  return () => {};
}

function getHealthyDevEnvironmentSnapshot(): DevEnvironmentHealthSnapshot {
  return HEALTHY_DEV_ENVIRONMENT_HEALTH_SNAPSHOT;
}

function DevEnvironmentStoppedScreen(props: { restartCommand: string }) {
  return (
    <div className="relative z-10 min-h-screen bg-background text-foreground flex items-center justify-center px-4">
      <div className="w-full max-w-lg rounded-2xl border border-black/[0.10] dark:border-white/[0.10] bg-white dark:bg-background p-6 shadow-sm">
        <div className="mb-3 inline-flex rounded-full bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-700 dark:text-blue-300">
          Development environment paused
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">The dev environment is not currently running</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Your Hexclave changes have been saved. The local Hexclave development environment just is not active right now, so the dashboard has paused instead of showing stale project data.
        </p>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          Restart it from your terminal with:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-black/[0.04] dark:bg-white/[0.06] px-3 py-2 text-sm"><code>{props.restartCommand}</code></pre>
      </div>
    </div>
  );
}

function DevEnvironmentHealthGate(props: { children: React.ReactNode, disabled?: boolean }) {
  const isRemoteDevelopmentEnvironment = getPublicEnvVar("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT") === "true";
  const shouldCheckHealth = props.disabled !== true && isRemoteDevelopmentEnvironment;
  const health = useSyncExternalStore(
    shouldCheckHealth ? subscribeDevEnvironmentHealth : subscribeHealthyDevEnvironment,
    shouldCheckHealth ? getDevEnvironmentHealthSnapshot : getHealthyDevEnvironmentSnapshot,
    shouldCheckHealth ? getServerDevEnvironmentHealthSnapshot : getHealthyDevEnvironmentSnapshot,
  );

  if (!shouldCheckHealth) {
    return props.children;
  }

  if (health.status === "wrong_address") {
    return <WrongAddressScreen suggestedUrl={health.suggestedUrl} />;
  }

  if (health.status === "unhealthy") {
    return <DevEnvironmentStoppedScreen restartCommand={health.restartCommand} />;
  }

  if (health.status === "checking") {
    return <Loading />;
  }

  return props.children;
}

export default function DashboardLayoutClient(props: {
  children: React.ReactNode,
  translationLocale?: string,
}) {
  const pathname = usePathname();
  const isBrowserSecretAuthorizationPage = pathname === "/development-environment/browser-secret";
  const isTvPresentationPage = isTvPresentationPath(pathname);
  const bypassDevelopmentEnvironmentGates = isBrowserSecretAuthorizationPage;

  return (
    <>
      <StackProvider app={hexclaveClientApp} lang={props.translationLocale as React.ComponentProps<typeof StackProvider>["lang"]}>
        <StackTheme>
          <TooltipProvider>
            <ClientPolyfill />
            <DevEnvironmentHealthGate disabled={bypassDevelopmentEnvironmentGates}>
              <RemoteDevelopmentEnvironmentAuthGate disabled={bypassDevelopmentEnvironmentGates}>
                <RouterProvider>
                  <UserIdentity />
                  {isTvPresentationPage ? null : <VersionAlerter />}
                  {isTvPresentationPage ? null : <BackgroundShine />}
                  {props.children}
                  {isTvPresentationPage ? null : <DevelopmentPortDisplay />}
                </RouterProvider>
              </RemoteDevelopmentEnvironmentAuthGate>
            </DevEnvironmentHealthGate>
          </TooltipProvider>
        </StackTheme>
      </StackProvider>
      <DevErrorNotifier />
      <Toaster />
      <SiteLoadingIndicatorDisplay />
    </>
  );
}
