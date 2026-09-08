import type { AdminWorkflow } from "@hexclave/next";
import type { GrowthPublishedQuiz, GrowthQuizQuestion, GrowthQuizRound } from "./games/growth-games-types";
import type { GrowthDocument } from "./growth-document";
import type { GrowthPhase } from "./growth-status";
import type { GrowthActionItem, GrowthAdsBody, GrowthAnalysisStep, GrowthBrief, GrowthComputeMetrics, GrowthIntegrations, GrowthInterview, GrowthInterviewQuestion, GrowthMilestone, GrowthOverview, GrowthPublishedCategoryPage, GrowthReport, GrowthStatus } from "./growth-types";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const GROWTH_DEMO_NOW_MILLIS = new Date("2026-08-04T12:00:00.000Z").getTime();

// The fictional customer behind every fixture: "Plannery", a small project-management SaaS. Keeping one
// coherent company across all demo states makes the lifecycle read as a single story when switching phases.
const DEMO_WEBSITE_URL = "https://plannery.example.com";

/**
 * The status endpoint's orchestration block for the demo workspace. Healthy by default (both
 * canonical workflows exist, unedited, nothing failing) so the overview shows no pipeline notice;
 * while analyzing, the analysis workflow reports an in-flight run — the one state a demo user can
 * actually observe live.
 */
function demoOrchestration(analysisRunning: boolean): GrowthStatus["orchestration"] {
  return {
    workflows: [
      { workflowId: "growth-analysis", exists: true, edited: false, activeWorkflowRunState: analysisRunning ? "running" : null, lastFailedRunSummary: null },
      { workflowId: "growth-daily-brief", exists: true, edited: false, activeWorkflowRunState: null, lastFailedRunSummary: null },
    ],
  };
}

// A representative label list for the demo compute-metrics block. Deliberately decoupled from the
// real backend catalog (like every other fixture): hardcoding ~10 plausible labels keeps demo mode
// buildable without importing backend code, at the cost of drifting from the live catalog — fine,
// since demo mode's job is to show the shape of the experience, not real data.
const DEMO_COMPUTE_METRIC_LABELS = [
  "Total users",
  "New users",
  "Daily active users",
  "Monthly active users",
  "Retained users",
  "Page views",
  "Visitors",
  "Emails created",
  "Revenue",
  "Active subscriptions",
];

function demoComputeMetrics(state: GrowthComputeMetrics["state"]): GrowthComputeMetrics {
  return { state, metricLabels: DEMO_COMPUTE_METRIC_LABELS };
}

/**
 * The integrations step's demo block. "connected" in the settled fixtures (the demo story has the
 * user having continued past this step); "pending" while analyzing,
 * because the analyzing fixture deliberately keeps compute-metrics running (to showcase the ticker)
 * and the real derivation only flips to "waiting" once metrics settle — a "waiting" fixture here
 * would show a state the backend could never produce alongside a running metrics block.
 */
function demoIntegrations(state: GrowthIntegrations["state"]): GrowthIntegrations {
  return { state };
}

function demoSteps(states: GrowthAnalysisStep["state"][]): GrowthAnalysisStep[] {
  // Abridged copies of the real backend descriptions (lib/growth/phases.ts and analysis-topics.ts), so the
  // demo exercises the hover affordance without pretending to be a second source of truth for the wording.
  const labels: [string, string, string][] = [
    // NOTE: the compute-metrics phase is deliberately absent — the backend excludes it from
    // `analysis.steps` (it renders as its own block via `computeMetrics` above the checklist).
    ["website-research", "Website & competitor research", "Reads your landing page and the sites of comparable products to work out how you position yourself and where competitors are stronger. What it finds becomes the outside-in view every later step builds on."],
    ["data-analysis", "Data analysis", "Mines your product analytics for the patterns behind the headline numbers: where signups come from, who activates, and who quietly drops off. It records the baselines that later recommendations are measured against."],
    ["analysis:first-screen-audit", "First-screen audit", "Audits the first screen of your landing page — headline, subheadline and main call to action — against who actually signs up and sticks around. It proposes exact replacement copy rather than vague directions."],
    ["analysis:seo-aeo-strategy", "SEO & AEO strategy", "Works out which search intents you can realistically win, in classic search and in answer engines like AI assistants. Produces a prioritized content plan plus one ready-to-approve blog idea."],
    ["interview-questions", "Interview preparation", "Turns everything the research could not observe from the outside into a short set of questions for you. Each one is grounded in something the analysis actually found, so none of them are generic."],
  ];
  if (states.length !== labels.length) {
    throw new Error(`Demo step fixtures must cover all ${labels.length} steps, got ${states.length}.`);
  }
  return labels.map(([id, label, description], index) => ({ id, label, description, state: states[index] }));
}

/**
 * Deterministic status fixture for each lifecycle phase. Everything is derived from `nowMillis` so the demo
 * reads the same on every load, and each fixture is written so `getGrowthPhase` derives exactly the phase it
 * is named after (asserted by the colocated test).
 */
