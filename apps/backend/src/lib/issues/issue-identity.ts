import { Prisma } from "@/generated/prisma/client";
import type { Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

const ISSUE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isIssueUuid(value: string): boolean {
  return ISSUE_UUID_PATTERN.test(value);
}


export function isValidShortId(raw: string): boolean {
  if (!/^[1-9]\d*$/.test(raw) || raw.length > 19) return false;
  return raw.length < 19 || raw <= "9223372036854775807";
}

function issueIdentityPredicate(rawId: string): Prisma.Sql {
  if (isValidShortId(rawId)) return Prisma.sql`i."shortId" = ${rawId}::bigint`;
  if (isIssueUuid(rawId)) return Prisma.sql`i."id" = ${rawId}::uuid`;
  throw new StatusError(StatusError.BadRequest, "issue_id must be a UUID or a numeric short id");
}

function issueRedirectPredicate(rawId: string): Prisma.Sql {
  if (isValidShortId(rawId)) return Prisma.sql`"fromShortId" = ${rawId}::bigint`;
  if (isIssueUuid(rawId)) return Prisma.sql`"fromIssueId" = ${rawId}::uuid`;
  throw new StatusError(StatusError.BadRequest, "issue_id must be a UUID or a numeric short id");
}

export type ResolvedIssueIdentity = {
  issueId: string,
  redirectedFromIssueId: string | null,
};

export async function resolveIssueIdentity(
  tenancy: Tenancy,
  rawId: string,
  options: { consistency?: "replica" | "primary" } = {},
): Promise<ResolvedIssueIdentity | null> {
  if (!isValidShortId(rawId) && !isIssueUuid(rawId)) {
    throw new StatusError(StatusError.BadRequest, "issue_id must be a UUID or a numeric short id");
  }

  const prisma = await getPrismaClientForTenancy(tenancy);
  const readClient = options.consistency === "primary" ? prisma : prisma.$replica();
  const directRows = await readClient.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT i."id"
    FROM "Issue" i
    WHERE i."tenancyId" = ${tenancy.id}::uuid
      AND ${issueIdentityPredicate(rawId)}
    LIMIT 1
  `);
  const direct = directRows.at(0);
  if (direct !== undefined) return { issueId: direct.id, redirectedFromIssueId: null };

  const redirectRows = await readClient.$queryRaw<{ fromIssueId: string, toIssueId: string }[]>(Prisma.sql`
    SELECT "fromIssueId", "toIssueId"
    FROM "IssueRedirect"
    WHERE "tenancyId" = ${tenancy.id}::uuid
      AND ${issueRedirectPredicate(rawId)}
    LIMIT 1
  `);
  const redirect = redirectRows.at(0);
  if (redirect === undefined) return null;

  const targetRows = await readClient.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT i."id"
    FROM "Issue" i
    WHERE i."tenancyId" = ${tenancy.id}::uuid
      AND i."id" = ${redirect.toIssueId}::uuid
    LIMIT 1
  `);
  const target = targetRows.at(0);
  return target === undefined
    ? null
    : { issueId: target.id, redirectedFromIssueId: redirect.fromIssueId };
}
