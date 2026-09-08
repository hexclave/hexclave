import { describe, type ExpectStatic } from "vitest";
import { it } from "../../../../../../helpers";
import { Project, niceBackendFetch } from "../../../../../backend-helpers";
import { GROWTH_AGENT_AUTH, asGrowthStaff, createGrowthProject, releaseGrowthInterviewAsStaff, requireRunId } from "./growth-helpers";

const ADMIN_BASE = "/api/latest/internal/growth";
const AGENT_BASE = "/api/latest/internal/growth-agent";

// Growth fixtures seed sandbox-backed workflows during onboarding and can land around 60s under
// full-suite load, so default-timeout tests need 90s of headroom.

// Non-streaming interview e2e: GET/skip semantics, answer-first persistence when Eve is unreachable,
// and the interview-questions append mode. This file must NOT use mock-eve (its fixed port belongs
// to growth-workflows.test.ts exclusively); every Eve dispatch from here either hits nothing (connection
// refused) or, when growth-workflows.test.ts happens to be running concurrently in another worker, its
// mock (which answers /interview with a body the backend treats as malformed). Both cases surface as
// the same retryable 502 from the stream route, which is exactly what the persist-then-proxy-fail
// tests assert — so the suite stays deterministic either way.
//
// The run is advanced via the growth-server BRIDGE tick (the same per-run orchestration tick the
// growth-analysis workflow calls), not via workflow-engine ticks: driving the real workflow would
// require the mock Eve, and the bridge authenticates as ordinary server auth, so calling it
// directly is both legal and exactly what production traffic looks like.

const PRE_INTERVIEW_PHASE_KEYS = [
  "website-research",
  "data-analysis",
  "analysis:first-screen-audit",
  "analysis:seo-aeo-strategy",
  "analysis:traffic-quality",
  "analysis:icp-visitor-outreach",
  "interview-questions",
] as const;

type AgentScope = { project_id: string, branch_id: string };
type AdminRunPhase = { phase_key: string, status: string, attempt: number };
type AdminRunBody = { id: string, status: string, phases: AdminRunPhase[] };

/** One per-run orchestration tick via the growth-server bridge (server auth, like the workflow). */
async function tickAnalysisRun(expect: ExpectStatic, runId: string) {
  const response = await niceBackendFetch("/api/v1/internal/growth-server/analysis/tick", {
    method: "POST",
    accessType: "server",
    body: { run_id: runId },
  });
  expect(response.status).toBe(200);
}

