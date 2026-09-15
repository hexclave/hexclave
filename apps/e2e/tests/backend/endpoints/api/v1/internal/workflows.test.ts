import { describe } from "vitest";
import { it } from "../../../../../helpers";
import { Project, backendContext, niceBackendFetch } from "../../../../backend-helpers";
import { createWorkflow, listRuns, pollWithTicks, randomSlug, retireWorkflow, sendCustomEvent, tickWorkflowEngine, updateWorkflowSource } from "./workflows-helpers";

// E2E tests for Hexclave Workflows v1. These exercise the real engine end to
// end: sync -> version mint -> event -> run creation (runKey/onConflict) ->
// sandbox step execution (freestyle mock) -> memoization -> completion, plus
// cancel/upgrade/retry and the app-installation gate on both sides.
//
// Notes on test hygiene: workflows are gated on the alpha-stage
// `workflows-alpha` app, so every test runs against its own freshly created
// project that installs it. Each workflow still uses a unique id and is
// deleted at the end so tests exercise the same cleanup path as the dashboard.
//
// Dynamic ids/emails make inline snapshots impractical here, so these tests
// use toMatchObject assertions instead (deliberate deviation from the
// usual snapshot preference).

/**
 * Creates a project with the Workflows app installed and switches the backend
 * context to it, returning its keys so a test can switch back later.
 */
async function createWorkflowsProject() {
  await Project.createAndSwitch();
  await Project.updateConfig({ "apps.installed.workflows-alpha.enabled": true });
  return backendContext.value.projectKeys;
}

/** Runs `fn` against a fresh project that has the Workflows app installed. */
async function inFreshWorkflowsProject<T>(fn: () => Promise<T>): Promise<T> {
  await createWorkflowsProject();
  return await fn();
}

async function setWorkflowPaused(expect: any, workflowId: string, isPaused: boolean) {
  const response = await niceBackendFetch(`/api/v1/internal/workflows/${workflowId}`, {
    method: "PATCH",
    accessType: "admin",
    body: { is_paused: isPaused },
  });
  expect(response).toMatchObject({ status: 200, body: { workflow_id: workflowId, is_paused: isPaused } });
  return response.body as { is_paused: boolean, paused_at_millis: number | null };
}

async function createUser(expect: any, email: string) {
  const response = await niceBackendFetch("/api/v1/users", {
    method: "POST",
    accessType: "server",
    body: { primary_email: email },
  });
  expect(response.status).toBe(201);
  return response.body.id as string;
}

describe("multi-tenancy", () => {
  it("serves every workflows route for an ordinary project", async ({ expect }) => {
    // Workflows are available to any project. Like every other app, the API is
    // NOT gated on `apps.installed.workflows-alpha` — installing the app only
    // decides whether the dashboard surfaces it.
    await Project.createAndSwitch();

    const listResponse = await niceBackendFetch("/api/v1/internal/workflows", { method: "GET", accessType: "admin" });
    expect(listResponse).toMatchObject({ status: 200, body: { workflows: [] } });

    const workflowId = randomSlug("e2e-uninstalled");
    await createWorkflow(expect, workflowId, `import { workflow, customEvent } from "@hexclave/workflows";
export default workflow("${workflowId}", { on: [customEvent("ping")] }, async () => {});
`);
    await retireWorkflow(expect, workflowId);
  });

  it("does not create runs for entity mutations in other projects", { timeout: 180_000 }, async ({ expect }) => {
    const workflowId = randomSlug("e2e-isolation");
    const workflowsProjectKeys = await createWorkflowsProject();
    await createWorkflow(expect, workflowId, `import { workflow } from "@hexclave/workflows";
export default workflow("${workflowId}", {
  on: ["user.created"],
  runKey: (event) => "user:" + event.data.id,
}, async (event, step) => {
  await step.run("noop", () => event.data.primary_email);
});
`);

    // A user created in ANOTHER project must never reach this project's
    // workflows: events and definitions are both tenancy-scoped, so the other
    // project's event only ever matches the other project's (empty) definitions.
    const otherEmail = `${randomSlug("isolated")}@example.com`;
    await Project.createAndSwitch();
    const createUserResponse = await niceBackendFetch("/api/v1/users", {
      method: "POST",
      accessType: "server",
      body: { primary_email: otherEmail },
    });
    expect(createUserResponse.status).toBe(201);

    await backendContext.with({ projectKeys: workflowsProjectKeys, userAuth: null }, async () => {
      await tickWorkflowEngine(expect);
      await tickWorkflowEngine(expect);
      const { runs } = await listRuns(workflowId);
      expect(runs.filter((run) => run.trigger_summary === otherEmail)).toEqual([]);
      await retireWorkflow(expect, workflowId);
    });
  });
});

