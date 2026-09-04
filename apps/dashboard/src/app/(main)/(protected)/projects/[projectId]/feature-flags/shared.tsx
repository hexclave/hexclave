"use client";

import { DesignAlert, DesignBadge, DesignButton, DesignCard, DesignEmptyState, DesignInput, type DesignBadgeColor } from "@/components/design-components";
import { useRouter } from "@/components/router";
import { isAppEnabled } from "@/lib/apps-utils";
import type { ExperimentRunStatus } from "@/lib/feature-flags/admin-adapter";
import { ChartLineIcon } from "@phosphor-icons/react";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import type { ReactNode } from "react";
import {
  bpsToPercentText,
  parseFeatureFlagsSection,
  percentToBps,
  type FeatureFlagsSection,
  type FlagStatus,
} from "@/lib/feature-flags/config";
import { FeatureFlagsBackendUnavailableError } from "@/lib/feature-flags/admin-adapter";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useId, useMemo, useState } from "react";
import { useAdminApp } from "../use-admin-app";

/**
 * Reads and parses the featureFlags config section for the current project.
 * All feature-flags pages read config exclusively through this hook so the
 * parse boundary stays in one place.
 */
export function useFeatureFlagsSection(): FeatureFlagsSection {
  const adminApp = useAdminApp();
  const config = adminApp.useProject().useConfig();
  return useMemo(() => parseFeatureFlagsSection(config), [config]);
}

export const FLAG_STATUS_BADGE: ReadonlyMap<FlagStatus, { label: string, color: DesignBadgeColor }> = new Map([
  ["enabled", { label: "Enabled", color: "green" }],
  ["disabled", { label: "Disabled", color: "blue" }],
  ["killed", { label: "Killed", color: "red" }],
  ["archived", { label: "Archived", color: "orange" }],
]);

export function FlagStatusBadge({ status }: { status: FlagStatus }) {
  const badge = FLAG_STATUS_BADGE.get(status);
  if (badge == null) {
    // Exhaustive map + union type make this unreachable; keep the throw so a
    // new status added to the union cannot silently render nothing.
    throw new Error(`No badge mapping for flag status ${status}`);
  }
  return <DesignBadge label={badge.label} color={badge.color} size="sm" />;
}

/** Collision-resistant IDs for variants/rules/metrics inside config. */
export function generateShortId(prefix: string): string {
  return `${prefix}-${generateUuid().slice(0, 8)}`;
}

/**
 * Percentage input over a basis-point value. The config stores basis points
 * (see `@/lib/feature-flags/config`); users always see and type percentages.
 * Invalid intermediate input keeps the last valid bps value and shows an
 * inline error instead of clamping silently.
 */
export function PercentField(props: {
  label: string,
  bps: number,
  onBpsChange: (bps: number) => void,
  disabled?: boolean,
}) {
  const inputId = useId();
  const [text, setText] = useState(() => bpsToPercentText(props.bps));
  const [editing, setEditing] = useState(false);
  // Reflect external updates (e.g. discard) while the field is not focused.
  useEffect(() => {
    if (!editing) setText(bpsToPercentText(props.bps));
  }, [props.bps, editing]);
  const parsedBps = percentToBps(text);
  const isInvalid = parsedBps == null;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">{props.label}</label>
      <div className="flex items-center gap-2">
        <DesignInput
          id={inputId}
          size="sm"
          className="w-24"
          inputMode="decimal"
          value={text}
          disabled={props.disabled}
          aria-invalid={isInvalid}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChange={(event) => {
            setText(event.target.value);
            const bps = percentToBps(event.target.value);
            if (bps != null) props.onBpsChange(bps);
          }}
        />
        <span className="text-xs text-muted-foreground">%</span>
      </div>
      {isInvalid && (
        <span className="text-xs text-red-600 dark:text-red-400">Enter a percentage between 0 and 100.</span>
      )}
    </div>
  );
}

/**
 * Load-state machine for data served by the feature-flags admin adapter. The
 * "unavailable" state is distinct from "error": it means the backend
 * workstream's endpoints are not deployed on this server, which pages render
 * as an informational notice rather than a failure.
 */
export type AdapterLoadState<T> =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error", message: string }
  | { status: "ok", data: T };

export function useAdapterData<T>(load: () => Promise<T>, dependencies: readonly unknown[]): AdapterLoadState<T> & { reload: () => void } {
  const [state, setState] = useState<AdapterLoadState<T>>({ status: "loading" });
  const [reloadCounter, setReloadCounter] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    runAsynchronously(async () => {
      try {
        const data = await load();
        if (!cancelled) setState({ status: "ok", data });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof FeatureFlagsBackendUnavailableError) {
          setState({ status: "unavailable" });
          return;
        }
        captureError("feature-flags-adapter-load", error);
        setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    });
    return () => {
      cancelled = true;
    };
    // The caller-supplied dependency list intentionally replaces `load` (an
    // inline closure) as the effect key, mirroring how useMemo callers work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, reloadCounter]);

  return { ...state, reload: () => setReloadCounter((counter) => counter + 1) };
}

export function BackendUnavailableAlert(props: { what: string }) {
  return (
    <DesignAlert
      variant="info"
      title={`${props.what} not available yet`}
      description="This server does not expose the feature-flags data endpoints yet. Flag configuration still works — live data appears automatically once the backend supports it."
    />
  );
}

export const EXPERIMENT_STATUS_BADGE: ReadonlyMap<ExperimentRunStatus, { label: string, color: DesignBadgeColor }> = new Map([
  ["not_started", { label: "Not started", color: "blue" }],
  ["draft", { label: "Draft", color: "blue" }],
  ["scheduled", { label: "Scheduled", color: "cyan" }],
  ["running", { label: "Running", color: "green" }],
  ["paused", { label: "Paused", color: "orange" }],
  ["completed", { label: "Completed", color: "purple" }],
]);

export function ExperimentStatusBadge({ status }: { status: ExperimentRunStatus }) {
  const badge = EXPERIMENT_STATUS_BADGE.get(status);
  if (badge == null) {
    throw new Error(`No badge mapping for experiment status ${status}`);
  }
  return <DesignBadge label={badge.label} color={badge.color} size="sm" />;
}

/**
 * Experiments need the Analytics app: exposures and metric events flow through
 * the analytics pipeline, so without it there is nothing to measure. This
 * renders an explicit blocker (rather than empty charts) until Analytics is
 * enabled for the project.
 */
export function AnalyticsRequiredGuard({ children }: { children: ReactNode }) {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const config = project.useConfig();
  const router = useRouter();

  if (!isAppEnabled(config.apps.installed, "analytics")) {
    return (
      <DesignCard>
        <DesignEmptyState
          icon={ChartLineIcon}
          title="Experiments need the Analytics app"
          description="Experiment exposures and metrics (page views, clicks, funnels, and custom events) are collected through Analytics. Enable it to create and measure experiments — flags keep working without it."
        >
          <DesignButton
            size="sm"
            onClick={() => router.push(urlString`/projects/${project.id}/apps/analytics`)}
          >
            <ChartLineIcon className="h-4 w-4 mr-1" />
            Enable Analytics
          </DesignButton>
        </DesignEmptyState>
      </DesignCard>
    );
  }

  return <>{children}</>;
}

export function formatRelativeTime(iso: string): string {
  const diffMillis = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diffMillis / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function AdapterErrorAlert(props: { what: string, message: string }) {
  return (
    <DesignAlert
      variant="error"
      title={`Failed to load ${props.what}`}
      description={props.message}
    />
  );
}