async function getRun(runId: string): Promise<AdminRunBody> {
  const response = await niceBackendFetch(`${ADMIN_BASE}/runs/${runId}`, { accessType: "admin" });
  if (response.status !== 200) {
    throw new Error(`Reading run ${runId} failed with status ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body as AdminRunBody;
}

async function setUpOnboardedGrowthProject() {
  const projectKeys = await createGrowthProject();
  if (projectKeys === "no-project") {
    throw new Error("createGrowthProject should have switched the context to a fresh project.");
  }
  const onboarding = await niceBackendFetch(`${ADMIN_BASE}/onboarding`, {
    accessType: "admin",
    method: "POST",
    body: { website_url: "https://plannery.example.com", company_summary: "Project management for small teams." },
  });
  if (onboarding.status !== 200) {
    throw new Error(`Growth onboarding failed with status ${onboarding.status}: ${JSON.stringify(onboarding.body)}`);
  }
  const scope: AgentScope = { project_id: projectKeys.projectId, branch_id: projectKeys.branchId ?? "main" };
  return { scope, runId: requireRunId(onboarding.body) };
}

async function saveQuestionPlan(scope: AgentScope, runId: string) {
  const response = await niceBackendFetch(`${AGENT_BASE}/interview-questions`, {
    method: "POST",
    headers: GROWTH_AGENT_AUTH,
    body: {
      ...scope,
      run_id: runId,
      questions: [
        {
          question_key: "primary-goal",
          prompt: "Forty-one percent of new workspaces never create a second project. Which growth outcome should the next quarter prioritize?",
          kind: "single",
          options: [{ id: "signups", label: "More signups" }, { id: "revenue", label: "More revenue" }],
        },
        {
          question_key: "team-size",
          prompt: "The site presents Plannery as a tool for small teams, but it does not name the team behind it. How big is your team?",
          kind: "single",
          options: [{ id: "solo", label: "Just me" }, { id: "small", label: "2-10 people" }],
        },
      ],
    },
  });
  if (response.status !== 200) {
    throw new Error(`Saving the question plan failed with status ${response.status}: ${JSON.stringify(response.body)}`);
  }
}

/**
 * Completes one phase through the machine lifecycle routes, echoing whatever attempt is currently
 * stored. Retries on 409: orchestration ticks (ours, or a workflow leg driven by
 * growth-workflows.test.ts's engine ticks in another worker) can bump the attempt between the read
 * and the call by claiming/dispatching the phase.
 */
async function settlePhase(scope: AgentScope, runId: string, phaseKey: string) {
  for (let i = 0; i < 20; i++) {
    const run = await getRun(runId);
    const phase = run.phases.find((candidate) => candidate.phase_key === phaseKey);
    if (phase == null) throw new Error(`Run ${runId} has no phase ${phaseKey}.`);
    if (phase.status === "completed") return;
    if (phase.status === "failed") {
      // A concurrent tick exhausted the dispatch budget (every dispatch from this file fails).
      // driveRunToAwaitingInterview recovers via the admin retry route; nothing to do here yet.
      return;
    }
    const start = await niceBackendFetch(`${AGENT_BASE}/runs/${runId}/phases/${phaseKey}/start`, {
      method: "POST",
      headers: GROWTH_AGENT_AUTH,
      body: { ...scope, attempt: phase.attempt, eve_session_id: `eve-session-${phaseKey}` },
    });
    if (start.status === 409) continue;
    if (start.status !== 200) throw new Error(`Starting phase ${phaseKey} failed with status ${start.status}: ${JSON.stringify(start.body)}`);
    const complete = await niceBackendFetch(`${AGENT_BASE}/runs/${runId}/phases/${phaseKey}/complete`, {
      method: "POST",
      headers: GROWTH_AGENT_AUTH,
      body: { ...scope, attempt: phase.attempt },
    });
    if (complete.status === 409) continue;
    if (complete.status !== 200) throw new Error(`Completing phase ${phaseKey} failed with status ${complete.status}: ${JSON.stringify(complete.body)}`);
    return;
  }
  throw new Error(`settlePhase(${phaseKey}) kept losing attempt races.`);
}

/**
 * Plays the agent for every pre-interview phase and ticks the run's orchestration (via the bridge)
 * until the run awaits the interview. Every Eve dispatch fails in this file (nothing listens, or
 * the other suite's mock is irrelevant), so this also exercises that the machine lifecycle routes
 * work independently of successful dispatches. Recovers runs that a tick already failed (exhausted
 * dispatch attempts) through the admin retry route.
 */
async function driveRunToAwaitingInterview(expect: ExpectStatic, scope: AgentScope, runId: string) {
  const deadline = Date.now() + 120_000;
  while (true) {
    // Tick BEFORE settling: the RUNNING flip only happens when a tick claims a pending phase, and
    // completing every phase while the run still sits in PENDING would leave it unable to ever
    // transition (the transition step only advances RUNNING runs).
    await tickAnalysisRun(expect, runId);
    const run = await getRun(runId);
    if (run.status === "awaiting_interview") return;
    if (run.status === "failed") {
      // A concurrent tick exhausted a phase's dispatch budget (every dispatch here fails); the
      // admin retry route revives the run, and the machine lifecycle calls below settle the phases
      // without needing a successful dispatch.
      const retry = await niceBackendFetch(`${ADMIN_BASE}/analysis/retry`, { accessType: "admin", method: "POST" });
      expect(retry.status).toBe(200);
    } else if (run.status !== "pending") {
      for (const phaseKey of PRE_INTERVIEW_PHASE_KEYS) {
        await settlePhase(scope, runId, phaseKey);
      }
    }
    if (Date.now() > deadline) throw new Error(`Run ${runId} did not reach awaiting_interview in time; last status: ${run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

type InterviewBody = {
  status: string,
  questions: {
    question_key: string,
    order_index: number,
    origin: string,
    allow_skip: boolean,
    answer_option_ids: string[] | null,
    answer_free_text: string | null,
    answered_at_millis: number | null,
    options: { id: string, label: string, description: string | null }[],
  }[],
  messages: unknown[],
};

async function getInterview(): Promise<{ status: number, body: InterviewBody }> {
  const response = await niceBackendFetch(`${ADMIN_BASE}/interview`, { accessType: "admin" });
  return { status: response.status, body: response.body as InterviewBody };
}

describe("internal growth interview (no mock Eve)", { timeout: 90_000 }, () => {
  it("rejects non-admin access, growth-disabled projects, and returns 404 before a question plan exists", async ({ expect }) => {
    await Project.createAndSwitch();
    // App not enabled: even an admin request is rejected with a 400.
    const disabled = await niceBackendFetch(`${ADMIN_BASE}/interview`, { accessType: "admin" });
    expect(disabled.status).toBe(400);

    await Project.updateConfig({ "apps.installed.gtm.enabled": true });
    const clientAccess = await niceBackendFetch(`${ADMIN_BASE}/interview`, { accessType: "client" });
    expect(clientAccess.status).toBe(401);
    const clientSkip = await niceBackendFetch(`${ADMIN_BASE}/interview/skip`, { accessType: "client", method: "POST" });
    expect(clientSkip.status).toBe(401);
    const clientStream = await niceBackendFetch(`${ADMIN_BASE}/interview/stream`, { accessType: "client", method: "POST", body: {} });
    expect(clientStream.status).toBe(401);

    // No run at all -> no interview resource.
    const noRun = await niceBackendFetch(`${ADMIN_BASE}/interview`, { accessType: "admin" });
    expect(noRun.status).toBe(404);

    // A run exists but the interview-questions phase hasn't saved a plan yet -> still 404.
    await niceBackendFetch(`${ADMIN_BASE}/onboarding`, {
      accessType: "admin",
      method: "POST",
      body: { website_url: "https://plannery.example.com" },
    });
    const beforePlan = await niceBackendFetch(`${ADMIN_BASE}/interview`, { accessType: "admin" });
    expect(beforePlan.status).toBe(404);
    const skipBeforePlan = await niceBackendFetch(`${ADMIN_BASE}/interview/skip`, { accessType: "admin", method: "POST" });
    expect(skipBeforePlan.status).toBe(404);
  });

  it("returns the plan, skips idempotently, and refuses skipping a completed interview", async ({ expect }) => {
    const { scope, runId } = await setUpOnboardedGrowthProject();
    const longQuestion = await niceBackendFetch(`${AGENT_BASE}/interview-questions`, {
      method: "POST",
      headers: GROWTH_AGENT_AUTH,
      body: {
        ...scope,
        run_id: runId,
        questions: [{ question_key: "too-long", prompt: "Q".repeat(301), kind: "single", options: [{ id: "yes", label: "Yes" }] }],
      },
    });
    expect(longQuestion.status).toBe(400);
    await saveQuestionPlan(scope, runId);

    // Written, but held for review: to the customer a plan nobody has read is indistinguishable
    // from one that has not been generated. interview-release.test.ts owns that gate; here it is a
    // precondition, asserted once so this suite fails loudly if the gate ever moves again.
    const beforeRelease = await getInterview();
    expect(beforeRelease.status).toBe(404);
    await releaseGrowthInterviewAsStaff(scope.project_id);

    const fresh = await getInterview();
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ status: "pending", messages: [] });
    expect(fresh.body.questions.map((question) => question.question_key)).toEqual(["primary-goal", "team-size"]);
    expect(fresh.body.questions.every((question) => question.origin === "planned" && question.answered_at_millis === null)).toBe(true);
    expect(fresh.body.questions.every((question) => question.options.at(-1)?.id === "other" && question.options.at(-1)?.label === "Other")).toBe(true);

    const skip = await niceBackendFetch(`${ADMIN_BASE}/interview/skip`, { accessType: "admin", method: "POST" });
    expect(skip).toMatchObject({ status: 200, body: { status: "skipped" } });
    // Skipping again is an idempotent no-op (retried requests must not error).
    const skipAgain = await niceBackendFetch(`${ADMIN_BASE}/interview/skip`, { accessType: "admin", method: "POST" });
    expect(skipAgain).toMatchObject({ status: 200, body: { status: "skipped" } });
    const afterSkip = await getInterview();
    expect(afterSkip.body.status).toBe("skipped");

    // A separate project whose interview the agent completed: skipping is refused with a 400.
    const second = await setUpOnboardedGrowthProject();
    await saveQuestionPlan(second.scope, second.runId);
    await releaseGrowthInterviewAsStaff(second.scope.project_id);
    const complete = await niceBackendFetch(`${AGENT_BASE}/interview/complete`, {
      method: "POST",
      headers: GROWTH_AGENT_AUTH,
      body: { ...second.scope, run_id: second.runId },
    });
    expect(complete).toMatchObject({ status: 200, body: { status: "completed" } });
    const skipCompleted = await niceBackendFetch(`${ADMIN_BASE}/interview/skip`, { accessType: "admin", method: "POST" });
    expect(skipCompleted.status).toBe(400);
  });

  it("persists answers before proxying, surfaces Eve unavailability as a retryable 502, and guards the machine write modes", { timeout: 300_000 }, async ({ expect }) => {
    const { scope, runId } = await setUpOnboardedGrowthProject();
    await saveQuestionPlan(scope, runId);
    await releaseGrowthInterviewAsStaff(scope.project_id);

    // The stream route refuses turns until the run awaits the interview.
    const tooEarly = await niceBackendFetch(`${ADMIN_BASE}/interview/stream`, {
      accessType: "admin",
      method: "POST",
      body: { answer: { order_index: 0, option_ids: ["signups"] } },
    });
    expect(tooEarly.status).toBe(400);

    await driveRunToAwaitingInterview(expect, scope, runId);

    // Invalid answers are rejected before anything is persisted or proxied.
    const unknownOption = await niceBackendFetch(`${ADMIN_BASE}/interview/stream`, {
      accessType: "admin",
      method: "POST",
      body: { answer: { order_index: 0, option_ids: ["definitely-not-an-option"] } },
    });
    expect(unknownOption.status).toBe(400);
    const unknownIndex = await niceBackendFetch(`${ADMIN_BASE}/interview/stream`, {
      accessType: "admin",
      method: "POST",
      body: { answer: { order_index: 99, option_ids: ["signups"] } },
    });
    expect(unknownIndex.status).toBe(400);
    const emptyAnswer = await niceBackendFetch(`${ADMIN_BASE}/interview/stream`, {
      accessType: "admin",
      method: "POST",
      body: { answer: { order_index: 0 } },
    });
    expect(emptyAnswer.status).toBe(400);
    const otherWithoutText = await niceBackendFetch(`${ADMIN_BASE}/interview/stream`, {
      accessType: "admin",
      method: "POST",
      body: { answer: { order_index: 0, option_ids: ["other"] } },
    });
    expect(otherWithoutText.status).toBe(400);

    // ANSWER-FIRST PERSISTENCE: the answer is written before the Eve proxy call, and no working Eve
    // exists in this suite, so the turn fails with the retryable 502 — but the answer survives.
    await expect(niceBackendFetch(`${ADMIN_BASE}/interview/stream`, {
      accessType: "admin",
      method: "POST",
      body: { answer: { order_index: 0, option_ids: ["signups"], free_text: "Mostly self-serve signups." } },
    })).rejects.toThrow(/API threw ISE.*502/);
    const afterAnswer = await getInterview();
    expect(afterAnswer.body.status).toBe("active");
    expect(afterAnswer.body.questions[0]).toMatchObject({
      answer_option_ids: ["signups"],
      answer_free_text: "Mostly self-serve signups.",
    });
    expect(typeof afterAnswer.body.questions[0].answered_at_millis).toBe("number");
    const adminAnswer = await asGrowthStaff(async () => await niceBackendFetch(
      `/api/latest/internal/growth/admin/interview?project_id=${scope.project_id}`,
      { accessType: "client" },
    ));
    expect(adminAnswer.status).toBe(200);
    expect((adminAnswer.body as { interview: { questions: InterviewBody["questions"] } }).interview.questions[0]).toMatchObject({
      answer_option_ids: ["signups"],
      answer_free_text: "Mostly self-serve signups.",
    });
    // The failed turn must not have written a transcript (the assistant never replied).
    expect(afterAnswer.body.messages).toEqual([]);

    // Wholesale replace is 409-guarded once anything was answered...
    const replaceAfterAnswer = await niceBackendFetch(`${AGENT_BASE}/interview-questions`, {
      method: "POST",
      headers: GROWTH_AGENT_AUTH,
      body: {
        ...scope,
        run_id: runId,
        questions: [{ question_key: "new-plan", prompt: "New plan?", kind: "single", options: [{ id: "a", label: "A" }] }],
      },
    });
    expect(replaceAfterAnswer.status).toBe(409);

    // ...but append mode still works while the interview is active, lands at the next orderIndex,
    // and is forced to origin "adaptive".
    const append = await niceBackendFetch(`${AGENT_BASE}/interview-questions`, {
      method: "POST",
      headers: GROWTH_AGENT_AUTH,
      body: {
        ...scope,
        run_id: runId,
        append: true,
        questions: [{
          question_key: "signup-source",
          prompt: "Where do most signups come from today?",
          kind: "single",
          options: [{ id: "organic", label: "Organic search" }, { id: "referrals", label: "Referrals" }],
          origin: "planned", // deliberately wrong; the backend must store "adaptive" anyway
        }],
      },
    });
    expect(append.status).toBe(200);
    expect(append.body).toMatchObject({ order_index: 2, question_id: expect.any(String) });

    // Append mode adds exactly one question per request.
    const appendTwo = await niceBackendFetch(`${AGENT_BASE}/interview-questions`, {
      method: "POST",
      headers: GROWTH_AGENT_AUTH,
      body: {
        ...scope,
        run_id: runId,
        append: true,
        questions: [
          { question_key: "a", prompt: "A?", kind: "single", options: [{ id: "a", label: "A" }] },
          { question_key: "b", prompt: "B?", kind: "single", options: [{ id: "b", label: "B" }] },
        ],
      },
    });
    expect(appendTwo.status).toBe(400);

    // A key that already exists is refused: the dashboard pairs a presented card with its plan row
    // by question_key, so a duplicate makes the founder's card resolve to the wrong (often already
    // answered) row and renders it unanswerable.
    const appendDuplicateKey = await niceBackendFetch(`${AGENT_BASE}/interview-questions`, {
      method: "POST",
      headers: GROWTH_AGENT_AUTH,
      body: {
        ...scope,
        run_id: runId,
        append: true,
        questions: [{ question_key: "primary-goal", prompt: "Primary goal again?", kind: "single", options: [{ id: "a", label: "A" }] }],
      },
    });
    expect(appendDuplicateKey.status).toBe(409);

    const afterAppend = await getInterview();
    expect(afterAppend.body.questions.map((question) => [question.question_key, question.origin])).toEqual([
      ["primary-goal", "planned"],
      ["team-size", "planned"],
      ["signup-source", "adaptive"],
    ]);

    // Once the interview is completed, the stream route refuses further turns (400, not 502: there
    // is nothing left to persist or proxy) and append mode is fenced with a 409.
    const complete = await niceBackendFetch(`${AGENT_BASE}/interview/complete`, {
      method: "POST",
      headers: GROWTH_AGENT_AUTH,
      body: { ...scope, run_id: runId },
    });
    expect(complete.status).toBe(200);
    const streamAfterComplete = await niceBackendFetch(`${ADMIN_BASE}/interview/stream`, {
      accessType: "admin",
      method: "POST",
      body: { answer: { order_index: 1, option_ids: ["solo"] } },
    });
    expect(streamAfterComplete.status).toBe(400);
    const appendAfterComplete = await niceBackendFetch(`${AGENT_BASE}/interview-questions`, {
      method: "POST",
      headers: GROWTH_AGENT_AUTH,
      body: {
        ...scope,
        run_id: runId,
        append: true,
        questions: [{ question_key: "late", prompt: "Too late?", kind: "single", options: [{ id: "x", label: "X" }] }],
      },
    });
    expect(appendAfterComplete.status).toBe(409);
  });

  it("retakes the interview: clears the plan, re-arms the question phase, and keeps the run's findings", { timeout: 300_000 }, async ({ expect }) => {
    await Project.createAndSwitch();
    await Project.updateConfig({ "apps.installed.gtm.enabled": true });
    const clientRetake = await niceBackendFetch(`${ADMIN_BASE}/interview/retake`, { accessType: "client", method: "POST" });
    expect(clientRetake.status).toBe(401);
    // No interview resource yet -> 404, same as the other interview routes.
    const retakeBeforePlan = await niceBackendFetch(`${ADMIN_BASE}/interview/retake`, { accessType: "admin", method: "POST" });
    expect(retakeBeforePlan.status).toBe(404);

    const { scope, runId } = await setUpOnboardedGrowthProject();
    await saveQuestionPlan(scope, runId);
    await releaseGrowthInterviewAsStaff(scope.project_id);

    // Retaking is refused until the run actually awaits the interview.
    const tooEarly = await niceBackendFetch(`${ADMIN_BASE}/interview/retake`, { accessType: "admin", method: "POST" });
    expect(tooEarly.status).toBe(400);

    await driveRunToAwaitingInterview(expect, scope, runId);

    // A finding from the research phases: the whole point of retake is that this survives.
    const finding = await niceBackendFetch(`${AGENT_BASE}/findings`, {
      method: "POST",
      headers: GROWTH_AGENT_AUTH,
      body: {
        ...scope,
        run_id: runId,
        source: "website-research",
        findings: [{ kind: "observation", category: "conversion", tags: ["website"], title: "Homepage has no pricing link", body: "Observed during research." }],
      },
    });
    expect(finding.status).toBe(200);

    // Answer one question so the retake has real state to discard.
    // Eve is unreachable from this file, so the turn 502s — but the answer is persisted first.
    await expect(niceBackendFetch(`${ADMIN_BASE}/interview/stream`, {
      accessType: "admin",
      method: "POST",
      body: { answer: { order_index: 0, option_ids: ["signups"] } },
    })).rejects.toThrow(/API threw ISE.*502/);
    const beforeRetake = await getInterview();
    expect(beforeRetake.body.questions[0]?.answer_option_ids).toEqual(["signups"]);

    const retake = await niceBackendFetch(`${ADMIN_BASE}/interview/retake`, { accessType: "admin", method: "POST" });
    expect(retake).toMatchObject({ status: 200, body: { status: "pending", run_id: runId } });

    // The plan and transcript are gone AND the interview is held again: the replacement plan has not
    // been reviewed, so a retake cannot be used to walk a fresh set of questions past the gate. The
    // customer therefore sees the same 404 they saw before their first plan was released, until the
    // re-armed phase writes a new plan and staff release that one.
    const afterRetake = await getInterview();
    expect(afterRetake.status).toBe(404);

    // The run is running again with the question phase re-armed on a fresh attempt budget, while
    // every other phase stays settled — retake must not re-run research. Integrations is
    // intentionally auto-settled as skipped until its future customer flow is wired up.
    const run = await getRun(runId);
    expect(run.status).toBe("running");
    const questionPhase = run.phases.find((phase) => phase.phase_key === "interview-questions");
    expect(questionPhase).toMatchObject({ status: "pending", attempt: 0 });
    const researchPhases = run.phases.filter((phase) => phase.phase_key !== "interview-questions" && phase.phase_key !== "report");
    expect(researchPhases.every((phase) => phase.status === "completed" || phase.status === "skipped")).toBe(true);

    // The finding is untouched.
    const findings = await niceBackendFetch(`${AGENT_BASE}/context-bundle?project_id=${encodeURIComponent(scope.project_id)}&branch_id=${encodeURIComponent(scope.branch_id)}`, {
      method: "GET",
      headers: GROWTH_AGENT_AUTH,
    });
    expect(findings.status).toBe(200);
    expect(JSON.stringify(findings.body)).toContain("Homepage has no pricing link");

    // Retaking again is refused — as a 404 rather than the "only while awaiting" 400, because the
    // retake the customer just performed put the interview back under the release gate, and that
    // gate is checked before the run status. Either way there is nothing for them to retake.
    const retakeAgain = await niceBackendFetch(`${ADMIN_BASE}/interview/retake`, { accessType: "admin", method: "POST" });
    expect(retakeAgain.status).toBe(404);
  });
});