export function buildGrowthDemoStatus(phase: GrowthPhase, nowMillis: number): GrowthStatus {
  const onboardedAt = nowMillis - 6 * DAY;
  const base: GrowthStatus = {
    onboarding: { completed: true, completedAtMillis: onboardedAt, websiteUrl: DEMO_WEBSITE_URL },
    analysis: {
      state: "completed",
      runId: "00000000-0000-4000-8000-000000000201",
      trigger: "initial",
      startedAtMillis: onboardedAt,
      completedAtMillis: onboardedAt + 2 * HOUR,
      steps: demoSteps(["done", "done", "done", "done", "done"]),
      computeMetrics: demoComputeMetrics("done"),
      integrations: demoIntegrations("connected"),
      errorMessage: null,
    },
    interview: { state: "completed", answeredCount: 8, estimatedTotal: 8 },
    latestReport: {
      id: "00000000-0000-4000-8000-000000000301",
      createdAtMillis: onboardedAt + 4 * HOUR,
      readAtMillis: null,
      trigger: "initial",
      milestoneLabel: null,
    },
    latestBrief: {
      id: "00000000-0000-4000-8000-000000000401",
      date: new Date(nowMillis).toISOString().slice(0, 10),
      createdAtMillis: nowMillis - 5 * HOUR,
    },
    counts: { suggestedActions: 4, activeActions: 5 },
    orchestration: demoOrchestration(false),
    release: { state: "released" },
  };

  switch (phase) {
    case "not-onboarded": {
      return {
        ...base,
        onboarding: { completed: false, completedAtMillis: null, websiteUrl: null },
        analysis: { state: "none", runId: null, trigger: null, startedAtMillis: null, completedAtMillis: null, steps: null, computeMetrics: null, integrations: null, errorMessage: null },
        interview: { state: "not_ready", answeredCount: 0, estimatedTotal: 8 },
        latestReport: null,
        latestBrief: null,
        counts: { suggestedActions: 0, activeActions: 0 },
        release: { state: "not_ready" },
      };
    }
    case "analyzing": {
      return {
        ...base,
        onboarding: { completed: true, completedAtMillis: nowMillis - 2 * HOUR, websiteUrl: DEMO_WEBSITE_URL },
        analysis: {
          state: "running",
          runId: "00000000-0000-4000-8000-000000000201",
          trigger: "initial",
          startedAtMillis: nowMillis - 2 * HOUR,
          completedAtMillis: null,
          steps: demoSteps(["done", "running", "running", "pending", "pending"]),
          // This fixture represents deep analysis itself, after the two setup phases settle, so demo
          // mode exercises the continuous loading state and its embedded interview/report rows.
          computeMetrics: demoComputeMetrics("done"),
          integrations: demoIntegrations("connected"),
          errorMessage: null,
        },
        interview: { state: "not_ready", answeredCount: 0, estimatedTotal: 8 },
        latestReport: null,
        latestBrief: null,
        counts: { suggestedActions: 0, activeActions: 0 },
        release: { state: "preparing" },
        orchestration: demoOrchestration(true),
      };
    }
    case "analysis-failed": {
      return {
        ...base,
        analysis: {
          state: "failed",
          runId: "00000000-0000-4000-8000-000000000201",
          trigger: "initial",
          startedAtMillis: nowMillis - 3 * HOUR,
          completedAtMillis: null,
          steps: demoSteps(["done", "failed", "done", "pending", "pending"]),
          computeMetrics: demoComputeMetrics("done"),
          integrations: demoIntegrations("connected"),
          errorMessage: "The data analysis step ran out of time while scanning your events. Retrying usually resolves this.",
        },
        interview: { state: "not_ready", answeredCount: 0, estimatedTotal: 8 },
        latestReport: null,
        latestBrief: null,
        counts: { suggestedActions: 0, activeActions: 0 },
        release: { state: "not_ready" },
      };
    }
    case "interview": {
      return {
        ...base,
        interview: { state: "in_progress", answeredCount: 3, estimatedTotal: 8 },
        latestReport: null,
        latestBrief: null,
        counts: { suggestedActions: 0, activeActions: 0 },
        release: { state: "preparing" },
      };
    }
    case "report-ready": {
      // The hold. `latestReport: null` is what makes this fixture worth having: with the report
      // withheld until a Hexclave reviewer publishes it, this is the state a real customer sits in
      // for most of a day, and it is the only one that exercises the "check back in about 24 hours"
      // copy on the timeline, the report page and the chat lock. The released-with-a-report case is
      // steady-state below.
      return {
        ...base,
        latestReport: null,
        latestBrief: null,
        counts: { suggestedActions: 4, activeActions: 0 },
        release: { state: "preparing" },
      };
    }
    case "steady-state": {
      return base;
    }
  }
}

// Fixture ids follow one scheme: 02xx = runs, 03xx = reports, 04xx = briefs, 05xx = interview
// questions, 06xx = action items, 07xx = milestones. (Workflows use their slug ids, not UUIDs.)
const DEMO_RUN_ID = "00000000-0000-4000-8000-000000000201";
const DEMO_REPORT_ID = "00000000-0000-4000-8000-000000000301";

function demoId(block: number, index: number): string {
  return `00000000-0000-4000-8000-000000000${block}${String(index).padStart(2, "0")}`;
}

/** ISO date (YYYY-MM-DD, UTC) `daysAgo` full days before `nowMillis`, matching the brief/metric day keys. */
function demoDate(nowMillis: number, daysAgo: number): string {
  return new Date(nowMillis - daysAgo * DAY).toISOString().slice(0, 10);
}

const DEMO_INTERVIEW_QUESTIONS: Omit<GrowthInterviewQuestion, "answerOptionIds" | "answerFreeText" | "answeredAtMillis">[] = [
  {
    questionKey: "primary-goal",
    orderIndex: 0,
    prompt: "Forty-one percent of new Plannery workspaces never create a second project. Which outcome should the next quarter prioritize?",
    kind: "single",
    options: [
      { id: "signups", label: "More signups", description: "Grow the top of the funnel" },
      { id: "revenue", label: "More revenue", description: "Convert and expand existing users" },
      { id: "retention", label: "Better retention", description: "Keep the users you already have" },
      { id: "other", label: "Other", description: null },
    ],
    allowSkip: false,
    origin: "planned",
  },
  {
    questionKey: "target-audience",
    orderIndex: 1,
    prompt: "Plannery's copy speaks to freelancers and small teams, but traffic cannot show which group matters most. Which audience should we treat as the core customer?",
    kind: "multi",
    options: [
      { id: "freelancers", label: "Freelancers", description: null },
      { id: "small-teams", label: "Small teams (2-15)", description: null },
      { id: "agencies", label: "Agencies", description: "Client-facing project work" },
      { id: "other", label: "Other", description: null },
    ],
    allowSkip: false,
    origin: "planned",
  },
  {
    questionKey: "acquisition-channels",
    orderIndex: 2,
    prompt: "Organic search and word of mouth drive most Plannery signups, but channel quality is still unclear. Which source brings users who stick?",
    kind: "multi",
    options: [
      { id: "organic-search", label: "Organic search", description: null },
      { id: "word-of-mouth", label: "Word of mouth", description: null },
      { id: "paid-ads", label: "Paid ads", description: null },
      { id: "communities", label: "Communities & social", description: null },
      { id: "other", label: "Other", description: null },
    ],
    allowSkip: true,
    origin: "planned",
  },
  {
    questionKey: "pricing-model",
    orderIndex: 3,
    prompt: "Plannery's site offers a free start, but the analysis could not confirm the intended upgrade path. Which pricing model should the report treat as intentional?",
    kind: "single",
    options: [
      { id: "freemium", label: "Freemium", description: "Free tier plus paid upgrades" },
      { id: "trial", label: "Free trial", description: "Time-limited full access" },
      { id: "paid-only", label: "Paid only", description: null },
      { id: "other", label: "Other", description: null },
    ],
    allowSkip: true,
    origin: "planned",
  },
  {
    questionKey: "ad-budget",
    orderIndex: 4,
    prompt: "High-intent freelancer searches activate more often than Plannery's average visitor. How much could you spend to test paid search?",
    kind: "single",
    options: [
      { id: "none", label: "No budget", description: null },
      { id: "small", label: "Under $1k/month", description: null },
      { id: "medium", label: "$1k-$5k/month", description: null },
      { id: "other", label: "Other", description: null },
    ],
    allowSkip: true,
    origin: "planned",
  },
  {
    questionKey: "content-capacity",
    orderIndex: 5,
    prompt: "No credible page owns the high-intent Plannery versus TaskHive query. Who could publish one evidence-led comparison each month?",
    kind: "single",
    options: [
      { id: "founder", label: "A founder", description: null },
      { id: "team", label: "A team member", description: null },
      { id: "nobody", label: "Nobody right now", description: null },
      { id: "other", label: "Other", description: null },
    ],
    allowSkip: true,
    origin: "planned",
  },
  {
    questionKey: "churn-drivers",
    orderIndex: 6,
    prompt: "Forty-one percent of new workspaces stop before creating a second project, but events cannot explain why. What reason do those users mention most often?",
    kind: "multi",
    options: [
      { id: "price", label: "Price", description: null },
      { id: "missing-features", label: "Missing features", description: null },
      { id: "onboarding", label: "Hard to get started", description: null },
      { id: "other", label: "Other", description: null },
    ],
    allowSkip: true,
    origin: "adaptive",
  },
  {
    questionKey: "competitor-focus",
    orderIndex: 7,
    prompt: "The research found an open TaskHive comparison query, but search demand does not prove lost deals. Which competitor do you actually lose deals to most often?",
    kind: "single",
    options: [
      { id: "taskhive", label: "TaskHive", description: null },
      { id: "boardly", label: "Boardly", description: null },
      { id: "other", label: "Other", description: null },
    ],
    allowSkip: true,
    origin: "adaptive",
  },
];

