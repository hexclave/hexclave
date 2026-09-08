import type { ChannelFrom } from "eve/channels";
import { runAgentSession, SafeRunError, safeMessageFromError } from "#lib/agent-session.ts";
import { getProjectContext, phaseFail, phaseStart } from "#lib/hexclave-client.ts";
import { startPhaseHeartbeat } from "#lib/heartbeat.ts";
import { buildPhaseContinuationToken } from "#lib/phase-continuation.ts";
import { GROWTH_ANALYSIS_TOPICS } from "#lib/analysis-topics.ts";
import type { AnalysisPhaseRunRequest, DailyBriefRunRequest } from "#lib/types.ts";
import { WRITING_STYLE_RULES } from "#lib/writing-style.ts";
import { FOUNDER_INTERVIEW_PROMPT_GUIDANCE, FOUNDER_INTERVIEW_PROMPT_MAX_LENGTH } from "#lib/interview-question.ts";


const MAX_AGENT_SESSION_MS = 45 * 60 * 1000;

const ANALYSIS_TIMEOUT_MESSAGE = "The analysis agent did not finish within the allowed time.";

function genericPhaseFailureMessage(phaseKey: string): string {
  return `The "${phaseKey}" analysis step failed unexpectedly.`;
}

function formatContextForPrompt(context: unknown): string {
  return JSON.stringify(context, null, 2);
}


export const SHARED_PROMPT_RULES = [
  "Rules:",
  "- Never fabricate data. Every number or claim must come from a tool result in this session.",
  "- Persist all results exclusively through the provided save/create tools; your final text reply is discarded.",
  "- Every finding and action item requires exactly one growth stage: product, reach, conversion, retention, or revenue. Product is the core experience; reach includes acquisition, distribution, content, and ads; conversion covers visitor-to-activation work; retention covers repeat use and churn; revenue covers monetization and expansion. Tags are optional; if supplied, tags must be a JSON array of short strings, never a single string.",
  "- Do not take any external side effects.",
  "- Paid acquisition: you never launch, publish, pause, or spend anything, and you have no tool that could — the most you can do is propose a campaign in a run_ads action item for a human to act on. Never write or imply that an ad is running, was launched, or spent money. Always state any ad budget with its currency spelled out (e.g. \"$30/day (USD)\", never a bare number). You also cannot read a project's ad account, so never present ad performance numbers: if you have no tool result for a number, you do not have the number.",
  "",
  WRITING_STYLE_RULES,
].join("\n");

