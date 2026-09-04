import { readFileSync } from "node:fs";
import path from "node:path";
import { describe } from "vitest";
import { it } from "../../../../../helpers";
import {
  Auth,
  INTERNAL_PROJECT_OWNER_TEAM_ID,
  InternalProjectKeys,
  Project,
  Team,
  backendContext,
  niceBackendFetch,
} from "../../../../backend-helpers";

const BASE_PATH = "/api/latest/internal/sign-up-risk-inspector";
const hasPrivateRiskEngine = readFileSync(
  path.resolve(process.cwd(), "apps/backend/src/private/implementation.generated.ts"),
  "utf8",
).includes("../private/implementation/index");

async function signInAsInternalAdmin() {
  backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
  const { userId } = await Auth.fastSignUp();
  await Team.addMember(INTERNAL_PROJECT_OWNER_TEAM_ID, userId);
  return backendContext.value.userAuth;
}

describe("internal sign-up risk inspector", () => {
  it("rejects unauthenticated, customer-project, and non-platform-admin requests", async ({ expect }) => {
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
    const unauthenticated = await niceBackendFetch(BASE_PATH, {
      method: "POST",
      accessType: "client",
      body: { entries: [{ email: "a@example.com" }] },
    });
    expect(unauthenticated.status).toBe(401);

    await Project.createAndSwitch();
    await Auth.fastSignUp();
    const customerProject = await niceBackendFetch(BASE_PATH, {
      method: "POST",
      accessType: "client",
      body: { entries: [{ email: "a@example.com" }] },
    });
    expect([400, 401]).toContain(customerProject.status);

    const customerUserAuth = backendContext.value.userAuth;
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: customerUserAuth });
    const nonPlatformAdmin = await niceBackendFetch(BASE_PATH, {
      method: "POST",
      accessType: "client",
      body: { entries: [{ email: "a@example.com" }] },
    });
    expect([401, 403]).toContain(nonPlatformAdmin.status);
  });

  it("deduplicates emails and returns risk breakdowns", async ({ expect }) => {
    const internalUserAuth = await signInAsInternalAdmin();
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: internalUserAuth });

    const response = await niceBackendFetch(BASE_PATH, {
      method: "POST",
      accessType: "client",
      body: {
        entries: [
          { email: "someone@mailinator.com" },
          { email: "Clean.User+tag@Gmail.com" },
          { email: "someone@mailinator.com" },
        ],
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.results).toHaveLength(2);
    expect(response.body.results[1].email).toBe("clean.user+tag@gmail.com");
    expect(response.body.results[1].ip_address).toBeNull();

    if (hasPrivateRiskEngine) {
      expect(response.body.results[1].heuristic_facts.email_normalized).toBe("cleanuser@gmail.com");
      expect(response.body.results[0].scores.bot).toBe(75);
      expect(response.body.results[0].breakdown).toHaveLength(9);
      expect(response.body.results[0].breakdown.find((entry: { signal: string }) => entry.signal === "blacklist")).toMatchObject({
        factor: { bot: 0.75 },
        details: { matchedRules: expect.arrayContaining(["knownDisposableDomain"]) },
      });
    } else {
      expect(response.body.results[1].heuristic_facts.email_normalized).toBeNull();
      expect(response.body.results[0].scores).toEqual({ bot: 0, free_trial_abuse: 0 });
      expect(response.body.results[0].breakdown).toEqual([]);
    }
  });

  it("preserves IP and country pairing", async ({ expect }) => {
    const internalUserAuth = await signInAsInternalAdmin();
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: internalUserAuth });

    const response = await niceBackendFetch(BASE_PATH, {
      method: "POST",
      accessType: "client",
      body: {
        entries: [
          { email: "pair@example.com", ip_address: "203.0.113.5", country_code: "de" },
          { email: "pair@example.com" },
        ],
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.results).toHaveLength(2);
    expect(response.body.results[0].ip_address).toBe("203.0.113.5");
    expect(response.body.results[0].country_code).toBe("DE");
    if (hasPrivateRiskEngine) {
      expect(response.body.results[0].breakdown.find((entry: { signal: string }) => entry.signal === "same_ip")).toMatchObject({
        details: {
          signUpIp: "203.0.113.5",
          signUpIpTrusted: true,
        },
      });
    }
  });

  it("derives country from development email tags", async ({ expect }) => {
    const internalUserAuth = await signInAsInternalAdmin();
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: internalUserAuth });

    const response = await niceBackendFetch(BASE_PATH, {
      method: "POST",
      accessType: "client",
      body: { entries: [{ email: "geo+ca@example.com" }] },
    });

    expect(response.status).toBe(200);
    expect(response.body.results[0].country_code).toBe("CA");
  });

  it("rejects invalid IP and country values", async ({ expect }) => {
    const internalUserAuth = await signInAsInternalAdmin();
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: internalUserAuth });

    const invalidIp = await niceBackendFetch(BASE_PATH, {
      method: "POST",
      accessType: "client",
      body: { entries: [{ email: "pair@example.com", ip_address: "not-an-ip" }] },
    });
    expect(invalidIp.status).toBe(400);

    const invalidCountry = await niceBackendFetch(BASE_PATH, {
      method: "POST",
      accessType: "client",
      body: { entries: [{ email: "pair@example.com", country_code: "XX1" }] },
    });
    expect(invalidCountry.status).toBe(400);
  });

  it("rejects invalid and empty entry lists", async ({ expect }) => {
    const internalUserAuth = await signInAsInternalAdmin();
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: internalUserAuth });

    const invalidEmail = await niceBackendFetch(BASE_PATH, {
      method: "POST",
      accessType: "client",
      body: { entries: [{ email: "not-an-email" }] },
    });
    expect(invalidEmail.status).toBe(400);
    expect(JSON.stringify(invalidEmail.body)).toContain("entries");

    const emptyEntries = await niceBackendFetch(BASE_PATH, {
      method: "POST",
      accessType: "client",
      body: { entries: [] },
    });
    expect(emptyEntries.status).toBe(400);
    expect(JSON.stringify(emptyEntries.body)).toContain("entries");
  });
});
