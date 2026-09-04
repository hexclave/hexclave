import {
  getTvBuiltInProfile,
  TvSavedProfileResourceSchema,
  TvSnapshotSchema,
} from "@hexclave/shared/dist/interface/admin-tv-mode";
import { it } from "../../../../helpers";
import { Project, niceBackendFetch } from "../../../backend-helpers";
import { createLiveModeOneTimePurchaseTransaction } from "../../../helpers/payments";

it("returns one validated, project-scoped TV snapshot for an admin", async ({ expect }) => {
  const firstProject = await Project.createAndSwitch();
  const firstResponse = await niceBackendFetch(
    "/api/v1/internal/tv-mode/profiles/company-pulse/snapshot",
    { accessType: "admin" },
  );

  expect(firstResponse.status).toBe(200);
  await expect(TvSnapshotSchema.validate(firstResponse.body, { strict: true })).resolves.toMatchObject({
    project: { id: firstProject.projectId },
    profile: { id: "company-pulse" },
    presentation: { highlight: null, takeover: null },
  });

  const legacyContractResponse = await niceBackendFetch(
    "/api/v1/internal/tv-mode/profiles/company-pulse/snapshot",
    {
      accessType: "admin",
      headers: { "x-stack-tv-snapshot-contract": "2" },
    },
  );
  expect(legacyContractResponse.status).toBe(200);
  expect(legacyContractResponse.body.profile.screenDurations).toHaveLength(
    legacyContractResponse.body.profile.playlist.length,
  );

  const secondProject = await Project.createAndSwitch();
  const secondResponse = await niceBackendFetch(
    "/api/v1/internal/tv-mode/profiles/company-pulse/snapshot",
    { accessType: "admin" },
  );

  expect(secondResponse.status).toBe(200);
  expect(secondResponse.body.project.id).toBe(secondProject.projectId);
  expect(secondResponse.body.project.id).not.toBe(firstProject.projectId);
});