describe("workflow lifecycle", () => {
  it("orders by latest deployment and deletes active workflows", { timeout: 180_000 }, async ({ expect }) => {
    await inFreshWorkflowsProject(async () => {
      const olderWorkflowId = randomSlug("e2e-order-older");
      const newerWorkflowId = randomSlug("e2e-order-newer");
      const eventName = randomSlug("e2e-delete-active");
      const olderSource = `import { workflow, customEvent } from "@hexclave/workflows";
export default workflow("${olderWorkflowId}", { on: [customEvent("${eventName}")] }, async (event, step) => {
  await step.sleep("keep-active", "1h");
});
`;
      const newerSource = `import { workflow } from "@hexclave/workflows";
export default workflow("${newerWorkflowId}", { on: ["user.created"] }, async () => {});
`;

      await createWorkflow(expect, olderWorkflowId, olderSource);
      await createWorkflow(expect, newerWorkflowId, newerSource);
      await updateWorkflowSource(expect, olderWorkflowId, olderSource.replace("1h", "2h"), 2);

      const listResponse = await niceBackendFetch("/api/v1/internal/workflows", { method: "GET", accessType: "admin" });
      expect(listResponse.status).toBe(200);
      const workflowIds = listResponse.body.workflows.map((workflow: any) => workflow.id);
      expect(workflowIds.indexOf(olderWorkflowId)).toBeLessThan(workflowIds.indexOf(newerWorkflowId));

      await sendCustomEvent(expect, eventName, { id: "delete-me" });
      await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(olderWorkflowId);
        return runs.find((run) => run.state === "sleeping") ?? null;
      }, { timeoutMs: 120_000 });

      await retireWorkflow(expect, olderWorkflowId);
      const afterDeleteResponse = await niceBackendFetch("/api/v1/internal/workflows", { method: "GET", accessType: "admin" });
      expect(afterDeleteResponse.body.workflows.map((workflow: any) => workflow.id)).not.toContain(olderWorkflowId);
      const secondDeleteResponse = await niceBackendFetch(`/api/v1/internal/workflows/${olderWorkflowId}`, {
        method: "DELETE",
        accessType: "admin",
      });
      expect(secondDeleteResponse.status).toBe(404);

      await retireWorkflow(expect, newerWorkflowId);
    });
  });

  it("syncs, versions, runs steps durably, memoizes, and dedupes by runKey", { timeout: 180_000 }, async ({ expect }) => {
    await inFreshWorkflowsProject(async () => {
      const workflowId = randomSlug("e2e-lifecycle");
      const eventName = randomSlug("e2e-ping");

      const source = `import { workflow, customEvent } from "@hexclave/workflows";

export default workflow("${workflowId}", {
  on: [customEvent("${eventName}")],
  runKey: (event) => "order:" + event.data.orderId,
  onConflict: "skip",
}, async (event, step) => {
  const doubled = await step.run("double", () => event.data.amount * 2);
  await step.sleep("short-nap", "1s");
  console.log("processed order", event.data.orderId);
});
`;
      await createWorkflow(expect, workflowId, source);

      // Creating the same id twice is an explicit error.
      const duplicateResponse = await niceBackendFetch("/api/v1/internal/workflows", {
        method: "POST",
        accessType: "admin",
        body: { id: workflowId, source },
      });
      expect(duplicateResponse.status).toBe(400);

      // Unchanged source does not mint a version.
      const unchangedResponse = await niceBackendFetch(`/api/v1/internal/workflows/${workflowId}/source`, {
        method: "PATCH",
        accessType: "admin",
        body: { source },
      });
      expect(unchangedResponse).toMatchObject({ status: 200, body: { version: 1, created: false } });

      // The workflow shows up in the list with its parsed triggers.
      const listResponse = await niceBackendFetch("/api/v1/internal/workflows", { method: "GET", accessType: "admin" });
      expect(listResponse.status).toBe(200);
      const summary = listResponse.body.workflows.find((workflow: any) => workflow.id === workflowId);
      expect(summary).toMatchObject({
        id: workflowId,
        latest_version: 1,
        triggers: [{ type: "event", event_type: `custom.${eventName}` }],
        stats: { total_runs: 0, active_runs: 0, sleeping_runs: 0 },
      });

      // Duplicate delivery: two events mapping to the same runKey while the
      // first run is active -> onConflict "skip" collapses them to one run.
      await sendCustomEvent(expect, eventName, { orderId: "o1", amount: 21 });
      await sendCustomEvent(expect, eventName, { orderId: "o1", amount: 21 });

      const completedRun = await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(workflowId);
        return runs.find((run) => run.run_key === "order:o1" && run.state === "completed") ?? null;
      }, { timeoutMs: 120_000 });

      const { runs: allRunsForKey } = await listRuns(workflowId, { run_key: "order:o1" });
      expect(allRunsForKey).toHaveLength(1);

      // The summary's total matches the historical runs grid, while the
      // active/sleeping fields remain zero after the run completes.
      const afterRunListResponse = await niceBackendFetch("/api/v1/internal/workflows", { method: "GET", accessType: "admin" });
      const afterRunSummary = afterRunListResponse.body.workflows.find((workflow: { id: string }) => workflow.id === workflowId);
      expect(afterRunSummary).toMatchObject({ stats: { total_runs: 1, active_runs: 0, sleeping_runs: 0 } });

      // The Admin SDK's includeState option is backed by this wire query.
      // It must return full details for every listed run rather than only
      // widening the TypeScript type.
      const { runs: runsWithState } = await listRuns(workflowId, {
        run_key: "order:o1",
        include_state: "true",
      });
      expect(runsWithState).toHaveLength(1);
      expect(runsWithState[0]).toMatchObject({
        id: completedRun.id,
        trigger_payload: { orderId: "o1", amount: 21 },
        steps: expect.arrayContaining([
          expect.objectContaining({ step_key: "double", result: 42 }),
          expect.objectContaining({ step_key: "short-nap", kind: "sleep" }),
        ]),
        step_attempts: expect.any(Array),
      });

      const detailsResponse = await niceBackendFetch(`/api/v1/internal/workflows/runs/${completedRun.id}`, {
        method: "GET",
        accessType: "admin",
      });
      expect(detailsResponse.status).toBe(200);
      const details = detailsResponse.body;
      expect(details).toMatchObject({
        id: completedRun.id,
        workflow_id: workflowId,
        run_key: "order:o1",
        state: "completed",
        version: 1,
        trigger_type: `custom.${eventName}`,
        steps_recorded: 2,
        error_summary: null,
      });
      expect(details.trigger_payload).toEqual({ orderId: "o1", amount: 21 });
      const stepsByKey = new Map<string, any>(details.steps.map((step: any) => [step.step_key, step]));
      expect(stepsByKey.get("double")).toMatchObject({ kind: "run", result: 42, executed_at_version: 1 });
      expect(stepsByKey.get("short-nap")).toMatchObject({ kind: "sleep" });
      const logs = details.step_attempts.map((attempt: any) => attempt.logs ?? "").join("\n");
      expect(logs).toContain("processed order o1");

      const invalidRunFilters: Record<string, string>[] = [{ version: "not-a-number" }, { limit: "1.5" }, { limit: "0" }];
      for (const query of invalidRunFilters) {
        const invalidFilterResponse = await niceBackendFetch(`/api/v1/internal/workflows/${workflowId}/runs`, {
          method: "GET",
          accessType: "admin",
          query,
        });
        expect(invalidFilterResponse.status).toBe(400);
      }

      const malformedUuid = "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz";
      for (const request of [
        { method: "GET" as const, path: `/api/v1/internal/workflows/runs/${malformedUuid}` },
        { method: "POST" as const, path: `/api/v1/internal/workflows/runs/${malformedUuid}/retry` },
      ]) {
        const malformedRunResponse = await niceBackendFetch(request.path, {
          method: request.method,
          accessType: "admin",
          ...(request.method === "POST" ? { body: {} } : {}),
        });
        expect(malformedRunResponse.status).toBe(400);
      }

      await retireWorkflow(expect, workflowId);
    });
  });

  it("rejects non-self-contained sources at sync time", async ({ expect }) => {
    await inFreshWorkflowsProject(async () => {
      const response = await niceBackendFetch("/api/v1/internal/workflows", {
        method: "POST",
        accessType: "admin",
        body: {
          id: randomSlug("e2e-imports"),
          source: `import fs from "fs";\nimport { workflow } from "@hexclave/workflows";\nexport default workflow("x", { on: ["user.created"] }, async () => {});`,
        },
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain("self-contained");
    });
  });

  it("lets workflow code call back into the platform via hexclaveApp", { timeout: 180_000 }, async ({ expect }) => {
    await inFreshWorkflowsProject(async () => {
      const workflowId = randomSlug("e2e-callback");
      const eventName = randomSlug("e2e-fetch-user");
      const email = `${randomSlug("wf-user")}@example.com`;

      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: { primary_email: email },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id as string;

      await createWorkflow(expect, workflowId, `import { workflow, customEvent, hexclaveApp } from "@hexclave/workflows";
export default workflow("${workflowId}", {
  on: [customEvent("${eventName}")],
  runKey: (event) => "user:" + event.data.userId,
}, async (event, step) => {
  const user = await step.run("fetch-user", () => hexclaveApp.getUser(event.data.userId));
  if (user == null) return;
  // A step's result is persisted and replayed as plain JSON, so the memoized
  // \`user\` above is a methodless data object on the replay where "tag-user"
  // first runs. To mutate, re-fetch a live SDK handle inside the same step
  // that performs the mutation.
  await step.run("tag-user", async () => {
    const liveUser = await hexclaveApp.getUser(event.data.userId);
    await liveUser.update({ serverMetadata: { taggedByWorkflow: true } });
  });
});
`);
      await sendCustomEvent(expect, eventName, { userId });

      const completedRun = await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(workflowId);
        return runs.find((run) => run.state === "completed") ?? null;
      }, { timeoutMs: 120_000 });

      const detailsResponse = await niceBackendFetch(`/api/v1/internal/workflows/runs/${completedRun.id}`, {
        method: "GET",
        accessType: "admin",
      });
      const stepsByKey = new Map<string, any>(detailsResponse.body.steps.map((step: any) => [step.step_key, step]));
      // hexclaveApp.getUser() returns an SDK user object, which serializes with
      // the SDK's camelCase field names (primaryEmail) — not the snake_case
      // REST wire shape (primary_email).
      expect(stepsByKey.get("fetch-user").result).toMatchObject({ id: userId, primaryEmail: email });

      // The side effect actually happened, with first-party credentials.
      const userResponse = await niceBackendFetch(`/api/v1/users/${userId}`, { method: "GET", accessType: "server" });
      expect(userResponse.body.server_metadata).toEqual({ taggedByWorkflow: true });

      await retireWorkflow(expect, workflowId);
    });
  });

  it("fails runs on NonRetriableError with the user-error channel, and supports manual retry", { timeout: 180_000 }, async ({ expect }) => {
    await inFreshWorkflowsProject(async () => {
      const workflowId = randomSlug("e2e-failure");
      const eventName = randomSlug("e2e-boom");

      await createWorkflow(expect, workflowId, `import { workflow, customEvent, NonRetriableError } from "@hexclave/workflows";
export default workflow("${workflowId}", {
  on: [customEvent("${eventName}")],
  runKey: (event) => "boom:" + event.data.id,
}, async (event, step) => {
  await step.run("always-fails", () => {
    throw new NonRetriableError("user has no primary email");
  });
});
`);
      await sendCustomEvent(expect, eventName, { id: "b1" });

      const failedRun = await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(workflowId);
        return runs.find((run) => run.state === "failed") ?? null;
      }, { timeoutMs: 120_000 });
      expect(failedRun).toMatchObject({
        state: "failed",
        failure_kind: "user",
        error_summary: "NonRetriableError: user has no primary email",
        current_step_id: "always-fails",
      });

      // NonRetriable = exactly one attempt, no backoff retries.
      const detailsResponse = await niceBackendFetch(`/api/v1/internal/workflows/runs/${failedRun.id}`, { method: "GET", accessType: "admin" });
      expect(detailsResponse.body.step_attempts).toHaveLength(1);

      // Dashboard-internal retry: fresh attempt budget, resumes from the
      // failed step (and fails again, since the code is deterministic).
      const retryResponse = await niceBackendFetch(`/api/v1/internal/workflows/runs/${failedRun.id}/retry`, {
        method: "POST",
        accessType: "admin",
        body: {},
      });
      expect(retryResponse).toMatchObject({ status: 200, body: { run_id: failedRun.id } });
      await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(workflowId);
        return runs.find((run) => run.id === failedRun.id && run.state === "failed") ?? null;
      }, { timeoutMs: 120_000 });

      // The retry re-executed, so its attempt must be recorded as history
      // rather than swallowed. Both executions use attempt 1 (retry grants a
      // fresh budget), so they are only distinguishable by retry_epoch.
      const afterRetryResponse = await niceBackendFetch(`/api/v1/internal/workflows/runs/${failedRun.id}`, { method: "GET", accessType: "admin" });
      expect(afterRetryResponse.body.step_attempts).toMatchObject([
        { step_key: "always-fails", retry_epoch: 0, attempt: 1, outcome: "failed" },
        { step_key: "always-fails", retry_epoch: 1, attempt: 1, outcome: "failed" },
      ]);

      // Retrying a non-failed (already re-failed, so pick a bogus state):
      // canceling the failed run is rejected too (only active runs cancel).
      const cancelResponse = await niceBackendFetch(`/api/v1/internal/workflows/${workflowId}/runs/cancel`, {
        method: "POST",
        accessType: "admin",
        body: { run_key: "boom:b1" },
      });
      expect(cancelResponse).toMatchObject({ status: 200, body: { canceled_count: 0 } });

      await retireWorkflow(expect, workflowId);
    });
  });

  it("records the successful attempt when a manual retry recovers a failed run", { timeout: 180_000 }, async ({ expect }) => {
    await inFreshWorkflowsProject(async () => {
      const workflowId = randomSlug("e2e-retry-ok");
      const eventName = randomSlug("e2e-gate");
      const email = `${randomSlug("wf-gate")}@example.com`;

      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: { primary_email: email },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id as string;

      // The same pinned code must fail the original execution and recover on
      // retry. The gate is durable platform state this test flips, NOT a
      // deadline: a wall-clock gate would race the sandbox's cold start, and
      // when it lost, the first execution would SUCCEED and the "failed" poll
      // would burn its full timeout — a slower machine making the test fail,
      // with a diagnostic pointing nowhere near the cause.
      // retries:0 keeps each execution to a single attempt (no backoff waits).
      await createWorkflow(expect, workflowId, `import { workflow, customEvent, hexclaveApp } from "@hexclave/workflows";
export default workflow("${workflowId}", {
  on: [customEvent("${eventName}")],
}, async (event, step) => {
  await step.run("gated", async () => {
    const user = await hexclaveApp.getUser(event.data.userId);
    if (user?.serverMetadata?.gateOpen !== true) {
      throw new Error("too early");
    }
    return "recovered";
  }, { retries: 0 });
});
`);
      await sendCustomEvent(expect, eventName, { userId });

      const failedRun = await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(workflowId);
        return runs.find((run) => run.state === "failed") ?? null;
      }, { timeoutMs: 120_000 });
      expect(failedRun).toMatchObject({ state: "failed", error_summary: "Error: too early (1/1 attempts)" });

      // Open the gate so the retried execution takes the success branch.
      const openGateResponse = await niceBackendFetch(`/api/v1/users/${userId}`, {
        method: "PATCH",
        accessType: "server",
        body: { server_metadata: { gateOpen: true } },
      });
      expect(openGateResponse.status).toBe(200);

      const retryResponse = await niceBackendFetch(`/api/v1/internal/workflows/runs/${failedRun.id}/retry`, {
        method: "POST",
        accessType: "admin",
        body: {},
      });
      expect(retryResponse).toMatchObject({ status: 200, body: { run_id: failedRun.id } });

      await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(workflowId);
        return runs.find((run) => run.id === failedRun.id && run.state === "completed") ?? null;
      }, { timeoutMs: 120_000 });

      // The regression this guards: the successful attempt reused attempt 1 of
      // the same step, so before retry_epoch existed it collided with the
      // original failure and was silently dropped by the skipDuplicates
      // insert — leaving a completed run whose history showed only a failure.
      const detailsResponse = await niceBackendFetch(`/api/v1/internal/workflows/runs/${failedRun.id}`, { method: "GET", accessType: "admin" });
      expect(detailsResponse.body.step_attempts).toMatchObject([
        { step_key: "gated", retry_epoch: 0, attempt: 1, outcome: "failed" },
        { step_key: "gated", retry_epoch: 1, attempt: 1, outcome: "succeeded" },
      ]);
      expect(detailsResponse.body.steps).toMatchObject([
        { step_id: "gated", result: "recovered" },
      ]);

      await retireWorkflow(expect, workflowId);
    });
  });

  it("cancels sleeping runs atomically and upgrades runs with skip-on-divergence", { timeout: 240_000 }, async ({ expect }) => {
    await inFreshWorkflowsProject(async () => {
      const workflowId = randomSlug("e2e-upgrade");
      const eventName = randomSlug("e2e-sleepy");

      const v1Source = `import { workflow, customEvent } from "@hexclave/workflows";
export default workflow("${workflowId}", {
  on: [customEvent("${eventName}")],
  runKey: (event) => "sleepy:" + event.data.id,
}, async (event, step) => {
  const greeting = await step.run("greet", () => "hello " + event.data.id);
  await step.sleep("long-nap", "1h");
  await step.run("after-nap", () => greeting + " again");
});
`;
      await createWorkflow(expect, workflowId, v1Source);
      await sendCustomEvent(expect, eventName, { id: "s1" });

      const sleepingRun = await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(workflowId);
        return runs.find((run) => run.state === "sleeping") ?? null;
      }, { timeoutMs: 120_000 });
      expect(sleepingRun).toMatchObject({
        state: "sleeping",
        version: 1,
        current_step_id: "long-nap",
        next_wake_at_millis: expect.any(Number),
      });

      // v2 RENAMES the sleep step: the sleeping run is suspended on a step
      // the new code no longer reaches -> mechanically divergent -> the
      // upgrade SKIPS it (no paused state; it keeps executing v1).
      await updateWorkflowSource(expect, workflowId, v1Source.replace(/long-nap/g, "renamed-nap"), 2);
      const divergedUpgradeResponse = await niceBackendFetch(`/api/v1/internal/workflows/${workflowId}/runs/upgrade`, {
        method: "POST",
        accessType: "admin",
        body: { to_version: 2 },
      });
      expect(divergedUpgradeResponse).toMatchObject({
        status: 200,
        body: {
          upgraded_count: 0,
          skipped: [{
            run_id: sleepingRun.id,
            run_key: "sleepy:s1",
            from_version: 1,
            diagnostic: {
              reason: "suspended-step-not-reached",
              suspended_step_key: "long-nap",
            },
          }],
        },
      });
      // The diagnostic is also persisted on the run for the dashboard.
      const divergedRun = (await listRuns(workflowId, { run_key: "sleepy:s1" })).runs[0];
      expect(divergedRun).toMatchObject({
        version: 1,
        last_upgrade_divergence: { reason: "suspended-step-not-reached" },
      });

      // v3 keeps the original step graph (plus an extra step after the
      // sleep): the replay arrives at the same suspended sleep -> clean
      // transfer.
      await updateWorkflowSource(expect, workflowId, v1Source.replace(
        `await step.run("after-nap", () => greeting + " again");`,
        `await step.run("after-nap", () => greeting + " again");\n  await step.run("extra", () => "extra");`,
      ), 3);
      const cleanUpgradeResponse = await niceBackendFetch(`/api/v1/internal/workflows/${workflowId}/runs/upgrade`, {
        method: "POST",
        accessType: "admin",
        body: { to_version: 3 },
      });
      expect(cleanUpgradeResponse).toMatchObject({
        status: 200,
        body: { upgraded_count: 1, skipped: [] },
      });
      const upgradedRun = (await listRuns(workflowId, { run_key: "sleepy:s1" })).runs[0];
      expect(upgradedRun).toMatchObject({ version: 3, state: "sleeping", last_upgrade_divergence: null });

      // Atomic query-cancel by key.
      const cancelResponse = await niceBackendFetch(`/api/v1/internal/workflows/${workflowId}/runs/cancel`, {
        method: "POST",
        accessType: "admin",
        body: { run_key: "sleepy:s1" },
      });
      expect(cancelResponse).toMatchObject({ status: 200, body: { canceled_count: 1 } });
      const canceledRun = (await listRuns(workflowId, { run_key: "sleepy:s1" })).runs[0];
      expect(canceledRun).toMatchObject({ state: "canceled" });

      // With the key freed, cancel-existing semantics are NOT in play (skip
      // default): a fresh event starts a fresh run. Versions list shows the
      // full timeline with in-flight counts.
      const versionsResponse = await niceBackendFetch(`/api/v1/internal/workflows/${workflowId}/versions`, {
        method: "GET",
        accessType: "admin",
      });
      expect(versionsResponse.status).toBe(200);
      expect(versionsResponse.body.versions.map((version: any) => version.version)).toEqual([3, 2, 1]);
      expect(versionsResponse.body.versions[0]).toMatchObject({
        is_latest: true,
        source_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });

      await retireWorkflow(expect, workflowId);
    });
  });

  it("reacts to platform events (user.created) through the transactional outbox", { timeout: 180_000 }, async ({ expect }) => {
    await inFreshWorkflowsProject(async () => {
      const workflowId = randomSlug("e2e-platform");
      const email = `${randomSlug("wf-platform")}@example.com`;

      await createWorkflow(expect, workflowId, `import { workflow } from "@hexclave/workflows";
export default workflow("${workflowId}", {
  on: ["user.created"],
  runKey: (event) => "user:" + event.data.id,
}, async (event, step) => {
  await step.run("snapshot-email", () => event.data.primary_email);
});
`);

      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: { primary_email: email },
      });
      expect(createUserResponse.status).toBe(201);

      const run = await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(workflowId);
        return runs.find((r) => r.trigger_summary === email && r.state === "completed") ?? null;
      }, { timeoutMs: 120_000 });
      expect(run).toMatchObject({
        trigger_type: "user.created",
        run_key: `user:${createUserResponse.body.id}`,
      });

      await retireWorkflow(expect, workflowId);
    });
  });

  it("rejects malformed custom events", async ({ expect }) => {
    await inFreshWorkflowsProject(async () => {
      const prefixedResponse = await niceBackendFetch("/api/v1/internal/workflows/events", {
        method: "POST",
        accessType: "admin",
        body: { name: "custom.already-prefixed", data: {} },
      });
      expect(prefixedResponse.status).toBe(400);
      expect(JSON.stringify(prefixedResponse.body)).toContain("automatically prefixed");

      const oversizedResponse = await niceBackendFetch("/api/v1/internal/workflows/events", {
        method: "POST",
        accessType: "admin",
        body: { name: "too-big", data: { blob: "x".repeat(300 * 1024) } },
      });
      expect(oversizedResponse.status).toBe(400);
      expect(JSON.stringify(oversizedResponse.body)).toContain("256 KiB");

      const invalidTriggerId = randomSlug("e2e-invalid-trigger");
      const invalidTriggerResponse = await niceBackendFetch("/api/v1/internal/workflows", {
        method: "POST",
        accessType: "admin",
        body: {
          id: invalidTriggerId,
          source: `import { workflow, customEvent } from "@hexclave/workflows";
export default workflow("${invalidTriggerId}", { on: [customEvent("contains whitespace")] }, async () => {});`,
        },
      });
      expect(invalidTriggerResponse.status).toBe(400);
      expect(JSON.stringify(invalidTriggerResponse.body)).toContain("must not contain whitespace");
    });
  });
});

