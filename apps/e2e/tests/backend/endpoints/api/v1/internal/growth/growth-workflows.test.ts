import { describe, type ExpectStatic } from "vitest";
import { it } from "../../../../../../helpers";
import { niceBackendFetch } from "../../../../../backend-helpers";
import { listRuns, pollWithTicks, sendCustomEvent } from "../workflows-helpers";
import { GROWTH_AGENT_AUTH, createGrowthProject, releaseGrowthInterviewAsStaff, releaseGrowthReportAsStaff, requireRunId, unlockGrowthWorkspaceAsStaff } from "./growth-helpers";
import { MockEve, MockEveDispatch, withMockEve } from "./mock-eve";

const ADMIN_BASE = "/api/latest/internal/growth";
const AGENT_BASE = "/api/latest/internal/growth-agent";
const SERVER_BASE = "/api/v1/internal/growth-server";

// Growth fixtures seed sandbox-backed workflows during onboarding and can land around 60s under
// full-suite load, so default-timeout tests need 90s of headroom.

// E2E tests for the workflow-driven growth orchestration: onboarding seeds the two canonical
// growth workflows and enqueues the activation boundary event transactionally; the WORKFLOW engine
// (workflow-engine-step, driven via the shared tickWorkflowEngine helper) executes the
// growth-analysis workflow in a real sandbox, which calls back into the growth-server bridge
// routes (analysis/tick + analysis/wait) — and those bridge ticks dispatch analysis phases to Eve
// (played by the in-process mock Eve server) exactly like the deleted v1 cron engine did.
//
// IMPORTANT: every test that needs the mock Eve lives in THIS file. The mock's port is fixed by
// HEXCLAVE_GROWTH_EVE_URL in apps/e2e/.env.development (the backend reads it per-dispatch), and
// vitest runs test files in separate workers, so a second file binding the same port would flake
// with EADDRINUSE. Within this file, withMockEve serializes entries via a module-level mutex.
//
// Time-dependent orchestration paths — the stuck-phase reaper (15min timeout), the milestone
// hourly claim, the watchdog's 5-minute resurrection grace, and the stale-brief sweep (3h) — keep
// their arithmetic in pure helpers unit-tested in apps/backend/src/lib/growth/{orchestration,
// watchdog}.test.ts; only the watchdog's resurrection is e2e-covered (watchdog.test.ts, which
// pays the real 5-minute grace).
//
// Dynamic run/project ids make inline snapshots impractical for the run-shaped assertions, so
// those use toMatchObject/toEqual (deliberate deviation from the usual snapshot preference); the
// cron auth negatives are fully deterministic and snapshotted.

const CRON_AUTH = { "authorization": "Bearer mock_cron_secret" };

// Wire event types of the growth boundary events (customEvent() adds the "custom." prefix); the
// analysis workflow's runKey is "<growth run id>:<wire event type>" (see
// apps/backend/src/lib/growth/workflow-sources.ts).
const ANALYSIS_ACTIVATED_EVENT_TYPE = "custom.growth.analysis-run-activated";
const INTERVIEW_FINISHED_EVENT_TYPE = "custom.growth.interview-finished";
const GROWTH_ANALYSIS_WORKFLOW_ID = "growth-analysis";
const GROWTH_DAILY_BRIEF_WORKFLOW_ID = "growth-daily-brief";

const IMMEDIATE_PHASE_KEYS = [
  "website-research",
  "data-analysis",
  "analysis:first-screen-audit",
  "analysis:seo-aeo-strategy",
  "analysis:traffic-quality",
  "analysis:icp-visitor-outreach",
] as const;

/** Waits for a dispatch matching `predicate`, ticking the WORKFLOW engine while waiting. */
async function waitForDispatchWithTicks(expect: ExpectStatic, mock: MockEve, predicate: (dispatch: MockEveDispatch) => boolean, options: { timeoutMs?: number } = {}): Promise<MockEveDispatch> {
  return await pollWithTicks(expect, async () => mock.dispatches.find(predicate) ?? null, options);
}

async function setUpOnboardedProject() {
  const projectKeys = await createGrowthProject();
  if (projectKeys === "no-project") {
    throw new Error("createGrowthProject should have switched the context to a fresh project.");
  }
  return { projectId: projectKeys.projectId, branchId: "main" };
}

async function completeOnboarding() {
  const onboarding = await niceBackendFetch(`${ADMIN_BASE}/onboarding`, {
    accessType: "admin",
    method: "POST",
    body: { website_url: "https://plannery.example.com", company_summary: "Project management for small teams." },
  });
  if (onboarding.status !== 200) {
    throw new Error(`Growth onboarding failed with status ${onboarding.status}: ${JSON.stringify(onboarding.body)}`);
  }
  return requireRunId(onboarding.body);
}

type AdminRunPhase = { phase_key: string, status: string, attempt: number };
type AdminRunBody = { id: string, status: string, completed_at_millis: number | null, phases: AdminRunPhase[] };

