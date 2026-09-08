import { authenticateGrowthAgentRequest } from "@/lib/growth/agent-auth";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { globalPrismaClient } from "@/prisma-client";
import { yupMixed, yupNumber, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";

// Everything in this bundle ends up verbatim in an agent prompt, so every list is capped and the
// whole body is held under a serialized-character budget — a project with months of accumulated
// findings must not blow up the agent's context window.
const MAX_FINDINGS = 50;
const MAX_FINDING_BODY_CHARS = 2000;
const MAX_BRIEFS = 7;
const MAX_DAILY_METRICS = 30;
const MAX_ARTIFACTS = 10;
const MAX_ARTIFACT_CONTENT_CHARS = 3000;
const BUNDLE_MAX_CHARS = 40_000;

// GrowthArtifact rows of these kinds hold binary payloads (base64 image bytes in the `content`
// column by the ad creative pipeline, or a brand screenshot), not model-readable context.
// A single one would instantly blow the character budget below and could crowd out every real
// finding, so they're excluded in the Prisma `where` itself — the bytes must never even leave the
// database, not just get dropped after the fact.
const CONTEXT_BUNDLE_EXCLUDED_ARTIFACT_KINDS = [
  // Both are literals rather than shared constants because neither feature otherwise shares code
  // with this route. "ad_image" is written by the ad creative pipeline, which lands with the ad
  // platform integration — the exclusion is kept now so that pipeline can never leak base64 image
  // payloads into an agent prompt the moment it arrives.
  "ad_image",
  "brand_screenshot",
];

function truncateFindingBody(body: string): string {
  // The ellipsis tells the agent the body was cut, so it can fetch the full text elsewhere (or just
  // not treat the last sentence as complete).
  return body.length > MAX_FINDING_BODY_CHARS ? body.slice(0, MAX_FINDING_BODY_CHARS) + "…" : body;
}

function truncateArtifactContent(content: string): string {
  return content.length > MAX_ARTIFACT_CONTENT_CHARS ? content.slice(0, MAX_ARTIFACT_CONTENT_CHARS) + "…" : content;
}

// Growth-agent machine route; see sql-query/route.tsx for the auth-opt-out rationale.
export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({}).nullable().optional(),
    method: yupString().oneOf(["GET"]).defined(),
    headers: yupObject({
      "authorization": yupTuple([yupString()]).optional(),
    }).defined(),
    query: yupObject({
      project_id: yupString().defined(),
      branch_id: yupString().defined(),
      run_id: yupString().uuid().optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupMixed().defined(),
  }),
  handler: async ({ headers, query }) => {
    const tenancy = await authenticateGrowthAgentRequest({
      authorizationHeader: headers.authorization?.[0],
      projectId: query.project_id,
      branchId: query.branch_id,
    });
    const projectId = tenancy.project.id;
    const branchId = tenancy.branchId;

    const [onboarding, findingRows, latestReport, latestInterview, activeActions, briefRows, dailyMetricRows, artifactRows] = await Promise.all([
      globalPrismaClient.growthOnboarding.findUnique({
        where: { projectId_branchId: { projectId, branchId } },
        select: { websiteUrl: true, companySummary: true, additionalNotes: true },
      }),
      // Fetch one more than the cap so we can tell "exactly at the cap" apart from "trimmed".
      globalPrismaClient.growthFinding.findMany({
        where: { projectId, branchId, ...(query.run_id != null ? { runId: query.run_id } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: MAX_FINDINGS + 1,
        select: { id: true, kind: true, title: true, body: true, createdAt: true },
      }),
      globalPrismaClient.growthReport.findFirst({
        where: { projectId, branchId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { summary: true },
      }),
      globalPrismaClient.growthInterview.findFirst({
        where: { projectId, branchId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          questions: {
            where: { answeredAt: { not: null } },
            orderBy: { orderIndex: "asc" },
            select: { questionKey: true, prompt: true, answerOptionIds: true, answerFreeText: true },
          },
        },
      }),
      globalPrismaClient.growthActionItem.findMany({
        where: { projectId, branchId, status: "active" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, typeId: true, title: true, status: true },
      }),
      // Only "ready" briefs: "generating"/"failed" rows have placeholder or missing prose that would
      // just confuse the agent (same reasoning as the dashboard's latest-brief query).
      globalPrismaClient.growthBrief.findMany({
        where: { projectId, branchId, status: "ready" },
        orderBy: [{ date: "desc" }],
        take: MAX_BRIEFS,
        select: { date: true, summary: true },
      }),
      globalPrismaClient.growthDailyMetrics.findMany({
        where: { projectId, branchId },
        orderBy: [{ date: "desc" }],
        take: MAX_DAILY_METRICS,
        select: { date: true, metrics: true },
      }),
      // Fetch one more than the cap for the same over-cap detection as findings, above.
      globalPrismaClient.growthArtifact.findMany({
        where: {
          projectId,
          branchId,
          ...(query.run_id != null ? { runId: query.run_id } : {}),
          kind: { notIn: CONTEXT_BUNDLE_EXCLUDED_ARTIFACT_KINDS },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: MAX_ARTIFACTS + 1,
        select: { id: true, kind: true, title: true, content: true, createdAt: true },
      }),
    ]);

    const overCap = findingRows.length > MAX_FINDINGS;
    const artifactsOverCap = artifactRows.length > MAX_ARTIFACTS;
    // Newest-first, so trimming from the end always drops the oldest finding.
    let findings = (overCap ? findingRows.slice(0, MAX_FINDINGS) : findingRows).map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      title: finding.title,
      body: truncateFindingBody(finding.body),
      created_at_millis: finding.createdAt.getTime(),
    }));

    // Newest-first, mirroring findings above; artifacts aren't part of the active budget-trim loop
    // below because — like briefs and daily metrics — they're already tightly capped (MAX_ARTIFACTS,
    // MAX_ARTIFACT_CONTENT_CHARS) rather than open-ended the way findings are.
    const artifacts = (artifactsOverCap ? artifactRows.slice(0, MAX_ARTIFACTS) : artifactRows).map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      content: truncateArtifactContent(artifact.content),
      created_at_millis: artifact.createdAt.getTime(),
    }));

    // `truncated` means "there were findings (or artifacts) we left out" — either because more than
    // MAX_FINDINGS/MAX_ARTIFACTS exist, or because the character budget below forced us to drop some
    // findings. Per-field body truncation is signaled inline by the ellipsis instead.
    let truncated = overCap || artifactsOverCap;
    const buildBody = () => ({
      onboarding: onboarding == null ? null : {
        website_url: onboarding.websiteUrl,
        company_summary: onboarding.companySummary,
        additional_notes: onboarding.additionalNotes,
      },
      findings,
      report_summary: latestReport == null ? null : latestReport.summary,
      interview_answers: (latestInterview?.questions ?? []).map((question) => ({
        question_key: question.questionKey,
        prompt: question.prompt,
        answer_option_ids: question.answerOptionIds,
        answer_free_text: question.answerFreeText,
      })),
      active_actions: activeActions.map((action) => ({
        id: action.id,
        type_id: action.typeId,
        title: action.title,
        status: action.status,
      })),
      recent_briefs: briefRows.map((brief) => ({
        date: brief.date.toISOString().slice(0, 10),
        summary: brief.summary,
      })),
      daily_metrics: dailyMetricRows.map((row) => ({
        date: row.date.toISOString().slice(0, 10),
        metrics: row.metrics,
      })),
      artifacts,
      truncated,
    });

    // Enforce the total budget by dropping the oldest findings first (they are the least valuable
    // part of the bundle — everything else is already tightly capped). Re-serializing per drop is
    // fine: at most MAX_FINDINGS iterations over a <=40k-char object.
    let responseBody = buildBody();
    while (JSON.stringify(responseBody).length > BUNDLE_MAX_CHARS && findings.length > 0) {
      findings = findings.slice(0, findings.length - 1);
      truncated = true;
      responseBody = buildBody();
    }

    return { statusCode: 200, bodyType: "json", body: responseBody };
  },
});