describe("pausing", () => {
  it("creates no runs while paused, and does not replay dropped events after resuming", { timeout: 240_000 }, async ({ expect }) => {
    await inFreshWorkflowsProject(async () => {
      const workflowId = randomSlug("e2e-pause");
      // A second, never-paused workflow on the same trigger. The outbox is
      // global and drained oldest-first, so "no run appeared after N ticks" on
      // its own can just mean the engine never got to the event. Waiting for
      // the control to run proves the engine DID process it — while the target
      // was paused — which is the thing under test.
      const controlWorkflowId = randomSlug("e2e-pause-control");
      const userCreatedSource = (id: string) => `import { workflow } from "@hexclave/workflows";
export default workflow("${id}", {
  on: ["user.created"],
  runKey: (event) => "user:" + event.data.id,
}, async (event, step) => {
  await step.run("snapshot-email", () => event.data.primary_email);
});
`;
      await createWorkflow(expect, workflowId, userCreatedSource(workflowId));
      await createWorkflow(expect, controlWorkflowId, userCreatedSource(controlWorkflowId));

      const pauseResult = await setWorkflowPaused(expect, workflowId, true);
      expect(pauseResult.paused_at_millis).toEqual(expect.any(Number));
      const pausedListResponse = await niceBackendFetch("/api/v1/internal/workflows", { method: "GET", accessType: "admin" });
      expect(pausedListResponse.body.workflows.find((workflow: any) => workflow.id === workflowId)).toMatchObject({ is_paused: true });
      expect(pausedListResponse.body.workflows.find((workflow: any) => workflow.id === controlWorkflowId)).toMatchObject({ is_paused: false });

      // A user created while the workflow is paused creates no run for it.
      const pausedEmail = `${randomSlug("wf-paused")}@example.com`;
      await createUser(expect, pausedEmail);
      await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(controlWorkflowId);
        return runs.find((r) => r.trigger_summary === pausedEmail) ?? null;
      }, { timeoutMs: 120_000 });
      expect((await listRuns(workflowId)).runs).toEqual([]);

      await setWorkflowPaused(expect, workflowId, false);
      const resumedListResponse = await niceBackendFetch("/api/v1/internal/workflows", { method: "GET", accessType: "admin" });
      expect(resumedListResponse.body.workflows.find((workflow: any) => workflow.id === workflowId)).toMatchObject({ is_paused: false, paused_at_millis: null });

      // Events enqueued after the resume dispatch normally.
      const resumedEmail = `${randomSlug("wf-resumed")}@example.com`;
      const resumedUserId = await createUser(expect, resumedEmail);
      const run = await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(workflowId);
        return runs.find((r) => r.trigger_summary === resumedEmail && r.state === "completed") ?? null;
      }, { timeoutMs: 120_000 });
      expect(run).toMatchObject({ trigger_type: "user.created", run_key: `user:${resumedUserId}` });

      // The event dropped during the pause is gone for good: the resumed run
      // is the only one that ever existed for this workflow.
      const { runs } = await listRuns(workflowId);
      expect(runs.map((run) => run.trigger_summary)).toEqual([resumedEmail]);

      await retireWorkflow(expect, workflowId);
      await retireWorkflow(expect, controlWorkflowId);
    });
  });

  // TODO(workflows-pause): two behaviours still uncovered here, both needing a
  // slow test — (1) a schedule-triggered workflow paused across several cron
  // ticks must resume without materializing the interval it slept through
  // (the cursor fast-forward in setWorkflowPaused), and (2) a run already
  // in flight must keep executing to completion after a pause.
  it("is idempotent and 404s for unknown workflows", { timeout: 180_000 }, async ({ expect }) => {
    await inFreshWorkflowsProject(async () => {
      const workflowId = randomSlug("e2e-pause-idem");
      await createWorkflow(expect, workflowId, `import { workflow, customEvent } from "@hexclave/workflows";
export default workflow("${workflowId}", { on: [customEvent("ping")] }, async () => {});
`);

      // Re-pausing keeps the original pausedAt so "paused 3 days ago" does not
      // reset itself on every repeated call.
      const first = await setWorkflowPaused(expect, workflowId, true);
      const second = await setWorkflowPaused(expect, workflowId, true);
      expect(second.paused_at_millis).toBe(first.paused_at_millis);

      await setWorkflowPaused(expect, workflowId, false);
      await setWorkflowPaused(expect, workflowId, false);

      const missingResponse = await niceBackendFetch(`/api/v1/internal/workflows/${randomSlug("e2e-nonexistent")}`, {
        method: "PATCH",
        accessType: "admin",
        body: { is_paused: true },
      });
      expect(missingResponse.status).toBe(404);

      await retireWorkflow(expect, workflowId);
    });
  });
});

