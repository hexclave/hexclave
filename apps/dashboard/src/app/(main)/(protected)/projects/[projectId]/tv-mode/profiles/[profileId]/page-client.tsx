"use client";

import {
  ArrowLeftIcon,
  ArrowDownIcon,
  ArrowSquareOutIcon,
  ArrowUpIcon,
  BroadcastIcon,
  CheckCircleIcon,
  ClockIcon,
  ConfettiIcon,
  EyeIcon,
  GearSixIcon,
  MonitorPlayIcon,
  ShieldCheckIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import {
  normalizeTvProfileDisplayName,
  TV_PROFILE_DISPLAY_NAME_MAX_LENGTH,
  type TvProfileResource,
} from "@hexclave/shared/dist/interface/admin-tv-mode";
import {
  DesignAlert,
  DesignButton,
  DesignCard,
  DesignInput,
  DesignSelectorDropdown,
} from "@/components/design-components";
import { Link } from "@/components/link";
import { useRouterConfirm } from "@/components/router";
import { Switch } from "@/components/ui/switch";
import { Typography } from "@/components/ui";
import { TvPresentation } from "@/components/tv-mode/tv-presentation";
import { useTvPresentationLauncher } from "@/components/tv-mode/presentation-window";
import { getTvScreenDefinition } from "@/components/tv-mode/screen-registry";
import { createTvFixtureSnapshot } from "@/lib/tv-mode/fixtures";
import { devFeaturesEnabledForProject } from "@/lib/utils";
import { navigateToTvProfiles } from "@/lib/tv-mode/navigation";
import {
  createTvProfileOrThrow,
  deleteTvProfileOrThrow,
  duplicateTvProfileOrThrow,
  fetchTvProfileOrThrow,
  TvProfileRequestError,
  updateTvProfileOrThrow,
} from "@/lib/hexclave-app-internals";
import {
  createTvProfileCopyDisplayName,
  createTvProfileEditorDraft,
  editorDraftToProfileConfiguration,
  profileResourceToEditorDraft,
} from "@/lib/tv-mode/profile-editor-model";
import {
  getTvProfileEditorCopy,
  TV_EVENT_PREVIEW_GROUPS,
  TV_STATE_PREVIEWS,
} from "@/lib/tv-mode/profile-editor-copy";
import type { TvProfileFixture, TvScreenId } from "@/lib/tv-mode/types";
import { PageLayout } from "../../../page-layout";
import { useAdminApp, useProjectId } from "../../../use-admin-app";
import { TvProfileDeleteDialog } from "./tv-profile-delete-dialog";

type TimingCategory = "celebration" | "incident" | "critical-incident";

const TIMING_CATEGORY_OPTIONS = [
  { value: "celebration", label: "Celebrations" },
  { value: "incident", label: "Incidents" },
  { value: "critical-incident", label: "Critical Incidents" },
];

const TAKEOVER_DURATION_OPTIONS = [
  { value: "30", label: "30 seconds" },
  { value: "60", label: "60 seconds" },
  { value: "90", label: "90 seconds" },
  { value: "120", label: "2 minutes" },
];

const HIGHLIGHT_DURATION_OPTIONS = [
  { value: "3600", label: "1 hour" },
  { value: "21600", label: "6 hours" },
  { value: "43200", label: "12 hours" },
  { value: "86400", label: "24 hours" },
];

const ANIMATION_DURATION_OPTIONS = [
  { value: "600", label: "10 minutes" },
  { value: "1800", label: "30 minutes" },
  { value: "3600", label: "1 hour" },
  { value: "7200", label: "2 hours" },
];

function getProfileIdFromPath(pathname: string): string {
  const segments = pathname.split("/");
  const profilesIndex = segments.indexOf("profiles");
  const profileId = segments.at(profilesIndex + 1);
  if (profileId == null || profileId.length === 0) {
    throw new Error("TV profile ID is missing from the route");
  }
  return decodeURIComponent(profileId);
}

function cloneProfile(profile: TvProfileFixture): TvProfileFixture {
  return structuredClone(profile);
}

function parseTimingCategory(value: string): TimingCategory {
  switch (value) {
    case "celebration":
    case "incident":
    case "critical-incident": {
      return value;
    }
    default: {
      throw new Error(`Unexpected TV timing category "${value}"`);
    }
  }
}

function parseDurationOption(value: string): number {
  switch (value) {
    case "15": {
      return 15;
    }
    case "16": {
      return 16;
    }
    case "18": {
      return 18;
    }
    case "20": {
      return 20;
    }
    case "30": {
      return 30;
    }
    default: {
      throw new Error(`Unexpected TV duration option "${value}"`);
    }
  }
}

function parseTakeoverSeconds(value: string): 30 | 60 | 90 | 120 {
  switch (value) {
    case "30": {
      return 30;
    }
    case "60": {
      return 60;
    }
    case "90": {
      return 90;
    }
    case "120": {
      return 120;
    }
    default: {
      throw new Error(`Unexpected TV takeover duration "${value}"`);
    }
  }
}

function parseAnimationSeconds(value: string): 600 | 1800 | 3600 | 7200 {
  switch (value) {
    case "600": {
      return 600;
    }
    case "1800": {
      return 1800;
    }
    case "3600": {
      return 3600;
    }
    case "7200": {
      return 7200;
    }
    default: {
      throw new Error(`Unexpected TV animation duration "${value}"`);
    }
  }
}

function parseHighlightSeconds(value: string): 3600 | 21600 | 43200 | 86400 {
  switch (value) {
    case "3600": {
      return 3600;
    }
    case "21600": {
      return 21600;
    }
    case "43200": {
      return 43200;
    }
    case "86400": {
      return 86400;
    }
    default: {
      throw new Error(`Unexpected TV Event Highlight duration "${value}"`);
    }
  }
}

function retainValidHighlight(
  currentHighlightSeconds: number,
  animationSeconds: 600 | 1800 | 3600 | 7200,
): 3600 | 21600 | 43200 | 86400 {
  const validatedHighlightSeconds = parseHighlightSeconds(currentHighlightSeconds.toString());
  return animationSeconds > validatedHighlightSeconds ? 21600 : validatedHighlightSeconds;
}

function retainValidAnimation(
  currentAnimationSeconds: number,
  highlightSeconds: 3600 | 21600 | 43200 | 86400,
): 600 | 1800 | 3600 | 7200 {
  const validatedAnimationSeconds = parseAnimationSeconds(currentAnimationSeconds.toString());
  return validatedAnimationSeconds > highlightSeconds ? 3600 : validatedAnimationSeconds;
}

function updatePlaylistEntry(
  profile: TvProfileFixture,
  screenId: TvScreenId,
  update: (entry: TvProfileFixture["playlist"][number]) => TvProfileFixture["playlist"][number],
): TvProfileFixture {
  return {
    ...profile,
    playlist: profile.playlist.map((entry) => entry.screenId === screenId ? update(entry) : entry),
  };
}

function movePlaylistEntry(profile: TvProfileFixture, index: number, offset: -1 | 1): TvProfileFixture {
  const targetIndex = index + offset;
  if (targetIndex < 0 || targetIndex >= profile.playlist.length) return profile;
  const playlist = [...profile.playlist];
  const current = playlist[index];
  const target = playlist[targetIndex];
  // Both positions are bounded above before indexing, so the swap preserves
  // the complete playlist and cannot introduce a missing entry.
  playlist[index] = target;
  playlist[targetIndex] = current;
  return { ...profile, playlist };
}

function settingRow({
  title,
  description,
  control,
}: {
  title: string,
  description: string,
  control: React.ReactNode,
}) {
  return (
    <div className="flex items-center justify-between gap-5 border-b border-foreground/[0.06] py-3 last:border-b-0">
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export default function PageClient() {
  const projectId = useProjectId();
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const profileId = getProfileIdFromPath(usePathname());
  const createFromTemplate = useSearchParams().get("create") === "1";
  const [resource, setResource] = useState<TvProfileResource | null>(null);
  const [draft, setDraft] = useState<TvProfileFixture | null>(null);
  const [saved, setSaved] = useState<TvProfileFixture | null>(null);
  const [resetDraft, setResetDraft] = useState<TvProfileFixture | null>(null);
  const [loading, setLoading] = useState(true);
  const requestKey = `${profileId}:${createFromTemplate ? "create" : "edit"}`;
  const [loadedRequestKey, setLoadedRequestKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [timingCategory, setTimingCategory] = useState<TimingCategory>("celebration");
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [savedNoticeVisible, setSavedNoticeVisible] = useState(false);
  const [createSavePending, setCreateSavePending] = useState(false);
  const draftRef = useRef<TvProfileFixture | null>(null);
  draftRef.current = draft;
  const { setNeedConfirm } = useRouterConfirm();
  const { launchPresentation, popupBlocked } = useTvPresentationLauncher(projectId);
  const developerPreviewsEnabled = devFeaturesEnabledForProject(projectId);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    setResource(null);
    setDraft(null);
    setSaved(null);
    setResetDraft(null);
    setSaveError(null);
    setDeleteError(null);
    setDuplicateError(null);
    runAsynchronously(async () => {
      try {
        const loaded = await fetchTvProfileOrThrow(adminApp, profileId);
        if (!active) return;
        const savedDraft = profileResourceToEditorDraft(loaded);
        const editorDraft = createTvProfileEditorDraft(loaded, createFromTemplate);
        setResource(loaded);
        setDraft(cloneProfile(editorDraft));
        setSaved(savedDraft);
        setResetDraft(cloneProfile(editorDraft));
      } catch {
        if (active) setLoadError(true);
      } finally {
        if (active) {
          setLoadedRequestKey(requestKey);
          setLoading(false);
        }
      }
    });
    return () => {
      active = false;
    };
  }, [adminApp, createFromTemplate, profileId, requestKey]);

  const hasChanges = draft != null && saved != null && JSON.stringify(draft) !== JSON.stringify(saved);
  const profileNameError = draft == null || draft.displayName.trim().length === 0
    ? "TV profile names are required."
    : Array.from(normalizeTvProfileDisplayName(draft.displayName)).length > TV_PROFILE_DISPLAY_NAME_MAX_LENGTH
      ? `TV profile names must remain within ${TV_PROFILE_DISPLAY_NAME_MAX_LENGTH} characters after normalization.`
      : null;
  const previewSnapshot = useMemo(
    () => draft == null ? null : createTvFixtureSnapshot(projectId, draft),
    [draft, projectId],
  );

  useEffect(() => {
    setNeedConfirm(hasChanges);
    return () => setNeedConfirm(false);
  }, [hasChanges, setNeedConfirm]);

  if (loading || loadedRequestKey !== requestKey) {
    return (
      <PageLayout title="TV Profile" description="Loading project presentation configuration…">
        <DesignAlert variant="info" title="Loading Profile" description="Resolving the project-scoped profile configuration." />
      </PageLayout>
    );
  }

  if (loadError || draft == null || saved == null || resource == null) {
    return (
      <PageLayout title="TV Profile Not Found" description="The requested TV profile does not exist.">
        <DesignAlert variant="error" title="Unknown Profile" description={`No TV presentation profile exists for "${profileId}", or it could not be loaded.`} />
        <Link href={urlString`/projects/${projectId}/tv-mode`} className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
          <ArrowLeftIcon className="h-4 w-4" />
          All Profiles
        </Link>
      </PageLayout>
    );
  }

  const enabledCount = draft.playlist.filter((entry) => entry.enabled).length;
  const editorCopy = getTvProfileEditorCopy(resource.origin, createFromTemplate);

  return (
    <>
      <PageLayout
        title={draft.displayName}
        description={editorCopy.pageDescription}
        allowContentOverflow
        actions={
          <div className="flex gap-2">
            <DesignButton variant="outline" size="sm" disabled={hasChanges} onClick={async () => {
              setDuplicateError(null);
              try {
                const duplicated = resource.origin === "saved"
                  ? await duplicateTvProfileOrThrow(
                    adminApp,
                    resource,
                    createTvProfileCopyDisplayName(resource.configuration.displayName),
                  )
                  : await createTvProfileOrThrow(adminApp, editorDraftToProfileConfiguration(
                    createTvProfileEditorDraft(resource, true),
                  ));
                setNeedConfirm(false);
                window.location.assign(urlString`/projects/${projectId}/tv-mode/profiles/${duplicated.id}`);
              } catch (error) {
                setDuplicateError(error instanceof TvProfileRequestError && error.status === 409
                  ? "This profile changed elsewhere or its name conflicts with another profile. Reload before retrying."
                  : "Profile storage is unavailable. Your profile was not duplicated.");
              }
            }}>
              Duplicate
            </DesignButton>
            <DesignButton variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
              <EyeIcon className="h-4 w-4" />
              Preview Changes
            </DesignButton>
            <button
              type="button"
              onClick={() => launchPresentation(urlString`/projects/${projectId}/tv-mode/present/${profileId}`)}
              className="inline-flex h-8 items-center gap-2 rounded-lg bg-foreground px-3 text-xs font-medium text-background"
            >
              <BroadcastIcon className="h-4 w-4" weight="fill" />
              Start TV Mode
              <ArrowSquareOutIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        }
      >
        <div className="flex items-center gap-2">
          <Link href={urlString`/projects/${projectId}/tv-mode`} className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ArrowLeftIcon className="h-3.5 w-3.5" />
            All Profiles
          </Link>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-xs text-muted-foreground">{editorCopy.breadcrumb}</span>
        </div>

        <DesignAlert
          variant="info"
          title={editorCopy.alertTitle}
          description={editorCopy.alertDescription}
        />
        {popupBlocked ? (
          <DesignAlert
            variant="error"
            title="TV Presentation Was Blocked"
            description="Allow popups for this dashboard, then launch the presentation again. Your profile changes remain on this page."
          />
        ) : null}
        {savedNoticeVisible && !hasChanges ? (
          <DesignAlert variant="success" title="Profile Saved" description="The project profile and its optimistic-concurrency version were updated." />
        ) : null}
        {saveError != null ? <DesignAlert variant="error" title="Profile Was Not Saved" description={saveError} /> : null}
        {duplicateError != null ? <DesignAlert variant="error" title="Profile Was Not Duplicated" description={duplicateError} /> : null}

        <div inert={createSavePending} aria-busy={createSavePending}>
          <div className="space-y-4">
            <DesignCard title="Profile" subtitle="Identity and profile details" icon={MonitorPlayIcon} gradient="cyan" glassmorphic>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="tv-profile-name" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">TV Name</label>
                  <DesignInput
                    id="tv-profile-name"
                    value={draft.displayName}
                    maxLength={TV_PROFILE_DISPLAY_NAME_MAX_LENGTH}
                    onChange={(event) => {
                      setDraft({ ...draft, displayName: event.target.value });
                      setSavedNoticeVisible(false);
                    }}
                  />
                  {profileNameError != null
                    ? <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">{profileNameError}</p>
                    : null}
                </div>
                <div>
                  <label htmlFor="tv-profile-mode" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Mode</label>
                  <DesignSelectorDropdown
                    triggerId="tv-profile-mode"
                    value="general"
                    onValueChange={() => undefined}
                    disabled
                    size="lg"
                    options={[{ value: "general", label: "General Mode" }]}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="tv-profile-description" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Description</label>
                  <DesignInput
                    id="tv-profile-description"
                    value={draft.description}
                    maxLength={240}
                    placeholder="Describe where or how this profile will be used."
                    onChange={(event) => {
                      setDraft({ ...draft, description: event.target.value });
                      setSavedNoticeVisible(false);
                    }}
                  />
                </div>
                <div className="sm:col-span-2">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Project</p>
                  <div className="rounded-xl border border-foreground/[0.08] bg-foreground/[0.025] px-4 py-2.5 text-sm text-foreground">{project.displayName}</div>
                </div>
              </div>
            </DesignCard>

            <DesignCard title="Playlist" subtitle={`${enabledCount} of ${draft.playlist.length} screens enabled`} icon={GearSixIcon} gradient="blue" glassmorphic>
              <div className="space-y-2">
                {draft.playlist.map((entry, index) => {
                  const definition = getTvScreenDefinition(entry.screenId);
                  const Icon = definition.icon;
                  return (
                    <div key={entry.screenId} className="flex items-center gap-3 rounded-xl border border-foreground/[0.07] bg-foreground/[0.02] p-3">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] text-xs font-semibold text-muted-foreground">{index + 1}</span>
                      <Icon className={`h-5 w-5 shrink-0 ${definition.accentClassName}`} weight="fill" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground">{definition.displayName}</p>
                        <p className="truncate text-xs text-muted-foreground">{definition.description}</p>
                      </div>
                      <DesignSelectorDropdown
                        value={(entry.durationSecondsOverride ?? draft.defaultDurationSeconds).toString()}
                        onValueChange={(value) => setDraft(updatePlaylistEntry(draft, entry.screenId, (current) => ({
                          ...current,
                          durationSecondsOverride: parseDurationOption(value),
                        })))}
                        disabled={!entry.enabled}
                        options={[
                          { value: "15", label: "15 sec" },
                          { value: "16", label: "16 sec" },
                          { value: "18", label: "18 sec" },
                          { value: "20", label: "20 sec" },
                          { value: "30", label: "30 sec" },
                        ]}
                      />
                      <div className="flex gap-1">
                        <button
                          type="button"
                          disabled={!entry.enabled || index === 0}
                          onClick={() => setDraft(movePlaylistEntry(draft, index, -1))}
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-foreground/[0.06] disabled:opacity-30"
                          aria-label={`Move ${definition.displayName} earlier`}
                        >
                          <ArrowUpIcon className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={!entry.enabled || index === draft.playlist.length - 1}
                          onClick={() => setDraft(movePlaylistEntry(draft, index, 1))}
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-foreground/[0.06] disabled:opacity-30"
                          aria-label={`Move ${definition.displayName} later`}
                        >
                          <ArrowDownIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <Switch
                        checked={entry.enabled}
                        disabled={entry.enabled && enabledCount === 1}
                        onCheckedChange={(enabled) => {
                          setDraft(updatePlaylistEntry(draft, entry.screenId, (current) => ({ ...current, enabled })));
                          setSavedNoticeVisible(false);
                        }}
                        aria-label={`${entry.enabled ? "Disable" : "Enable"} ${definition.displayName}`}
                      />
                    </div>
                  );
                })}
                <div className="flex items-center gap-3 rounded-xl border border-dashed border-foreground/[0.1] p-3 opacity-60">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-foreground/[0.04] text-xs text-muted-foreground">—</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-muted-foreground">Deployments</p>
                    <p className="text-xs text-muted-foreground">Unavailable · deployment integration required</p>
                  </div>
                  <Switch checked={false} disabled aria-label="Deployments unavailable" />
                </div>
              </div>
            </DesignCard>

            <DesignCard title="Timing" subtitle="Control rotation and presentation duration" icon={ClockIcon} gradient="purple" glassmorphic>
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="min-w-0">
                  <label htmlFor="tv-default-duration" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Rotation Speed</label>
                  <DesignSelectorDropdown
                    triggerId="tv-default-duration"
                    value={draft.defaultDurationSeconds.toString()}
                    onValueChange={(value) => setDraft({ ...draft, defaultDurationSeconds: parseDurationOption(value) })}
                    size="lg"
                    options={[
                      { value: "15", label: "15 seconds" },
                      { value: "16", label: "16 seconds" },
                      { value: "18", label: "18 seconds" },
                      { value: "20", label: "20 seconds" },
                      { value: "30", label: "30 seconds" },
                    ]}
                  />
                  <Typography variant="secondary" className="mt-2 text-xs">Individual playlist screens may override this value.</Typography>
                </div>
                <div className="min-w-0">
                  <label htmlFor="tv-presentation-timing" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Presentation Timing</label>
                  <DesignSelectorDropdown
                    triggerId="tv-presentation-timing"
                    value={timingCategory}
                    onValueChange={(value) => setTimingCategory(parseTimingCategory(value))}
                    size="lg"
                    options={TIMING_CATEGORY_OPTIONS}
                  />
                  <Typography variant="secondary" className="mt-2 text-xs">Choose which presentation timings to configure.</Typography>
                </div>
              </div>

              <div className="mt-5 border-t border-foreground/[0.06] pt-1">
                {timingCategory === "celebration" ? (
                  <>
                    {settingRow({
                      title: "Celebration Takeover",
                      description: "Full-screen milestone moment.",
                      control: <DesignSelectorDropdown value={draft.interruptionTiming.celebration.takeoverSeconds.toString()} onValueChange={(value) => setDraft({
                        ...draft,
                        interruptionTiming: {
                          ...draft.interruptionTiming,
                          celebration: { ...draft.interruptionTiming.celebration, takeoverSeconds: parseTakeoverSeconds(value) },
                        },
                      })} options={TAKEOVER_DURATION_OPTIONS} />,
                    })}
                    {settingRow({
                      title: "Celebration Effect",
                      description: "Fireworks over the rotating screens.",
                      control: <DesignSelectorDropdown value={draft.interruptionTiming.celebration.animationSeconds.toString()} onValueChange={(value) => setDraft({
                        ...draft,
                        interruptionTiming: {
                          ...draft.interruptionTiming,
                          celebration: {
                            ...draft.interruptionTiming.celebration,
                            animationSeconds: parseAnimationSeconds(value),
                            highlightSeconds: retainValidHighlight(
                              draft.interruptionTiming.celebration.highlightSeconds,
                              parseAnimationSeconds(value),
                            ),
                          },
                        },
                      })} options={ANIMATION_DURATION_OPTIONS} />,
                    })}
                    {settingRow({
                      title: "Celebration Highlight",
                      description: "How long the milestone remains in rotation.",
                      control: <DesignSelectorDropdown value={draft.interruptionTiming.celebration.highlightSeconds.toString()} onValueChange={(value) => setDraft({
                        ...draft,
                        interruptionTiming: {
                          ...draft.interruptionTiming,
                          celebration: {
                            ...draft.interruptionTiming.celebration,
                            highlightSeconds: parseHighlightSeconds(value),
                            animationSeconds: retainValidAnimation(
                              draft.interruptionTiming.celebration.animationSeconds,
                              parseHighlightSeconds(value),
                            ),
                          },
                        },
                      })} options={HIGHLIGHT_DURATION_OPTIONS} />,
                    })}
                  </>
                ) : timingCategory === "incident" ? (
                  <>
                    {settingRow({
                      title: "Incident Takeover",
                      description: "Temporary attention period before rotation resumes.",
                      control: <DesignSelectorDropdown value={draft.interruptionTiming.incident.takeoverSeconds.toString()} onValueChange={(value) => setDraft({
                        ...draft,
                        interruptionTiming: {
                          ...draft.interruptionTiming,
                          incident: { ...draft.interruptionTiming.incident, takeoverSeconds: parseTakeoverSeconds(value) },
                        },
                      })} options={TAKEOVER_DURATION_OPTIONS} />,
                    })}
                    {settingRow({
                      title: "Incident Recovery Takeover",
                      description: "How long a confirmed recovery takes over before rotation resumes.",
                      control: <DesignSelectorDropdown value={draft.interruptionTiming.incident.recoveryTakeoverSeconds.toString()} onValueChange={(value) => setDraft({
                        ...draft,
                        interruptionTiming: {
                          ...draft.interruptionTiming,
                          incident: {
                            ...draft.interruptionTiming.incident,
                            recoveryTakeoverSeconds: parseTakeoverSeconds(value),
                          },
                        },
                      })} options={TAKEOVER_DURATION_OPTIONS} />,
                    })}
                    {settingRow({
                      title: "Incident Restored Highlight",
                      description: "How long a restored incident remains visible.",
                      control: <DesignSelectorDropdown value={draft.interruptionTiming.incident.resolvedHighlightSeconds.toString()} onValueChange={(value) => setDraft({
                        ...draft,
                        interruptionTiming: {
                          ...draft.interruptionTiming,
                          incident: {
                            ...draft.interruptionTiming.incident,
                            resolvedHighlightSeconds: parseHighlightSeconds(value),
                          },
                        },
                      })} options={HIGHLIGHT_DURATION_OPTIONS} />,
                    })}
                  </>
                ) : (
                  <>
                    {settingRow({
                      title: "Critical Incident Takeover",
                      description: "Urgent attention period before rotation resumes with a Critical Highlight.",
                      control: <DesignSelectorDropdown value={draft.interruptionTiming.criticalIncident.takeoverSeconds.toString()} onValueChange={(value) => setDraft({
                        ...draft,
                        interruptionTiming: {
                          ...draft.interruptionTiming,
                          criticalIncident: {
                            ...draft.interruptionTiming.criticalIncident,
                            takeoverSeconds: parseTakeoverSeconds(value),
                          },
                        },
                      })} options={TAKEOVER_DURATION_OPTIONS} />,
                    })}
                    {settingRow({
                      title: "Critical Recovery Takeover",
                      description: "How long a confirmed Critical recovery takes over before rotation resumes.",
                      control: <DesignSelectorDropdown value={draft.interruptionTiming.criticalIncident.recoveryTakeoverSeconds.toString()} onValueChange={(value) => setDraft({
                        ...draft,
                        interruptionTiming: {
                          ...draft.interruptionTiming,
                          criticalIncident: {
                            ...draft.interruptionTiming.criticalIncident,
                            recoveryTakeoverSeconds: parseTakeoverSeconds(value),
                          },
                        },
                      })} options={TAKEOVER_DURATION_OPTIONS} />,
                    })}
                    {settingRow({
                      title: "Critical Restored Highlight",
                      description: "How long a restored Critical Incident remains visible.",
                      control: <DesignSelectorDropdown value={draft.interruptionTiming.criticalIncident.resolvedHighlightSeconds.toString()} onValueChange={(value) => setDraft({
                        ...draft,
                        interruptionTiming: {
                          ...draft.interruptionTiming,
                          criticalIncident: {
                            ...draft.interruptionTiming.criticalIncident,
                            resolvedHighlightSeconds: parseHighlightSeconds(value),
                          },
                        },
                      })} options={HIGHLIGHT_DURATION_OPTIONS} />,
                    })}
                  </>
                )}
              </div>
            </DesignCard>

            <DesignCard title="Interruption Policy" subtitle="How important events take over this TV" icon={WarningCircleIcon} gradient="orange" glassmorphic>
              <div>
                {settingRow({
                  title: "Email Delivery Degradation",
                  description: "Bounded Incident and Critical takeovers followed by persistent active Highlights until recovery.",
                  control: <Switch checked={draft.incidentTypes.emailDeliveryDegradation} onCheckedChange={(emailDeliveryDegradation) => setDraft({
                    ...draft,
                    incidentTypes: { ...draft.incidentTypes, emailDeliveryDegradation },
                  })} aria-label="Enable email delivery degradation interruptions" />,
                })}
                {settingRow({
                  title: "Subscription Collection Degradation",
                  description: "Bounded interruptions when subscription collection falls below its expected range.",
                  control: <Switch checked={draft.incidentTypes.subscriptionCollectionDegradation} onCheckedChange={(subscriptionCollectionDegradation) => setDraft({
                    ...draft,
                    incidentTypes: { ...draft.incidentTypes, subscriptionCollectionDegradation },
                  })} aria-label="Enable subscription collection degradation interruptions" />,
                })}
              </div>
            </DesignCard>

            <DesignCard title="Celebrations" subtitle="Positive moments worth sharing" icon={ConfettiIcon} gradient="purple" glassmorphic>
              <div>
                {settingRow({
                  title: "User Milestones",
                  description: "User growth milestones worth celebrating.",
                  control: <Switch checked={draft.celebrations.userMilestone} onCheckedChange={(userMilestone) => setDraft({
                    ...draft,
                    celebrations: { ...draft.celebrations, userMilestone },
                  })} aria-label="Enable user milestone celebrations" />,
                })}
                {settingRow({
                  title: "Revenue Milestones",
                  description: "Unavailable · live revenue milestone evaluation is not yet supported.",
                  control: <Switch checked={draft.celebrations.revenueMilestone} disabled aria-label="Revenue milestone celebrations are unavailable" />,
                })}
                {settingRow({
                  title: "Successful Launches",
                  description: "Unavailable · deployment integration required.",
                  control: <Switch checked={false} disabled />,
                })}
              </div>
            </DesignCard>

            <DesignCard title="Privacy" subtitle="Control what a shared room can see" icon={ShieldCheckIcon} gradient="green" glassmorphic>
              {settingRow({
                title: "Show Exact Financial Values",
                description: "Shows exact currency in Revenue & Payments. Operational counts and direction remain visible when off.",
                control: <Switch checked={draft.showExactFinancialValues} onCheckedChange={(showExactFinancialValues) => setDraft({
                  ...draft,
                  showExactFinancialValues,
                  celebrations: showExactFinancialValues
                    ? draft.celebrations
                    : { ...draft.celebrations, revenueMilestone: false },
                })} aria-label="Show exact financial values on this TV" />,
              })}
              <DesignAlert variant="success" title="Backend-Enforced Privacy" description="Live TV snapshots expose aggregate metrics only. User identities, email subjects, recipients, support messages, and session replay content are excluded by the backend." />
            </DesignCard>

            {developerPreviewsEnabled ? (
              <>
                <DesignCard title="Event Previews" subtitle="Preview milestone and incident presentations" icon={BroadcastIcon} gradient="cyan" glassmorphic>
                  <div className="grid gap-4 2xl:grid-cols-2">
                    {TV_EVENT_PREVIEW_GROUPS.map((group) => (
                      <div key={group.title} className="min-w-0">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{group.title}</p>
                        <div className="grid gap-2">
                          {group.previews.map((preview) => (
                            <button
                              type="button"
                              key={preview.fixture}
                              onClick={() => launchPresentation(urlString`/projects/${projectId}/tv-mode/present/${profileId}?fixture=${preview.fixture}`)}
                              className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-foreground/[0.08] px-3 py-2.5 text-left text-xs font-medium text-foreground transition-colors duration-150 hover:bg-foreground/[0.04] hover:transition-none"
                            >
                              <span className="min-w-0">{preview.label}</span>
                              <ArrowSquareOutIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </DesignCard>

                <DesignCard title="State Previews" subtitle="Validate honest failure and freshness behavior" icon={WarningCircleIcon} gradient="orange" glassmorphic>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {TV_STATE_PREVIEWS.map((state) => (
                      <button
                        type="button"
                        key={state.fixture}
                        onClick={() => launchPresentation(urlString`/projects/${projectId}/tv-mode/present/${profileId}?fixture=${state.fixture}`)}
                        className="flex items-center justify-between rounded-xl border border-foreground/[0.08] px-3 py-2.5 text-left text-xs font-medium text-foreground transition-colors duration-150 hover:bg-foreground/[0.04] hover:transition-none"
                      >
                        {state.label}
                        <ArrowSquareOutIcon className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                </DesignCard>
              </>
            ) : null}
          </div>
        </div>

        <div inert={createSavePending} className="sticky bottom-4 z-20 flex items-center justify-between rounded-2xl border border-foreground/[0.09] bg-background/90 p-3 shadow-xl backdrop-blur-xl">
          <div className="flex items-center gap-2 text-sm">
            {hasChanges ? <WarningCircleIcon className="h-4 w-4 text-amber-500" weight="fill" /> : <CheckCircleIcon className="h-4 w-4 text-emerald-500" weight="fill" />}
            <span className="text-muted-foreground">{hasChanges ? "Unsaved profile changes" : "Profile is up to date"}</span>
          </div>
          <div className="flex gap-2">
            <DesignButton variant="outline" size="sm" disabled={!hasChanges} onClick={() => {
              setDraft(cloneProfile(resetDraft ?? saved));
              setSavedNoticeVisible(false);
            }}>
              Reset
            </DesignButton>
            {resource.origin === "saved" && !createFromTemplate ? (
              <DesignButton variant="outline" size="sm" onClick={() => setDeleteConfirmationOpen(true)}>
                Delete Profile
              </DesignButton>
            ) : null}
            <DesignButton size="sm" disabled={!hasChanges || profileNameError != null} onClick={async () => {
              setSaveError(null);
              const submittedDraft = draft;
              if (profileNameError != null) {
                setSaveError(profileNameError);
                return;
              }
              const creatingProfile = resource.origin !== "saved" || createFromTemplate;
              // A newly created profile must navigate to its authoritative ID. Freeze
              // the create form while that request is pending so edits cannot land in
              // the redirect gap; saved-profile updates still preserve concurrent edits.
              if (creatingProfile) setCreateSavePending(true);
              try {
                const configuration = editorDraftToProfileConfiguration({
                  ...draft,
                  displayName: draft.displayName.trim(),
                });
                const savedResource = resource.origin === "saved" && !createFromTemplate
                  ? await updateTvProfileOrThrow(adminApp, resource.id, resource.version, configuration)
                  : await createTvProfileOrThrow(adminApp, configuration);
                const nextDraft = profileResourceToEditorDraft(savedResource);
                setResource(savedResource);
                setSaved(cloneProfile(nextDraft));
                setResetDraft(cloneProfile(nextDraft));
                const draftChangedWhileSaving = draftRef.current !== submittedDraft;
                if (!draftChangedWhileSaving) setDraft(cloneProfile(nextDraft));
                setSavedNoticeVisible(!draftChangedWhileSaving);
                if (savedResource.id !== profileId) {
                  setNeedConfirm(false);
                  window.location.assign(urlString`/projects/${projectId}/tv-mode/profiles/${savedResource.id}`);
                } else if (creatingProfile) {
                  setCreateSavePending(false);
                }
              } catch (error) {
                if (creatingProfile) setCreateSavePending(false);
                setSaveError(error instanceof TvProfileRequestError && error.status === 409
                  ? "This profile changed elsewhere or its name conflicts with another profile. Reload before retrying."
                  : "Profile storage is unavailable. Your unsaved changes remain on this page.");
              }
            }}>
              {editorCopy.saveLabel}
            </DesignButton>
          </div>
        </div>
      </PageLayout>

      {resource.origin === "saved" && !createFromTemplate ? (
        <TvProfileDeleteDialog
          open={deleteConfirmationOpen}
          onOpenChange={(open) => {
            setDeleteConfirmationOpen(open);
            if (open) setDeleteError(null);
          }}
          profileName={resource.configuration.displayName}
          error={deleteError}
          onConfirm={async () => {
            try {
              await deleteTvProfileOrThrow(adminApp, resource);
              setNeedConfirm(false);
              navigateToTvProfiles(projectId);
            } catch {
              setDeleteError("Profile deletion is unavailable. The profile was not deleted.");
              return "prevent-close";
            }
          }}
        />
      ) : null}

      {previewOpen && previewSnapshot != null ? (
        <div className="fixed inset-0 z-[200] bg-black">
          <TvPresentation snapshot={previewSnapshot} onExit={() => setPreviewOpen(false)} previewData />
          <button
            type="button"
            className="absolute right-5 top-5 z-[250] flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-black/60 text-white/80 backdrop-blur-xl"
            onClick={() => setPreviewOpen(false)}
            aria-label="Close Preview"
          >
            <XIcon className="h-5 w-5" weight="bold" />
          </button>
        </div>
      ) : null}
    </>
  );
}
