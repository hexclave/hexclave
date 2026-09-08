import {
  TvDisplayPairingChallengeSchema,
  TvDisplayPairingStatusSchema,
  TvSnapshotSchema,
} from "@hexclave/shared/dist/interface/admin-tv-mode";
import { it, niceFetch, type NiceResponse, STACK_BACKEND_BASE_URL, updateCookiesFromResponse } from "../../../../helpers";
import { Project } from "../../../backend-helpers";

const LATEST_REFRESH_COOKIE = "hexclave-tv-display-refresh";
const V1_REFRESH_COOKIE = "hexclave-tv-display-refresh-v1";

function apiUrl(path: string, version: "latest" | "v1" = "latest"): URL {
  return new URL(`/api/${version}${path}`, STACK_BACKEND_BASE_URL);
}

async function publicJsonRequest(path: string, options: {
  method?: "GET" | "POST",
  body?: unknown,
  authorization?: string,
  cookie?: string,
  version?: "latest" | "v1",
}) {
  return await niceFetch(apiUrl(path, options.version), {
    method: options.method ?? "GET",
    headers: {
      ...options.body === undefined ? {} : { "content-type": "application/json" },
      ...options.authorization == null ? {} : { authorization: `Bearer ${options.authorization}` },
      ...options.cookie == null ? {} : { cookie: options.cookie },
    },
    ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
  });
}

function activeRefreshCookie(response: NiceResponse, cookieName: string): string {
  // The generic E2E cookie helper ignores paths. Select the live cookie by
  // name so these requests model a browser sending only its matching alias.
  const matchingCookies = response.headers.getSetCookie().filter((cookie) =>
    cookie.startsWith(`${cookieName}=`) && !cookie.includes("Max-Age=0"));
  if (matchingCookies.length !== 1) throw new Error(`Expected one live ${cookieName} cookie.`);
  const cookiePair = matchingCookies.at(0)?.split(";").at(0);
  if (cookiePair == null) throw new Error("Expected the live Set-Cookie header to contain a cookie pair.");
  return cookiePair;
}

async function adminJsonRequest(options: {
  path: string,
  projectId: string,
  adminAccessToken: string,
  method?: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
}) {
  return await niceFetch(apiUrl(options.path), {
    method: options.method ?? "GET",
    headers: {
      "x-stack-access-type": "admin",
      "x-stack-project-id": options.projectId,
      "x-stack-branch-id": "main",
      "x-stack-admin-access-token": options.adminAccessToken,
      ...options.body === undefined ? {} : { "content-type": "application/json" },
    },
    ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
  });
}

async function createPairedDisplay(displayName: string) {
  const project = await Project.createAndSwitch();
  const challengeResponse = await publicJsonRequest("/tv-displays/pairing-challenges", { method: "POST" });
  if (challengeResponse.status !== 200) throw new Error(`Expected pairing challenge, received ${challengeResponse.status}.`);
  const challenge = await TvDisplayPairingChallengeSchema.validate(challengeResponse.body, { strict: true });
  const approvalResponse = await adminJsonRequest({
    path: "/internal/tv-mode/displays",
    projectId: project.projectId,
    adminAccessToken: project.adminAccessToken,
    method: "POST",
    body: {
      pairingCode: challenge.pairingCode,
      profileId: "company-pulse",
      displayName,
      acknowledgeExactFinancials: false,
    },
  });
  if (approvalResponse.status !== 200) throw new Error(`Expected display approval, received ${approvalResponse.status}.`);
  const statusResponse = await publicJsonRequest(
    `/tv-displays/pairing-challenges/${encodeURIComponent(challenge.challengeId)}/status`,
    { method: "POST", body: { deviceSecret: challenge.deviceSecret } },
  );
  if (statusResponse.status !== 200) throw new Error(`Expected paired status, received ${statusResponse.status}.`);
  const pairing = await TvDisplayPairingStatusSchema.validate(statusResponse.body, { strict: true });
  if (pairing.status !== "paired") throw new Error(`Expected paired display, received ${pairing.status}.`);
  return {
    pairing,
    refreshCookie: updateCookiesFromResponse("", statusResponse),
    challenge,
    project,
    statusResponse,
  };
}