function buildPhasePrompt(input: AnalysisPhaseRunRequest, projectContextJson: string): string {
  const header = [
    `You are running the "${input.phase_key}" phase of growth analysis run ${input.run_id} for project ${input.project_id} (branch ${input.branch_id}).`,
    "",
    "Stored project context:",
    "```json",
    projectContextJson,
    "```",
    "",
  ].join("\n");
  switch (input.phase_key) {
    case "website-research": {
      return header + [
        "Delegate this phase to the `website-research` subagent by calling its tool exactly once. Your task message to it must include:",
        `- project_id: ${input.project_id}`,
        `- branch_id: ${input.branch_id}`,
        `- run_id: ${input.run_id}`,
        "- The website URL and product context from the stored project context above.",
        "- Its goal: research the project's website and competitors, then persist findings and a crawl summary artifact through its own tools.",
        "After the subagent returns, verify from its result that it saved findings; if it reports that it could not, relay its stated reason in your reply and stop.",
        "",
        SHARED_PROMPT_RULES,
      ].join("\n");
    }
    case "data-analysis": {
      return header + [
        "Delegate this phase to the `data-analyst` subagent by calling its tool exactly once. Your task message to it must include:",
        `- project_id: ${input.project_id}`,
        `- branch_id: ${input.branch_id}`,
        `- run_id: ${input.run_id}`,
        "- Relevant product context from above (what the product is, what activation likely looks like).",
        "- Its goal: mine the project's analytics data for growth patterns and persist metric baselines and data insights through its own tools.",
        "- That it must ALSO look for movement over time — metrics trending up or down across weeks, recurring weekly or seasonal shapes, a channel gaining or losing share, step changes with a visible before and after, cohorts behaving differently from earlier ones — and record each one with `save-notes`, citing the numbers at both ends of the window. Its instructions cover how; your job is to ask for it explicitly so it is not skipped.",
        "After the subagent returns, verify from its result that it saved findings; if it reports that it could not, relay its stated reason in your reply and stop.",
        "",
        SHARED_PROMPT_RULES,
      ].join("\n");
    }
    case "interview-questions": {
      // Owned by the root agent, not delegated: no `interview-generator` subagent is declared
      // (eve 0.27 cannot mirror a child's tool events into the parent stream, which the live
      // interview turns depend on — see run-interview.ts). The framing block below is
      // load-bearing: "customer interview" is a growth term of art meaning "interview your
      // buyers about why they bought", and the model previously read it that way and asked the
      // founder why they picked Hexclave over competing auth vendors. The interviewee is the
      // person who BUILT the researched product; Hexclave is only the platform running this.
      return header + [
        "Design this run's founder interview and save it yourself. Do not delegate this phase.",
        "",
        "WHO YOU ARE INTERVIEWING: the founder or operator of the product at the website in the stored project context above. They built that product; you are interviewing them to understand their business well enough that the growth report actually fits it.",
        "NEVER ask why they chose Hexclave, how they compare it to other vendors, or which Hexclave features they use. Hexclave is the platform running this analysis, never the subject of a question. Every question is about THEIR product, market, and customers.",
        "",
        "Steps:",
        "1. Call `get-context-bundle` exactly once to read what the research phases already found.",
        `2. Design 5-7 questions targeting the biggest gaps between what the research could observe and what the report needs. ${FOUNDER_INTERVIEW_PROMPT_GUIDANCE} Keep the complete prompt at or below ${FOUNDER_INTERVIEW_PROMPT_MAX_LENGTH} characters and ask only one thing.`,
        "3. Make the evidence anchor specific enough that the founder can recognize their product. Prefer \"Search visitors activated at 18%, twice the project average. What makes those visitors different?\" over \"What are your best acquisition channels?\" Use 3-5 short options grounded in the observed evidence and plausible alternatives. Always make the final option { id: \"other\", label: \"Other\" }; the UI asks for text when it is selected.",
        "4. Call `save-interview-questions` exactly once with the complete ordered plan.",
        "",
        SHARED_PROMPT_RULES,
      ].join("\n");
    }
    case "report": {
      return header + [
        "1. Delegate this phase to the `report-composer` subagent by calling its tool exactly once. Your task message to it must include:",
        `- project_id: ${input.project_id}`,
        `- branch_id: ${input.branch_id}`,
        `- run_id: ${input.run_id}`,
        "- Relevant product context from above.",
        "- Its goal: read the run's accumulated context and interview answers, compose the final growth report, persist it (with 2-5 action items), and then score all 5 growth stages 0-100 with `save-category-scores` — both through its own tools.",
        "- That the scoring call is required, not optional: until it lands, every stage on the customer's overview reads \"Not scored\".",
        "After the subagent returns, verify from its result that it saved BOTH the report and the category scores; if it reports that it could not do either, relay its stated reason in your reply and stop.",
        "",
        SHARED_PROMPT_RULES,
      ].join("\n");
    }
    default: {
      if (input.phase_key.startsWith("analysis:")) {
        const topicId = input.phase_key.slice("analysis:".length);
        const topic = GROWTH_ANALYSIS_TOPICS.get(topicId);
        if (topic == null) {
          throw new SafeRunError(`Unknown growth analysis topic "${topicId}". The analysis plan references an analysis topic this agent version does not ship.`);
        }
        return header + [
          `Your task: execute the "${topic.title}" growth analysis topic.`,
          `1. Load the \`${topic.skillName}\` skill with the \`load_skill\` tool and follow it exactly.`,
          "2. Call `get-context-bundle` first to ground yourself in what the run has already gathered.",
          "3. Persist your results through the tools the skill names (`save-finding`, `save-artifact`, ...).",
          "4. If anything you looked at has a time dimension, also record the movement with `save-note` — a note is how something has been MOVING over a window (with the numbers at both ends), as opposed to a finding, which is what is true now. Skip this when the topic produced nothing time-varying; never manufacture a trend to have one.",
          "",
          SHARED_PROMPT_RULES,
        ].join("\n");
      }
      throw new SafeRunError(`Unknown analysis phase "${input.phase_key}". The analysis plan references a phase this agent version does not implement.`);
    }
  }
}


