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

const BASE_PATH = "/api/latest/internal/workflows-status";

describe("internal workflows status", () => {
  it("rejects unauthenticated, customer-project, and non-platform-admin requests", async ({ expect }) => {
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
    const unauthenticated = await niceBackendFetch(BASE_PATH, { accessType: "client" });
    expect(unauthenticated.status).toBe(401);

    await Project.createAndSwitch();
    await Auth.fastSignUp();
    const customerProject = await niceBackendFetch(BASE_PATH, { accessType: "client" });
    expect([400, 401]).toContain(customerProject.status);

    // The one that matters: a signed-in INTERNAL-project user who is not on
    // the platform team. The internal project's publishable key is public, so
    // this is the account anyone could make for themselves. It has to be a
    // real internal-project session — a customer project's token sent with
    // the internal keys is rejected earlier, as a 401, and would never reach
    // the platform-admin check.
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
    await Auth.fastSignUp();
    const nonPlatformAdmin = await niceBackendFetch(BASE_PATH, { accessType: "client" });
    expect(nonPlatformAdmin.status).toBe(403);
  });

  it("returns the outbox, run queue, and engine numbers", async ({ expect }) => {
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
    const { userId } = await Auth.fastSignUp();
    await Team.addMember(INTERNAL_PROJECT_OWNER_TEAM_ID, userId);

    const response = await niceBackendFetch(BASE_PATH, { accessType: "client" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      generated_at_millis: expect.any(Number),
      limits: {
        event_batch_size: expect.any(Number),
        event_tenancy_concurrency: expect.any(Number),
        event_claim_lease_seconds: expect.any(Number),
        run_claim_batch_size: expect.any(Number),
        per_workflow_concurrency: expect.any(Number),
        run_lease_seconds: expect.any(Number),
      },
      events: {
        pending: expect.any(Number),
        ready: expect.any(Number),
        claimed: expect.any(Number),
        backing_off: expect.any(Number),
        without_workflows: expect.any(Number),
        max_processing_attempts: expect.any(Number),
        enqueued_last_hour: expect.any(Number),
        processed_last_5_minutes: expect.any(Number),
        processed_last_hour: expect.any(Number),
        pending_by_type: expect.any(Array),
        pending_by_tenancy: expect.any(Array),
      },
      runs: {
        queued_due: expect.any(Number),
        queued_backing_off: expect.any(Number),
        running: expect.any(Number),
        running_lease_expired: expect.any(Number),
        sleeping: expect.any(Number),
        sleeping_overdue: expect.any(Number),
        completed_last_hour: expect.any(Number),
        failed_last_hour: expect.any(Number),
        canceled_last_hour: expect.any(Number),
        completed_last_day: expect.any(Number),
        failed_last_day: expect.any(Number),
        platform_failed_last_day: expect.any(Number),
        canceled_last_day: expect.any(Number),
        active_by_workflow: expect.any(Array),
      },
      definitions: {
        total: expect.any(Number),
        paused: expect.any(Number),
        tenancies: expect.any(Number),
      },
      schedules: {
        cursors: expect.any(Number),
      },
    });
    // The buckets partition the pending events, so they can never exceed it.
    const { events } = response.body;
    expect(events.ready + events.claimed).toBeLessThanOrEqual(events.pending);
    expect(events.without_workflows).toBeLessThanOrEqual(events.pending);
  });
});
