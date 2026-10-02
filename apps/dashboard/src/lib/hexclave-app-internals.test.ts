import { describe, expect, it } from "vitest";
import {
  approveTvDisplayOrThrow,
  fetchTvDisplaysOrThrow,
  fetchTvSnapshotOrThrow,
  getTvSnapshotPath,
  hexclaveAppInternalsSymbol,
} from "./hexclave-app-internals";
import { createTvFixtureSnapshot, getTvProfileFixture } from "./tv-mode/fixtures";

describe("TV snapshot admin path", () => {
  it("keeps the profile as a URL-encoded path resource", () => {
    expect(getTvSnapshotPath("office / north")).toBe(
      "/internal/tv-mode/profiles/office%20%2F%20north/snapshot",
    );
  });

  it("renegotiates at contract 2 when a legacy backend omits screenDurations", async () => {
    const profile = getTvProfileFixture("company-pulse");
    if (profile == null) throw new Error("The fallback test requires the company-pulse fixture.");
    const snapshot = createTvFixtureSnapshot("fallback-test", profile);
    if (snapshot.profile.screenDurations == null) {
      throw new Error("The fallback test requires a fixture with screenDurations.");
    }
    const { screenDurations: _screenDurations, ...legacyProfile } = snapshot.profile;
    const legacySnapshot = { ...snapshot, profile: legacyProfile };

    const requests: Array<{ path: string, options: RequestInit, type: string | undefined }> = [];
    const adminApp = {
      [hexclaveAppInternalsSymbol]: {
        sendRequest: async (path: string, options: RequestInit, type?: string) => {
          requests.push({ path, options, type });
          const body = requests.length === 1 ? legacySnapshot : snapshot;
          return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    };

    const result = await fetchTvSnapshotOrThrow(adminApp, "company-pulse");

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.path)).toEqual([
      "/internal/tv-mode/profiles/company-pulse/snapshot",
      "/internal/tv-mode/profiles/company-pulse/snapshot",
    ]);
    expect(new Headers(requests[0].options.headers).get("x-hexclave-tv-snapshot-contract")).toBe("3");
    expect(new Headers(requests[1].options.headers).get("x-hexclave-tv-snapshot-contract")).toBe("2");
    expect(result.profile.screenDurations).toEqual(snapshot.profile.screenDurations);
  });

  it("does not re-request when a contract-3 snapshot includes screenDurations", async () => {
    const profile = getTvProfileFixture("company-pulse");
    if (profile == null) throw new Error("The contract test requires the company-pulse fixture.");
    const snapshot = createTvFixtureSnapshot("contract-test", profile);
    const requests: Array<{ path: string, options: RequestInit }> = [];
    const adminApp = {
      [hexclaveAppInternalsSymbol]: {
        sendRequest: async (path: string, options: RequestInit) => {
          requests.push({ path, options });
          return new Response(JSON.stringify(snapshot), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    };

    await expect(fetchTvSnapshotOrThrow(adminApp, "company-pulse")).resolves.toMatchObject({
      profile: { id: "company-pulse" },
    });
    expect(requests).toHaveLength(1);
  });
});

describe("TV display admin API", () => {
  it("uses the narrow display-management routes and validates their response", async () => {
    const requests: Array<{ path: string, options: RequestInit, type: string | undefined }> = [];
    const adminApp = {
      [hexclaveAppInternalsSymbol]: {
        sendRequest: async (path: string, options: RequestInit, type?: string) => {
          requests.push({ path, options, type });
          const body = options.method === "POST"
            ? {
              success: true,
              approvedAt: "2026-08-14T12:00:00.000Z",
              expiresAt: "2026-08-14T12:10:00.000Z",
            }
            : {
              displays: [{
                id: "3af6ca2f-20eb-4c6b-a8b2-8f93d940f037",
                displayName: "Lobby",
                profileId: "company-pulse",
                profileDisplayName: "Company Pulse",
                profileFinancialVisibility: "redacted",
                state: "online",
                pairedAt: "2026-08-14T12:00:00.000Z",
                lastSeenAt: "2026-08-14T12:01:00.000Z",
                exactFinancialsAcknowledged: false,
              }],
            };
          return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    };

    await expect(fetchTvDisplaysOrThrow(adminApp)).resolves.toMatchObject([
      { displayName: "Lobby", profileId: "company-pulse" },
    ]);
    await approveTvDisplayOrThrow(adminApp, {
      pairingCode: "ABCD-EFGH",
      profileId: "company-pulse",
      displayName: "Lobby",
      acknowledgeExactFinancials: false,
    });

    expect(requests[0]).toMatchObject({
      path: "/internal/tv-mode/displays",
      options: { method: "GET" },
      type: "admin",
    });
    expect(requests[1]).toMatchObject({
      path: "/internal/tv-mode/displays",
      options: { method: "POST" },
      type: "admin",
    });
    expect(JSON.parse(String(requests[1].options.body))).toEqual({
      pairingCode: "ABCD-EFGH",
      profileId: "company-pulse",
      displayName: "Lobby",
      acknowledgeExactFinancials: false,
    });
  });
});
