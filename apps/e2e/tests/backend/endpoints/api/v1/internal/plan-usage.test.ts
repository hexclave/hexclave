import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe } from "vitest";
import { ITEM_IDS } from "@hexclave/shared/dist/plans";
import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { planUsageResponseSchema, type PlanUsageResponse } from "@hexclave/shared/dist/interface/plan-usage";
import { it } from "../../../../../helpers";
import { Auth, InternalProjectKeys, Project, backendContext, niceBackendFetch } from "../../../../backend-helpers";
import { deleteSyncedRowsWithTombstones, withInternalDatabase } from "../external-db-sync-utils";

type ProjectUsageContext = {
  projectId: string,
  tenancyId: string,
};

async function getMainTenancyId(client: Client, projectId: string): Promise<string> {
  const tenancies = await client.query<{ id: string }>(
    `SELECT "id" FROM "Tenancy" WHERE "projectId" = $1 AND "branchId" = 'main' LIMIT 1`,
    [projectId],
  );
  return tenancies.rows[0]?.id ?? throwErr(`Could not find main tenancy for project ${projectId}`);
}

async function getProjectUsageContext(client: Client, projectId: string): Promise<ProjectUsageContext> {
  return {
    projectId,
    tenancyId: await getMainTenancyId(client, projectId),
  };
}

