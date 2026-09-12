"use client";

import type { TvProfileResource } from "@hexclave/shared/dist/interface/admin-tv-mode";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { ArrowSquareOutIcon, CopyIcon, MonitorIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { DesignAlert, DesignButton, DesignCard } from "@/components/design-components";
import { SimpleTooltip, toast } from "@/components/ui";
import { fetchTvProfilesOrThrow } from "@/lib/hexclave-app-internals";
import { getConfiguredTvDisplayUrl, isLocalTvDisplayUrl } from "@/lib/tv-mode/display-url";
import { PageLayout } from "../../page-layout";
import { useAdminApp, useProjectId } from "../../use-admin-app";
import { TvDisplayManagement } from "../display-management";

export default function PageClient() {
  const adminApp = useAdminApp();
  const projectId = useProjectId();
  const [profilesState, setProfilesState] = useState<{ projectId: string, profiles: TvProfileResource[] } | null>(null);
  const [defaultProfileId, setDefaultProfileId] = useState("company-pulse");
  const [loadErrorProjectId, setLoadErrorProjectId] = useState<string | null>(null);
  const [tvDisplayUrl, setTvDisplayUrl] = useState<string | null>(null);

  useEffect(() => {
    setTvDisplayUrl(getConfiguredTvDisplayUrl(window.location.origin));
  }, []);

  useEffect(() => {
    let active = true;
    runAsynchronously(async () => {
      try {
        const result = await fetchTvProfilesOrThrow(adminApp);
        if (!active) return;
        setProfilesState({ projectId, profiles: [...result.savedProfiles, ...result.templates] });
        setDefaultProfileId(result.effectiveDefaultProfileId);
        setLoadErrorProjectId(null);
      } catch (cause) {
        captureError("tv-display-profile-load-failed", cause);
        if (active) {
          setProfilesState(null);
          setLoadErrorProjectId(projectId);
        }
      }
    });
    return () => {
      active = false;
    };
  }, [adminApp, projectId]);

  const profiles = profilesState?.projectId === projectId ? profilesState.profiles : null;
  const loadError = loadErrorProjectId === projectId;

  const copyTvDisplayUrl = async () => {
    if (tvDisplayUrl == null) return;
    await navigator.clipboard.writeText(tvDisplayUrl);
    toast({
      variant: "success",
      title: "TV Link Copied",
      description: "The display address is ready to paste.",
    });
  };

  return (
    <PageLayout
      title="Displays"
      description="Pair shared screens and choose which profile each display presents."
      allowContentOverflow
      actions={(
        <div className="flex flex-wrap gap-2">
          {tvDisplayUrl == null ? (
            <DesignButton type="button" variant="outline" size="sm" disabled>
              <ArrowSquareOutIcon className="h-4 w-4" />
              Open TV Display
            </DesignButton>
          ) : (
            <DesignButton asChild variant="outline" size="sm">
              <a href={tvDisplayUrl} target="_blank" rel="noreferrer">
                <ArrowSquareOutIcon className="h-4 w-4" />
                Open TV Display
              </a>
            </DesignButton>
          )}
        </div>
      )}
    >
      <DesignCard title="Pair a Display" subtitle="Connect a TV or shared screen in three steps" icon={MonitorIcon} gradient="cyan" glassmorphic>
        <div className="grid gap-3 md:grid-cols-3">
          {[
            ["1", "Open the TV link", "Open the display link on the screen you want to connect."],
            ["2", "Find the pairing code", "Keep the TV page open while its secure code is visible."],
            ["3", "Approve the display", "Enter the code below, name the display, and assign a profile."],
          ].map(([number, title, description]) => (
            <div key={number} className="rounded-xl border border-foreground/[0.07] bg-foreground/[0.025] p-4">
              <div className="mb-3 flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-500/10 text-xs font-semibold text-cyan-600 dark:text-cyan-300">{number}</div>
              <p className="text-sm font-medium text-foreground">{title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
            </div>
          ))}
        </div>
        {tvDisplayUrl == null ? null : (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-foreground/[0.07] bg-foreground/[0.025] px-3 py-2.5">
            <span className="min-w-0 flex-1 break-all px-1 font-mono text-xs text-muted-foreground">{tvDisplayUrl}</span>
            <SimpleTooltip tooltip="Copy TV display link">
              <DesignButton
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Copy TV display link"
                onClick={copyTvDisplayUrl}
                className="h-8 w-8 shrink-0 rounded-lg"
              >
                <CopyIcon className="h-4 w-4" />
              </DesignButton>
            </SimpleTooltip>
          </div>
        )}
      </DesignCard>

      {tvDisplayUrl != null && isLocalTvDisplayUrl(tvDisplayUrl) ? (
        <DesignAlert
          variant="info"
          title="Local Development Link"
          description="This address works only on devices that can reach your development environment. A separate TV will usually need a network-accessible dashboard URL."
        />
      ) : null}
      {loadError ? (
        <DesignAlert
          variant="error"
          title="Profiles Couldn’t Be Loaded"
          description="Refresh the page to try again. Existing displays and assignments are unchanged."
        />
      ) : null}
      {profiles == null && !loadError ? (
        <DesignCard gradient="default" glassmorphic>
          <p className="text-sm text-muted-foreground">Loading display profiles…</p>
        </DesignCard>
      ) : null}
      {profiles == null ? null : (
        <TvDisplayManagement
          adminApp={adminApp}
          profiles={profiles}
          defaultProfileId={defaultProfileId}
        />
      )}
    </PageLayout>
  );
}