// The demo answers for the questions above, in order. First-option-ish picks keep the story plausible.
const DEMO_INTERVIEW_ANSWERS: string[][] = [
  ["signups"],
  ["freelancers", "small-teams"],
  ["organic-search", "word-of-mouth"],
  ["freemium"],
  ["small"],
  ["founder"],
  ["onboarding"],
  ["taskhive"],
];

/**
 * Interview fixture consistent with the status fixture of the same phase: pre-interview phases carry an
 * empty plan ("pending" — questions are generated by the interview-questions analysis step), the
 * interview phase has 3 of 8 answered, and post-interview phases are fully answered.
 */
export function buildGrowthDemoInterview(phase: GrowthPhase, nowMillis: number): GrowthInterview {
  if (phase === "not-onboarded" || phase === "analyzing" || phase === "analysis-failed") {
    return { status: "pending", questions: [], messages: [] };
  }
  const answeredCount = phase === "interview" ? 3 : DEMO_INTERVIEW_QUESTIONS.length;
  const interviewStartedAt = nowMillis - 6 * DAY + 3 * HOUR;
  return {
    status: phase === "interview" ? "active" : "completed",
    questions: DEMO_INTERVIEW_QUESTIONS.map((question, index) => ({
      ...question,
      answerOptionIds: index < answeredCount ? DEMO_INTERVIEW_ANSWERS[index] : null,
      answerFreeText: null,
      answeredAtMillis: index < answeredCount ? interviewStartedAt + index * 2 * 60 * 1000 : null,
    })),
    // The transcript is rendered by the AI SDK; an empty transcript is a valid resumable state and keeps
    // the fixture from depending on the UIMessage shape.
    messages: [],
  };
}

/** The workflow id of the one workflow-bearing demo action (the dormant-user re-engagement email). */
export const GROWTH_DEMO_ACTION_WORKFLOW_ID = "growth-action-dormant-reactivation";

// A plausible one-shot workflow source for the demo automation: runs once when the customer
// activates the item, emailing dormant free users. Purely illustrative — demo mode never deploys.
const DEMO_ACTION_WORKFLOW_SOURCE = `import { workflow, customEvent } from "@hexclave/workflows";

export default workflow({
  id: "${GROWTH_DEMO_ACTION_WORKFLOW_ID}",
  triggers: [customEvent("growth.action.dormant-reactivation")],
  run: async ({ step, hexclaveApp }) => {
    const dormantUsers = await step("find-dormant-users", async () => {
      const users = await hexclaveApp.listUsers({ limit: 200 });
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      return users
        .filter((user) => user.lastActiveAt != null && user.lastActiveAt.getTime() < cutoff)
        .map((user) => user.id);
    });
    for (const userId of dormantUsers) {
      await step(\`send-reengagement-\${userId}\`, async () => {
        await hexclaveApp.sendEmail({
          userIds: [userId],
          subject: "Your Plannery projects miss you",
          html: "<p>Pick up where you left off — your workspace is exactly how you left it.</p>",
        });
      });
    }
    return { emailed: dormantUsers.length };
  },
});
`;

/**
 * A wire-shaped (snake_case) `ad_campaign` proposal, matching the frozen `AdCampaignSpec` — see
 * `apps/dashboard/src/lib/ad-platforms/campaign-spec-types.ts`. `image.asset_id` is a fixture id with
 * no backing bytes (demo mode never calls the real creative-image route), so the review dialog's image
 * preview correctly renders its "image unavailable" fallback rather than a fabricated picture.
 */
function demoAdCampaignSpec(overrides: { accountId?: string } = {}): Record<string, unknown> {
  return {
    spec_version: 1,
    platform: "meta",
    account_id: overrides.accountId ?? "act_1",
    objective: "OUTCOME_TRAFFIC",
    special_ad_categories: [],
    budget: { mode: "daily", amount_minor: 2000, currency: "USD" },
    schedule: { start_at_millis: null, end_at_millis: null },
    targeting: {
      geo: { countries: ["US", "CA"], regions: [], cities: [] },
      age_min: 25,
      age_max: 54,
      genders: null,
      locales: null,
      interests: [{ id: "6003139266461", name: "Freelancing" }],
      advantage_audience: true,
    },
    placements: { mode: "automatic" },
    delivery: { optimization_goal: "LINK_CLICKS", billing_event: "LINK_CLICKS", bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_amount_minor: null },
    creative: {
      kind: "link_ad",
      page_id: "demo-page-1",
      instagram_actor_id: null,
      primary_text: "Freelance project tracking that stays out of your way. Try Plannery free — no credit card required.",
      headline: "Plannery: Freelance PM",
      description: "Free forever plan",
      link_url: "https://plannery.example.com/freelancers",
      display_link: "plannery.example.com",
      call_to_action: "SIGN_UP",
      image: { source: "generated", asset_id: "00000000-0000-4000-8000-000000009901", prompt: "A freelancer working calmly at a bright desk with a laptop showing a project board", brand_kit_ref: null },
    },
    naming: { campaign_name: "Plannery — Freelance PM search test", ad_set_name: "Freelancers 25-54", ad_name: "Freelance PM v1" },
  };
}

