import { getTvBuiltInProfile, TvProfileDisplayNameSchema } from "@hexclave/shared/dist/interface/admin-tv-mode";
import { describe, expect, it } from "vitest";
import {
  createTvProfileCopyDisplayName,
  createTvProfileEditorDraft,
  editorDraftToProfileConfiguration,
  profileResourceToEditorDraft,
} from "./profile-editor-model";

describe("TV profile editor model", () => {
  it("round-trips a resolved profile without changing persisted configuration", () => {
    const profile = getTvBuiltInProfile("company-pulse");
    if (profile == null) throw new Error("Company Pulse must exist.");

    expect(editorDraftToProfileConfiguration(profileResourceToEditorDraft(profile)))
      .toEqual(profile.configuration);
  });

  it("keeps disabled screens out of persisted playlist order", () => {
    const profile = getTvBuiltInProfile("engineering-office");
    if (profile == null) throw new Error("Engineering Office must exist.");

    const draft = profileResourceToEditorDraft(profile);
    expect(draft.playlist).toHaveLength(4);
    expect(editorDraftToProfileConfiguration(draft).playlist.map((entry) => entry.screenId))
      .toEqual(["live-pulse", "audience-momentum", "email-health"]);
  });

  it("starts a template copy with its own name and description", () => {
    const profile = getTvBuiltInProfile("company-pulse");
    if (profile == null) throw new Error("Company Pulse must exist.");

    expect(createTvProfileEditorDraft(profile, true)).toMatchObject({
      displayName: "Company Pulse Copy",
      description: "New Profile",
    });
    expect(createTvProfileEditorDraft(profile, false)).toMatchObject({
      displayName: profile.configuration.displayName,
      description: profile.configuration.description,
    });
  });

  it("keeps duplicated names within the normalized profile-name limit", () => {
    expect(createTvProfileCopyDisplayName("A".repeat(80))).toBe(`${"A".repeat(75)} Copy`);
    expect(createTvProfileCopyDisplayName(`${"A".repeat(74)}ﬃ`)).toBe(`${"A".repeat(74)} Copy`);
  });

  it("keeps astral-character copies valid for the raw name schema", async () => {
    const copyName = createTvProfileCopyDisplayName("😀".repeat(40));
    await expect(TvProfileDisplayNameSchema.validate(copyName)).resolves.toBe(copyName);
  });
});
