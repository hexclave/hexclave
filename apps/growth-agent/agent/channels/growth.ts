import { POST, defineChannel, type ChannelFrom } from "eve/channels";
import { z } from "zod";
import { verifyGrowthAgentBearer } from "#lib/auth.ts";
import { executeAnalysisPhase, executeDailyBrief } from "#lib/run-analysis-phase.ts";
import { executeBlogDraft } from "#lib/run-blog-draft.ts";
import { executeChatTurn } from "#lib/run-chat.ts";
import { executeInterviewTurn } from "#lib/run-interview.ts";
import { executeQuizAuthoring } from "#lib/run-quiz.ts";
import { settleGrowthPhaseFromTerminalEvent } from "#lib/phase-settlement.ts";


const projectRefSchema = z.object({
  project_id: z.string().min(1),
  branch_id: z.string().min(1),

  agent_token: z.string().min(1).optional(),
});


const analysisPhaseRunRequestSchema = projectRefSchema.extend({
  run_id: z.string().min(1),
  phase_key: z.string().min(1),
  attempt: z.number().int().nonnegative(),
});

const dailyBriefRunRequestSchema = projectRefSchema.extend({
  brief_id: z.string().min(1),
  date: z.string().min(1),
});


// Mirrors the body the backend's streamGrowthChatTurn proxy sends
// (apps/backend/src/lib/growth/chat.ts). The transcript is opaque prompt
// context; turn_id is the backend-generated per-request session token seed
// (see ChatTurnRequest in run-chat.ts).
const chatTurnRequestSchema = projectRefSchema.extend({
  turn_id: z.string().min(1),
  transcript: z.array(z.unknown()).min(1),
});

// Mirrors the body the backend's generateGrowthBlogDraft sends
// (apps/backend/src/lib/growth/blog-drafts.ts). No agent_token: this session
// calls no backend routes, so it holds no capability at all.
const blogDraftRequestSchema = projectRefSchema.extend({
  action_item_id: z.string().min(1),
  action_title: z.string(),
  action_description: z.string(),
  blog_idea: z.object({
    title: z.string().min(1),
    target_intent: z.string().nullable(),
    aeo_angle: z.string().nullable(),
    outline_summary: z.string().nullable(),
  }),
  product: z.object({
    website_url: z.string().nullable(),
    company_summary: z.string().nullable(),
    additional_notes: z.string().nullable(),
  }),
});

// Mirrors the body the backend's streamGrowthInterviewTurn proxy sends
// (apps/backend/src/lib/growth/interview.ts). Transcript and questions are
// opaque prompt context here — the backend owns their shapes.
const interviewTurnRequestSchema = projectRefSchema.extend({
  run_id: z.string().min(1),
  transcript: z.array(z.unknown()),
  questions: z.array(z.unknown()),
});

// Mirrors the body the backend's authorQuizQuestions sends
// (apps/backend/src/lib/growth/games/quiz-agent.ts). Note what is NOT here: no
// true values and no answer options. The backend computed those from real
// metric rows and keeps using its own copy — this session only supplies
// wording, and is not given anything it could leak.
const quizAuthoringRequestSchema = projectRefSchema.extend({
  round_id: z.string().min(1),
  product: z.object({
    website_url: z.string().nullable(),
    company_summary: z.string().nullable(),
    additional_notes: z.string().nullable(),
  }),
  facts: z.array(z.object({
    fact_id: z.string().min(1),
    metric_label: z.string().min(1),
    metric_description: z.string(),
    kind: z.string().min(1),
    unit: z.string().min(1),
    default_text: z.string().min(1),
  })).min(1),
});

/**
 * Runs a dispatched execution in the background. This is the detachment
 * boundary for the whole run, so a catch-all here is deliberate: nothing
 * above us can observe the promise anymore, and an escaped rejection would
 * otherwise crash the server process. The execute functions own reporting
 * their failures to the backend (phase fail); an error reaching this catch
 * means even that reporting failed (or the run kind has no failure endpoint,
 * like daily briefs), so logging is the only remaining escalation path.
 */
async function runDetached(label: string, execute: () => Promise<void>): Promise<void> {
  try {
    await execute();
  } catch (error) {
    console.error(`[growth-agent] run failed and could not be reported to the backend: ${label}`, error);
  }
}

function createRunRoute<TInput>(path: string, label: (input: TInput) => string, schema: z.ZodType<TInput>, execute: (input: TInput, helpers: { readonly from: ChannelFrom }) => Promise<void>) {
  return POST(path, async (req, { from, waitUntil }) => {
    const auth = verifyGrowthAgentBearer(req);
    if (!auth.ok) return auth.response;
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ error: "Invalid request body", details: z.treeifyError(parsed.error) }, { status: 400 });
    }
    waitUntil(runDetached(label(parsed.data), () => execute(parsed.data, { from })));
    return Response.json({ accepted: true });
  });
}

const SESSION_FAILED_PHASE_MESSAGE = "The analysis step failed unexpectedly.";

