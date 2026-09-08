import { authenticateGrowthAgentRequest } from "@/lib/growth/agent-auth";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { globalPrismaClient } from "@/prisma-client";
import { yupMixed, yupNumber, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";

// Growth-agent machine route; see sql-query/route.tsx for the auth-opt-out rationale. Returns the
// small, always-relevant facts about a project that every agent invocation wants in its prompt
// (identity, onboarding answers, domains, installed apps, rough scale, run state).
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

    const [onboarding, userCount, latestRun] = await Promise.all([
      globalPrismaClient.growthOnboarding.findUnique({
        where: { projectId_branchId: { projectId, branchId } },
        select: { websiteUrl: true, companySummary: true, additionalNotes: true },
      }),
      // Non-anonymous only, matching the growth metrics' INCLUDE_ANONYMOUS = false convention (the
      // agent reasons about real humans, not anonymous sessions).
      globalPrismaClient.projectUser.count({
        where: { tenancyId: tenancy.id, isAnonymous: false },
      }),
      globalPrismaClient.growthAnalysisRun.findFirst({
        where: { projectId, branchId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, status: true, trigger: true },
      }),
    ]);

    // Same shape as getTrustedDomainsForTenancy in lib/redirect-urls.tsx: wildcard-only entries have
    // no baseUrl and are useless as a browsable domain, so they're filtered out.
    const domains = Object.values(tenancy.config.domains.trustedDomains)
      .map((domain) => domain.baseUrl)
      .filter((baseUrl): baseUrl is string => baseUrl != null);

    const enabledApps = Object.entries(tenancy.config.apps.installed)
      // The installed record's index signature makes values possibly-undefined; an absent entry is
      // simply not an enabled app.
      .filter(([, app]) => app?.enabled === true)
      .map(([appId]) => appId);

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        project: {
          id: projectId,
          display_name: tenancy.project.display_name,
        },
        onboarding: onboarding == null ? null : {
          website_url: onboarding.websiteUrl,
          company_summary: onboarding.companySummary,
          additional_notes: onboarding.additionalNotes,
        },
        domains,
        enabled_apps: enabledApps,
        user_count: userCount,
        latest_run: latestRun == null ? null : {
          id: latestRun.id,
          // Lowercase wire form, matching runStatusToWire in lib/growth/dashboard.ts.
          status: latestRun.status.toLowerCase(),
          trigger: latestRun.trigger,
        },
      },
    };
  },
});