it("pairs a narrow display principal, preserves tenancy assignment, and detects refresh replay", async ({ expect }) => {
  const {
    pairing,
    refreshCookie: firstRefreshCookie,
    challenge,
    project: firstProject,
    statusResponse,
  } = await createPairedDisplay("E2E Lobby Display");
  const refreshSetCookies = statusResponse.headers.getSetCookie()
    .filter((cookie) => cookie.startsWith(`${LATEST_REFRESH_COOKIE}=`) || cookie.startsWith(`${V1_REFRESH_COOKIE}=`));
  expect(refreshSetCookies).toHaveLength(4);
  // Legacy deletions must precede both replacements: affected WebKit cookie
  // stores delete by name/domain without respecting the cookie path.
  expect(refreshSetCookies.slice(0, 2)).toEqual([
    expect.stringContaining(`${LATEST_REFRESH_COOKIE}=; Path=/api; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`),
    expect.stringContaining(`${LATEST_REFRESH_COOKIE}=; Path=/api/v1/tv-displays; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`),
  ]);
  expect(refreshSetCookies[2]).toContain("Path=/api/latest/tv-displays");
  expect(refreshSetCookies[2]?.startsWith(`${LATEST_REFRESH_COOKIE}=`)).toBe(true);
  expect(refreshSetCookies[3]).toContain("Path=/api/v1/tv-displays");
  expect(refreshSetCookies[3]?.startsWith(`${V1_REFRESH_COOKIE}=`)).toBe(true);
  for (const refreshSetCookie of refreshSetCookies) {
    expect(refreshSetCookie).toContain("HttpOnly");
    expect(refreshSetCookie).toContain("SameSite=Strict");
  }
  for (const refreshSetCookie of refreshSetCookies.filter((cookie) => !cookie.includes("Max-Age=0"))) {
    expect(refreshSetCookie).toContain("Max-Age=2592000");
  }

  const snapshotResponse = await publicJsonRequest(
    "/tv-displays/snapshot?projectId=not-trusted&profileId=engineering-office",
    { authorization: pairing.accessToken },
  );
  expect(snapshotResponse.status).toBe(200);
  const snapshot = await TvSnapshotSchema.validate(snapshotResponse.body, { strict: true });
  expect(snapshot.project.id).toBe(firstProject.projectId);
  expect(snapshot.profile.id).toBe("company-pulse");

  const adminBoundaryResponse = await publicJsonRequest("/internal/tv-mode/profiles", {
    authorization: pairing.accessToken,
  });
  expect(adminBoundaryResponse.status).toBe(400);

  const secondProject = await Project.createAndSwitch();
  const crossTenantUpdate = await adminJsonRequest({
    path: `/internal/tv-mode/displays/${encodeURIComponent(pairing.display.id)}`,
    projectId: secondProject.projectId,
    adminAccessToken: secondProject.adminAccessToken,
    method: "PATCH",
    body: {
      profileId: "company-pulse",
      displayName: "Wrong Tenant",
      acknowledgeExactFinancials: false,
    },
  });
  expect(crossTenantUpdate.status).toBe(404);

  const crossTenantDelete = await adminJsonRequest({
    path: `/internal/tv-mode/displays/${encodeURIComponent(pairing.display.id)}`,
    projectId: secondProject.projectId,
    adminAccessToken: secondProject.adminAccessToken,
    method: "DELETE",
  });
  expect(crossTenantDelete.status).toBe(404);

  const secondProjectDisplays = await adminJsonRequest({
    path: "/internal/tv-mode/displays",
    projectId: secondProject.projectId,
    adminAccessToken: secondProject.adminAccessToken,
  });
  expect(secondProjectDisplays.status).toBe(200);
  expect(secondProjectDisplays.body).toEqual({ displays: [] });

  const refreshResponse = await publicJsonRequest("/tv-displays/auth/refresh", {
    method: "POST",
    cookie: firstRefreshCookie,
  });
  expect(refreshResponse.status).toBe(200);
  expect(refreshResponse.body).toMatchObject({ accessToken: expect.any(String) });

  const replayResponse = await publicJsonRequest("/tv-displays/auth/refresh", {
    method: "POST",
    cookie: firstRefreshCookie,
  });
  expect(replayResponse.status).toBe(401);

  const compromisedFamilySnapshot = await publicJsonRequest("/tv-displays/snapshot", {
    authorization: refreshResponse.body.accessToken,
  });
  expect(compromisedFamilySnapshot.status).toBe(401);
});