describe("run credentials", () => {
  it("does not create any project API keys for workflow runs", async ({ expect }) => {
    // Regression guard. Runs used to authenticate with a real per-claim
    // ApiKeySet, which surfaced in the customer-facing Project Keys list (and
    // could be revoked there, breaking a live run). They now use a signed
    // run-scoped token that is never persisted. Without this assertion a
    // revert to key-minting would pass CI green.
    await inFreshWorkflowsProject(async () => {
      const workflowId = randomSlug("e2e-nokeys");
      const eventName = randomSlug("e2e-nokeys-evt");

      await createWorkflow(expect, workflowId, `import { workflow, customEvent, hexclaveApp } from "@hexclave/workflows";
export default workflow("${workflowId}", {
  on: [customEvent("${eventName}")],
}, async (event, step) => {
  await step.run("count-users", async () => {
    const users = await hexclaveApp.listUsers({ limit: 1 });
    return users.length;
  });
});
`);
      await sendCustomEvent(expect, eventName, {});

      await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(workflowId);
        return runs.find((run) => run.state === "completed") ?? null;
      }, { timeoutMs: 120_000 });

      const keysResponse = await niceBackendFetch("/api/v1/internal/api-keys", {
        method: "GET",
        accessType: "admin",
      });
      expect(keysResponse.status).toBe(200);
      const descriptions = (keysResponse.body.items as any[]).map((key) => key.description);
      expect(descriptions.filter((description: string) => description.startsWith("workflow-run:"))).toEqual([]);

      await retireWorkflow(expect, workflowId);
    });
  });

  it("does not let a run-token credential authenticate an admin-type request", async ({ expect }) => {
    // The token is scoped to SERVER access. On an admin-type request it must
    // be ignored entirely rather than accepted, so the request succeeds or
    // fails purely on the strength of the real admin credential beside it.
    // Before the credential was re-scoped, the run-token path ran first and
    // this returned 401.
    await inFreshWorkflowsProject(async () => {
      const response = await niceBackendFetch("/api/v1/users", {
        method: "GET",
        accessType: "admin",
        headers: { "x-stack-secret-server-key": "wrt_eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJmb3JnZWQifQ.bm90LWEtc2lnbmF0dXJl" },
      });
      expect(response.status).toBe(200);
    });
  });

  it("rejects a forged run-token credential without leaking why", async ({ expect }) => {
    // The run token rides in the secret-server-key header, keyed on the `wrt_`
    // prefix; the admin header is covered too because a `wrt_` value there is
    // just a key that matches no row. A forged one must fail closed with the
    // same error a garbage key produces — never a 500, and never a rejection
    // reason that discloses run ids, run state or lease details.
    await inFreshWorkflowsProject(async () => {
      for (const header of ["x-stack-secret-server-key", "x-stack-super-secret-admin-key"] as const) {
        const response = await niceBackendFetch("/api/v1/users", {
          method: "GET",
          accessType: header === "x-stack-secret-server-key" ? "server" : "admin",
          headers: { [header]: "wrt_eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJmb3JnZWQifQ.bm90LWEtc2lnbmF0dXJl" },
        });
        expect(response.status).toBe(401);
        const body = JSON.stringify(response.body);
        for (const leak of ["run-not-found", "lease", "tenancy", "audience", "signature"]) {
          expect(body).not.toContain(leak);
        }
      }
    });
  });

  it("stops a canceled run from performing any further side effects", async ({ expect }) => {
    // Cancellation is what revokes a run's credential now — there is no key to
    // delete. A run parked on a sleep is a deterministic point to cancel at;
    // after cancelling, the post-sleep step must never run, so the metadata it
    // would write must never appear.
    await inFreshWorkflowsProject(async () => {
      const workflowId = randomSlug("e2e-cancelrevoke");
      const eventName = randomSlug("e2e-cancelrevoke-evt");
      const email = `${randomSlug("wf-cancel")}@example.com`;

      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: { primary_email: email },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id as string;

      await createWorkflow(expect, workflowId, `import { workflow, customEvent, hexclaveApp } from "@hexclave/workflows";
export default workflow("${workflowId}", {
  on: [customEvent("${eventName}")],
}, async (event, step) => {
  await step.run("before-nap", async () => {
    const user = await hexclaveApp.getUser(event.data.userId);
    await user.update({ serverMetadata: { phase: "before" } });
  });
  await step.sleep("nap", "1h");
  await step.run("after-nap", async () => {
    const user = await hexclaveApp.getUser(event.data.userId);
    await user.update({ serverMetadata: { phase: "after" } });
  });
});
`);
      await sendCustomEvent(expect, eventName, { userId });

      const sleepingRun = await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(workflowId);
        return runs.find((run) => run.state === "sleeping") ?? null;
      }, { timeoutMs: 120_000 });

      // The first step really did run with first-party credentials.
      const beforeResponse = await niceBackendFetch(`/api/v1/users/${userId}`, { method: "GET", accessType: "server" });
      expect(beforeResponse.body.server_metadata).toEqual({ phase: "before" });

      const cancelResponse = await niceBackendFetch(`/api/v1/internal/workflows/${workflowId}/runs/cancel`, {
        method: "POST",
        accessType: "admin",
        body: { run_id: sleepingRun.id },
      });
      expect(cancelResponse).toMatchObject({ status: 200, body: { canceled_count: 1 } });

      // Several ticks later the run is still canceled and the post-sleep step
      // never happened.
      await tickWorkflowEngine(expect);
      await tickWorkflowEngine(expect);
      const { runs } = await listRuns(workflowId);
      expect(runs.find((run) => run.id === sleepingRun.id)).toMatchObject({ state: "canceled" });
      const afterResponse = await niceBackendFetch(`/api/v1/users/${userId}`, { method: "GET", accessType: "server" });
      expect(afterResponse.body.server_metadata).toEqual({ phase: "before" });

      await retireWorkflow(expect, workflowId);
    });
  });
});
