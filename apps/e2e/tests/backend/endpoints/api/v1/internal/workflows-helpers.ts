import { generateSecureRandomString } from "@hexclave/shared/dist/utils/crypto";
import type { ExpectStatic } from "vitest";
import { niceBackendFetch } from "../../../../backend-helpers";

// Shared drivers for e2e suites that exercise the workflow engine.
// workflows.test.ts remains the canonical consumer.

export const CRON_AUTH = { "authorization": "Bearer mock_cron_secret" };

export function randomSlug(prefix: string): string {
  return `${prefix}-${generateSecureRandomString(8).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "x"}`;
}

export async function tickWorkflowEngine(expect: ExpectStatic) {
  const response = await niceBackendFetch("/api/v1/internal/workflow-engine-step", {
    method: "GET",
    headers: CRON_AUTH,
    query: { only_one_step: "true" },
  });
  expect(response.status).toBe(200);
}

export async function pollWithTicks<T>(expect: ExpectStatic, check: () => Promise<T | null>, options: { timeoutMs?: number } = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    await tickWorkflowEngine(expect);
    const result = await check();
    if (result != null) return result;
    if (Date.now() > deadline) throw new Error(`pollWithTicks: condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function createWorkflow(expect: ExpectStatic, workflowId: string, source: string) {
  const response = await niceBackendFetch("/api/v1/internal/workflows", {
    method: "POST",
    accessType: "admin",
    body: { id: workflowId, source },
  });
  expect(response).toMatchObject({
    status: 201,
    body: { workflow_id: workflowId, version: 1, created: true },
  });
}

export async function updateWorkflowSource(expect: ExpectStatic, workflowId: string, source: string, expectedVersion: number) {
  const response = await niceBackendFetch(`/api/v1/internal/workflows/${workflowId}/source`, {
    method: "PATCH",
    accessType: "admin",
    body: { source },
  });
  expect(response).toMatchObject({
    status: 200,
    body: { workflow_id: workflowId, version: expectedVersion, created: true },
  });
}

/** Permanently removes the workflow, including active work and history. */
export async function retireWorkflow(expect: ExpectStatic, workflowId: string) {
  const response = await niceBackendFetch(`/api/v1/internal/workflows/${workflowId}`, {
    method: "DELETE",
    accessType: "admin",
  });
  expect(response.status).toBe(200);
}

export async function sendCustomEvent(expect: ExpectStatic, name: string, data: unknown) {
  const response = await niceBackendFetch("/api/v1/internal/workflows/events", {
    method: "POST",
    accessType: "admin",
    body: { name, data },
  });
  expect(response).toMatchObject({ status: 200, body: { event_id: expect.any(String) } });
  return response.body.event_id as string;
}

export async function listRuns(workflowId: string, query: Record<string, string> = {}) {
  const response = await niceBackendFetch(`/api/v1/internal/workflows/${workflowId}/runs`, {
    method: "GET",
    accessType: "admin",
    query,
  });
  if (response.status !== 200) throw new Error(`listRuns failed: ${JSON.stringify(response.body)}`);
  return response.body as { runs: any[], next_cursor: string | null }; // eslint-disable-line @typescript-eslint/no-explicit-any -- run shapes are backend-defined JSON; tests narrow them per-assertion, same as the original in workflows.test.ts
}
