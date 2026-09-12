import {
  normalizeTvProfileDisplayName,
  TV_PROFILE_DISPLAY_NAME_MAX_LENGTH,
  TV_SCREEN_IDS,
  type TvProfileConfiguration,
  type TvProfileResource,
} from "@hexclave/shared/dist/interface/admin-tv-mode";
import type { TvProfileFixture } from "./types";

const TV_PROFILE_COPY_SUFFIX = " Copy";

export function createTvProfileCopyDisplayName(displayName: string): string {
  const baseCharacters: string[] = [];
  for (const character of Array.from(displayName.trim())) {
    const candidate = `${baseCharacters.join("")}${character}${TV_PROFILE_COPY_SUFFIX}`;
    const normalizedCandidate = normalizeTvProfileDisplayName(candidate);
    if (
      Array.from(normalizedCandidate).length > TV_PROFILE_DISPLAY_NAME_MAX_LENGTH
      || candidate.length > TV_PROFILE_DISPLAY_NAME_MAX_LENGTH
    ) break;
    baseCharacters.push(character);
  }
  return `${baseCharacters.join("").trimEnd()}${TV_PROFILE_COPY_SUFFIX}`;
}

export function profileResourceToEditorDraft(profile: TvProfileResource): TvProfileFixture {
  const configuredScreens = new Map(
    profile.configuration.playlist.map((entry) => [entry.screenId, entry]),
  );
  const orderedScreenIds = [
    ...profile.configuration.playlist.map((entry) => entry.screenId),
    ...TV_SCREEN_IDS.filter((screenId) => !configuredScreens.has(screenId)),
  ];
  return {
    id: profile.id,
    displayName: profile.configuration.displayName,
    description: profile.configuration.description,
    mode: profile.configuration.mode,
    defaultDurationSeconds: profile.configuration.defaultDurationSeconds,
    playlist: orderedScreenIds.map((screenId) => ({
      screenId,
      enabled: configuredScreens.has(screenId),
      durationSecondsOverride: configuredScreens.get(screenId)?.durationSecondsOverride ?? null,
    })),
    incidentTypes: profile.configuration.interruptionPreferences.incidentTypes,
    celebrations: profile.configuration.interruptionPreferences.celebrations,
    interruptionTiming: profile.configuration.interruptionPreferences.timing,
    showExactFinancialValues: profile.configuration.financialVisibility === "exact",
  };
}

export function createTvProfileEditorDraft(
  profile: TvProfileResource,
  createFromTemplate: boolean,
): TvProfileFixture {
  const draft = profileResourceToEditorDraft(profile);
  if (!createFromTemplate) return draft;
  return {
    ...draft,
    displayName: createTvProfileCopyDisplayName(draft.displayName),
    description: "New Profile",
  };
}

export function editorDraftToProfileConfiguration(draft: TvProfileFixture): TvProfileConfiguration {
  return {
    displayName: draft.displayName,
    description: draft.description,
    mode: draft.mode,
    defaultDurationSeconds: draft.defaultDurationSeconds,
    playlist: draft.playlist
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        screenId: entry.screenId,
        durationSecondsOverride: entry.durationSecondsOverride,
      })),
    interruptionPreferences: {
      incidentTypes: draft.incidentTypes,
      celebrations: draft.celebrations,
      timing: draft.interruptionTiming,
    },
    financialVisibility: draft.showExactFinancialValues ? "exact" : "redacted",
  };
}