it("persists project-scoped TV profiles with duplication and optimistic concurrency", async ({ expect }) => {
  await createLiveModeOneTimePurchaseTransaction();
  const template = getTvBuiltInProfile("company-pulse");
  if (template == null) throw new Error("Company Pulse must exist.");

  const createdResponse = await niceBackendFetch("/api/v1/internal/tv-mode/profiles", {
    method: "POST",
    accessType: "admin",
    body: {
      configuration: {
        ...template.configuration,
        displayName: "Operations Wall",
        financialVisibility: "exact",
      },
    },
  });
  expect(createdResponse.status).toBe(200);
  const created = await TvSavedProfileResourceSchema.validate(createdResponse.body.profile, { strict: true });

  const immediateReadResponse = await niceBackendFetch(
    `/api/v1/internal/tv-mode/profiles/${created.id}`,
    { accessType: "admin" },
  );
  expect(immediateReadResponse.status).toBe(200);
  expect(immediateReadResponse.body.profile).toMatchObject({
    id: created.id,
    version: created.version,
    configuration: {
      displayName: "Operations Wall",
      interruptionPreferences: {
        timing: {
          incident: {
            takeoverSeconds: 60,
            recoveryTakeoverSeconds: 30,
            resolvedHighlightSeconds: 3600,
          },
          criticalIncident: {
            takeoverSeconds: 120,
            recoveryTakeoverSeconds: 60,
            resolvedHighlightSeconds: 21600,
          },
        },
      },
    },
  });

  const immediateListResponse = await niceBackendFetch(
    "/api/v1/internal/tv-mode/profiles",
    { accessType: "admin" },
  );
  expect(immediateListResponse.status).toBe(200);
  expect(immediateListResponse.body.savedProfiles).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: created.id, version: created.version }),
  ]));

  const snapshotResponse = await niceBackendFetch(
    `/api/v1/internal/tv-mode/profiles/${created.id}/snapshot`,
    { accessType: "admin" },
  );
  expect(snapshotResponse.status).toBe(200);
  expect(snapshotResponse.body.profile).toMatchObject({
    id: created.id,
    displayName: "Operations Wall",
  });

  const updateResponse = await niceBackendFetch(`/api/v1/internal/tv-mode/profiles/${created.id}`, {
    method: "PATCH",
    accessType: "admin",
    body: {
      expectedVersion: created.version,
      configuration: { ...created.configuration, displayName: "Operations Wall Updated" },
    },
  });
  expect(updateResponse.status).toBe(200);
  const updated = await TvSavedProfileResourceSchema.validate(updateResponse.body.profile, { strict: true });
  expect(updated.version).toBe(created.version + 1);

  const redactResponse = await niceBackendFetch(`/api/v1/internal/tv-mode/profiles/${created.id}`, {
    method: "PATCH",
    accessType: "admin",
    body: {
      expectedVersion: updated.version,
      configuration: { ...updated.configuration, financialVisibility: "redacted" },
    },
  });
  expect(redactResponse.status).toBe(200);
  const redacted = await TvSavedProfileResourceSchema.validate(redactResponse.body.profile, { strict: true });
  expect(redacted.version).toBe(updated.version + 1);

  const immediateRedactedProfileResponse = await niceBackendFetch(
    `/api/v1/internal/tv-mode/profiles/${created.id}`,
    { accessType: "admin" },
  );
  expect(immediateRedactedProfileResponse.status).toBe(200);
  expect(immediateRedactedProfileResponse.body.profile).toMatchObject({
    id: created.id,
    version: redacted.version,
    configuration: { financialVisibility: "redacted" },
  });

  const immediateRedactedSnapshotResponse = await niceBackendFetch(
    `/api/v1/internal/tv-mode/profiles/${created.id}/snapshot`,
    { accessType: "admin" },
  );
  expect(immediateRedactedSnapshotResponse.status).toBe(200);
  const immediateRedactedSnapshot = await TvSnapshotSchema.validate(
    immediateRedactedSnapshotResponse.body,
    { strict: true },
  );
  const revenueScreen = immediateRedactedSnapshot.screens.find((screen) => screen.id === "revenue-payments");
  if (revenueScreen?.id !== "revenue-payments" || revenueScreen.data == null) {
    throw new Error(
      `The live payment fixture must produce Revenue & Payments data for redaction coverage (status: ${revenueScreen?.sourceStatus ?? "missing"}, diagnostic: ${revenueScreen?.diagnosticCode ?? "missing"}).`,
    );
  }
  expect(revenueScreen.data.financials.visibility).toBe("redacted");

  const staleUpdateResponse = await niceBackendFetch(`/api/v1/internal/tv-mode/profiles/${created.id}`, {
    method: "PATCH",
    accessType: "admin",
    body: {
      expectedVersion: created.version,
      configuration: created.configuration,
    },
  });
  expect(staleUpdateResponse.status).toBe(409);

  const staleDuplicateResponse = await niceBackendFetch(`/api/v1/internal/tv-mode/profiles/${created.id}/duplicate`, {
    method: "POST",
    accessType: "admin",
    body: { displayName: "Operations Wall Stale Copy", expectedSourceVersion: updated.version },
  });
  expect(staleDuplicateResponse.status).toBe(409);

  const duplicateResponse = await niceBackendFetch(`/api/v1/internal/tv-mode/profiles/${created.id}/duplicate`, {
    method: "POST",
    accessType: "admin",
    body: { displayName: "Operations Wall Copy", expectedSourceVersion: redacted.version },
  });
  expect(duplicateResponse.status).toBe(200);

  const nameConflictResponse = await niceBackendFetch(`/api/v1/internal/tv-mode/profiles/${created.id}`, {
    method: "PATCH",
    accessType: "admin",
    body: {
      expectedVersion: redacted.version,
      configuration: { ...redacted.configuration, displayName: "Operations Wall Copy" },
    },
  });
  expect(nameConflictResponse.status).toBe(409);

  const staleDeleteResponse = await niceBackendFetch(`/api/v1/internal/tv-mode/profiles/${created.id}`, {
    method: "DELETE",
    accessType: "admin",
    body: { expectedVersion: updated.version },
  });
  expect(staleDeleteResponse.status).toBe(409);

  const deleteResponse = await niceBackendFetch(`/api/v1/internal/tv-mode/profiles/${created.id}`, {
    method: "DELETE",
    accessType: "admin",
    body: { expectedVersion: redacted.version },
  });
  expect(deleteResponse.status).toBe(200);

  const immediateDeletedReadResponse = await niceBackendFetch(
    `/api/v1/internal/tv-mode/profiles/${created.id}`,
    { accessType: "admin" },
  );
  expect(immediateDeletedReadResponse.status).toBe(404);

  const immediateDeletedListResponse = await niceBackendFetch(
    "/api/v1/internal/tv-mode/profiles",
    { accessType: "admin" },
  );
  expect(immediateDeletedListResponse.status).toBe(200);
  expect(immediateDeletedListResponse.body.savedProfiles).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ id: created.id }),
  ]));
});