async function getRun(runId: string): Promise<AdminRunBody> {
  const response = await niceBackendFetch(`${ADMIN_BASE}/runs/${runId}`, { accessType: "admin" });
  if (response.status !== 200) {
    throw new Error(`Reading run ${runId} failed with status ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body as AdminRunBody;
}

function getRunPhase(run: AdminRunBody, phaseKey: string): AdminRunPhase {
  const phase = run.phases.find((candidate) => candidate.phase_key === phaseKey);
  if (phase == null) throw new Error(`Run ${run.id} has no phase ${phaseKey}.`);
  return phase;
}

async function waitForSettledIntegrationsPhase(expect: ExpectStatic, runId: string): Promise<void> {
  await pollWithTicks(expect, async () => {
    const phase = getRunPhase(await getRun(runId), "integrations");
    return phase.status === "completed" || phase.status === "skipped" ? phase : null;
  });
}

type AgentScope = { project_id: string, branch_id: string };

async function agentPhaseCall(runId: string, phaseKey: string, action: "start" | "heartbeat" | "complete" | "fail", scope: AgentScope, attempt: number, extraBody: Record<string, unknown> = {}) {
  return await niceBackendFetch(`${AGENT_BASE}/runs/${runId}/phases/${phaseKey}/${action}`, {
    method: "POST",
    headers: GROWTH_AGENT_AUTH,
    body: { ...scope, attempt, ...extraBody },
  });
}

function isAnalysisPhaseDispatchFor(dispatch: MockEveDispatch, projectId: string, runId: string, phaseKey: string, attempt: number): boolean {
  return dispatch.path === "/runs/analysis-phase"
    && dispatch.body.project_id === projectId
    && dispatch.body.run_id === runId
    && dispatch.body.phase_key === phaseKey
    && dispatch.body.attempt === attempt;
}

/** The active-or-finished workflow leg of one growth run for one boundary event type, or null. */
async function findAnalysisLegRun(runId: string, wireEventType: string) {
  const { runs } = await listRuns(GROWTH_ANALYSIS_WORKFLOW_ID, { run_key: `${runId}:${wireEventType}` });
  return runs[0] ?? null;
}

/** Direct server-auth call to a growth-server bridge route (what the workflow sandbox does). */
async function bridgeCall(path: string, body: unknown) {
  return await niceBackendFetch(`${SERVER_BASE}/${path}`, {
    method: "POST",
    accessType: "server",
    body,
  });
}

describe("growth workflow orchestration e2e (mock Eve)", { timeout: 90_000 }, () => {
  it("drives a full analysis lifecycle through the workflow engine: seeding, legs, dispatches, interview gate, report, completion", { timeout: 420_000 }, async ({ expect }) => {
    await withMockEve(async (mock) => {
      const { projectId, branchId } = await setUpOnboardedProject();
      const scope: AgentScope = { project_id: projectId, branch_id: branchId };
      const runId = await completeOnboarding();

      // Onboarding seeded both canonical growth workflows as ordinary customer workflows.
      const workflowList = await niceBackendFetch("/api/v1/internal/workflows", { method: "GET", accessType: "admin" });
      expect(workflowList.status).toBe(200);
      const workflowsById = new Map<string, any>(workflowList.body.workflows.map((workflow: any) => [workflow.id, workflow])); // eslint-disable-line @typescript-eslint/no-explicit-any -- backend-defined JSON, narrowed by the assertions below
      expect(workflowsById.get(GROWTH_ANALYSIS_WORKFLOW_ID)).toMatchObject({
        latest_version: 1,
        triggers: expect.arrayContaining([
          { type: "event", event_type: ANALYSIS_ACTIVATED_EVENT_TYPE },
          { type: "event", event_type: INTERVIEW_FINISHED_EVENT_TYPE },
        ]),
      });
      expect(workflowsById.get(GROWTH_DAILY_BRIEF_WORKFLOW_ID)).toMatchObject({
        latest_version: 1,
        triggers: expect.arrayContaining([
          { type: "schedule", cron: "10 0 * * *", timezone: "Etc/UTC" },
          { type: "event", event_type: "custom.growth.daily-brief-due" },
        ]),
      });

      // The activation boundary event (enqueued transactionally with the run) starts the analysis
      // leg with the runKey the source's runKey function derives.
      const activationLeg = await pollWithTicks(expect, async () => await findAnalysisLegRun(runId, ANALYSIS_ACTIVATED_EVENT_TYPE), { timeoutMs: 120_000 });
      expect(activationLeg).toMatchObject({ run_key: `${runId}:${ANALYSIS_ACTIVATED_EVENT_TYPE}` });

      // The leg row appears before the workflow's first advance step ticks the bridge, so drive
      // until integrations settles before asserting the explicit route's CAS response.
      await waitForSettledIntegrationsPhase(expect, runId);
      const skipIntegrations = await niceBackendFetch(`${ADMIN_BASE}/runs/${runId}/integrations`, {
        accessType: "admin",
        method: "POST",
        body: { action: "skip" },
      });
      expect(skipIntegrations.status).toBe(409);
      expect(getRunPhase(await getRun(runId), "integrations")).toMatchObject({ status: "skipped" });

      // The workflow's bridge ticks dispatch the 6 immediate phases (attempt 1) to Eve.
      for (const phaseKey of IMMEDIATE_PHASE_KEYS) {
        const dispatch = await waitForDispatchWithTicks(expect, mock, (candidate) => isAnalysisPhaseDispatchFor(candidate, projectId, runId, phaseKey, 1), { timeoutMs: 180_000 });
        expect(dispatch.body).toEqual({
          project_id: projectId,
          branch_id: branchId,
          run_id: runId,
          phase_key: phaseKey,
          attempt: 1,
          // The session's run-scoped token (lib/growth/run-token.ts) rides in the BODY. The header
          // below is unchanged and still carries the shared machine secret: the two credentials
          // authenticate different things — the hop, and the session the hop starts.
          agent_token: expect.stringMatching(/^grt_/),
        });
        expect(dispatch.authorization).toBe("Bearer mock_growth_agent_secret");
      }
      // The interview-questions phase is DAG-gated on the immediate phases, so it must not have
      // been dispatched yet.
      expect(mock.dispatches.some((dispatch) => dispatch.path === "/runs/analysis-phase" && dispatch.body.run_id === runId && dispatch.body.phase_key === "interview-questions")).toBe(false);

      // BRIDGE ABUSE: the bridge authenticates as plain server auth, so any server-scope caller can
      // repeat analysis/tick at any time. Every mutation is CAS-guarded, so hostile repetition must
      // neither re-dispatch already-DISPATCHED phases nor bump their attempts.
      for (let i = 0; i < 3; i++) {
        const tick = await bridgeCall("analysis/tick", { run_id: runId });
        expect(tick.status).toBe(200);
        expect(tick.body).toMatchObject({ state: "running", resting: false });
      }
      for (const phaseKey of IMMEDIATE_PHASE_KEYS) {
        expect(mock.dispatches.filter((dispatch) => isAnalysisPhaseDispatchFor(dispatch, projectId, runId, phaseKey, 1))).toHaveLength(1);
        expect(mock.dispatches.some((dispatch) => isAnalysisPhaseDispatchFor(dispatch, projectId, runId, phaseKey, 2))).toBe(false);
      }
      // Forged/foreign run ids are a clean 404 on both bridge verbs.
      const forgedTick = await bridgeCall("analysis/tick", { run_id: "00000000-0000-4000-8000-000000000000" });
      expect(forgedTick.status).toBe(404);
      const forgedWait = await bridgeCall("analysis/wait", { run_id: "00000000-0000-4000-8000-000000000000", fingerprint: "whatever", timeout_ms: 0 });
      expect(forgedWait.status).toBe(404);

      // Play the agent for every immediate phase, echoing the dispatched attempt.
      for (const phaseKey of IMMEDIATE_PHASE_KEYS) {
        const start = await agentPhaseCall(runId, phaseKey, "start", scope, 1, { eve_session_id: `eve-session-${phaseKey}` });
        expect(start).toMatchObject({ status: 200, body: { status: "running" } });
        const complete = await agentPhaseCall(runId, phaseKey, "complete", scope, 1);
        expect(complete).toMatchObject({ status: 200, body: { status: "completed" } });
      }

      // With every immediate phase settled, the next bridge tick dispatches interview-questions.
      const interviewQuestionsDispatch = await waitForDispatchWithTicks(expect, mock, (candidate) => isAnalysisPhaseDispatchFor(candidate, projectId, runId, "interview-questions", 1), { timeoutMs: 180_000 });
      expect(interviewQuestionsDispatch.body).toEqual({
        project_id: projectId,
        branch_id: branchId,
        run_id: runId,
        phase_key: "interview-questions",
        attempt: 1,
        agent_token: expect.stringMatching(/^grt_/),
      });

      // The interview-questions phase must save its question plan before completing — the
      // orchestration treats a settled pre-interview set without a GrowthInterview row as an
      // impossible state.
      const startInterviewQuestions = await agentPhaseCall(runId, "interview-questions", "start", scope, 1, { eve_session_id: "eve-session-interview-questions" });
      expect(startInterviewQuestions).toMatchObject({ status: 200, body: { status: "running" } });
      const questionPlan = await niceBackendFetch(`${AGENT_BASE}/interview-questions`, {
        method: "POST",
        headers: GROWTH_AGENT_AUTH,
        body: {
          ...scope,
          run_id: runId,
          questions: [
            {
              question_key: "primary-goal",
              prompt: "What is your primary growth goal?",
              kind: "single",
              options: [{ id: "signups", label: "More signups" }, { id: "revenue", label: "More revenue" }],
            },
          ],
        },
      });
      expect(questionPlan).toMatchObject({ status: 200, body: { question_count: 1 } });
      // Capture the workflow fingerprint while the final pre-interview phase is still running. The
      // wait bridge must advance a changed snapshot before returning it; otherwise the canonical
      // workflow's second in-checkpoint long-poll can show every phase as complete while the parent
      // run remains RUNNING for another four minutes.
      const beforeFinalCompletion = await bridgeCall("analysis/wait", { run_id: runId, fingerprint: "force-current-snapshot", timeout_ms: 0 });
      expect(beforeFinalCompletion).toMatchObject({ status: 200, body: { state: "running", resting: false } });
      const completeInterviewQuestions = await agentPhaseCall(runId, "interview-questions", "complete", scope, 1);
      expect(completeInterviewQuestions).toMatchObject({ status: 200, body: { status: "completed" } });

      // Pre-interview phases all settled + interview row exists -> this very wait advances the run
      // to its RESTING interview state. It does not depend on a later workflow-engine tick.
      const afterFinalCompletion = await bridgeCall("analysis/wait", {
        run_id: runId,
        fingerprint: beforeFinalCompletion.body.fingerprint,
        timeout_ms: 0,
      });
      expect(afterFinalCompletion).toMatchObject({ status: 200, body: { state: "awaiting_interview", resting: true } });
      const awaitingRun = await getRun(runId);
      expect(awaitingRun.status).toBe("awaiting_interview");
      expect(awaitingRun.completed_at_millis).toBeNull();
      await pollWithTicks(expect, async () => {
        const leg = await findAnalysisLegRun(runId, ANALYSIS_ACTIVATED_EVENT_TYPE);
        return leg != null && leg.state === "completed" ? leg : null;
      }, { timeoutMs: 180_000 });

      // The user finishes the interview (played through the agent completion route here). That
      // enqueues the interview-finished boundary event, which starts the report leg; its bridge
      // tick dispatches the interview-gated report phase and moves the run to composing_report.
      const interviewComplete = await niceBackendFetch(`${AGENT_BASE}/interview/complete`, {
        method: "POST",
        headers: GROWTH_AGENT_AUTH,
        body: { ...scope, run_id: runId },
      });
      expect(interviewComplete).toMatchObject({ status: 200, body: { status: "completed" } });

      const reportLeg = await pollWithTicks(expect, async () => await findAnalysisLegRun(runId, INTERVIEW_FINISHED_EVENT_TYPE), { timeoutMs: 180_000 });
      expect(reportLeg).toMatchObject({ run_key: `${runId}:${INTERVIEW_FINISHED_EVENT_TYPE}` });
      const reportDispatch = await waitForDispatchWithTicks(expect, mock, (candidate) => isAnalysisPhaseDispatchFor(candidate, projectId, runId, "report", 1), { timeoutMs: 180_000 });
      expect(reportDispatch.body).toEqual({
        project_id: projectId,
        branch_id: branchId,
        run_id: runId,
        phase_key: "report",
        attempt: 1,
        agent_token: expect.stringMatching(/^grt_/),
      });
      const composingRun = await getRun(runId);
      expect(composingRun.status).toBe("composing_report");

      // Play the report phase: save the report (with one action item) and complete the phase.
      const startReport = await agentPhaseCall(runId, "report", "start", scope, 1, { eve_session_id: "eve-session-report" });
      expect(startReport).toMatchObject({ status: 200, body: { status: "running" } });
      const report = await niceBackendFetch(`${AGENT_BASE}/report`, {
        method: "POST",
        headers: GROWTH_AGENT_AUTH,
        body: {
          ...scope,
          run_id: runId,
          title: "Growth analysis for Plannery",
          summary: "Focus on paid acquisition and content.",
          content_md: "# Report\n\nDetails...",
          action_items: [
            { type_id: "run_ads", category: "reach", tags: ["search"], title: "Launch a search ads campaign", description: "Target small agencies." },
          ],
        },
      });
      expect(report.status).toBe(200);
      expect((report.body as { action_item_ids: string[] }).action_item_ids).toHaveLength(1);
      await releaseGrowthReportAsStaff(projectId, (report.body as { report_id: string }).report_id);
      const completeReport = await agentPhaseCall(runId, "report", "complete", scope, 1);
      expect(completeReport).toMatchObject({ status: 200, body: { status: "completed" } });

      // Report phase completed + GrowthReport row exists -> the run completes (another resting
      // state, so the report leg completes too).
      const completedRun = await pollWithTicks(expect, async () => {
        const run = await getRun(runId);
        return run.status === "completed" ? run : null;
      }, { timeoutMs: 180_000 });
      expect(typeof completedRun.completed_at_millis).toBe("number");
      expect(completedRun.phases.every((phase) => phase.status === "completed" && phase.attempt === 1)).toBe(true);
      await pollWithTicks(expect, async () => {
        const leg = await findAnalysisLegRun(runId, INTERVIEW_FINISHED_EVENT_TYPE);
        return leg != null && leg.state === "completed" ? leg : null;
      }, { timeoutMs: 180_000 });

      // The admin status route reflects the finished analysis, its report, and healthy
      // orchestration (both canonical workflows exist, unedited, with no active analysis leg).
      const status = await niceBackendFetch(`${ADMIN_BASE}/status`, { accessType: "admin" });
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        onboarding: { completed: true },
        analysis: { run_id: runId },
        latest_report: { id: expect.any(String), trigger: "initial" },
        counts: { suggested_actions: 1 },
        orchestration: {
          workflows: [
            { workflow_id: GROWTH_ANALYSIS_WORKFLOW_ID, exists: true, edited: false, active_workflow_run_state: null },
            { workflow_id: GROWTH_DAILY_BRIEF_WORKFLOW_ID, exists: true, edited: false, active_workflow_run_state: null },
          ],
        },
      });
    });
  });

  it("resets failed dispatches to pending and re-dispatches with a bumped attempt", { timeout: 300_000 }, async ({ expect }) => {
    await withMockEve(async (mock) => {
      const { projectId, branchId } = await setUpOnboardedProject();
      const scope: AgentScope = { project_id: projectId, branch_id: branchId };

      // Arm the failure window BEFORE onboarding: the boundary event is enqueued transactionally
      // with the run, so the first dispatch wave can arrive as soon as the engine picks the event
      // up. The predicate scopes the 500s to this project's first-attempt analysis-phase
      // dispatches, so dispatches from other growth tests running concurrently (or daily-brief
      // dispatches) cannot consume the budget.
      mock.failNextDispatches(IMMEDIATE_PHASE_KEYS.length, {
        predicate: (dispatch) => dispatch.path === "/runs/analysis-phase" && dispatch.body.project_id === projectId && dispatch.body.attempt === 1,
      });
      const runId = await completeOnboarding();

      // The whole first wave was claimed at attempt 1 and 500'd by the mock.
      for (const phaseKey of IMMEDIATE_PHASE_KEYS) {
        const failedDispatch = await waitForDispatchWithTicks(expect, mock, (candidate) => isAnalysisPhaseDispatchFor(candidate, projectId, runId, phaseKey, 1), { timeoutMs: 180_000 });
        expect(failedDispatch.respondedWithStatus).toBe(500);
      }

      // A failed POST resets the phase to PENDING but keeps the incremented attempt, so persistent
      // dispatch failures eventually exhaust the attempt budget instead of retrying forever. The
      // intermediate PENDING-at-attempt-1 state is no longer observable here: the workflow leg
      // ticks the bridge autonomously between our polls (unlike the v1 cron engine, which only
      // ticked when the test told it to), so the next round re-claims the phases within seconds —
      // the reset semantics themselves are pinned by lib/growth/orchestration.test.ts. What IS
      // reliably observable is the outcome: a re-dispatch of every phase at attempt 2.
      for (const phaseKey of IMMEDIATE_PHASE_KEYS) {
        const redispatch = await waitForDispatchWithTicks(expect, mock, (candidate) => isAnalysisPhaseDispatchFor(candidate, projectId, runId, phaseKey, 2), { timeoutMs: 180_000 });
        expect(redispatch.respondedWithStatus).toBe(200);
        expect(redispatch.body).toEqual({
          project_id: projectId,
          branch_id: branchId,
          run_id: runId,
          phase_key: phaseKey,
          attempt: 2,
          // A FRESH token, minted after the attempt-2 CAS. The attempt is the token's fencing claim,
          // so the attempt-1 session's token stops authenticating the moment this one is issued.
          agent_token: expect.stringMatching(/^grt_/),
        });
      }

      // An agent echoing the stale attempt 1 is fenced off; echoing the stored attempt 2 works.
      const staleStart = await agentPhaseCall(runId, "website-research", "start", scope, 1, { eve_session_id: "eve-session-stale" });
      expect(staleStart.status).toBe(409);
      const freshStart = await agentPhaseCall(runId, "website-research", "start", scope, 2, { eve_session_id: "eve-session-fresh" });
      expect(freshStart).toMatchObject({ status: 200, body: { status: "running" } });
    });
  });

  it("retries exhausted phases with fresh token anchors and attempt budgets", { timeout: 300_000 }, async ({ expect }) => {
    await withMockEve(async (mock) => {
      const { projectId, branchId } = await setUpOnboardedProject();
      const scope: AgentScope = { project_id: projectId, branch_id: branchId };

      // Exhaust every immediate phase's two-attempt dispatch budget. Direct bridge ticks keep
      // this deterministic and fast instead of waiting for the workflow leg's long-poll windows.
      mock.failNextDispatches(IMMEDIATE_PHASE_KEYS.length * 2, {
        predicate: (dispatch) => dispatch.path === "/runs/analysis-phase" && dispatch.body.project_id === projectId,
      });
      const runId = await completeOnboarding();
      // One bridge tick computes metrics, which is what makes integrations auto-skippable; the skip
      // itself lands on a following tick, so drive until it settles before asserting the explicit
      // route's CAS response.
      expect((await bridgeCall("analysis/tick", { run_id: runId })).status).toBe(200);
      await waitForSettledIntegrationsPhase(expect, runId);
      const skipIntegrations = await niceBackendFetch(`${ADMIN_BASE}/runs/${runId}/integrations`, {
        accessType: "admin",
        method: "POST",
        body: { action: "skip" },
      });
      expect(skipIntegrations.status).toBe(409);
      expect(getRunPhase(await getRun(runId), "integrations")).toMatchObject({ status: "skipped" });
      for (let attempt = 1; attempt <= 2; attempt++) {
        const tick = await bridgeCall("analysis/tick", { run_id: runId });
        expect(tick.status).toBe(200);
        for (const phaseKey of IMMEDIATE_PHASE_KEYS) {
          const dispatch = await mock.waitForDispatch((candidate) => isAnalysisPhaseDispatchFor(candidate, projectId, runId, phaseKey, attempt));
          expect(dispatch.respondedWithStatus).toBe(500);
        }
      }
      // One tick promotes PENDING-at-attempt-2 phases to FAILED; the next observes those failures
      // and fails the run.
      expect((await bridgeCall("analysis/tick", { run_id: runId })).status).toBe(200);
      expect((await bridgeCall("analysis/tick", { run_id: runId })).status).toBe(200);
      const failedRun = await getRun(runId);
      expect(failedRun.status).toBe("failed");
      for (const phaseKey of IMMEDIATE_PHASE_KEYS) {
        expect(getRunPhase(failedRun, phaseKey)).toMatchObject({ status: "failed", attempt: 2 });
      }

      const oldDispatch = await mock.waitForDispatch((candidate) => isAnalysisPhaseDispatchFor(candidate, projectId, runId, "website-research", 2));
      const oldToken = oldDispatch.body.agent_token;
      if (typeof oldToken !== "string") throw new Error("Expected the failed dispatch to contain an agent token.");
      expect(oldToken).toMatch(/^grt_/);

      const retry = await niceBackendFetch(`${ADMIN_BASE}/analysis/retry`, { accessType: "admin", method: "POST" });
      expect(retry).toMatchObject({ status: 200, body: { run_id: runId } });
      const retriedRun = await getRun(runId);
      expect(retriedRun.status).toBe("pending");
      for (const phaseKey of IMMEDIATE_PHASE_KEYS) {
        expect(getRunPhase(retriedRun, phaseKey)).toMatchObject({ status: "pending", attempt: 0 });
      }

      // The replacement row has a new phase id, so even when a later dispatch reuses attempt 1,
      // no token anchored to an old failed row can authenticate.
      const staleStart = await niceBackendFetch(`${AGENT_BASE}/runs/${runId}/phases/website-research/start`, {
        method: "POST",
        headers: { "authorization": `Bearer ${oldToken}` },
        body: { ...scope, attempt: 2, eve_session_id: "eve-session-before-manual-retry" },
      });
      expect(staleStart.status).toBe(401);

      const redispatchTick = await bridgeCall("analysis/tick", { run_id: runId });
      expect(redispatchTick.status).toBe(200);
      const freshDispatch = await mock.waitForDispatch((candidate) => isAnalysisPhaseDispatchFor(candidate, projectId, runId, "website-research", 1));
      expect(freshDispatch.respondedWithStatus).toBe(200);
      expect(freshDispatch.body.agent_token).toMatch(/^grt_/);
      expect(freshDispatch.body.agent_token).not.toBe(oldToken);
      expect(getRunPhase(await getRun(runId), "website-research")).toMatchObject({ status: "dispatched", attempt: 1 });
    });
  });

  it("fences zombie agents echoing a stale attempt after a re-dispatch, without changing state", { timeout: 300_000 }, async ({ expect }) => {
    await withMockEve(async (mock) => {
      const { projectId, branchId } = await setUpOnboardedProject();
      const scope: AgentScope = { project_id: projectId, branch_id: branchId };

      // Fail only website-research's first dispatch; the other 5 immediate phases dispatch fine.
      mock.failNextDispatches(1, {
        predicate: (dispatch) => dispatch.path === "/runs/analysis-phase" && dispatch.body.project_id === projectId && dispatch.body.phase_key === "website-research",
      });
      const runId = await completeOnboarding();

      const failedDispatch = await waitForDispatchWithTicks(expect, mock, (candidate) => isAnalysisPhaseDispatchFor(candidate, projectId, runId, "website-research", 1), { timeoutMs: 180_000 });
      expect(failedDispatch.respondedWithStatus).toBe(500);

      // Re-dispatch at attempt 2 (the workflow leg's next bridge tick re-claims the reset phase).
      const redispatch = await waitForDispatchWithTicks(expect, mock, (candidate) => isAnalysisPhaseDispatchFor(candidate, projectId, runId, "website-research", 2), { timeoutMs: 180_000 });
      expect(redispatch.respondedWithStatus).toBe(200);

      // A zombie from the dead attempt-1 invocation gets 409 on every lifecycle verb...
      const zombieStart = await agentPhaseCall(runId, "website-research", "start", scope, 1, { eve_session_id: "eve-session-zombie" });
      expect(zombieStart.status).toBe(409);
      const zombieHeartbeat = await agentPhaseCall(runId, "website-research", "heartbeat", scope, 1);
      expect(zombieHeartbeat.status).toBe(409);
      const zombieComplete = await agentPhaseCall(runId, "website-research", "complete", scope, 1);
      expect(zombieComplete.status).toBe(409);

      // ...and none of those calls changed the phase state.
      const runAfterZombie = await getRun(runId);
      expect(getRunPhase(runAfterZombie, "website-research")).toMatchObject({ status: "dispatched", attempt: 2 });

      // The real attempt-2 invocation proceeds normally.
      const start = await agentPhaseCall(runId, "website-research", "start", scope, 2, { eve_session_id: "eve-session-real" });
      expect(start).toMatchObject({ status: 200, body: { status: "running" } });
      const complete = await agentPhaseCall(runId, "website-research", "complete", scope, 2);
      expect(complete).toMatchObject({ status: 200, body: { status: "completed" } });
      const runAfterComplete = await getRun(runId);
      expect(getRunPhase(runAfterComplete, "website-research")).toMatchObject({ status: "completed", attempt: 2 });
    });
  });

  it("runs the daily-brief workflow end to end: rollup, Eve dispatch, agent content, deliveries, milestone evaluation", { timeout: 300_000 }, async ({ expect }) => {
    await withMockEve(async (mock) => {
      const { projectId, branchId } = await setUpOnboardedProject();
      const scope: AgentScope = { project_id: projectId, branch_id: branchId };
      await completeOnboarding();

      // The schedule trigger (00:10 UTC) can't fire in-test, so use the workflow's other trigger:
      // the catch-up custom event with an explicit date. The rollup only accepts fully-elapsed
      // recent UTC days, so target yesterday.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await sendCustomEvent(expect, "growth.daily-brief-due", { date: yesterday });

      // One run per brief day, keyed "brief:<date>".
      const briefRun = await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(GROWTH_DAILY_BRIEF_WORKFLOW_ID, { run_key: `brief:${yesterday}` });
        return runs[0] ?? null;
      }, { timeoutMs: 120_000 });
      expect(briefRun).toMatchObject({ run_key: `brief:${yesterday}` });

      // The workflow's rollup step created the day's "generating" brief and its dispatch step asked
      // Eve to write it.
      const briefDispatch = await waitForDispatchWithTicks(expect, mock, (dispatch) => dispatch.path === "/runs/daily-brief" && dispatch.body.project_id === projectId && dispatch.body.date === yesterday, { timeoutMs: 180_000 });
      expect(briefDispatch.body).toEqual({
        project_id: projectId,
        branch_id: branchId,
        brief_id: expect.any(String),
        date: yesterday,
        agent_token: expect.stringMatching(/^grt_/),
      });
      expect(briefDispatch.authorization).toBe("Bearer mock_growth_agent_secret");
      const briefId = briefDispatch.body.brief_id as string;

      // Play the agent: upsert the brief content, flipping it to "ready" — the workflow's
      // wait-brief long-poll picks that up and wires deliveries.
      const agentBrief = await niceBackendFetch(`${AGENT_BASE}/briefs`, {
        method: "POST",
        headers: GROWTH_AGENT_AUTH,
        body: { ...scope, date: yesterday, summary: "Signups steady.", content_md: "## Daily brief\n\nDetails..." },
      });
      expect(agentBrief).toMatchObject({ status: 200, body: { brief_id: briefId } });

      // The workflow run completes (rollup -> dispatch -> wait -> deliveries -> milestones).
      await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(GROWTH_DAILY_BRIEF_WORKFLOW_ID, { run_key: `brief:${yesterday}` });
        return runs[0]?.state === "completed" ? runs[0] : null;
      }, { timeoutMs: 180_000 });

      // The brief is readable on the admin surface with the agent's content. Releasing the workspace
      // first because briefs are withheld until the customer's report is published — that gate is
      // this suite's precondition, not its subject (report-release.test.ts owns it).
      await unlockGrowthWorkspaceAsStaff(scope);
      const adminBrief = await niceBackendFetch(`${ADMIN_BASE}/briefs/${briefId}`, { accessType: "admin" });
      expect(adminBrief.status).toBe(200);
      expect(adminBrief.body).toMatchObject({
        id: briefId,
        date: yesterday,
        status: "ready",
        summary: "Signups steady.",
        content_md: "## Daily brief\n\nDetails...",
      });

      // BRIDGE ABUSE: re-calling wire-deliveries must not create a second GrowthDelivery row — the
      // unique on (briefId, channel) makes row creation the claim. The registry currently contains
      // exactly the no-op dashboard channel, and the workflow already wired it, so the re-call
      // reports the single existing row.
      for (let i = 0; i < 2; i++) {
        const rewire = await bridgeCall("daily/wire-deliveries", { brief_id: briefId });
        expect(rewire).toMatchObject({
          status: 200,
          body: { deliveries: [{ channel: "dashboard", status: "delivered" }] },
        });
      }

      // Milestone evaluation ran inside the workflow: the hourly per-milestone claim is consumed,
      // so a direct re-evaluation finds zero candidates. (Actually CROSSING a milestone is not
      // e2e-asserted: metric values come exclusively from the engine-written rollup of real
      // project data, so arranging a deterministic crossing here is not possible — the crossing
      // logic incl. run creation is unit-covered in lib/growth/orchestration.test.ts.)
      const reevaluate = await bridgeCall("milestones/evaluate", {});
      expect(reevaluate).toMatchObject({ status: 200, body: { evaluated: 0, crossed: [] } });

      // Re-firing the same day's event after the first run completed starts a FRESH run (onConflict
      // "skip" only dedupes against active runs) — but the day's pipeline is idempotent end to end:
      // the rollup's unique claim returns the existing "ready" brief, so the second run completes
      // without a second Eve dispatch and without a second delivery row.
      await sendCustomEvent(expect, "growth.daily-brief-due", { date: yesterday });
      await pollWithTicks(expect, async () => {
        const { runs } = await listRuns(GROWTH_DAILY_BRIEF_WORKFLOW_ID, { run_key: `brief:${yesterday}` });
        return runs.length === 2 && runs.every((run) => run.state === "completed") ? runs : null;
      }, { timeoutMs: 120_000 });
      expect(mock.dispatches.filter((dispatch) => dispatch.path === "/runs/daily-brief" && dispatch.body.project_id === projectId && dispatch.body.date === yesterday)).toHaveLength(1);
      const rewireAfterSecondRun = await bridgeCall("daily/wire-deliveries", { brief_id: briefId });
      expect(rewireAfterSecondRun).toMatchObject({
        status: 200,
        body: { deliveries: [{ channel: "dashboard", status: "delivered" }] },
      });
    });
  });

  // The cron auth negatives don't dispatch anything, so they don't need (and must not hold) the
  // mock Eve — mirrors email-queue-step.test.ts. They target the growth WATCHDOG route (the
  // workflow engine's own negatives live in its suite; the v1 growth-engine-step route is gone).
  it("should return error when no authorization header is provided", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/internal/growth-watchdog-step", {
      method: "GET",
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "SCHEMA_ERROR",
          "details": {
            "message": deindent\`
              Request validation failed on GET /api/v1/internal/growth-watchdog-step:
                - headers.authorization must be defined
            \`,
          },
          "error": deindent\`
            Request validation failed on GET /api/v1/internal/growth-watchdog-step:
              - headers.authorization must be defined
          \`,
        },
        "headers": Headers {
          "x-stack-known-error": "SCHEMA_ERROR",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should return error when invalid authorization header is provided", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/internal/growth-watchdog-step", {
      method: "GET",
      headers: {
        "authorization": "Bearer invalid_secret",
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 401,
        "body": "Unauthorized",
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });
});

// The interview streaming turn needs a mock Eve that RESPONDS with a body (unlike the
// fire-and-forget run routes, the backend consumes /interview's response), so it lives in this file
// — the only one allowed to bind the fixed mock-Eve port. Non-streaming interview behavior
// (GET/skip/answer-persistence negatives) lives in interview.test.ts without the mock.
describe("growth interview streaming (mock Eve)", () => {
  it("persists the answer before proxying, passes the assistant turn through as a UI chunk stream, and persists the transcript", { timeout: 420_000 }, async ({ expect }) => {
    await withMockEve(async (mock) => {
      const { projectId, branchId } = await setUpOnboardedProject();
      const scope: AgentScope = { project_id: projectId, branch_id: branchId };
      const runId = await completeOnboarding();

      // Drive the run to AWAITING_INTERVIEW (same choreography as the full-lifecycle test above,
      // compressed: play the agent for every pre-interview phase and save a two-question plan).
      for (const phaseKey of IMMEDIATE_PHASE_KEYS) {
        await waitForDispatchWithTicks(expect, mock, (candidate) => isAnalysisPhaseDispatchFor(candidate, projectId, runId, phaseKey, 1), { timeoutMs: 180_000 });
        expect(await agentPhaseCall(runId, phaseKey, "start", scope, 1, { eve_session_id: `eve-session-${phaseKey}` })).toMatchObject({ status: 200 });
        expect(await agentPhaseCall(runId, phaseKey, "complete", scope, 1)).toMatchObject({ status: 200 });
      }
      await waitForDispatchWithTicks(expect, mock, (candidate) => isAnalysisPhaseDispatchFor(candidate, projectId, runId, "interview-questions", 1), { timeoutMs: 180_000 });
      expect(await agentPhaseCall(runId, "interview-questions", "start", scope, 1, { eve_session_id: "eve-session-interview-questions" })).toMatchObject({ status: 200 });
      const questionPlan = await niceBackendFetch(`${AGENT_BASE}/interview-questions`, {
        method: "POST",
        headers: GROWTH_AGENT_AUTH,
        body: {
          ...scope,
          run_id: runId,
          questions: [
            {
              question_key: "primary-goal",
              prompt: "What is your primary growth goal?",
              kind: "single",
              options: [{ id: "signups", label: "More signups" }, { id: "revenue", label: "More revenue" }],
            },
            {
              question_key: "team-size",
              prompt: "How big is your team?",
              kind: "single",
              options: [{ id: "solo", label: "Just me" }, { id: "small", label: "2-10 people" }],
            },
          ],
        },
      });
      expect(questionPlan.status).toBe(200);
      expect(await agentPhaseCall(runId, "interview-questions", "complete", scope, 1)).toMatchObject({ status: 200 });
      // The plan is written held; a customer cannot start a turn on questions nobody has reviewed
      // (see lib/growth/interview-release.ts). Releasing it is what makes the stream route below
      // reachable at all.
      await releaseGrowthInterviewAsStaff(projectId);
      await pollWithTicks(expect, async () => {
        const run = await getRun(runId);
        return run.status === "awaiting_interview" ? run : null;
      }, { timeoutMs: 180_000 });

      // Canned Eve /interview response: the completed assistant UIMessage of one turn (v1
      // non-streamed contract — the backend synthesizes the chunk stream from it).
      const assistantMessage = {
        id: "assistant-turn-1",
        role: "assistant",
        parts: [
          { type: "text", text: "Great, thanks! Next up:", state: "done" },
          {
            type: "tool-present-interview-question",
            toolCallId: "call-1",
            state: "output-available",
            input: {
              question_id: "mock-question-id",
              question_key: "team-size",
              text: "How big is your team?",
              kind: "single",
              options: [{ id: "solo", label: "Just me" }, { id: "small", label: "2-10 people" }],
              allow_free_text: true,
              allow_skip: true,
            },
            output: { presented: true },
          },
        ],
      };
      mock.respondWith(
        (dispatch) => dispatch.path === "/interview" && dispatch.body.run_id === runId,
        { body: { message: assistantMessage } },
      );

      const turn = await niceBackendFetch(`${ADMIN_BASE}/interview/stream`, {
        accessType: "admin",
        method: "POST",
        body: { answer: { order_index: 0, option_ids: ["signups"] } },
      });
      expect(turn.status).toBe(200);
      // The response is an AI SDK UI message chunk stream (SSE), which niceBackendFetch surfaces as
      // text. Assert the chunk sequence carries the text and the structured question tool part.
      const sse = turn.body as string;
      expect(typeof sse).toBe("string");
      expect(sse).toContain('"type":"start"');
      expect(sse).toContain("Great, thanks! Next up:");
      expect(sse).toContain('"toolName":"present-interview-question"');
      expect(sse).toContain('"type":"tool-output-available"');

      // ANSWER-FIRST: the dispatch the backend sent to Eve already carried the persisted answer,
      // and the transcript it sent ends with the backend-authored user answer message.
      const dispatch = await mock.waitForDispatch((candidate) => candidate.path === "/interview" && candidate.body.run_id === runId);
      expect(dispatch.authorization).toBe("Bearer mock_growth_agent_secret");
      expect(dispatch.body.questions[0]).toMatchObject({ question_key: "primary-goal", answer_option_ids: ["signups"] });
      expect(dispatch.body.transcript).toHaveLength(1);
      expect(dispatch.body.transcript[0]).toMatchObject({ role: "user" });

      // Transcript persisted wholesale after the turn: the user answer message plus the assistant
      // message, exactly as sent/returned.
      const interview = await niceBackendFetch(`${ADMIN_BASE}/interview`, { accessType: "admin" });
      expect(interview.status).toBe(200);
      const interviewBody = interview.body as { status: string, messages: { role?: string, id?: string }[], questions: { answer_option_ids: string[] | null }[] };
      expect(interviewBody.status).toBe("active");
      expect(interviewBody.messages).toHaveLength(2);
      expect(interviewBody.messages[0]).toMatchObject({ role: "user" });
      expect(interviewBody.messages[1]).toMatchObject({ id: "assistant-turn-1", role: "assistant" });
      expect(interviewBody.questions[0]).toMatchObject({ answer_option_ids: ["signups"] });
    });
  });
});