/** camelCase GrowthAdsBody fixtures for the demoable created-paused / live / failed states (see growth-types.ts). */
export function buildGrowthDemoAdsBodyForAction(actionId: string, nowMillis: number): GrowthAdsBody | null {
  const createdAt = nowMillis - 2 * DAY;
  const base = {
    platform: "meta" as const,
    accountId: "act_1",
    currency: "USD",
    dailyBudgetMinor: 2000,
    lifetimeBudgetMinor: null,
    orphanedExternalIds: [] as string[],
    lastError: { stage: null, code: null, subcode: null },
    publishedAtMillis: null as number | null,
    publishedByUserId: null as string | null,
    pausedAtMillis: null as number | null,
    createdAtMillis: createdAt,
    reconciledAtMillis: nowMillis - 5 * 60 * 1000,
    mayBeLiveUnconfirmed: false,
    verification: {
      outcome: "verified" as GrowthAdsBody["verification"]["outcome"],
      verifiedAtMillis: nowMillis - 5 * 60 * 1000,
      findings: [] as GrowthAdsBody["verification"]["findings"],
    },
    execution: {
      mode: "agent" as GrowthAdsBody["execution"]["mode"],
      attempt: 1 as number | null,
      status: "reported" as string | null,
      dispatchedAtMillis: createdAt as number | null,
      leaseExpiresAtMillis: null as number | null,
      agentReportedIds: {} as Record<string, string>,
    },
    publishInProgress: false,
  };
  const entity = (id: string, name: string, status: "paused" | "active") => ({ externalId: id, name, configuredStatus: status, effectiveStatus: status });

  switch (actionId) {
    case demoId(6, 7): {
      return {
        ...base, status: "paused", creationStep: "done", attempt: 1,
        campaign: entity("120000000000901", "Plannery — Freelance PM search test [hexclave:demo]", "paused"),
        adSet: entity("120000000000902", "Freelancers 25-54 [hexclave:demo]", "paused"),
        creative: { externalId: "120000000000903" },
        ad: entity("120000000000904", "Freelance PM v1 [hexclave:demo]", "paused"),
      };
    }
    case demoId(6, 8): {
      return {
        ...base, status: "active", creationStep: "done", attempt: 1,
        publishedAtMillis: nowMillis - 1 * DAY, publishedByUserId: null,
        campaign: entity("120000000000911", "Plannery — Freelance PM search test [hexclave:demo]", "active"),
        adSet: entity("120000000000912", "Freelancers 25-54 [hexclave:demo]", "active"),
        creative: { externalId: "120000000000913" },
        ad: entity("120000000000914", "Freelance PM v1 [hexclave:demo]", "active"),
      };
    }
    case demoId(6, 9): {
      return {
        // The realistic agent-era failure, and the one worth having demoable: the AI stopped partway
        // and verification found an incomplete tree. Everything it did create is PAUSED and costing
        // nothing — which is exactly what the panel has to communicate, rather than a bare "failed".
        ...base, status: "failed", creationStep: "verifying", attempt: 2,
        orphanedExternalIds: ["120000000000921"],
        lastError: { stage: "adset", code: "100", subcode: "1885183" },
        campaign: entity("120000000000921", "Plannery — Freelance PM search test [hexclave:demo]", "paused"),
        adSet: null, creative: null, ad: null,
        verification: {
          outcome: "incomplete" as GrowthAdsBody["verification"]["outcome"],
          verifiedAtMillis: nowMillis - 30 * 60 * 1000,
          findings: [
            { code: "missing_object", severity: "blocking" as const, level: "adset", externalId: null, expected: "One ad set under this campaign", actual: "None found", message: "The agent stopped before creating the ad set. Nothing is running or spending." },
          ],
        },
        execution: {
          ...base.execution,
          attempt: 2,
          status: "failed",
          // An expired lease is what the watchdog acted on — the agent never reported back at all,
          // and the backend reconciled anyway rather than leaving the row stuck.
          leaseExpiresAtMillis: nowMillis - 25 * 60 * 1000,
          agentReportedIds: {},
        },
      };
    }
    default: {
      return null;
    }
  }
}

function demoReportDocument(): GrowthDocument {
  return {
    format: "growth-mdx-v1",
    sourceMdx: "## The clearest opportunity\n\n<ComparisonChart data=\"workspace-progress\" />\n\n<Hypothesis confidence=\"high\">\n\nAn empty workspace leaves new users without a clear next step.\n\n</Hypothesis>\n\n## What to test\n\n<Experiment>\n\nShow a four-step checklist until a workspace completes its first useful loop.\n\n</Experiment>",
    blocks: [
      { type: "heading", level: 2, children: [{ type: "text", value: "The clearest opportunity" }] },
      { type: "component", name: "ComparisonChart", dataId: "workspace-progress", confidence: null, actionId: null, children: [] },
      { type: "component", name: "Hypothesis", dataId: null, confidence: "high", actionId: null, children: [{ type: "paragraph", children: [{ type: "text", value: "An empty workspace leaves new users without a clear next step." }] }] },
      { type: "heading", level: 2, children: [{ type: "text", value: "What to test" }] },
      { type: "component", name: "Experiment", dataId: null, confidence: null, actionId: null, children: [{ type: "paragraph", children: [{ type: "text", value: "Show a four-step checklist until a workspace completes its first useful loop." }] }] },
    ],
    data: [{
      id: "workspace-progress",
      kind: "comparison",
      title: "New workspaces reaching each milestone",
      unit: "percent",
      source: "Workspace events · first 7 days · Jul 1–31",
      takeaway: "The largest drop happens before users create a second project.",
      timezone: "UTC",
      currency: null,
      items: [{ label: "Created", value: 100 }, { label: "First project", value: 74 }, { label: "Second project", value: 59 }],
    }],
  };
}

function demoActionDocument(): GrowthDocument {
  return {
    format: "growth-mdx-v1",
    sourceMdx: `<Finding>

Freelancers from high-intent search activate more often than the average visitor.

</Finding>

<Evidence data="search-intent">

High-intent search visitors activated at 31% over 30 days. The site average was 23%.

</Evidence>

<Recommendation>

Run a capped search campaign for freelancers.

- Send visitors to the freelancer page.
- Run the campaign for 14 days.
- Stop when spend reaches the approved cap.

</Recommendation>

<MeasurementPlan />`,
    blocks: [
      { type: "component", name: "Finding", dataId: null, confidence: null, actionId: null, children: [{ type: "paragraph", children: [{ type: "text", value: "Freelancers from high-intent search activate more often than the average visitor." }] }] },
      { type: "component", name: "Evidence", dataId: "search-intent", confidence: null, actionId: null, children: [{ type: "paragraph", children: [{ type: "text", value: "High-intent search visitors activated at 31% over 30 days. The site average was 23%." }] }] },
      { type: "component", name: "Recommendation", dataId: null, confidence: null, actionId: null, children: [
        { type: "paragraph", children: [{ type: "text", value: "Run a capped search campaign for freelancers." }] },
        { type: "list", ordered: false, items: [
          [{ type: "paragraph", children: [{ type: "text", value: "Send visitors to the freelancer page." }] }],
          [{ type: "paragraph", children: [{ type: "text", value: "Run the campaign for 14 days." }] }],
          [{ type: "paragraph", children: [{ type: "text", value: "Stop when spend reaches the approved cap." }] }],
        ] },
      ] },
      { type: "component", name: "MeasurementPlan", dataId: null, confidence: null, actionId: null, children: [] },
    ],
    data: [{
      id: "search-intent",
      kind: "metric",
      title: "Activation from high-intent search",
      unit: "percent",
      source: "Acquisition cohorts · last 30 days",
      takeaway: "High-intent search visitors activate 8 points above the site average.",
      timezone: "UTC",
      currency: null,
      value: 31,
      comparisonLabel: "site average",
      comparisonValue: 23,
    }],
  };
}

