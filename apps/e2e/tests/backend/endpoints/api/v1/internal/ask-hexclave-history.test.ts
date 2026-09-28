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

const BASE_PATH = "/api/latest/internal/ask-hexclave-history";

async function signInAsInternalAdmin() {
  backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
  const { userId } = await Auth.fastSignUp();
  await Team.addMember(INTERNAL_PROJECT_OWNER_TEAM_ID, userId);
}

describe("internal ask Hexclave history", () => {
  it("rejects unauthenticated, customer-project, and non-platform-admin requests", async ({ expect }) => {
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
    const unauthenticated = await niceBackendFetch(BASE_PATH, { accessType: "client" });
    expect(unauthenticated.status).toBe(401);

    await Project.createAndSwitch();
    await Auth.fastSignUp();
    const customerProject = await niceBackendFetch(BASE_PATH, { accessType: "client" });
    expect([400, 401]).toContain(customerProject.status);

    const customerUserAuth = backendContext.value.userAuth;
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: customerUserAuth });
    const nonPlatformAdmin = await niceBackendFetch(BASE_PATH, { accessType: "client" });
    expect([401, 403]).toContain(nonPlatformAdmin.status);
  });

  it("returns a bounded history page and validates filters", async ({ expect }) => {
    await signInAsInternalAdmin();

    const response = await niceBackendFetch(
      `${BASE_PATH}?transport=skill-ask&query=oauth&limit=10`,
      { accessType: "client" },
    );
    expect(response.status).toBe(200);
    expect(response.body.calls).toEqual(expect.any(Array));
    expect(response.body.next_cursor === null || typeof response.body.next_cursor === "string").toBe(true);

    const invalidTransport = await niceBackendFetch(
      `${BASE_PATH}?transport=unknown`,
      { accessType: "client" },
    );
    expect(invalidTransport.status).toBe(400);

    const invalidLimit = await niceBackendFetch(
      `${BASE_PATH}?limit=201`,
      { accessType: "client" },
    );
    expect(invalidLimit.status).toBe(400);
  });
});