it("keeps latest and v1 refresh aliases synchronized across repeated rotations and detects cross-alias replay", async ({ expect }) => {
  const { statusResponse } = await createPairedDisplay("Alternating API Alias Display");
  let latestCookie = activeRefreshCookie(statusResponse, LATEST_REFRESH_COOKIE);
  let v1Cookie = activeRefreshCookie(statusResponse, V1_REFRESH_COOKIE);
  const originalV1Cookie = v1Cookie;
  let finalResponse = statusResponse;

  for (let rotation = 0; rotation < 4; rotation++) {
    const version = rotation % 2 === 0 ? "latest" : "v1";
    const response = await publicJsonRequest("/tv-displays/auth/refresh", {
      version,
      method: "POST",
      cookie: version === "latest" ? latestCookie : v1Cookie,
    });
    expect(response.status).toBe(200);
    const nextLatestCookie = activeRefreshCookie(response, LATEST_REFRESH_COOKIE);
    const nextV1Cookie = activeRefreshCookie(response, V1_REFRESH_COOKIE);
    // Compare booleans to keep bearer values out of failed assertion output.
    expect(nextLatestCookie !== latestCookie).toBe(true);
    expect(nextV1Cookie !== v1Cookie).toBe(true);
    expect(nextLatestCookie.slice(LATEST_REFRESH_COOKIE.length) === nextV1Cookie.slice(V1_REFRESH_COOKIE.length)).toBe(true);
    latestCookie = nextLatestCookie;
    v1Cookie = nextV1Cookie;
    finalResponse = response;
  }

  const snapshot = await publicJsonRequest("/tv-displays/snapshot", {
    authorization: finalResponse.body.accessToken,
  });
  expect(snapshot.status).toBe(200);

  const replayResponse = await publicJsonRequest("/tv-displays/auth/refresh", {
    version: "v1",
    method: "POST",
    cookie: originalV1Cookie,
  });
  expect(replayResponse.status).toBe(401);
  const compromisedSnapshot = await publicJsonRequest("/tv-displays/snapshot", {
    authorization: finalResponse.body.accessToken,
  });
  expect(compromisedSnapshot.status).toBe(401);
});

it("migrates an existing original-name v1 cookie to the distinct alias without re-pairing", async ({ expect }) => {
  const { statusResponse } = await createPairedDisplay("Legacy V1 Cookie Display");
  const legacyCookie = activeRefreshCookie(statusResponse, LATEST_REFRESH_COOKIE);
  const migratedResponse = await publicJsonRequest("/tv-displays/auth/refresh", {
    version: "v1",
    method: "POST",
    cookie: legacyCookie,
  });
  expect(migratedResponse.status).toBe(200);

  const nextResponse = await publicJsonRequest("/tv-displays/auth/refresh", {
    version: "v1",
    method: "POST",
    cookie: activeRefreshCookie(migratedResponse, V1_REFRESH_COOKIE),
  });
  expect(nextResponse.status).toBe(200);
  const snapshot = await publicJsonRequest("/tv-displays/snapshot", {
    authorization: nextResponse.body.accessToken,
  });
  expect(snapshot.status).toBe(200);
});

it("does not retry a rejected v1 alias with a valid legacy credential", async ({ expect }) => {
  const { statusResponse } = await createPairedDisplay("Conflicting Alias Display");
  const legacyCookie = activeRefreshCookie(statusResponse, LATEST_REFRESH_COOKIE);
  const invalidResponse = await publicJsonRequest("/tv-displays/auth/refresh", {
    version: "v1",
    method: "POST",
    cookie: `${V1_REFRESH_COOKIE}=invalid; ${legacyCookie}`,
  });
  expect(invalidResponse.status).toBe(401);
  const clearedCookies = invalidResponse.headers.getSetCookie();
  expect(clearedCookies).toHaveLength(4);
  for (const cookie of clearedCookies) expect(cookie).toContain("Max-Age=0");
  expect(clearedCookies.some((cookie) => cookie.startsWith(`${V1_REFRESH_COOKIE}=`))).toBe(true);

  // The rejected alias must not consume the valid legacy credential or
  // cause a second refresh attempt that silently authorizes the request.
  const validResponse = await publicJsonRequest("/tv-displays/auth/refresh", {
    method: "POST",
    cookie: legacyCookie,
  });
  expect(validResponse.status).toBe(200);
});