function demoTrendDocument(): GrowthDocument {
  return {
    format: "growth-mdx-v1",
    sourceMdx: "## Three-week direction\n\n<TrendChart data=\"organic-signups\" />\n\n<DataGap>\n\nCampaign tags are missing on 9% of signups, so channel attribution is directional.\n\n</DataGap>",
    blocks: [
      { type: "heading", level: 2, children: [{ type: "text", value: "Three-week direction" }] },
      { type: "component", name: "TrendChart", dataId: "organic-signups", confidence: null, actionId: null, children: [] },
      { type: "component", name: "DataGap", dataId: null, confidence: null, actionId: null, children: [{ type: "paragraph", children: [{ type: "text", value: "Campaign tags are missing on 9% of signups, so channel attribution is directional." }] }] },
    ],
    data: [{
      id: "organic-signups",
      kind: "time_series",
      title: "Organic signups by week",
      unit: "count",
      source: "Growth daily metrics · Jul 14–Aug 3",
      takeaway: "Organic signups rose for three consecutive weeks.",
      timezone: "UTC",
      currency: null,
      series: [{ label: "Organic", points: [{ label: "Jul 20", value: 82 }, { label: "Jul 27", value: 91 }, { label: "Aug 3", value: 104 }] }],
    }],
  };
}

/**
 * A staff-authored stage page, as a customer sees it: the conversion stage argues its case in prose
 * and evidence, and ends in a button that starts the action the page is about.
 *
 * Demo mode has no backend, so the compiled form is written out by hand here. It is the fixture that
 * makes the "page instead of raw lanes" behaviour visible without a seeded project — and the reason
 * the conversion stage in the demo shows a page while every other stage still shows its lanes.
 */
function demoConversionStagePage(actions: GrowthActionItem[]): GrowthPublishedCategoryPage {
  const actionId = demoId(6, 3);
  const referenced = actions.find((item) => item.id === actionId);
  if (referenced == null) throw new Error("The Growth stage page demo references an action that no longer exists in the fixtures.");
  return {
    category: "conversion",
    actions: [referenced],
    version: 3,
    publishedAtMillis: GROWTH_DEMO_NOW_MILLIS - 2 * DAY,
    document: {
      format: "growth-mdx-v1",
      sourceMdx: `## Your first session is where growth is decided\n\n<ComparisonChart data="workspace-progress" />\n\nMost workspaces that stall never get past their first project. The drop is not gradual — it happens in the first session, before anyone sees what the product does for them.\n\n<Hypothesis confidence="high">\n\nA workspace that reaches its second project has understood the product. Everything before that is setup.\n\n</Hypothesis>\n\n## What we suggest doing about it\n\n<ActionButton action="${actionId}" />`,
      blocks: [
        { type: "heading", level: 2, children: [{ type: "text", value: "Your first session is where growth is decided" }] },
        { type: "component", name: "ComparisonChart", dataId: "workspace-progress", confidence: null, actionId: null, children: [] },
        { type: "paragraph", children: [{ type: "text", value: "Most workspaces that stall never get past their first project. The drop is not gradual — it happens in the first session, before anyone sees what the product does for them." }] },
        { type: "component", name: "Hypothesis", dataId: null, confidence: "high", actionId: null, children: [{ type: "paragraph", children: [{ type: "text", value: "A workspace that reaches its second project has understood the product. Everything before that is setup." }] }] },
        { type: "heading", level: 2, children: [{ type: "text", value: "What we suggest doing about it" }] },
        { type: "component", name: "ActionButton", dataId: null, confidence: null, actionId, children: [] },
      ],
      data: [{
        id: "workspace-progress",
        kind: "comparison",
        title: "New workspaces reaching each milestone",
        unit: "percent",
        source: "Workspace events · first 7 days · Jul 1–31",
        takeaway: "The largest drop happens before users create a second project.",
        timezone: "UTC",
        currency: null,
        items: [{ label: "Created", value: 100 }, { label: "First project", value: 74 }, { label: "Second project", value: 59 }],
      }],
    },
  };
}

