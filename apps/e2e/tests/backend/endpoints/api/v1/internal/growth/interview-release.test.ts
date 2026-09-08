import { describe } from "vitest";
import { it } from "../../../../../../helpers";
import { Auth, InternalProjectKeys, backendContext, niceBackendFetch } from "../../../../../backend-helpers";
import { GROWTH_AGENT_AUTH, asGrowthStaff, createGrowthProject, requireRunId } from "./growth-helpers";

const GROWTH_BASE = "/api/latest/internal/growth";
const ADMIN_BASE = "/api/latest/internal/growth/admin";
const AGENT_BASE = "/api/latest/internal/growth-agent";

/**
 * The release gate: an interview's question plan is written by the analysis but withheld from the
 * customer until a Hexclave staff member has read it. This is the ONLY human gate left in the growth
 * lifecycle; report review and release are covered separately in report-release.test.ts.
 *
 * Seeding "plays the agent" with the shared machine secret: question plans have no customer-facing
 * write API, so that is the only way one comes into existence. The run is deliberately left RUNNING
 * rather than driven to AWAITING_INTERVIEW — every assertion here is about who may see the plan,
 * which the run's status has no say in, and driving it needs the orchestration choreography that
 * interview.test.ts owns.
 *
 * Every test batches its staff work into a single asGrowthStaff block. Entering one signs up a fresh
 * platform admin and adds them to the owner team, which is several round trips; doing that per
 * request is what pushed an earlier version of this suite past the default timeout.
 */

type AdminInterviewQuestion = {
  id: string,
  order_index: number,
  question_key: string,
  prompt: string,
  allow_skip: boolean,
  options: { id: string, label: string, description: string | null }[],
  answer_option_ids: string[] | null,
  answer_free_text: string | null,
  answered_at_millis: number | null,
};

type AdminInterviewBody = {
  interview: {
    id: string,
    run_id: string,
    status: string,
    released_at_millis: number | null,
    released_by_user_id: string | null,
    questions: AdminInterviewQuestion[],
  },
};

type CustomerInterviewBody = {
  status: string,
  questions: {
    question_key: string,
    prompt: string,
    allow_skip: boolean,
    options: { id: string, label: string, description: string | null }[],
  }[],
  messages: unknown[],
};

