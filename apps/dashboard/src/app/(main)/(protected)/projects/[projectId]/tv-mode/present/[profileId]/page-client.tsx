"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { TvPresentation } from "@/components/tv-mode/tv-presentation";
import {
  exitStandaloneTvPresentation,
  getBrowserTvPresentationExitEnvironment,
} from "@/components/tv-mode/presentation-window";
import { createTvFixtureSnapshot } from "@/lib/tv-mode/fixtures";
import { fetchTvProfileOrThrow } from "@/lib/hexclave-app-internals";
import { profileResourceToEditorDraft } from "@/lib/tv-mode/profile-editor-model";
import type { TvProfileResource } from "@hexclave/shared/dist/interface/admin-tv-mode";
import { useTvLiveSnapshot } from "@/lib/tv-mode/live-snapshot";
import { devFeaturesEnabledForProject } from "@/lib/utils";
import {
  TV_SCREEN_IDS,
  type TvScreenId,
} from "@/lib/tv-mode/types";
import { resolveTvFixtureVariant } from "@/lib/tv-mode/fixture-route";
import { runAsynchronously, runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { useAdminApp } from "../../../use-admin-app";

const TV_SCREEN_ID_SET = new Set<string>(TV_SCREEN_IDS);

function isTvScreenId(value: string | null): value is TvScreenId {
  return value != null && TV_SCREEN_ID_SET.has(value);
}

function getRouteValues(pathname: string): { projectId: string, profileId: string } {
  const segments = pathname.split("/");
  const projectsIndex = segments.indexOf("projects");
  const presentIndex = segments.indexOf("present");
  const projectId = segments.at(projectsIndex + 1);
  const profileId = segments.at(presentIndex + 1);
  if (projectId == null || projectId.length === 0) {
    throw new Error("Project ID is missing from the TV presentation route");
  }
  if (profileId == null || profileId.length === 0) {
    throw new Error("Profile ID is missing from the TV presentation route");
  }
  return {
    projectId: decodeURIComponent(projectId),
    profileId: decodeURIComponent(profileId),
  };
}

export default function PageClient() {
  const { projectId, profileId } = getRouteValues(usePathname());
  const fixtureParam = useSearchParams().get("fixture");
  const screenParam = useSearchParams().get("screen");
  const fixtureVariant = resolveTvFixtureVariant(fixtureParam, devFeaturesEnabledForProject(projectId));
  const adminApp = useAdminApp();
  const fixtureLoadKey = fixtureVariant == null ? null : `${projectId}\u0000${profileId}\u0000${fixtureVariant}`;
  const [fixtureLoad, setFixtureLoad] = useState<{
    key: string,
    profile: TvProfileResource | null,
    failed: boolean,
  } | null>(null);
  const fixtureProfile = fixtureLoad?.key === fixtureLoadKey ? fixtureLoad.profile : null;
  const fixtureLoadFailed = fixtureLoad?.key === fixtureLoadKey && fixtureLoad.failed;
  useEffect(() => {
    if (fixtureLoadKey == null) return;
    let active = true;
    runAsynchronously(async () => {
      try {
        const profile = await fetchTvProfileOrThrow(adminApp, profileId);
        if (active) setFixtureLoad({ key: fixtureLoadKey, profile, failed: false });
      } catch {
        if (active) setFixtureLoad({ key: fixtureLoadKey, profile: null, failed: true });
      }
    });
    return () => {
      active = false;
    };
  }, [adminApp, fixtureLoadKey, profileId, projectId]);
  const liveSnapshot = useTvLiveSnapshot({
    adminApp,
    projectId,
    profileId,
    enabled: fixtureVariant == null,
  });
  const fixtureSnapshot = useMemo(() => fixtureProfile == null || fixtureVariant == null
    ? null
    : createTvFixtureSnapshot(projectId, profileResourceToEditorDraft(fixtureProfile), fixtureVariant), [
      fixtureProfile,
      fixtureVariant,
      projectId,
    ]);
  const snapshot = fixtureVariant == null ? liveSnapshot.snapshot : fixtureSnapshot;

  return (
    <TvPresentation
      snapshot={snapshot}
      loading={(fixtureVariant === "loading" && !fixtureLoadFailed) || (fixtureVariant != null && fixtureProfile == null && !fixtureLoadFailed) || (fixtureVariant == null && liveSnapshot.loading)}
      unavailableReason={fixtureVariant == null
        ? liveSnapshot.unavailableReason
        : fixtureLoadFailed
          ? "error"
          : null}
      onExit={() => runAsynchronouslyWithAlert(exitStandaloneTvPresentation({
        fallbackHref: urlString`/projects/${projectId}/tv-mode`,
        environment: getBrowserTvPresentationExitEnvironment(),
      }))}
      initialScreenId={isTvScreenId(screenParam) ? screenParam : undefined}
      previewData={fixtureVariant != null}
    />
  );
}