function demoActionItems(nowMillis: number): GrowthActionItem[] {
  const reportCreatedAt = nowMillis - 6 * DAY + 4 * HOUR;
  return [
    {
      id: demoId(6, 1),
      typeId: "run_ads",
      category: "reach",
      tags: ["paid-acquisition", "experiment"],
      title: "Run a small search-ads test for \"freelance project tracker\"",
      description: "Your interview mentioned a small paid budget. A 2-week search campaign on high-intent freelancer keywords is the fastest way to test paid acquisition.",
      document: demoActionDocument(),
      status: "proposed",
      payload: { ad_campaign: demoAdCampaignSpec() },
      watchedMetrics: [{ metricId: "new_signups", windowDays: 14 }],
      reportId: DEMO_REPORT_ID,
      briefId: null,
      workflow: null,
      createdAtMillis: reportCreatedAt,
      activatedAtMillis: null,
      completedAtMillis: null,
    },
    {
      id: demoId(6, 2),
      typeId: "publish_blog",
      category: "reach",
      tags: ["comparison", "organic-search"],
      title: "Publish: \"Plannery vs TaskHive: an honest comparison\"",
      description: "You lose most deals to TaskHive, but nobody ranks for the comparison keyword yet.",
      status: "proposed",
      // Idea-only, matching what an analysis run now produces: the draft is written on demand from
      // the action page, so this fixture demos the "Write the draft" state. The drafted state is
      // deliberately not fixtured — there is one blog item in the demo report (its count is pinned
      // by the action-mix test), and the pre-generation state is the one a reader actually meets.
      payload: {
        blog_idea: {
          title: "Plannery vs TaskHive: an honest comparison",
          target_intent: "plannery vs taskhive / taskhive alternative",
          aeo_angle: "Which project tracker is better for freelancers and small teams?",
          outline_summary: "Compare onboarding speed and free-tier limits head to head, and concede TaskHive's larger integration catalog so the piece reads as honest rather than promotional.",
        },
      },
      watchedMetrics: [{ metricId: "new_signups", windowDays: 30 }, { metricId: "total_users", windowDays: 30 }],
      reportId: DEMO_REPORT_ID,
      briefId: null,
      workflow: null,
      createdAtMillis: reportCreatedAt,
      activatedAtMillis: null,
      completedAtMillis: null,
    },
    {
      id: demoId(6, 3),
      typeId: "custom",
      category: "conversion",
      tags: ["onboarding", "product"],
      title: "Add a getting-started checklist to the empty workspace",
      description: "People who leave say the hardest part is getting started. Show a short 4-step checklist when a workspace is still empty, so a new user always knows what to do next.",
      status: "proposed",
      // This action needs a code change, so it carries a prompt the reader can paste straight into
      // their coding agent — the fixture exists so that card is demoable.
      payload: {
        coding_agent_prompt: "In our web app, the empty state of a new workspace currently shows only a heading and a \"New project\" button. Replace it with a 4-step getting-started checklist that tracks real progress: create a project, add a task, invite a teammate, and complete a task. Each step should show as done once the underlying action has happened, and the whole checklist should disappear once all four are done. Persist progress per workspace, not per browser. Verify by creating a fresh workspace and confirming each step ticks off as you perform it, and that the checklist is gone on reload after the fourth.",
      },
      watchedMetrics: [{ metricId: "returning_users", windowDays: 30 }],
      reportId: DEMO_REPORT_ID,
      briefId: null,
      workflow: null,
      createdAtMillis: reportCreatedAt,
      activatedAtMillis: null,
      completedAtMillis: null,
    },
    {
      id: demoId(6, 4),
      typeId: "custom",
      category: "retention",
      tags: ["lifecycle-email", "dormant-users"],
      title: "Send a re-engagement email to dormant free users",
      description: "1,900 of your free users have not signed in for 30+ days. A single well-timed email typically reactivates 3-5% of them.",
      status: "proposed",
      payload: null,
      watchedMetrics: [{ metricId: "returning_users", windowDays: 14 }, { metricId: "emails_sent", windowDays: 14 }],
      reportId: DEMO_REPORT_ID,
      briefId: null,
      // The one workflow-bearing demo action: a proposed (not yet deployed) one-shot automation
      // that runs once on activation. warnings stays empty — the demo source is clean by design.
      workflow: {
        workflowId: GROWTH_DEMO_ACTION_WORKFLOW_ID,
        source: DEMO_ACTION_WORKFLOW_SOURCE,
        triggers: [{ type: "event", eventType: "custom.growth.action.dormant-reactivation" }],
        explanation: "When you activate this action, the automation runs once: it finds free users who have not signed in for 30+ days and sends each of them a single re-engagement email. Nothing recurs and nothing runs before you activate.",
        rollbackNote: "The emails cannot be unsent, but the automation runs exactly once and touches nothing else. Dismissing the action deletes the workflow, so no further emails can ever go out.",
        status: "not_deployed",
        lastRunState: null,
        warnings: [],
      },
      createdAtMillis: reportCreatedAt,
      activatedAtMillis: null,
      completedAtMillis: null,
    },
    {
      id: demoId(6, 5),
      typeId: "custom",
      category: "product",
      tags: ["community", "word-of-mouth"],
      title: "Answer the top three questions on the freelancers subreddit",
      description: "Word of mouth is your strongest channel; showing up where freelancers already ask for tool advice compounds it.",
      status: "active",
      payload: null,
      watchedMetrics: [{ metricId: "new_signups", windowDays: 14 }],
      reportId: DEMO_REPORT_ID,
      briefId: null,
      workflow: null,
      createdAtMillis: reportCreatedAt,
      activatedAtMillis: nowMillis - 4 * DAY,
      completedAtMillis: null,
    },
    {
      id: demoId(6, 6),
      typeId: "custom",
      category: "reach",
      tags: ["templates", "organic-search"],
      title: "Add a public template gallery",
      description: "Templates rank well for long-tail searches and give new users a working setup on day one.",
      status: "active",
      payload: null,
      watchedMetrics: [{ metricId: "new_signups", windowDays: 30 }, { metricId: "total_users", windowDays: 30 }],
      reportId: DEMO_REPORT_ID,
      briefId: null,
      workflow: null,
      createdAtMillis: reportCreatedAt,
      activatedAtMillis: nowMillis - 3 * DAY,
      completedAtMillis: null,
    },
    // Three more run_ads items, already activated, one per demoable post-activation lifecycle state
    // (see buildGrowthDemoAdsBodyForAction above) — created-and-paused, live, and a failed creation
    // attempt with an orphaned object — so the ads panel is demoable end to end without a Meta app.
    {
      id: demoId(6, 7),
      typeId: "run_ads",
      category: "reach",
      tags: ["retargeting", "experiment"],
      title: "Retarget cart-abandoners with a 10% discount",
      description: "A small retargeting campaign for freelancers who started (but didn't finish) checkout in the last 30 days.",
      status: "active",
      payload: { ad_campaign: demoAdCampaignSpec() },
      watchedMetrics: [{ metricId: "new_signups", windowDays: 14 }],
      reportId: DEMO_REPORT_ID,
      briefId: null,
      workflow: null,
      createdAtMillis: reportCreatedAt,
      activatedAtMillis: nowMillis - 2 * DAY,
      completedAtMillis: null,
    },
    {
      id: demoId(6, 8),
      typeId: "run_ads",
      category: "reach",
      tags: ["awareness", "positioning"],
      title: "Awareness campaign: \"project tracking, without the busywork\"",
      description: "A broad awareness push on the core positioning line that tested well in the interview.",
      status: "active",
      payload: { ad_campaign: demoAdCampaignSpec() },
      watchedMetrics: [{ metricId: "new_signups", windowDays: 30 }],
      reportId: DEMO_REPORT_ID,
      briefId: null,
      workflow: null,
      createdAtMillis: reportCreatedAt,
      activatedAtMillis: nowMillis - 1 * DAY,
      completedAtMillis: null,
    },
    {
      id: demoId(6, 9),
      typeId: "run_ads",
      category: "reach",
      tags: ["lookalike", "experiment"],
      title: "Lookalike audience test off the Q2 customer list",
      description: "Attempted a lookalike audience test; the ad set failed to create in Meta and needs attention.",
      status: "active",
      payload: { ad_campaign: demoAdCampaignSpec() },
      watchedMetrics: [{ metricId: "new_signups", windowDays: 14 }],
      reportId: DEMO_REPORT_ID,
      briefId: null,
      workflow: null,
      createdAtMillis: reportCreatedAt,
      activatedAtMillis: nowMillis - 12 * HOUR,
      completedAtMillis: null,
    },
  ];
}

/**
 * The initial-analysis report for Plannery. Carries 9 action items — 4 proposed (matching
 * counts.suggestedActions) and 5 active (matching steady-state counts.activeActions) — including the
 * run_ads proposal, three more run_ads items covering the post-activation lifecycle states, and a
 * publish_blog item with a markdown draft payload.
 */