export default defineChannel({
  events: {
    "session.completed": async (_data, channel) => {
      await settleGrowthPhaseFromTerminalEvent(channel, null);
    },
    "session.failed": async (data, channel) => {
      console.error(`[growth-agent] session failed: session=${data.sessionId} code=${data.code} message=${data.message}`);
      await settleGrowthPhaseFromTerminalEvent(channel, SESSION_FAILED_PHASE_MESSAGE);
    },
  },
  routes: [
    createRunRoute("/runs/analysis-phase", (input) => `run=${input.run_id} phase=${input.phase_key}`, analysisPhaseRunRequestSchema, executeAnalysisPhase),
    createRunRoute("/runs/daily-brief", (input) => `brief=${input.brief_id} date=${input.date}`, dailyBriefRunRequestSchema, executeDailyBrief),
    // Unlike the run routes, /interview is SYNCHRONOUS (no waitUntil): the backend proxy awaits the
    // completed turn and relays the returned assistant UIMessage to the dashboard as a UI message
    // chunk stream (v1 non-streamed adaptation — see run-interview.ts / the backend's
    // streamGrowthInterviewTurn). Errors return a generic 500; the backend maps any non-2xx or
    // malformed body to its retryable 502, and the customer's answer was already persisted there.
    POST("/interview", async (req, { from }) => {
      const auth = verifyGrowthAgentBearer(req);
      if (!auth.ok) return auth.response;
      const parsed = interviewTurnRequestSchema.safeParse(await req.json());
      if (!parsed.success) {
        return Response.json({ error: "Invalid request body", details: z.treeifyError(parsed.error) }, { status: 400 });
      }
      try {
        return Response.json(await executeInterviewTurn(parsed.data, { from }));
      } catch (error) {
        // Deliberate catch-all at the HTTP boundary: the error must not leak internals to the
        // response, and there is no backend failure endpoint for interview turns — logging plus the
        // backend's 502 mapping is the whole failure story.
        console.error(`[growth-agent] interview turn failed: run=${parsed.data.run_id}`, error);
        return Response.json({ error: "Interview turn failed" }, { status: 500 });
      }
    }),
    // Synchronous like /interview: a human is waiting on a "Generate draft" button, and the backend
    // stores the returned markdown itself — so there is no phase row, no polling, and nothing
    // half-written to reconcile when it fails. See run-blog-draft.ts for why the post is written
    // here on demand instead of inside the SEO analysis phase.
    POST("/blog-draft", async (req, { from }) => {
      const auth = verifyGrowthAgentBearer(req);
      if (!auth.ok) return auth.response;
      const parsed = blogDraftRequestSchema.safeParse(await req.json());
      if (!parsed.success) {
        return Response.json({ error: "Invalid request body", details: z.treeifyError(parsed.error) }, { status: 400 });
      }
      try {
        return Response.json(await executeBlogDraft(parsed.data, { from }));
      } catch (error) {
        // Deliberate catch-all at the HTTP boundary: the error must not leak internals to the
        // response. The backend maps any non-2xx to a customer-visible "try again", and nothing was
        // persisted, so the action item still shows its idea.
        console.error(`[growth-agent] blog draft failed: action_item=${parsed.data.action_item_id}`, error);
        return Response.json({ error: "Blog draft generation failed" }, { status: 500 });
      }
    }),
    // Synchronous like /blog-draft: a human is waiting on the "Play" button, and the backend stores
    // the returned wording itself. A failure here is NOT fatal to the round — the backend falls back
    // to its own deterministic question text and records textSource: "template" — so the generic 500
    // below is the whole failure story on this side.
    POST("/quiz", async (req, { from }) => {
      const auth = verifyGrowthAgentBearer(req);
      if (!auth.ok) return auth.response;
      const parsed = quizAuthoringRequestSchema.safeParse(await req.json());
      if (!parsed.success) {
        return Response.json({ error: "Invalid request body", details: z.treeifyError(parsed.error) }, { status: 400 });
      }
      try {
        return Response.json(await executeQuizAuthoring(parsed.data, { from }));
      } catch (error) {
        // Deliberate catch-all at the HTTP boundary: the error must not leak internals to the
        // response, and the backend treats any non-2xx as "use the template wording".
        console.error(`[growth-agent] quiz authoring failed: round=${parsed.data.round_id}`, error);
        return Response.json({ error: "Quiz authoring failed" }, { status: 500 });
      }
    }),
    // Synchronous like /interview: the backend awaits the completed chat turn and synthesizes the
    // dashboard's UI chunk stream from the returned assistant UIMessage (see run-chat.ts). Errors
    // return a generic 500; the backend maps any non-2xx or malformed body to its retryable 502,
    // and nothing has been persisted on the backend at that point (persist-after-proxy — the
    // opposite of the interview's answer-first rule; see streamGrowthChatTurn).
    POST("/chat", async (req, { from }) => {
      const auth = verifyGrowthAgentBearer(req);
      if (!auth.ok) return auth.response;
      const parsed = chatTurnRequestSchema.safeParse(await req.json());
      if (!parsed.success) {
        return Response.json({ error: "Invalid request body", details: z.treeifyError(parsed.error) }, { status: 400 });
      }
      try {
        return Response.json(await executeChatTurn(parsed.data, { from }));
      } catch (error) {
        // Deliberate catch-all at the HTTP boundary: the error must not leak internals to the
        // response; logging plus the backend's 502 mapping is the whole failure story.
        console.error(`[growth-agent] chat turn failed: project=${parsed.data.project_id} turn=${parsed.data.turn_id}`, error);
        return Response.json({ error: "Chat turn failed" }, { status: 500 });
      }
    }),
  ],
});
