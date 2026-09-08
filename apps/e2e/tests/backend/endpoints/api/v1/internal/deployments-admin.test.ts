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

const BASE_PATH = "/api/latest/internal/deployments-admin";

async function signInAsInternalAdmin() {
  backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
  const { userId } = await Auth.fastSignUp();
  await Team.addMember(INTERNAL_PROJECT_OWNER_TEAM_ID, userId);
}

describe("internal deployments admin", () => {
  it("rejects unauthenticated, customer-project, and non-platform-admin requests", async ({ expect }) => {
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
    const unauthenticated = await niceBackendFetch(BASE_PATH, { accessType: "client" });
    expect(unauthenticated.status).toBe(401);

    await Project.createAndSwitch();
    await Auth.fastSignUp();
    const customerProject = await niceBackendFetch(BASE_PATH, { accessType: "client" });
    expect([400, 401]).toContain(customerProject.status);

    // The one that matters: a signed-in internal-project user who is NOT on the
    // platform team. The internal project's publishable key is public, so this
    // is the account anyone could make for themselves.
    const customerUserAuth = backendContext.value.userAuth;
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: customerUserAuth });
    const nonPlatformAdmin = await niceBackendFetch(BASE_PATH, { accessType: "client" });
    expect([401, 403]).toContain(nonPlatformAdmin.status);

    const nonPlatformAdminWrite = await niceBackendFetch(BASE_PATH, {
      accessType: "client",
      method: "POST",
      body: { deployments_enabled: true },
    });
    expect([401, 403]).toContain(nonPlatformAdminWrite.status);
  });

  it("returns platform statistics and the deployment list", async ({ expect }) => {
    await signInAsInternalAdmin();

    const response = await niceBackendFetch(BASE_PATH, { accessType: "client" });
    expect(response.status).toBe(200);
    expect(response.body.fusebox).toMatchObject({ deployments_enabled: expect.any(Boolean) });
    expect(response.body.stats).toMatchObject({
      projects_with_provisioned_services: expect.any(Number),
      provisioned_services: expect.any(Number),
      max_deployed_services: expect.any(Number),
      deployments_total: expect.any(Number),
      deployments_recent: expect.any(Number),
      builds_total: expect.any(Number),
      builds_recent: expect.any(Number),
      deployments_in_flight: expect.any(Number),
      deployments_succeeded_recent: expect.any(Number),
      deployments_failed_recent: expect.any(Number),
      sources_by_runtime: expect.any(Array),
      recent_window_days: expect.any(Number),
    });
    expect(response.body.deployments).toEqual(expect.any(Array));
    // A build is a deployment that started a builder, so it can never exceed the
    // deployments it is drawn from — the one invariant between the two tiles.
    expect(response.body.stats.builds_total).toBeLessThanOrEqual(response.body.stats.deployments_total);
  });

  it("round-trips the fusebox", async ({ expect }) => {
    await signInAsInternalAdmin();

    const before = await niceBackendFetch(BASE_PATH, { accessType: "client" });
    expect(before.status).toBe(200);

    // Writes the SAME value back rather than flipping it, exactly as the
    // external-db-sync fusebox test does: this row is GLOBAL, so actually
    // turning deploys off here would fail every deployment test running
    // concurrently in another worker. The refusal itself is covered by
    // apps/backend/src/lib/deployments/platform-config.test.tsx, which needs no
    // shared state to prove both directions.
    const write = await niceBackendFetch(BASE_PATH, {
      accessType: "client",
      method: "POST",
      body: { deployments_enabled: before.body.fusebox.deployments_enabled },
    });
    expect(write.status).toBe(200);
    expect(write.body).toMatchObject({ deployments_enabled: before.body.fusebox.deployments_enabled });
  });
});
