"use client";

import { useStackApp, useUser } from "@hexclave/next";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { Button, Card, Typography } from "@hexclave/ui";
import { useCallback, useEffect, useState } from "react";
import { captureConversionEvent, getFeatureFlagValue } from "./feature-flag-client";

const FLAG_KEY = "demo-checkout-redesign";

type FlagState =
  | { status: "loading" }
  | { status: "error", message: string }
  | { status: "ready", value: boolean, source: "flag" | "fallback" };

type ConversionState =
  | { status: "idle" }
  | { status: "recording" }
  | { status: "recorded" }
  | { status: "undelivered" }
  | { status: "error", message: string };

function FallbackNotice() {
  return (
    <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-800">
      <Typography variant="secondary" className="text-sm text-yellow-700 dark:text-yellow-400">
        ⚠️ The Feature Flags SDK isn&apos;t available in this build, so you are seeing the
        explicit fallback value <code className="font-mono">false</code> that this page passed
        to <code className="font-mono">getFeatureFlag</code>. This is not a real flag
        evaluation — nothing is silently defaulting; the fallback state is surfaced on purpose.
      </Typography>
    </div>
  );
}

function CheckoutPreview({ flagValue }: { flagValue: boolean }) {
  return flagValue ? (
    <Card className="p-6 border-2 border-green-300 dark:border-green-700">
      <div className="flex items-center justify-between mb-2">
        <Typography variant="primary" className="text-lg font-semibold">
          🛒 New checkout
        </Typography>
        <span className="rounded bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300 px-2 py-0.5 text-xs font-medium">
          {FLAG_KEY} = true
        </span>
      </div>
      <Typography variant="secondary" className="text-sm text-gray-500">
        This is the redesigned one-page checkout that the flag rolls out. Users in this
        variant see the streamlined flow.
      </Typography>
    </Card>
  ) : (
    <Card className="p-6 border-2 border-gray-300 dark:border-gray-700">
      <div className="flex items-center justify-between mb-2">
        <Typography variant="primary" className="text-lg font-semibold">
          🧾 Classic checkout
        </Typography>
        <span className="rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-2 py-0.5 text-xs font-medium">
          {FLAG_KEY} = false
        </span>
      </div>
      <Typography variant="secondary" className="text-sm text-gray-500">
        This is the existing multi-step checkout. Users outside the rollout (and this
        page&apos;s explicit fallback) see this variant.
      </Typography>
    </Card>
  );
}

export default function FeatureFlagsDemoPage() {
  const app = useStackApp();
  const user = useUser();

  const [flagState, setFlagState] = useState<FlagState>({ status: "loading" });
  const [conversionState, setConversionState] = useState<ConversionState>({ status: "idle" });

  const loadFlag = useCallback(async () => {
    setFlagState({ status: "loading" });
    try {
      const result = await getFeatureFlagValue(app, FLAG_KEY, { fallback: false });
      setFlagState({ status: "ready", value: result.value, source: result.source });
    } catch (error) {
      // Surfaced in the red error banner below (with a Retry button) — not swallowed.
      setFlagState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [app]);

  useEffect(() => {
    runAsynchronouslyWithAlert(loadFlag());
  }, [loadFlag]);

  const recordConversion = useCallback(async () => {
    if (flagState.status !== "ready") {
      // The button is only rendered in the "ready" state, so this should be unreachable.
      throw new Error("Cannot record a conversion before the flag has been evaluated");
    }
    setConversionState({ status: "recording" });
    try {
      const result = await captureConversionEvent(app, "purchase-completed", {
        value: 49.99,
        variant: flagState.value ? "new-checkout" : "classic-checkout",
      });
      setConversionState(result.delivered ? { status: "recorded" } : { status: "undelivered" });
    } catch (error) {
      // Surfaced inline below the button — not swallowed.
      setConversionState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [app, flagState]);

  return (
    <div className="stack-scope min-h-screen flex justify-center p-4 md:p-8">
      <div className="max-w-2xl w-full mx-auto space-y-6">
        <div className="text-center">
          <Typography variant="primary" className="text-2xl font-bold mb-2">
            🚩 Feature Flags Demo
          </Typography>
          <Typography variant="secondary" className="text-gray-500">
            Evaluates the boolean flag <code className="font-mono">{FLAG_KEY}</code> and records
            a conversion event against the evaluated variant.
          </Typography>
        </div>

        {flagState.status === "loading" && (
          <Card className="p-8 text-center">
            <Typography variant="secondary" className="text-gray-500 animate-pulse">
              Loading flag…
            </Typography>
          </Card>
        )}

        {flagState.status === "error" && (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800 flex flex-col gap-3">
            <Typography variant="secondary" className="text-sm text-red-700 dark:text-red-400">
              ❌ Failed to evaluate flag: {flagState.message}
            </Typography>
            <div>
              <Button variant="outline" onClick={async () => await loadFlag()}>
                Retry
              </Button>
            </div>
          </div>
        )}

        {flagState.status === "ready" && (
          <>
            {flagState.source === "fallback" && <FallbackNotice />}

            <CheckoutPreview flagValue={flagState.value} />

            <Card className="p-6">
              <Typography variant="primary" className="text-lg font-semibold mb-2">
                Conversion tracking
              </Typography>
              <Typography variant="secondary" className="text-sm text-gray-500 mb-4">
                Completing the purchase captures a <code className="font-mono">purchase-completed</code>{" "}
                event with the purchase value and the checkout variant you were shown, so the
                experiment can compare conversion rates per variant.
              </Typography>
              <div className="flex items-center gap-3 flex-wrap">
                <Button
                  disabled={conversionState.status === "recording"}
                  onClick={async () => await recordConversion()}
                >
                  {conversionState.status === "recording" ? "Recording…" : "Complete purchase ($49.99)"}
                </Button>
                {conversionState.status === "recorded" && (
                  <span className="text-sm text-green-700 dark:text-green-400">
                    ✅ Conversion recorded
                  </span>
                )}
              </div>
              {conversionState.status === "undelivered" && (
                <div className="mt-3 p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-800">
                  <Typography variant="secondary" className="text-sm text-yellow-700 dark:text-yellow-400">
                    ⚠️ The event could not be delivered because the Feature Flags SDK
                    (<code className="font-mono">app.trackEvent</code>) isn&apos;t available in this
                    build. Nothing was sent — this is surfaced instead of silently dropped.
                  </Typography>
                </div>
              )}
              {conversionState.status === "error" && (
                <div className="mt-3 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
                  <Typography variant="secondary" className="text-sm text-red-700 dark:text-red-400">
                    ❌ Failed to record conversion: {conversionState.message}
                  </Typography>
                </div>
              )}
            </Card>
          </>
        )}

        <Card className="p-4">
          <Typography variant="primary" className="text-sm font-semibold mb-1">
            {user ? `Signed in as ${user.displayName ?? user.primaryEmail ?? user.id}` : "Browsing anonymously"}
          </Typography>
          <Typography variant="secondary" className="text-sm text-gray-500">
            Flags evaluate for anonymous visitors too — you don&apos;t need to sign in for this
            page to work. Targeting rules that reference user attributes simply treat those
            attributes as absent for anonymous visitors.
          </Typography>
        </Card>
      </div>
    </div>
  );
}