async function clearSeededUsageRows(client: Client, tenancies: readonly ProjectUsageContext[]): Promise<void> {
  const tenancyIds = tenancies.map((tenancy) => tenancy.tenancyId);
  await client.query("BEGIN");
  try {
    await client.query(`DELETE FROM "SessionReplay" WHERE "tenancyId" = ANY($1::uuid[])`, [tenancyIds]);
    // Deletions of synced tables only reach ClickHouse through DeletedRow.
    await deleteSyncedRowsWithTombstones(client, {
      table: "EmailOutbox",
      whereClause: `"tenancyId" = ANY($1::uuid[])`,
      values: [tenancyIds],
    });
    await deleteSyncedRowsWithTombstones(client, {
      table: "ProjectUser",
      whereClause: `"tenancyId" = ANY($1::uuid[])`,
      values: [tenancyIds],
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function insertProjectUsers(client: Client, context: ProjectUsageContext, options: {
  nonAnonymousCount: number,
  anonymousCount: number,
}): Promise<string[]> {
  const nonAnonymousUsers = await client.query<{ projectUserId: string }>(
    `
      INSERT INTO "ProjectUser"
        ("tenancyId", "projectUserId", "mirroredProjectId", "mirroredBranchId",
         "displayName", "createdAt", "updatedAt", "isAnonymous",
         "signedUpAt", "signUpRiskScoreBot", "signUpRiskScoreFreeTrialAbuse")
      SELECT
        $1::uuid,
        gen_random_uuid(),
        $2,
        'main',
        'Plan Usage User ' || gs,
        now(),
        now(),
        false,
        now(),
        0,
        0
      FROM generate_series(1, $3::int) AS gs
      RETURNING "projectUserId"
    `,
    [context.tenancyId, context.projectId, options.nonAnonymousCount],
  );

  await client.query(
    `
      INSERT INTO "ProjectUser"
        ("tenancyId", "projectUserId", "mirroredProjectId", "mirroredBranchId",
         "displayName", "createdAt", "updatedAt", "isAnonymous",
         "signedUpAt", "signUpRiskScoreBot", "signUpRiskScoreFreeTrialAbuse")
      SELECT
        $1::uuid,
        gen_random_uuid(),
        $2,
        'main',
        'Plan Usage Anonymous User ' || gs,
        now(),
        now(),
        true,
        now(),
        0,
        0
      FROM generate_series(1, $3::int) AS gs
    `,
    [context.tenancyId, context.projectId, options.anonymousCount],
  );

  return nonAnonymousUsers.rows.map((row) => row.projectUserId);
}

// Marks the EmailOutbox rows this test seeds so we can distinguish them from
// incidental transactional emails the platform sends to the billing team's
// projects (see waitForPlanUsageValues for why that matters).
const SEEDED_EMAIL_SUBJECT = "Plan usage test email";

async function insertEmailOutboxRow(client: Client, tenancyId: string, startedSendingAt: Date | null): Promise<void> {
  const renderedAt = new Date();
  // These are synthetic rows we insert purely to be counted by plan usage; they must never be touched
  // by the real email-queue worker. We mark them "isPaused" because that is the single flag every worker
  // stage checks (render, queue, and send all require isPaused = FALSE). This matters for the not-yet-sent
  // row (the one with a null startedSendingAt): it is fully rendered, so the send step would otherwise
  // claim any non-paused row whose startedSendingAt IS NULL and stamp it to ~now -- which lands inside the
  // active subscription window and inflates the metered email count nondeterministically (only when the
  // worker runs before the test's assertions, e.g. on slower CI shards). "isQueued" alone does not prevent
  // this: the send step claims the row regardless of "isQueued" once it is rendered and not started sending.
  // Pausing is safe for the count because plan usage windows purely on startedSendingAt, never on isPaused.
  await client.query(
    `
      INSERT INTO "EmailOutbox"
        ("tenancyId", "id", "createdAt", "updatedAt", "tsxSource", "isHighPriority", "to", "extraRenderVariables",
         "shouldSkipDeliverabilityCheck", "createdWith", "renderedByWorkerId", "startedRenderingAt",
         "finishedRenderingAt", "renderedHtml", "renderedSubject", "renderedIsTransactional",
         "scheduledAt", "isQueued", "isPaused", "startedSendingAt", "finishedSendingAt", "canHaveDeliveryInfo")
      VALUES
        ($1::uuid, gen_random_uuid(), $4, $4, '', false, $2::jsonb, '{}'::jsonb,
         true, 'PROGRAMMATIC_CALL', $3::uuid, $4, $4, '<p>usage test</p>',
         $7, true, $4, false, true, $5, $5, $6)
    `,
    [
      tenancyId,
      JSON.stringify({ type: "custom-emails", emails: ["usage-test@example.com"] }),
      randomUUID(),
      renderedAt,
      startedSendingAt,
      startedSendingAt == null ? null : false,
      SEEDED_EMAIL_SUBJECT,
    ],
  );
}

// Removes any EmailOutbox rows in the given tenancies that this test did not seed.
// The platform sends incidental transactional emails to a billing team's projects
// around purchase/setup time; because those land at ~now they fall inside the
// active subscription window and inflate the metered email count. We can't clear
// them once up front the way we do the rest of the seeded usage, because they are
// written asynchronously and can arrive after that clear (observed only on slower
// CI shards — locally they settle before seeding). Deleting the non-seeded rows
// keeps the test measuring exactly the usage it controls.
async function deleteIncidentalEmailRows(client: Client, tenancyIds: readonly string[]): Promise<void> {
  await client.query("BEGIN");
  try {
    // Deletions of synced tables only reach ClickHouse through DeletedRow.
    await deleteSyncedRowsWithTombstones(client, {
      table: "EmailOutbox",
      whereClause: `"tenancyId" = ANY($1::uuid[]) AND "renderedSubject" IS DISTINCT FROM $2`,
      values: [tenancyIds, SEEDED_EMAIL_SUBJECT],
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function insertSessionReplayRow(client: Client, context: ProjectUsageContext, projectUserId: string, startedAt: Date): Promise<void> {
  await client.query(
    `
      INSERT INTO "SessionReplay"
        ("tenancyId", "id", "projectUserId", "refreshTokenId", "startedAt", "lastEventAt", "createdAt", "updatedAt")
      VALUES
        ($1::uuid, gen_random_uuid(), $2::uuid, $3::uuid, $4, $4, $4, $4)
    `,
    [context.tenancyId, projectUserId, randomUUID(), startedAt],
  );
}

async function getPlanUsage(): Promise<PlanUsageResponse> {
  const response = await niceBackendFetch("/api/latest/internal/plan-usage", {
    accessType: "admin",
  });
  if (response.status !== 200) {
    throw new HexclaveAssertionError("Expected plan usage request to succeed", { response });
  }
  return await planUsageResponseSchema.validate(response.body);
}

async function purchaseTeamPlanForBillingTeam(ownerTeamId: string): Promise<void> {
  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "team",
      customer_id: ownerTeamId,
      product_id: "team",
    },
  });
  if (createUrlResponse.status !== 200 || typeof createUrlResponse.body?.url !== "string") {
    throw new HexclaveAssertionError("Expected team plan purchase URL creation to succeed", { createUrlResponse });
  }

  const fullCode = createUrlResponse.body.url.match(/\/purchase\/([a-z0-9_-]+)/)?.[1]
    ?? throwErr("Could not parse purchase code from team plan purchase URL", { createUrlResponse });
  const purchaseResponse = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: {
      full_code: fullCode,
      price_id: "monthly",
      quantity: 1,
    },
  });
  if (purchaseResponse.status !== 200) {
    throw new HexclaveAssertionError("Expected test-mode team plan purchase to succeed", { purchaseResponse });
  }
}

function getUsedUsageValue(usage: PlanUsageResponse, itemId: string): number {
  const row = usage.rows.find((candidate) => candidate.item_id === itemId) ?? throwErr(`Missing usage row for ${itemId}`);
  return row.used ?? throwErr(`Expected usage row ${itemId} to have a used value`);
}

// Plan usage windows metered items (emails, session replays) by the billing team's active
// subscription period, not the calendar month: getPlanUsagePeriod derives the window from the
// subscription's currentPeriodStart/End (via bulldozer-js) and only falls back to the calendar month
// when there is no active paid subscription. So for a paid plan we must anchor both the seeded rows
// and the period assertions to the actual subscription period, read here from the source-of-truth
// Subscription row.
async function getActiveTeamSubscriptionPeriod(client: Client, ownerTeamId: string): Promise<{ start: Date, end: Date }> {
  const result = await client.query<{ currentPeriodStart: Date, currentPeriodEnd: Date }>(
    `
      SELECT "currentPeriodStart", "currentPeriodEnd"
      FROM "Subscription"
      WHERE "customerId" = $1 AND "customerType" = 'TEAM' AND "productId" = 'team' AND "status" = 'active'
      ORDER BY "createdAt" DESC
      LIMIT 1
    `,
    [ownerTeamId],
  );
  const row = result.rows[0] ?? throwErr(`Could not find an active team subscription for billing team ${ownerTeamId}`);
  return { start: row.currentPeriodStart, end: row.currentPeriodEnd };
}

async function waitForPlanUsageValues(
  client: Client,
  billingTenancyIds: readonly string[],
  expected: {
    authUsers: number,
    emails: number,
    sessionReplays: number,
    analyticsEvents: number,
  },
): Promise<PlanUsageResponse> {
  const startedAt = performance.now();
  let latestUsage: PlanUsageResponse | undefined;
  while (performance.now() - startedAt < 15_000) {
    await deleteIncidentalEmailRows(client, billingTenancyIds);
    latestUsage = await getPlanUsage();
    if (
      getUsedUsageValue(latestUsage, ITEM_IDS.authUsers) === expected.authUsers
      && getUsedUsageValue(latestUsage, ITEM_IDS.emailsPerMonth) === expected.emails
      && getUsedUsageValue(latestUsage, ITEM_IDS.sessionReplays) === expected.sessionReplays
      && getUsedUsageValue(latestUsage, ITEM_IDS.analyticsEvents) === expected.analyticsEvents
    ) {
      return latestUsage;
    }
    await wait(250);
  }
  throw new HexclaveAssertionError("Timed out waiting for seeded plan usage to be visible", {
    latestUsage,
    expected,
  });
}

describe("internal plan usage", () => {
  it("returns zero usage for a fresh owned project with no seeded usage rows", async ({ expect }) => {
    const { projectId } = await Project.createAndSwitch({
      display_name: "Plan Usage Empty Project",
    });

    await withInternalDatabase(async (client) => {
      const context = await getProjectUsageContext(client, projectId);
      await clearSeededUsageRows(client, [context]);
    });

    const usage = await getPlanUsage();

    expect(usage.owner_team_id).toBeTruthy();
    expect(usage.plan_id).toBe("free");
    expect(getUsedUsageValue(usage, ITEM_IDS.authUsers)).toBe(0);
    expect(getUsedUsageValue(usage, ITEM_IDS.emailsPerMonth)).toBe(0);
    expect(getUsedUsageValue(usage, ITEM_IDS.sessionReplays)).toBe(0);
    expect(getUsedUsageValue(usage, ITEM_IDS.analyticsEvents)).toBe(0);
    expect(getUsedUsageValue(usage, ITEM_IDS.analyticsSpans)).toBe(0);
  });

  it("rolls up metered usage across all projects owned by the billing team", async ({ expect }) => {
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
    await Auth.fastSignUp();
    const internalUserAuth = backendContext.value.userAuth ?? throwErr("Expected internal user auth after sign-up");

    const primaryProject = await Project.createAndSwitch({
      display_name: "Plan Usage Primary Project",
    }, true);
    const primaryProjectKeys = backendContext.value.projectKeys;
    const ownerTeamId = primaryProject.createProjectResponse.body.owner_team_id;
    if (typeof ownerTeamId !== "string") {
      throw new HexclaveAssertionError("Expected created project to include an owner team ID", { primaryProject });
    }

    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: internalUserAuth });
    await purchaseTeamPlanForBillingTeam(ownerTeamId);
    const secondaryProject = await Project.create({
      display_name: "Plan Usage Secondary Project",
      owner_team_id: ownerTeamId,
    });

    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
    const unrelatedProject = await Project.createAndSwitch({
      display_name: "Plan Usage Unrelated Project",
    });

    backendContext.set({ projectKeys: primaryProjectKeys, userAuth: null });

    const { period, billingTenancyIds } = await withInternalDatabase(async (client) => {
      const primary = await getProjectUsageContext(client, primaryProject.projectId);
      const secondary = await getProjectUsageContext(client, secondaryProject.projectId);
      const unrelated = await getProjectUsageContext(client, unrelatedProject.projectId);
      await clearSeededUsageRows(client, [primary, secondary, unrelated]);

      // Anchor the seeded rows to the actual subscription period. Metered usage is windowed by the
      // billing cycle [start, end), so "inside" rows must sit within it and "outside" rows just beyond
      // its edges. (Previously these were anchored to the calendar month, which stopped matching the
      // window once plan usage started deriving the period from the subscription via bulldozer-js.)
      const { start, end } = await getActiveTeamSubscriptionPeriod(client, ownerTeamId);
      const dayMs = 24 * 60 * 60 * 1000;
      const outsideBefore = new Date(start.getTime() - 2 * dayMs);
      const insidePrimary = new Date(start.getTime() + 2 * dayMs);
      const insideSecondaryA = new Date(start.getTime() + 3 * dayMs);
      const insideSecondaryB = new Date(start.getTime() + 4 * dayMs);
      const outsideAfter = new Date(end.getTime() + 2 * dayMs);

      const primaryUserIds = await insertProjectUsers(client, primary, {
        nonAnonymousCount: 2,
        anonymousCount: 1,
      });
      const secondaryUserIds = await insertProjectUsers(client, secondary, {
        nonAnonymousCount: 1,
        anonymousCount: 0,
      });
      const unrelatedUserIds = await insertProjectUsers(client, unrelated, {
        nonAnonymousCount: 2,
        anonymousCount: 0,
      });
      const firstPrimaryUserId = primaryUserIds[0] ?? throwErr("Expected seeded primary project user");
      const secondPrimaryUserId = primaryUserIds[1] ?? throwErr("Expected second seeded primary project user");
      const firstSecondaryUserId = secondaryUserIds[0] ?? throwErr("Expected seeded secondary project user");
      const firstUnrelatedUserId = unrelatedUserIds[0] ?? throwErr("Expected seeded unrelated project user");

      await insertEmailOutboxRow(client, primary.tenancyId, insidePrimary);
      await insertEmailOutboxRow(client, primary.tenancyId, insideSecondaryA);
      await insertEmailOutboxRow(client, secondary.tenancyId, insideSecondaryB);
      await insertEmailOutboxRow(client, primary.tenancyId, outsideBefore);
      await insertEmailOutboxRow(client, secondary.tenancyId, outsideAfter);
      await insertEmailOutboxRow(client, primary.tenancyId, null);
      await insertEmailOutboxRow(client, unrelated.tenancyId, insidePrimary);

      await insertSessionReplayRow(client, primary, firstPrimaryUserId, insidePrimary);
      await insertSessionReplayRow(client, primary, secondPrimaryUserId, outsideBefore);
      await insertSessionReplayRow(client, secondary, firstSecondaryUserId, insideSecondaryA);
      await insertSessionReplayRow(client, secondary, firstSecondaryUserId, insideSecondaryB);
      await insertSessionReplayRow(client, secondary, firstSecondaryUserId, outsideAfter);
      await insertSessionReplayRow(client, unrelated, firstUnrelatedUserId, insidePrimary);

      return {
        period: { start, end },
        billingTenancyIds: [primary.tenancyId, secondary.tenancyId],
      };
    });

    const usage = await withInternalDatabase((client) => waitForPlanUsageValues(client, billingTenancyIds, {
      authUsers: 3,
      emails: 3,
      sessionReplays: 3,
      analyticsEvents: 0,
    }));

    expect(usage.owner_team_id).toBe(ownerTeamId);
    expect(usage.plan_id).toBe("team");
    expect(usage.period_start_millis).toBe(period.start.getTime());
    expect(usage.period_end_millis).toBe(period.end.getTime());
    expect(getUsedUsageValue(usage, ITEM_IDS.authUsers)).toBe(3);
    expect(getUsedUsageValue(usage, ITEM_IDS.emailsPerMonth)).toBe(3);
    expect(getUsedUsageValue(usage, ITEM_IDS.sessionReplays)).toBe(3);
    expect(getUsedUsageValue(usage, ITEM_IDS.analyticsEvents)).toBe(0);
    expect(getUsedUsageValue(usage, ITEM_IDS.analyticsSpans)).toBe(0);
  });
});
