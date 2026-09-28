"use client";

import {
  ArrowSquareOutIcon,
  BroadcastIcon,
  CopyIcon,
  EyeIcon,
  EyeSlashIcon,
  GearSixIcon,
  MonitorIcon,
  MonitorPlayIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import type { TvProfileResource } from "@hexclave/shared/dist/interface/admin-tv-mode";
import { useEffect, useState } from "react";
import { DesignAlert, DesignBadge, DesignCard } from "@/components/design-components";
import { Link } from "@/components/link";
import { useTvPresentationLauncher } from "@/components/tv-mode/presentation-window";
import { Typography } from "@/components/ui";
import { fetchTvProfilesOrThrow } from "@/lib/hexclave-app-internals";
import { getTvScreenDefinition } from "@/components/tv-mode/screen-registry";
import { getTvProfileEventCoverageLabel, getTvProfileOverviewAction } from "@/lib/tv-mode/profile-editor-copy";
import { PageLayout } from "../page-layout";
import { useAdminApp, useProjectId } from "../use-admin-app";

function actionLinkClass(variant: "primary" | "secondary"): string {
  return variant === "primary"
    ? "inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-foreground px-4 text-sm font-medium text-background transition-opacity duration-150 hover:opacity-90 hover:transition-none"
    : "inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-foreground/[0.1] bg-foreground/[0.035] px-4 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-foreground/[0.07] hover:transition-none";
}

export default function PageClient() {
  const projectId = useProjectId();
  const adminApp = useAdminApp();
  const { launchPresentation, popupBlocked } = useTvPresentationLauncher(projectId);
  const [profiles, setProfiles] = useState<TvProfileResource[] | null>(null);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [persistenceReady, setPersistenceReady] = useState(true);

  useEffect(() => {
    let active = true;
    runAsynchronously(async () => {
      try {
        const result = await fetchTvProfilesOrThrow(adminApp);
        if (!active) return;
        setProfiles([...result.savedProfiles, ...result.templates]);
        setLoadedProjectId(projectId);
        setPersistenceReady(result.persistenceReady);
        setLoadError(false);
      } catch {
        if (active) {
          setProfiles(null);
          setLoadedProjectId(projectId);
          setPersistenceReady(true);
          setLoadError(true);
        }
      }
    });
    return () => {
      active = false;
    };
  }, [adminApp, projectId]);
  const visibleProfiles = loadedProjectId === projectId ? profiles : null;
  const visibleLoadError = loadedProjectId === projectId && loadError;

  return (
    <PageLayout
      title="Profiles"
      description="Create and manage the presentation profiles shown on shared displays."
      allowContentOverflow
      actions={
        <div className="flex flex-wrap gap-2">
          <Link href={urlString`/projects/${projectId}/tv-mode/displays`} className={actionLinkClass("secondary")}>
            <MonitorIcon className="h-4 w-4" weight="fill" />
            Manage Displays
          </Link>
          <Link href={urlString`/projects/${projectId}/tv-mode/profiles/company-pulse?create=1`} className={actionLinkClass("secondary")}>
            <PlusIcon className="h-4 w-4" weight="bold" />
            New Profile
          </Link>
        </div>
      }
    >
      <DesignAlert
        variant="info"
        title="Project Presentation Profiles"
        description="Choose a ready-to-use template or create a profile tailored to this project."
      />
      {loadedProjectId === projectId && !persistenceReady ? <DesignAlert variant="error" title="Profile Storage Isn’t Ready" description="TV Mode needs its profile storage update before you can save changes." /> : null}
      {visibleLoadError ? <DesignAlert variant="error" title="Profiles Couldn’t Be Loaded" description="Refresh the page to try again. Your existing profiles and presentations are unchanged." /> : null}
      {popupBlocked ? (
        <DesignAlert
          variant="error"
          title="TV Presentation Was Blocked"
          description="Allow popups for this dashboard, then start TV Mode again. This page will remain open."
        />
      ) : null}

      <div className="space-y-4">
        {visibleProfiles == null && !visibleLoadError ? (
          <DesignCard gradient="default" glassmorphic>
            <Typography variant="secondary">Loading Presentation Profiles…</Typography>
          </DesignCard>
        ) : null}
        {visibleProfiles?.map((profile) => {
          const configuration = profile.configuration;
          const enabledScreens = configuration.playlist;
          return (
            <DesignCard key={profile.id} gradient="default" glassmorphic>
              <div className="flex flex-col gap-5 p-1">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 items-start gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-cyan-500/10 text-cyan-600 ring-1 ring-cyan-500/15 dark:text-cyan-300">
                      <MonitorPlayIcon className="h-6 w-6" weight="fill" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Typography className="text-base font-semibold text-foreground">{configuration.displayName}</Typography>
                        <DesignBadge label={profile.origin === "built-in" ? "Template" : "Saved"} color={profile.origin === "built-in" ? "blue" : "green"} size="sm" />
                      </div>
                      <Typography variant="secondary" className="mt-1 text-sm">{configuration.description}</Typography>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Link
                      href={profile.origin === "built-in"
                        ? urlString`/projects/${projectId}/tv-mode/profiles/${profile.id}?create=1`
                        : urlString`/projects/${projectId}/tv-mode/profiles/${profile.id}`}
                      className={actionLinkClass("secondary")}
                    >
                      {profile.origin === "built-in"
                        ? <CopyIcon className="h-4 w-4" />
                        : <GearSixIcon className="h-4 w-4" />}
                      {getTvProfileOverviewAction(profile.origin)}
                    </Link>
                    <button
                      type="button"
                      onClick={() => launchPresentation(urlString`/projects/${projectId}/tv-mode/present/${profile.id}`)}
                      className={actionLinkClass("primary")}
                    >
                      <BroadcastIcon className="h-4 w-4" weight="fill" />
                      Start TV Mode
                      <ArrowSquareOutIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 border-t border-foreground/[0.06] pt-4 sm:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Screens</p>
                    <p className="mt-1 text-sm font-medium text-foreground">{enabledScreens.length} Enabled</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Rotation</p>
                    <p className="mt-1 text-sm font-medium text-foreground">{configuration.defaultDurationSeconds} Seconds</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Event Coverage</p>
                    <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
                      <BroadcastIcon className="h-4 w-4 text-cyan-500" weight="fill" />
                      {getTvProfileEventCoverageLabel(configuration.interruptionPreferences)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Financial Values</p>
                    <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
                      {configuration.financialVisibility === "exact"
                        ? <EyeIcon className="h-4 w-4 text-emerald-500" weight="fill" />
                        : <EyeSlashIcon className="h-4 w-4 text-muted-foreground" weight="fill" />}
                      {configuration.financialVisibility === "exact" ? "Shown" : "Hidden"}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {enabledScreens.map((entry) => {
                    const definition = getTvScreenDefinition(entry.screenId);
                    const Icon = definition.icon;
                    return (
                      <span key={entry.screenId} className="inline-flex items-center gap-1.5 rounded-lg bg-foreground/[0.04] px-2.5 py-1.5 text-xs text-muted-foreground ring-1 ring-foreground/[0.06]">
                        <Icon className="h-3.5 w-3.5" weight="fill" />
                        {definition.displayName}
                      </span>
                    );
                  })}
                </div>
              </div>
            </DesignCard>
          );
        })}
      </div>
    </PageLayout>
  );
}