it("does not resolve a saved TV profile through another project's tenancy", async ({ expect }) => {
  await Project.createAndSwitch();
  const template = getTvBuiltInProfile("company-pulse");
  if (template == null) throw new Error("Company Pulse must exist.");
  const createdResponse = await niceBackendFetch("/api/v1/internal/tv-mode/profiles", {
    method: "POST",
    accessType: "admin",
    body: {
      configuration: { ...template.configuration, displayName: "Private Project TV" },
    },
  });
  expect(createdResponse.status).toBe(200);
  const created = await TvSavedProfileResourceSchema.validate(createdResponse.body.profile, { strict: true });

  await Project.createAndSwitch();
  const crossProjectResponse = await niceBackendFetch(
    `/api/v1/internal/tv-mode/profiles/${created.id}`,
    { accessType: "admin" },
  );
  expect(crossProjectResponse.status).toBe(404);
});

it("rejects non-admin access and unknown TV profile resources", async ({ expect }) => {
  await Project.createAndSwitch();
  const template = getTvBuiltInProfile("company-pulse");
  if (template == null) throw new Error("Company Pulse must exist.");

  const nonAdminResponse = await niceBackendFetch(
    "/api/v1/internal/tv-mode/profiles/company-pulse/snapshot",
    { accessType: "server" },
  );
  expect(nonAdminResponse.status).toBe(401);

  const expandedNormalizedNameResponse = await niceBackendFetch(
    "/api/v1/internal/tv-mode/profiles",
    {
      method: "POST",
      accessType: "admin",
      body: {
        configuration: {
          ...template.configuration,
          displayName: "ﷺ".repeat(5),
        },
      },
    },
  );
  expect(expandedNormalizedNameResponse.status).toBe(400);

  const unknownProfileResponse = await niceBackendFetch(
    "/api/v1/internal/tv-mode/profiles/unknown%20profile/snapshot",
    { accessType: "admin" },
  );
  expect(unknownProfileResponse.status).toBe(404);

  const malformedUpdateResponse = await niceBackendFetch(
    "/api/v1/internal/tv-mode/profiles/not-a-uuid",
    {
      method: "PATCH",
      accessType: "admin",
      body: {
        expectedVersion: 1,
        configuration: template.configuration,
      },
    },
  );
  expect(malformedUpdateResponse.status).toBe(404);

  const malformedDeleteResponse = await niceBackendFetch(
    "/api/v1/internal/tv-mode/profiles/not-a-uuid",
    {
      method: "DELETE",
      accessType: "admin",
      body: { expectedVersion: 1 },
    },
  );
  expect(malformedDeleteResponse.status).toBe(404);
});