export async function executeAnalysisPhase(input: AnalysisPhaseRunRequest, helpers: { readonly from: ChannelFrom }): Promise<void> {
  await phaseStart(input);
  const stopHeartbeat = startPhaseHeartbeat(input);
  try {
    const projectContext = await getProjectContext({ project_id: input.project_id, branch_id: input.branch_id });
    // Keep the waitUntil task attached to the durable Eve session. Merely sending the task and
    // returning leaves no process lifetime in which to heartbeat, so the backend can reap a healthy
    // phase while the report composer is still working. Terminal channel hooks remain the single
    // source of phase completion; this follower owns liveness, timeouts, and failure reporting.
    await runAgentSession({
      from: helpers.from,
      maxSessionMs: MAX_AGENT_SESSION_MS,
      timeoutMessage: ANALYSIS_TIMEOUT_MESSAGE,
      message: buildPhasePrompt(input, formatContextForPrompt(projectContext)),
      context: {
        project_id: input.project_id,
        branch_id: input.branch_id,
        run_id: input.run_id,
        phase_key: input.phase_key,
        finding_source: input.phase_key,
        agent_token: input.agent_token,
      },
      continuationToken: buildPhaseContinuationToken(input),
      title: `Growth analysis: ${input.phase_key} (run ${input.run_id})`,
    });
  } catch (error) {
    console.error(`[growth-agent] analysis phase failed: run=${input.run_id} phase=${input.phase_key} attempt=${input.attempt}`, error);
    await phaseFail({ ...input, error_message: safeMessageFromError(error, genericPhaseFailureMessage(input.phase_key)) });
  } finally {
    stopHeartbeat();
  }
}


export async function executeDailyBrief(input: DailyBriefRunRequest, helpers: { readonly from: ChannelFrom }): Promise<void> {
  const message = [
    `Write today's growth brief (date ${input.date}, UTC) for project ${input.project_id} (branch ${input.branch_id}).`,
    "",
    "1. Call `get-metrics` for the current metric series and `get-context-bundle` for project context, recent findings, and the latest report.",
    "2. Compute nothing yourself beyond reading those tool results; every number in the brief must appear in them.",
    "   - If a number looks surprising, you may spot-check it against the stored per-day metric table (`growth_daily_metrics`) with one small `sql-query` — `get-metrics-context` documents what it contains.",
    "3. Save the brief with a single `save-brief` call:",
    "   - `summary`: 1-3 sentences a founder can read in ten seconds — lead with the most notable change.",
    "   - `content_md`: a legacy markdown copy of the brief.",
    "   - `document`: the primary growth-mdx-v1 brief, led by useful charts and short takeaways; include evidence, honest uncertainty, and at most one suggested focus.",
    "   - `data`: machine-readable key numbers you cited — the dashboard renders these later.",
    "Then stop.",
    "",
    SHARED_PROMPT_RULES,
  ].join("\n");
  await runAgentSession({
    from: helpers.from,
    maxSessionMs: MAX_AGENT_SESSION_MS,
    timeoutMessage: ANALYSIS_TIMEOUT_MESSAGE,
    message,
    context: {
      project_id: input.project_id,
      branch_id: input.branch_id,
      brief_date: input.date,
      finding_source: "daily-brief",
      agent_token: input.agent_token,
    },
    continuationToken: `brief:${input.brief_id}`,
    title: `Growth daily brief ${input.date}`,
  });
}