export function buildGrowthDemoReport(nowMillis: number): GrowthReport {
  const reportCreatedAt = nowMillis - 6 * DAY + 4 * HOUR;
  return {
    id: DEMO_REPORT_ID,
    runId: DEMO_RUN_ID,
    title: "Plannery growth analysis",
    summary: "Plannery's word-of-mouth engine works, but onboarding drop-off and an untouched comparison keyword are leaving easy growth on the table. Fix the empty-state experience first, then invest in the TaskHive comparison content.",
    contentMd: "# Plannery growth analysis\n\nPlannery is a project-management tool for freelancers and small teams with strong organic acquisition and a leaky onboarding funnel.\n\n## What is working\n\nWord of mouth and organic search drive most signups at effectively zero cost.\n\n## What is not\n\n41% of new workspaces never create a second project — churned users consistently cite \"hard to get started\".\n\n## Recommended focus\n\n1. Fix the empty-workspace experience.\n2. Own the \"Plannery vs TaskHive\" comparison keyword.\n3. Test a small paid-search budget on high-intent keywords.\n",
    document: demoReportDocument(),
    sections: [
      { id: "what-is-working", kind: "insight", title: "What is working", bodyMd: "Word of mouth and organic search drive most signups at effectively zero cost. Your activation-to-signup ratio is above the benchmark for freemium PM tools." },
      { id: "what-is-not", kind: "insight", title: "What is not", bodyMd: "41% of new workspaces never create a second project. Churned users consistently cite \"hard to get started\", which matches the drop-off we see in the event data." },
      { id: "recommended-focus", kind: "recommendation", title: "Recommended focus", bodyMd: "Fix the empty-workspace experience first, then own the TaskHive comparison keyword, then test a small paid-search budget." },
    ],
    createdAtMillis: reportCreatedAt,
    actionItems: demoActionItems(nowMillis),
  };
}

/** All demo action items across statuses; the report-ready/steady-state counts fixtures are derived from these. */
export function buildGrowthDemoActions(nowMillis: number): GrowthActionItem[] {
  return demoActionItems(nowMillis);
}

export function buildGrowthDemoOverview(nowMillis: number): GrowthOverview {
  const report = buildGrowthDemoReport(nowMillis);
  const briefs = buildGrowthDemoBriefs(nowMillis);
  const actions = buildGrowthDemoActions(nowMillis);
  const latestBrief = briefs.at(0) ?? null;
  const archivedSeed = actions.at(5);
  if (archivedSeed == null) throw new Error("The Growth overview demo requires at least six action fixtures.");
  return {
    latestReport: { id: report.id, title: report.title, summary: report.summary, createdAtMillis: report.createdAtMillis },
    latestBrief: latestBrief == null ? null : {
      id: latestBrief.id,
      date: latestBrief.date,
      summary: latestBrief.summary,
      contentMd: latestBrief.contentMd,
      createdAtMillis: latestBrief.createdAtMillis,
    },
    findings: [
      { id: demoId(8, 1), source: "data-analysis", kind: "data-insight", category: "conversion", tags: ["onboarding", "drop-off"], title: "New workspaces stall before the second project", body: "41% of new workspaces never create a second project, making the first-session experience the clearest activation opportunity.", data: null, document: demoReportDocument(), createdAtMillis: nowMillis - 2 * DAY },
      { id: demoId(8, 2), source: "website-research", kind: "competitor", category: "reach", tags: ["comparison", "organic-search"], title: "The TaskHive comparison query is still open", body: "No credible comparison page currently owns the highest-intent competitor query mentioned in customer interviews.", data: null, createdAtMillis: nowMillis - 3 * DAY },
      { id: demoId(8, 3), source: "data-analysis", kind: "metric-baseline", category: "revenue", tags: ["annual-plans"], title: "Annual upgrades are carrying weekly revenue", body: "Two annual upgrades moved this week ahead of its previous revenue total one day early.", data: null, createdAtMillis: nowMillis - DAY },
    ],
    notes: [
      { id: demoId(8, 4), source: "data-analysis", kind: "note", category: "reach", tags: ["organic-search"], title: "Organic signups rose for three straight weeks", body: "Organic signups moved from 82 to 104 per week across the last three complete weeks.", data: null, document: demoTrendDocument(), createdAtMillis: nowMillis - DAY },
    ],
    actions: actions.slice(0, 7),
    archive: [{ ...archivedSeed, id: demoId(8, 5), status: "completed", completedAtMillis: nowMillis - 8 * DAY }],
    categories: [
      { category: "product", count: 1, score: 71 },
      { category: "reach", count: 7, score: 60 },
      { category: "conversion", count: 2, score: 46 },
      { category: "retention", count: 2, score: 55 },
      { category: "revenue", count: 1, score: 68 },
    ],
    categoryPages: [demoConversionStagePage(actions)],
    needsCategoryCount: 0,
    limit: 24,
  };
}

/**
 * A week of daily briefs, newest first (matching the list endpoint's ordering). The newest brief is the
 * one the steady-state status fixture points at; older briefs are already read.
 */
export function buildGrowthDemoBriefs(nowMillis: number): GrowthBrief[] {
  const summaries: string[] = [
    "New signups up 12% vs the trailing week — the subreddit answers are starting to show up in referral traffic.",
    "Quiet day: metrics flat, no action item movement. The template gallery ships tomorrow.",
    "Returning users up 6% since the onboarding checklist discussion; transactions steady.",
    "Revenue crossed last week's total a day early, driven by two annual upgrades.",
    "Signups dipped 4% (weekend effect); nothing actionable.",
    "Emails sent doubled after the re-engagement draft went out to the first cohort.",
    "First full day of data since the report — baselines captured for all six metrics.",
  ];
  return summaries.map((summary, index) => ({
    // The newest brief keeps the 0401 id referenced by the steady-state status fixture.
    id: demoId(4, index + 1),
    date: demoDate(nowMillis, index),
    status: "ready",
    summary,
    contentMd: `# Daily brief for ${demoDate(nowMillis, index)}\n\n${summary}\n\n## Metrics\n\n- New signups: ${18 - index}\n- Returning users: ${52 - 2 * index}\n- Revenue: $${(412 - 9 * index).toFixed(2)}\n`,
    ...index === 0 ? { document: demoTrendDocument() } : {},
    readAtMillis: index === 0 ? null : nowMillis - index * DAY + 2 * HOUR,
    createdAtMillis: nowMillis - 5 * HOUR - index * DAY,
    // Only the last two ads-running days carry ad metrics — earlier briefs predate campaign
    // activation. `date`/`timezone` deliberately differ from the brief's own UTC `date` above: Meta
    // reports in the ad account's timezone (America/Los_Angeles here), so the demo exercises the
    // "these are not the same day" case the timezone note exists to prevent misreading.
    adMetrics: index < 2 ? {
      spendMinor: 1850 + index * 240,
      currency: "USD",
      impressions: 4200 - index * 300,
      clicks: 96 - index * 8,
      ctr: 0.0229 - index * 0.001,
      date: demoDate(nowMillis - 7 * HOUR, index),
      timezone: "America/Los_Angeles",
    } : null,
  }));
}

export function buildGrowthDemoMilestones(nowMillis: number): GrowthMilestone[] {
  const onboardedAt = nowMillis - 6 * DAY;
  return [
    { id: demoId(7, 1), metricId: "total_users", comparator: "gte", threshold: 5000, source: "default", status: "armed", createdAtMillis: onboardedAt },
    { id: demoId(7, 2), metricId: "revenue", comparator: "gte", threshold: 50000_00, source: "user", status: "armed", createdAtMillis: nowMillis - 4 * DAY },
    { id: demoId(7, 3), metricId: "new_signups", comparator: "gte", threshold: 100, source: "agent", status: "reached", createdAtMillis: onboardedAt + 4 * HOUR },
    { id: demoId(7, 4), metricId: "emails_sent", comparator: "gte", threshold: 10000, source: "default", status: "disabled", createdAtMillis: onboardedAt },
  ];
}