it("does not accept a v1-only cookie on the latest route", async ({ expect }) => {
  const { statusResponse } = await createPairedDisplay("Path Scoped Cookie Display");
  const wrongAliasResponse = await publicJsonRequest("/tv-displays/auth/refresh", {
    method: "POST",
    cookie: activeRefreshCookie(statusResponse, V1_REFRESH_COOKIE),
  });
  expect(wrongAliasResponse.status).toBe(401);

  const validResponse = await publicJsonRequest("/tv-displays/auth/refresh", {
    method: "POST",
    cookie: activeRefreshCookie(statusResponse, LATEST_REFRESH_COOKIE),
  });
  expect(validResponse.status).toBe(200);
});

it("hard-deletes a display after an administrator unpairs it and rejects its remote credentials", async ({ expect }) => {
  const { pairing, refreshCookie, project } = await createPairedDisplay("E2E Active Display");

  const activeDisplays = await adminJsonRequest({
    path: "/internal/tv-mode/displays",
    projectId: project.projectId,
    adminAccessToken: project.adminAccessToken,
  });
  expect(activeDisplays.status).toBe(200);
  expect(activeDisplays.body).toMatchObject({
    displays: [expect.objectContaining({ id: pairing.display.id, state: "never-connected" })],
  });

  const unpairResponse = await adminJsonRequest({
    path: `/internal/tv-mode/displays/${encodeURIComponent(pairing.display.id)}`,
    projectId: project.projectId,
    adminAccessToken: project.adminAccessToken,
    method: "DELETE",
  });
  expect(unpairResponse.status).toBe(200);

  const remainingDisplays = await adminJsonRequest({
    path: "/internal/tv-mode/displays",
    projectId: project.projectId,
    adminAccessToken: project.adminAccessToken,
  });
  expect(remainingDisplays.status).toBe(200);
  expect(remainingDisplays.body).toEqual({ displays: [] });

  const staleSnapshot = await publicJsonRequest("/tv-displays/snapshot", {
    authorization: pairing.accessToken,
  });
  expect(staleSnapshot.status).toBe(401);
  const staleRefresh = await publicJsonRequest("/tv-displays/auth/refresh", {
    method: "POST",
    cookie: refreshCookie,
  });
  expect(staleRefresh.status).toBe(401);

  const staleV1Refresh = await publicJsonRequest("/tv-displays/auth/refresh", {
    version: "v1",
    method: "POST",
    cookie: refreshCookie,
  });
  expect(staleV1Refresh.status).toBe(401);

  const repeatedUnpair = await publicJsonRequest("/tv-displays/unpair", {
    method: "POST",
    authorization: pairing.accessToken,
    cookie: refreshCookie,
  });
  expect(repeatedUnpair.status).toBe(401);
});

it("clears every refresh-cookie path when a display unpairs itself", async ({ expect }) => {
  const { pairing, refreshCookie } = await createPairedDisplay("Self Unpair Display");

  const unpairResponse = await publicJsonRequest("/tv-displays/unpair", {
    method: "POST",
    authorization: pairing.accessToken,
    cookie: refreshCookie,
  });
  expect(unpairResponse.status).toBe(200);
  expect(unpairResponse.body).toEqual({ success: true });
  const clearedCookies = unpairResponse.headers.getSetCookie()
    .filter((cookie) => cookie.startsWith(`${LATEST_REFRESH_COOKIE}=`) || cookie.startsWith(`${V1_REFRESH_COOKIE}=`));
  expect(clearedCookies).toHaveLength(4);
  expect(clearedCookies).toEqual(expect.arrayContaining([
    expect.stringContaining(`${LATEST_REFRESH_COOKIE}=; Path=/api/latest/tv-displays;`),
    expect.stringContaining(`${LATEST_REFRESH_COOKIE}=; Path=/api/v1/tv-displays;`),
    expect.stringContaining(`${LATEST_REFRESH_COOKIE}=; Path=/api;`),
    expect.stringContaining(`${V1_REFRESH_COOKIE}=; Path=/api/v1/tv-displays;`),
  ]));
  for (const clearedCookie of clearedCookies) expect(clearedCookie).toContain("Max-Age=0");

  const staleRefresh = await publicJsonRequest("/tv-displays/auth/refresh", {
    method: "POST",
    cookie: refreshCookie,
  });
  expect(staleRefresh.status).toBe(401);
});
