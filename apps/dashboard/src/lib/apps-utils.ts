"use client";

import { ALL_APPS_FRONTEND, hasNavigationItems } from "@/lib/apps-frontend";
import { ALL_APPS, expandAppSoftRequirements, getParentAppId, type AppId } from "@hexclave/shared/dist/apps/apps-config";
import type { EnvironmentConfigOverrideOverride } from "@hexclave/shared/dist/config/schema";

type InstalledAppConfig = {
  enabled?: boolean,
} | undefined;

export type InstalledAppsMap = Record<string, InstalledAppConfig>;

// Typed wide on purpose: any given app's stage is a single literal, so a
// narrowed lookup type would make each caller's null check read as
// "always true/false" and rot the moment that app's stage changes.
const STAGE_LABELS: Record<"alpha" | "beta" | "stable", string | null> = { alpha: "Alpha", beta: "Beta", stable: null };

/**
 * The badge text for an app's maturity, or null once it is stable (a "Stable"
 * badge on every page would be noise). Derived from the app registry so a page
 * header can't go stale when the app graduates.
 */
export function getAppStageLabel(appId: AppId): string | null {
  return STAGE_LABELS[ALL_APPS[appId].stage];
}

/**
 * Returns the apps that may be shown in discovery surfaces.
 *
 * Alpha apps stay hidden until explicitly enabled. Once enabled, they remain
 * visible so users can navigate to and manage functionality they already use.
 */
export function getAppIdsForListing(enabledAppIds: Iterable<AppId> = []): AppId[] {
  const enabledAppIdSet = new Set(enabledAppIds);
  return Object.keys(ALL_APPS)
    .filter((appId): appId is AppId => Object.prototype.hasOwnProperty.call(ALL_APPS, appId))
    .filter((appId) => ALL_APPS[appId].stage !== "alpha" || enabledAppIdSet.has(appId));
}

/** Get all app IDs that may be shown in discovery surfaces. */
export function getAllAvailableAppIds(): AppId[] {
  return getAppIdsForListing();
}

/**
 * Determines whether an app is enabled.
 * - Regular apps are enabled via their own config entry.
 * - Sub-apps are enabled when their parent app is enabled.
 */
export function isAppEnabled(installedApps: InstalledAppsMap, appId: AppId): boolean {
  const parentAppId = getParentAppId(appId);
  if (parentAppId != null) {
    return installedApps[parentAppId]?.enabled ?? false;
  }
  return installedApps[appId]?.enabled ?? false;
}

/**
 * Get all enabled app IDs using centralized enabled/sub-app logic.
 *
 * Unlike `getAllAvailableAppIds`, this intentionally includes alpha-stage apps
 * that are explicitly enabled. The alpha filter only gates *discovery*
 * (app store listing, onboarding wizard), not functionality.
 */
export function getEnabledAppIds(installedApps: InstalledAppsMap): AppId[] {
  return (Object.keys(ALL_APPS) as AppId[]).filter((appId) => isAppEnabled(installedApps, appId));
}

/**
 * Get enabled apps that expose sidebar/cmdk navigation items.
 */
export function getEnabledNavigableAppIds(installedApps: InstalledAppsMap): AppId[] {
  return getEnabledAppIds(installedApps).filter((appId) =>
    getParentAppId(appId) == null && hasNavigationItems(ALL_APPS_FRONTEND[appId])
  );
}

/**
 * Get uninstalled app IDs (available but not installed)
 */
export function getUninstalledAppIds(installedApps: AppId[]): AppId[] {
  const installedSet = new Set(installedApps);
  return getAllAvailableAppIds().filter(appId => !installedSet.has(appId));
}

/**
 * Enables an app together with its recursively recommended apps. These are
 * deliberately one-way defaults: disabling any app remains an independent
 * action because soft requirements are guidance, not config constraints.
 */
export function getAppEnableConfigUpdate(appId: AppId): EnvironmentConfigOverrideOverride {
  const update: EnvironmentConfigOverrideOverride = {};
  for (const enabledAppId of expandAppSoftRequirements([appId])) {
    update[`apps.installed.${enabledAppId}.enabled`] = true;
  }
  return update;
}
