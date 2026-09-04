import { describe, expect, it } from "vitest";
import {
  approveTvDisplayOrThrow,
  fetchTvDisplaysOrThrow,
  getTvSnapshotPath,
  hexclaveAppInternalsSymbol,
} from "./hexclave-app-internals";

describe("TV snapshot admin path", () => {
  it("keeps the profile as a URL-encoded path resource", () => {
    expect(getTvSnapshotPath("office / north")).toBe(
      "/internal/tv-mode/profiles/office%20%2F%20north/snapshot",
    );
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