async function seedHeldPlan() {
  const keys = await createGrowthProject();
  if (keys === "no-project") throw new Error("The interview release test requires a fresh project.");
  const scope = { project_id: keys.projectId, branch_id: "main" };

  const onboarding = await niceBackendFetch(`${GROWTH_BASE}/onboarding`, {
    accessType: "admin",
    method: "POST",
    body: { website_url: "https://interview-gate.example.com", company_summary: "Interview gate fixture" },
  });
  if (onboarding.status !== 200) throw new Error(`Growth onboarding failed with ${onboarding.status}.`);
  const runId = requireRunId(onboarding.body);

  const plan = await niceBackendFetch(`${AGENT_BASE}/interview-questions`, {
    method: "POST",
    headers: GROWTH_AGENT_AUTH,
    body: {
      ...scope,
      run_id: runId,
      questions: [
        {
          question_key: "primary-goal",
          prompt: "Which growth outcome should the next quarter prioritize?",
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
  if (plan.status !== 200) throw new Error(`Saving the question plan failed with ${plan.status}.`);
  return { projectId: keys.projectId, scope, runId };
}

// The three staff calls under test. All must run inside an asGrowthStaff block.
const staffCalls = {
  readInterview: async (projectId: string) => await niceBackendFetch(`${ADMIN_BASE}/interview?project_id=${projectId}`, { accessType: "client" }),
  release: async (projectId: string) => await niceBackendFetch(`${ADMIN_BASE}/interview/release`, {
    accessType: "client",
    method: "POST",
    body: { target_project_id: projectId },
  }),
  editQuestion: async (projectId: string, questionId: string, body: { prompt: string, options: { id: string, label: string, description?: string }[], allow_skip: boolean }) =>
    await niceBackendFetch(`${ADMIN_BASE}/interview/questions/${questionId}`, {
      accessType: "client",
      method: "PATCH",
      body: { target_project_id: projectId, ...body },
    }),
  deleteQuestion: async (projectId: string, questionId: string) => await niceBackendFetch(`${ADMIN_BASE}/interview/questions/${questionId}`, {
    accessType: "client",
    method: "DELETE",
    body: { target_project_id: projectId },
  }),
};

async function readCustomerInterview(): Promise<{ status: number, body: CustomerInterviewBody }> {
  const response = await niceBackendFetch(`${GROWTH_BASE}/interview`, { accessType: "admin" });
  return { status: response.status, body: response.body as CustomerInterviewBody };
}

describe("internal Growth interview release", () => {
  it("withholds the whole interview from the customer until staff release it", { timeout: 300_000 }, async ({ expect }) => {
    const { projectId } = await seedHeldPlan();

    // Every customer route that reaches the plan. All 404 rather than 403: to the customer, a plan
    // nobody has read must be indistinguishable from one that has not been generated — a 403 would
    // tell them questions exist and are being withheld, which is not a state they can act on.
    const heldGet = await readCustomerInterview();
    expect(heldGet.status).toBe(404);
    const heldSkip = await niceBackendFetch(`${GROWTH_BASE}/interview/skip`, { accessType: "admin", method: "POST" });
    expect(heldSkip.status).toBe(404);
    const heldRetake = await niceBackendFetch(`${GROWTH_BASE}/interview/retake`, { accessType: "admin", method: "POST" });
    expect(heldRetake.status).toBe(404);
    const heldStream = await niceBackendFetch(`${GROWTH_BASE}/interview/stream`, {
      accessType: "admin",
      method: "POST",
      body: { answer: { order_index: 0, option_ids: ["signups"] } },
    });
    expect(heldStream.status).toBe(404);

    const released = await asGrowthStaff(async () => await staffCalls.release(projectId));
    expect(released.status).toBe(200);

    const customer = await readCustomerInterview();
    expect(customer.status).toBe(200);
    expect(customer.body).toMatchObject({ status: "pending", messages: [] });
    expect(customer.body.questions.map((question) => question.question_key)).toEqual(["primary-goal", "team-size"]);
  });

  it("shows staff the held plan, and records who released it", { timeout: 300_000 }, async ({ expect }) => {
    const { projectId } = await seedHeldPlan();

    await asGrowthStaff(async () => {
      const held = await staffCalls.readInterview(projectId);
      expect(held.status).toBe(200);
      expect((held.body as AdminInterviewBody).interview).toMatchObject({
        status: "pending",
        released_at_millis: null,
        released_by_user_id: null,
      });
      expect((held.body as AdminInterviewBody).interview.questions.map((question) => question.question_key))
        .toEqual(["primary-goal", "team-size"]);
      expect((held.body as AdminInterviewBody).interview.questions[0]).toMatchObject({
        answer_option_ids: null,
        answer_free_text: null,
        answered_at_millis: null,
      });

      const released = await staffCalls.release(projectId);
      expect(released.status).toBe(200);
      expect((released.body as AdminInterviewBody).interview.released_at_millis).toEqual(expect.any(Number));
      // Attributed to the reviewer who pressed the button — an audit trail the customer never sees,
      // but the whole point of having a human in the loop.
      expect((released.body as AdminInterviewBody).interview.released_by_user_id).toEqual(expect.any(String));

      // Releasing twice is a stale second tab — 409, not a silent re-release with a new timestamp.
      const again = await staffCalls.release(projectId);
      expect(again.status).toBe(409);
    });
  });

  it("lets staff rewrite a held plan, and the customer gets the edited version", { timeout: 300_000 }, async ({ expect }) => {
    const { projectId } = await seedHeldPlan();

    await asGrowthStaff(async () => {
      const held = await staffCalls.readInterview(projectId);
      const [first, second] = (held.body as AdminInterviewBody).interview.questions;

      const edited = await staffCalls.editQuestion(projectId, first.id, {
        prompt: "Which outcome matters most for the next quarter?",
        options: [{ id: "signups", label: "Signups" }, { id: "revenue", label: "Revenue", description: "Expansion included" }],
        allow_skip: true,
      });
      expect(edited.status).toBe(200);

      // Dropping a weak question re-packs the order indices, so the survivor becomes index 0.
      const deleted = await staffCalls.deleteQuestion(projectId, second.id);
      expect(deleted.status).toBe(200);
      expect((deleted.body as AdminInterviewBody).interview.questions).toMatchObject([{ id: first.id, order_index: 0 }]);

      // A plan needs at least one question: emptying it would release an interview with nothing to
      // ask, so the last one is refused and the reviewer is pointed at regenerate instead.
      const lastOne = await staffCalls.deleteQuestion(projectId, first.id);
      expect(lastOne.status).toBe(400);

      expect((await staffCalls.release(projectId)).status).toBe(200);
    });

    const customer = await readCustomerInterview();
    expect(customer.status).toBe(200);
    expect(customer.body.questions).toHaveLength(1);
    expect(customer.body.questions[0]).toMatchObject({
      question_key: "primary-goal",
      prompt: "Which outcome matters most for the next quarter?",
      allow_skip: true,
    });
    // Staff omitted Other in the edit, so the released customer copy preserves that choice.
    expect(customer.body.questions[0].options.map((option) => option.id)).toEqual(["signups", "revenue"]);
  });

  it("refuses every edit once the plan is the customer's", { timeout: 300_000 }, async ({ expect }) => {
    const { projectId } = await seedHeldPlan();

    await asGrowthStaff(async () => {
      const held = await staffCalls.readInterview(projectId);
      const [first, second] = (held.body as AdminInterviewBody).interview.questions;
      expect((await staffCalls.release(projectId)).status).toBe(200);

      // 409 rather than 403: the reviewer had the right to edit this a moment ago, and the reason
      // they no longer do is that the customer may already be part-way through answering it.
      // Rewording a question under them would change what their answer to it means.
      const edit = await staffCalls.editQuestion(projectId, first.id, {
        prompt: "Too late to reword this.",
        options: [{ id: "signups", label: "Signups" }],
        allow_skip: false,
      });
      expect(edit.status).toBe(409);
      expect((await staffCalls.deleteQuestion(projectId, second.id)).status).toBe(409);
    });

    // The plan the customer sees is untouched by the refused edits.
    const customer = await readCustomerInterview();
    expect(customer.body.questions.map((question) => question.question_key)).toEqual(["primary-goal", "team-size"]);
  });

  it("rejects malformed ids and other projects' questions with the same clean 404", { timeout: 300_000 }, async ({ expect }) => {
    const other = await seedHeldPlan();
    const otherQuestionId = await asGrowthStaff(async () => {
      const response = await staffCalls.readInterview(other.projectId);
      return (response.body as AdminInterviewBody).interview.questions[0].id;
    });

    const { projectId } = await seedHeldPlan();
    // A project that never onboarded has no plan to review at all. Created up front so the whole
    // staff batch below runs under one sign-up.
    const fresh = await createGrowthProject();
    if (fresh === "no-project") throw new Error("createGrowthProject should have switched the context.");

    await asGrowthStaff(async () => {
      for (const questionId of ["not-a-uuid", otherQuestionId]) {
        // A malformed id would otherwise reach Postgres as a bad uuid cast (a 500), and a foreign id
        // must not be distinguishable from a missing one, or ids from other projects could be probed.
        const response = await staffCalls.deleteQuestion(projectId, questionId);
        expect([questionId, response.status]).toEqual([questionId, 404]);
      }
      expect((await staffCalls.readInterview(fresh.projectId)).status).toBe(404);
    });
  });

  it("refuses every admin interview route for a signed-in user who is not a platform admin", { timeout: 300_000 }, async ({ expect }) => {
    const { projectId } = await seedHeldPlan();
    const questionId = await asGrowthStaff(async () => {
      const response = await staffCalls.readInterview(projectId);
      return (response.body as AdminInterviewBody).interview.questions[0].id;
    });

    // The internal project's publishable key is public, so "signed into internal" must never be
    // enough to read — let alone release — another company's interview.
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
    await Auth.fastSignUp();
    for (const [label, path, init] of [
      ["GET interview", `${ADMIN_BASE}/interview?project_id=${projectId}`, {}],
      ["release", `${ADMIN_BASE}/interview/release`, { method: "POST", body: { target_project_id: projectId } }],
      ["regenerate", `${ADMIN_BASE}/interview/regenerate`, { method: "POST", body: { target_project_id: projectId } }],
      ["delete question", `${ADMIN_BASE}/interview/questions/${questionId}`, { method: "DELETE", body: { target_project_id: projectId } }],
      ["edit question", `${ADMIN_BASE}/interview/questions/${questionId}`, {
        method: "PATCH",
        body: { target_project_id: projectId, prompt: "Nope.", options: [{ id: "a", label: "A" }], allow_skip: false },
      }],
    ] as const) {
      const response = await niceBackendFetch(path, { accessType: "client", ...init });
      expect([label, response.status]).toEqual([label, 403]);
    }

    // And the plan is still held afterwards — none of those requests half-applied.
    const still = await asGrowthStaff(async () => await staffCalls.readInterview(projectId));
    expect((still.body as AdminInterviewBody).interview.released_at_millis).toBeNull();
  });
});
