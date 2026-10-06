import type { SmartRequest } from "@/route-handlers/smart-request";
import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as priorityRoute } from "./actions/priority/route";
import { GET as metadataRoute } from "./metadata/route";

let tenancy: Tenancy;
let issueId: string;
let expectedDefaultTeamId: string | null;

function request(body: unknown = undefined): SmartRequest {
  return {
    auth: { type: "server", project: tenancy.project, branchId: tenancy.branchId, tenancy },
    url: `http://localhost/api/latest/issues/${issueId}`,
    method: body === undefined ? "GET" : "POST",
    body,
    bodyBuffer: new ArrayBuffer(0),
    headers: {},
    query: {},
    params: { issue_id: issueId },
    clientVersion: undefined,
  };
}

beforeAll(async () => {
  const rows = await globalPrismaClient.tenancy.findMany({ orderBy: { id: "asc" }, select: { id: true } });
  let picked: Tenancy | null = null;
  for (const row of rows) {
    const resolved = await getTenancy(row.id);
    if (resolved === null) continue;
    if (resolved.config.apps.installed["observability"]?.enabled !== true) continue;
    picked = resolved;
    break;
  }
  if (picked === null) throw new Error("Issue product route tests need a seeded tenancy with the observability app enabled.");
  tenancy = picked;
  const projectRow = await globalPrismaClient.project.findUnique({
    where: { id: tenancy.project.id },
    select: { ownerTeamId: true },
  });
  expectedDefaultTeamId = projectRow?.ownerTeamId ?? null;
  const prisma = await getPrismaClientForTenancy(tenancy);
  const [{ shortId }] = await prisma.$queryRaw<Array<{ shortId: bigint }>>`
    INSERT INTO "IssueCounter" ("tenancyId", "nextShortId") VALUES (${tenancy.id}::uuid, 2::bigint)
    ON CONFLICT ("tenancyId") DO UPDATE SET "nextShortId" = "IssueCounter"."nextShortId" + 1
    RETURNING "nextShortId" - 1 AS "shortId"
  `;
  issueId = randomUUID();
  const seenAt = new Date("2026-08-06T13:00:00.000Z");
  await prisma.issue.create({ data: { id: issueId, tenancyId: tenancy.id, shortId, type: "RouteError", value: `issue-product-route-${issueId}`, culprit: "product-route.test.ts", platform: "javascript", firstSeenAt: seenAt, lastSeenAt: seenAt, timesSeen: 1n } });
});

afterAll(async () => {
  const prisma = await getPrismaClientForTenancy(tenancy);
  await prisma.issue.delete({ where: { tenancyId_id: { tenancyId: tenancy.id, id: issueId } } });
});

describe("issue product API routes", () => {
  it("persists priority through the public action entry point", async () => {
    const response = await priorityRoute.invoke(request({ priority: "high" }));
    expect(response.body).toMatchObject({ issue_id: issueId, priority: "high", previous_priority: null, changed: true });
  });

  it("returns bounded product metadata from the branch-scoped read entry point", async () => {
    const response = await metadataRoute.invoke(request());
    expect(response.body).toMatchObject({ priority: "high", team_id: expectedDefaultTeamId, bookmarked_user_ids: [] });
    expect(response.body.activities).toEqual(expect.arrayContaining([expect.objectContaining({ type: "priority_changed" })]));
  });
});
