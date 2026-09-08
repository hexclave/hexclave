import { Auth, INTERNAL_PROJECT_OWNER_TEAM_ID, InternalProjectKeys, Project, Team, backendContext, niceBackendFetch } from "../../../../../backend-helpers";
import { afterEach } from "vitest";

// Shared helpers for the growth + growth-agent e2e suites. Growth is gated on the alpha-stage
// `growth` app, so every test runs against its own freshly created project that installs it.

// Must match HEXCLAVE_GROWTH_AGENT_API_SECRET in apps/e2e/.env.development (and the backend's dev
// env). This is the machine secret Eve uses; e2e tests "play the agent" with it.
export const GROWTH_AGENT_AUTH = { "authorization": "Bearer mock_growth_agent_secret" };

const growthProjectsToDelete: { projectId: string, adminAccessToken: string }[] = [];

afterEach(async () => {
  // A Growth test commonly changes the active context to the internal project for staff calls, so
  // cleanup cannot rely on whichever project happens to be selected when the test ends. Delete all
  // fixtures from their captured credentials, and start with an empty queue even if deletion fails.
  const projects = growthProjectsToDelete.splice(0);
  await Promise.all(projects.map(async (project) => await Project.deleteProject(project)));
});

export async function createGrowthProject() {
  const project = await Project.createAndSwitch();
  growthProjectsToDelete.push({ projectId: project.projectId, adminAccessToken: project.adminAccessToken });
  await Project.updateConfig({ "apps.installed.gtm.enabled": true });
  return backendContext.value.projectKeys;
}

export function requireRunId(body: unknown): string {
  if (typeof body !== "object" || body == null || !("run_id" in body) || typeof body.run_id !== "string") {
    throw new Error("Expected the growth response to contain a run_id string.");
  }
  return body.run_id;
}

/**
 * Runs `call` as a Hexclave platform admin — the internal project's keys plus a member of its owner
 * team — and restores whoever the caller was afterwards.
 *
 * The restore is the point: these suites interleave customer, agent and staff calls, and leaving the
 * context pointing at the internal project would break the NEXT assertion rather than this one,
 * which is a miserable thing to debug.
 */
export async function asGrowthStaff<T>(call: () => Promise<T>): Promise<T> {
  const { projectKeys, userAuth, mailbox } = backendContext.value;
  try {
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
    const { userId } = await Auth.fastSignUp();
    await Team.addMember(INTERNAL_PROJECT_OWNER_TEAM_ID, userId);
    return await call();
  } finally {
    backendContext.set({ projectKeys, userAuth, mailbox });
  }
}

/**
 * Releases a project's interview question plan to the customer, the way a staff reviewer would.
 *
 * The plan is written held — see lib/growth/interview-release.ts — so a suite that drives a run to
 * the interview and then answers it as the customer has to release it in between, exactly as
 * production does. This is the ONLY human gate left in the growth lifecycle; reports publish on
 * write, so there is no report-side counterpart to this helper.
 */
export async function releaseGrowthInterviewAsStaff(projectId: string): Promise<void> {
  await asGrowthStaff(async () => {
    const released = await niceBackendFetch("/api/latest/internal/growth/admin/interview/release", {
      accessType: "client",
      method: "POST",
      body: { target_project_id: projectId },
    });
    if (released.status !== 200) {
      throw new Error(`Releasing the growth interview failed with status ${released.status}: ${JSON.stringify(released.body)}`);
    }
  });
}

/**
 * Seeds a minimal report so the customer-facing growth routes are reachable.
 *
 * For suites whose subject is something else entirely — briefs, chat, workflows, the overview read
 * model — and which therefore have no report of their own, but which need the workspace released
 * before they can read anything. Nothing about the report matters here except that it exists, so it
 * is deliberately the smallest one the agent API accepts.
 *
 * Writing and releasing are intentionally separate, matching production's staff review gate.
 */
export async function unlockGrowthWorkspaceAsStaff(scope: { project_id: string, branch_id: string }): Promise<string> {
  const runId = await requireGrowthRunIdForScope();
  const report = await niceBackendFetch("/api/latest/internal/growth-agent/report", {
    method: "POST",
    headers: GROWTH_AGENT_AUTH,
    body: {
      ...scope,
      run_id: runId,
      title: "Workspace unlock fixture",
      summary: "Seeded so the customer routes are reachable.",
      content_md: "# Fixture",
      action_items: [],
    },
  });
  if (report.status !== 200) {
    throw new Error(`Seeding the unlock report failed with status ${report.status}: ${JSON.stringify(report.body)}`);
  }
  const reportId = (report.body as { report_id: string }).report_id;
  await releaseGrowthReportAsStaff(scope.project_id, reportId);
  return reportId;
}

export async function releaseGrowthReportAsStaff(projectId: string, reportId: string): Promise<void> {
  await asGrowthStaff(async () => {
    const released = await niceBackendFetch(`/api/latest/internal/growth/admin/reports/${reportId}`, {
      accessType: "client",
      method: "PATCH",
      body: { target_project_id: projectId, action: "publish" },
    });
    if (released.status !== 200) {
      throw new Error(`Releasing the growth report failed with status ${released.status}: ${JSON.stringify(released.body)}`);
    }
  });
}

/**
 * The current run's id, onboarding the project first if it has never had one.
 *
 * A report hangs off a run, so unlocking a workspace needs one — but the suites that need unlocking
 * are all about something else and mostly never onboarded. Reading the status endpoint first (rather
 * than always onboarding) keeps this usable from suites that DID onboard, where a second onboarding
 * call would 400.
 */
async function requireGrowthRunIdForScope(): Promise<string> {
  const status = await niceBackendFetch("/api/latest/internal/growth/status", { accessType: "admin" });
  if (status.status !== 200) {
    throw new Error(`Reading the growth status failed with status ${status.status}: ${JSON.stringify(status.body)}`);
  }
  const existingRunId = (status.body as { analysis: { run_id: string | null } }).analysis.run_id;
  if (existingRunId != null) return existingRunId;

  const onboarding = await niceBackendFetch("/api/latest/internal/growth/onboarding", {
    accessType: "admin",
    method: "POST",
    body: { website_url: "https://unlock-fixture.example.com", company_summary: "Seeded to unlock the growth workspace." },
  });
  if (onboarding.status !== 200) {
    throw new Error(`Onboarding for the unlock fixture failed with status ${onboarding.status}: ${JSON.stringify(onboarding.body)}`);
  }
  return requireRunId(onboarding.body);
}

/**
 * A fresh growth project whose workspace is already released — the shortest path for suites whose
 * subject is not the release gate but which read customer-facing growth routes.
 */
export async function createUnlockedGrowthProject(): Promise<{ project_id: string, branch_id: string }> {
  const keys = await createGrowthProject();
  if (keys === "no-project") throw new Error("createGrowthProject should have switched the context to a fresh project.");
  const scope = { project_id: keys.projectId, branch_id: "main" };
  await unlockGrowthWorkspaceAsStaff(scope);
  return scope;
}