/**
 * The demo workspace's growth-prefixed workflows for the Automations page: the two canonical
 * pipeline workflows plus one AI-authored recurring one. Shapes mirror the SDK's AdminWorkflow so
 * the page renders fixtures and live data through the exact same table. Stats are small, fixed
 * numbers — determinism matters more than realism here.
 */
export function buildGrowthDemoAutomations(nowMillis: number): AdminWorkflow[] {
  const onboardedAt = nowMillis - 6 * DAY;
  const quietWeek = [0, 0, 0, 0, 0, 0, 0];
  return [
    {
      id: "growth-analysis",
      displayName: "Growth: Analysis Runner",
      latestVersion: 1,
      triggers: [{ type: "event", eventType: "custom.growth.run.activated" }],
      isPaused: false,
      pausedAtMillis: null,
      stats: { activeRuns: 0, sleepingRuns: 0, failed7d: 0, runVolume14d: [...quietWeek, 1, 0, 0, 0, 0, 0, 0] },
      createdAtMillis: onboardedAt,
      lastDeployedAtMillis: onboardedAt,
    },
    {
      id: "growth-daily-brief",
      displayName: "Growth: Daily Brief",
      latestVersion: 1,
      triggers: [{ type: "schedule", cron: "0 6 * * *", timezone: "UTC" }],
      isPaused: false,
      pausedAtMillis: null,
      stats: { activeRuns: 0, sleepingRuns: 0, failed7d: 0, runVolume14d: [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1] },
      createdAtMillis: onboardedAt,
      lastDeployedAtMillis: onboardedAt,
    },
    {
      id: "growth-task-competitor-sweep",
      displayName: "Growth: Weekly competitor sweep",
      latestVersion: 1,
      triggers: [{ type: "schedule", cron: "0 9 * * 1", timezone: "UTC" }],
      isPaused: false,
      pausedAtMillis: null,
      stats: { activeRuns: 0, sleepingRuns: 0, failed7d: 0, runVolume14d: [0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0] },
      createdAtMillis: onboardedAt + 4 * HOUR,
      lastDeployedAtMillis: onboardedAt + 4 * HOUR,
    },
  ];
}

// ─── Games ───────────────────────────────────────────────────────────────────
// Demo mode has no ClickHouse behind it, so the quiz needs a fixture to render at all. Kept
// deliberately mid-round (three answered, one of them wrong) because that is the state with the most
// UI in it: the header's streak and score, a graded question, and the reveal panel.

const GROWTH_DEMO_QUIZ_QUESTIONS: GrowthQuizQuestion[] = [
  {
    orderIndex: 0,
    metricId: "new_users",
    factKind: "window_sum",
    text: "Across the last 30 days, how many people actually signed up?",
    options: [
      { id: "o0", label: "1,200" },
      { id: "o1", label: "430" },
      { id: "o2", label: "2,300" },
      { id: "o3", label: "5,100" },
    ],
    answeredOptionId: "o0",
    correctOptionId: "o0",
    isCorrect: true,
    pointsAwarded: 100,
    explanation: "New signups are the top of every other number on this page — everything downstream is a fraction of it.",
    trueValueLabel: "1,204",
  },
  {
    orderIndex: 1,
    metricId: "dau",
    factKind: "peak_weekday",
    text: "Which day of the week brings you the most daily active users, on average?",
    options: [
      { id: "o0", label: "Sunday" },
      { id: "o1", label: "Tuesday" },
      { id: "o2", label: "Thursday" },
      { id: "o3", label: "Saturday" },
    ],
    answeredOptionId: "o1",
    correctOptionId: "o1",
    isCorrect: true,
    pointsAwarded: 125,
    explanation: "Knowing your busiest weekday tells you when a launch or an email will actually be seen.",
    trueValueLabel: "312",
  },
  {
    orderIndex: 2,
    metricId: "visitor_signup_rate",
    factKind: "ratio",
    text: "Of everyone who lands on your site, what share ends up signing up?",
    options: [
      { id: "o0", label: "12.4%" },
      { id: "o1", label: "3.1%" },
      { id: "o2", label: "24.0%" },
      { id: "o3", label: "1.1%" },
    ],
    answeredOptionId: "o0",
    correctOptionId: "o1",
    isCorrect: false,
    pointsAwarded: 0,
    explanation: "Signup rate is the cheapest number to move — a landing page change shifts it without touching traffic.",
    trueValueLabel: "3.1%",
  },
  {
    orderIndex: 3,
    metricId: "revenue_cents",
    factKind: "window_change_pct",
    text: "How did your revenue move over the last two weeks, against the fortnight before?",
    options: [
      { id: "o0", label: "-14%" },
      { id: "o1", label: "+42%" },
      { id: "o2", label: "+18%" },
      { id: "o3", label: "+5%" },
    ],
    answeredOptionId: null,
    correctOptionId: null,
    isCorrect: null,
    pointsAwarded: null,
    explanation: null,
    trueValueLabel: null,
  },
];

const GROWTH_DEMO_QUIZ_GAME_ID = "demo-quiz-game";

export function buildGrowthDemoQuizRound(): GrowthQuizRound {
  return {
    id: "demo-quiz-round",
    gameId: GROWTH_DEMO_QUIZ_GAME_ID,
    status: "ready",
    questionCount: GROWTH_DEMO_QUIZ_QUESTIONS.length,
    answeredCount: GROWTH_DEMO_QUIZ_QUESTIONS.filter((question) => question.answeredOptionId != null).length,
    score: 225,
    maxScore: 550,
    correctCount: 2,
    bestStreak: 2,
    rankTitle: "Pattern Spotter",
    rankBlurb: "Solid instincts. The details are where you slipped.",
    createdAtMillis: GROWTH_DEMO_NOW_MILLIS - HOUR,
    completedAtMillis: null,
    questions: GROWTH_DEMO_QUIZ_QUESTIONS,
  };
}

/** The banner's fixture: a published quiz with a round already part-way through it. */
export function buildGrowthDemoPublishedQuiz(): GrowthPublishedQuiz {
  const round = buildGrowthDemoQuizRound();
  return {
    game: {
      id: GROWTH_DEMO_QUIZ_GAME_ID,
      gameKey: "know_your_users",
      questionCount: round.questionCount,
      metricsAsOf: "2026-08-03",
      publishedAtMillis: GROWTH_DEMO_NOW_MILLIS - 2 * HOUR,
    },
    round: {
      id: round.id,
      status: round.status,
      questionCount: round.questionCount,
      answeredCount: round.answeredCount,
      score: round.score,
      maxScore: round.maxScore,
      correctCount: round.correctCount,
      rankTitle: round.rankTitle,
      completedAtMillis: null,
    },
  };
}
