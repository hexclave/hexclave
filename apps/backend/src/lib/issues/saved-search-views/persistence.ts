import { Prisma } from "@/generated/prisma/client";
import { getPrismaClientForTenancy, retryTransaction } from "@/prisma-client";
import type { Tenancy } from "@/lib/tenancies";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { isUuid } from "@hexclave/shared/dist/utils/uuids";
import {
  SAVED_ISSUE_SEARCH_QUERY_VERSION,
  SAVED_ISSUE_SEARCH_VIEW_MAX_PER_SCOPE,
  SAVED_ISSUE_SEARCH_VIEW_LIST_MAX,
  type SavedIssueSearchView,
  type SavedIssueSearchViewMutation,
  isSavedIssueSearchQuery,
  isSavedIssueSearchViewVisibility,
  parseSavedIssueSearchQuery,
  parseSavedIssueSearchViewName,
} from "./contract";

export type SavedIssueSearchViewDatabase = Awaited<ReturnType<typeof getPrismaClientForTenancy>>;

export type SavedIssueSearchViewPersistenceDependencies = {
  database?: SavedIssueSearchViewDatabase,
};

export type SavedIssueSearchViewScope = {
  tenancyId: string,
  projectId: string,
  branchId: string,
};

export type SavedIssueSearchViewMutationAuthorization =
  | { kind: "creator", actorUserId: string }
  | { kind: "admin" };

type RawSavedIssueSearchView = {
  id: string,
  schemaVersion: number,
  name: string,
  nameKey: string,
  visibility: string,
  ownerUserId: string | null,
  query: unknown,
  createdAt: Date,
  updatedAt: Date,
};

const SAVED_ISSUE_SEARCH_VIEW_COLUMNS = Prisma.sql`
  "id",
  "schemaVersion",
  "name",
  "nameKey",
  "visibility",
  "ownerUserId",
  "query",
  "createdAt",
  "updatedAt"
`;

function badRequest(message: string): never {
  throw new StatusError(StatusError.BadRequest, message);
}

function notFound(): never {
  throw new StatusError(StatusError.NotFound, "Saved issue search view not found");
}

function conflict(message: string): never {
  throw new StatusError(StatusError.Conflict, message);
}

function forbidden(message: string): never {
  throw new StatusError(StatusError.Forbidden, message);
}

export function createSavedIssueSearchViewMutationAuthorization(options: {
  authType: unknown,
  actorUserId: string | null,
}): SavedIssueSearchViewMutationAuthorization {
  if (options.authType === "admin") return { kind: "admin" };
  if (options.authType !== "client" && options.authType !== "server") {
    return forbidden("saved issue search view mutation access is invalid");
  }
  if (options.actorUserId === null) {
    return forbidden("saved issue search view mutations require an authenticated user");
  }
  if (!isUuid(options.actorUserId)) {
    return forbidden("saved issue search view mutation owner is invalid");
  }
  return { kind: "creator", actorUserId: options.actorUserId };
}

function scopeForTenancy(tenancy: Tenancy): SavedIssueSearchViewScope {
  return {
    tenancyId: tenancy.id,
    projectId: tenancy.project.id,
    branchId: tenancy.branchId,
  };
}

function scopeWhere(scope: SavedIssueSearchViewScope): Prisma.Sql {
  return Prisma.sql`
    "tenancyId" = ${scope.tenancyId}::uuid
    AND "projectId" = ${scope.projectId}
    AND "branchId" = ${scope.branchId}
  `;
}

function accessWhere(actorUserId: string | null): Prisma.Sql {
  if (actorUserId === null) return Prisma.sql`"visibility" = 'project'`;
  if (!isUuid(actorUserId)) return Prisma.sql`FALSE`;
  return Prisma.sql`
    (
      "visibility" = 'project'
      OR ("visibility" = 'private' AND "ownerUserId" = ${actorUserId}::uuid)
    )
  `;
}

function mutationAccessWhere(authorization: SavedIssueSearchViewMutationAuthorization): Prisma.Sql {
  if (authorization.kind === "admin") return Prisma.sql`TRUE`;
  return Prisma.sql`"ownerUserId" = ${authorization.actorUserId}::uuid`;
}

function ownerValue(actorUserId: string | null, visibility: SavedIssueSearchViewMutation["visibility"]): Prisma.Sql {
  if (visibility === "private" && actorUserId === null) {
    return forbidden("private saved issue search views require an authenticated user");
  }
  if (actorUserId === null) return Prisma.sql`NULL`;
  if (!isUuid(actorUserId)) return forbidden("saved issue search view owner is invalid");
  return Prisma.sql`${actorUserId}::uuid`;
}

function validateViewId(viewId: string): string {
  if (!isUuid(viewId)) return badRequest("view_id must be a UUID");
  return viewId;
}

function malformedStoredView(): never {
  throw new Error("IssueSavedSearchView contains invalid persisted data");
}

function toSavedIssueSearchView(row: RawSavedIssueSearchView): SavedIssueSearchView {
  if (!isUuid(row.id) || row.schemaVersion !== SAVED_ISSUE_SEARCH_QUERY_VERSION) return malformedStoredView();
  if (typeof row.name !== "string" || typeof row.nameKey !== "string") return malformedStoredView();
  if (!isSavedIssueSearchViewVisibility(row.visibility)) return malformedStoredView();
  if (row.ownerUserId !== null && !isUuid(row.ownerUserId)) return malformedStoredView();
  if (!(row.createdAt instanceof Date) || Number.isNaN(row.createdAt.getTime())) return malformedStoredView();
  if (!(row.updatedAt instanceof Date) || Number.isNaN(row.updatedAt.getTime())) return malformedStoredView();

  const normalizedName = parseSavedIssueSearchViewName(row.name);
  if (normalizedName.nameKey !== row.nameKey) return malformedStoredView();
  const query = parseSavedIssueSearchQuery(row.query);
  if (!isSavedIssueSearchQuery(query)) return malformedStoredView();
  return {
    id: row.id,
    schemaVersion: row.schemaVersion,
    name: row.name,
    nameKey: row.nameKey,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    query,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function getDatabase(
  tenancy: Tenancy,
  database: SavedIssueSearchViewDatabase | undefined,
): Promise<SavedIssueSearchViewDatabase> {
  return database ?? await getPrismaClientForTenancy(tenancy);
}

function scopeAdvisoryKey(scope: SavedIssueSearchViewScope): string {
  return `${scope.tenancyId}:${scope.projectId}:${scope.branchId}`;
}

export async function listSavedIssueSearchViews(options: {
  tenancy: Tenancy,
  actorUserId: string | null,
  limit: number,
  dependencies?: SavedIssueSearchViewPersistenceDependencies,
}): Promise<{ items: SavedIssueSearchView[], hasMore: boolean }> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > SAVED_ISSUE_SEARCH_VIEW_LIST_MAX) {
    return badRequest(`limit must be an integer between 1 and ${SAVED_ISSUE_SEARCH_VIEW_LIST_MAX}`);
  }
  const database = await getDatabase(options.tenancy, options.dependencies?.database);
  const scope = scopeForTenancy(options.tenancy);
  // Access control and deletion must be observed from one primary snapshot;
  // a replica read can briefly expose a private/deleted view after mutation.
  const rows = await retryTransaction(database, async (tx) => await tx.$queryRaw<RawSavedIssueSearchView[]>(Prisma.sql`
      SELECT ${SAVED_ISSUE_SEARCH_VIEW_COLUMNS}
      FROM "IssueSavedSearchView"
      WHERE ${scopeWhere(scope)}
        AND ${accessWhere(options.actorUserId)}
      ORDER BY "updatedAt" DESC, "id" DESC
      LIMIT ${options.limit + 1}
    `));
  const views = rows.map(toSavedIssueSearchView);
  return {
    items: views.slice(0, options.limit),
    hasMore: views.length > options.limit,
  };
}

export async function getSavedIssueSearchView(options: {
  tenancy: Tenancy,
  actorUserId: string | null,
  viewId: string,
  dependencies?: SavedIssueSearchViewPersistenceDependencies,
}): Promise<SavedIssueSearchView | null> {
  const viewId = validateViewId(options.viewId);
  const database = await getDatabase(options.tenancy, options.dependencies?.database);
  const rows = await retryTransaction(database, async (tx) => await tx.$queryRaw<RawSavedIssueSearchView[]>(Prisma.sql`
      SELECT ${SAVED_ISSUE_SEARCH_VIEW_COLUMNS}
      FROM "IssueSavedSearchView"
      WHERE ${scopeWhere(scopeForTenancy(options.tenancy))}
        AND "id" = ${viewId}::uuid
        AND ${accessWhere(options.actorUserId)}
      LIMIT 1
    `));
  const row = rows.at(0);
  return row === undefined ? null : toSavedIssueSearchView(row);
}

export async function createSavedIssueSearchView(options: {
  tenancy: Tenancy,
  actorUserId: string | null,
  mutation: SavedIssueSearchViewMutation,
  dependencies?: SavedIssueSearchViewPersistenceDependencies,
}): Promise<SavedIssueSearchView> {
  const database = await getDatabase(options.tenancy, options.dependencies?.database);
  const scope = scopeForTenancy(options.tenancy);
  const owner = ownerValue(options.actorUserId, options.mutation.visibility);
  const queryJson = JSON.stringify(options.mutation.query);

  return await retryTransaction(database, async (transaction) => {
    await transaction.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${scopeAdvisoryKey(scope)}, 0))
    `);
    const countRows = await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS count
      FROM "IssueSavedSearchView"
      WHERE ${scopeWhere(scope)}
    `);
    const count = countRows.at(0)?.count;
    if (count === undefined || count >= BigInt(SAVED_ISSUE_SEARCH_VIEW_MAX_PER_SCOPE)) {
      return conflict(`a project branch can contain at most ${SAVED_ISSUE_SEARCH_VIEW_MAX_PER_SCOPE} saved issue search views`);
    }

    const rows = await transaction.$queryRaw<RawSavedIssueSearchView[]>(Prisma.sql`
      INSERT INTO "IssueSavedSearchView" (
        "tenancyId", "projectId", "branchId", "schemaVersion", "name", "nameKey", "visibility", "ownerUserId", "query"
      )
      VALUES (
        ${scope.tenancyId}::uuid, ${scope.projectId}, ${scope.branchId}, ${SAVED_ISSUE_SEARCH_QUERY_VERSION},
        ${options.mutation.name}, ${options.mutation.nameKey}, ${options.mutation.visibility}, ${owner}, ${queryJson}::jsonb
      )
      ON CONFLICT ("tenancyId", "projectId", "branchId", "nameKey") DO NOTHING
      RETURNING ${SAVED_ISSUE_SEARCH_VIEW_COLUMNS}
    `);
    const row = rows.at(0);
    return row === undefined ? conflict("a saved issue search view with this name already exists") : toSavedIssueSearchView(row);
  });
}

export async function updateSavedIssueSearchView(options: {
  tenancy: Tenancy,
  authorization: SavedIssueSearchViewMutationAuthorization,
  viewId: string,
  mutation: SavedIssueSearchViewMutation,
  dependencies?: SavedIssueSearchViewPersistenceDependencies,
}): Promise<SavedIssueSearchView> {
  const viewId = validateViewId(options.viewId);
  const database = await getDatabase(options.tenancy, options.dependencies?.database);
  const scope = scopeForTenancy(options.tenancy);
  const queryJson = JSON.stringify(options.mutation.query);

  return await retryTransaction(database, async (transaction) => {
    const currentRows = await transaction.$queryRaw<RawSavedIssueSearchView[]>(Prisma.sql`
      SELECT ${SAVED_ISSUE_SEARCH_VIEW_COLUMNS}
      FROM "IssueSavedSearchView"
      WHERE ${scopeWhere(scope)}
        AND "id" = ${viewId}::uuid
        AND ${mutationAccessWhere(options.authorization)}
      FOR UPDATE
    `);
    const currentRow = currentRows.at(0);
    if (currentRow === undefined) return notFound();
    const current = toSavedIssueSearchView(currentRow);
    const owner = options.mutation.visibility === "private"
      ? current.ownerUserId !== null
        ? Prisma.sql`${current.ownerUserId}::uuid`
        : options.authorization.kind === "creator"
          ? ownerValue(options.authorization.actorUserId, options.mutation.visibility)
          : forbidden("private saved issue search views require an existing owner")
      : current.ownerUserId === null
        ? options.authorization.kind === "creator"
          ? ownerValue(options.authorization.actorUserId, options.mutation.visibility)
          : Prisma.sql`NULL`
        : Prisma.sql`${current.ownerUserId}::uuid`;

    const rows = await transaction.$queryRaw<RawSavedIssueSearchView[]>(Prisma.sql`
      UPDATE "IssueSavedSearchView"
      SET
        "schemaVersion" = ${SAVED_ISSUE_SEARCH_QUERY_VERSION},
        "name" = ${options.mutation.name},
        "nameKey" = ${options.mutation.nameKey},
        "visibility" = ${options.mutation.visibility},
        "ownerUserId" = ${owner},
        "query" = ${queryJson}::jsonb,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE ${scopeWhere(scope)}
        AND "id" = ${viewId}::uuid
        AND NOT EXISTS (
          SELECT 1
          FROM "IssueSavedSearchView" AS duplicate
          WHERE ${scopeWhere(scope)}
            AND duplicate."nameKey" = ${options.mutation.nameKey}
            AND duplicate."id" <> ${viewId}::uuid
        )
      RETURNING ${SAVED_ISSUE_SEARCH_VIEW_COLUMNS}
    `);
    const row = rows.at(0);
    return row === undefined ? conflict("a saved issue search view with this name already exists") : toSavedIssueSearchView(row);
  });
}

export async function deleteSavedIssueSearchView(options: {
  tenancy: Tenancy,
  authorization: SavedIssueSearchViewMutationAuthorization,
  viewId: string,
  dependencies?: SavedIssueSearchViewPersistenceDependencies,
}): Promise<void> {
  const viewId = validateViewId(options.viewId);
  const database = await getDatabase(options.tenancy, options.dependencies?.database);
  const rows = await database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    DELETE FROM "IssueSavedSearchView"
    WHERE ${scopeWhere(scopeForTenancy(options.tenancy))}
      AND "id" = ${viewId}::uuid
      AND ${mutationAccessWhere(options.authorization)}
    RETURNING "id"
  `);
  if (rows.at(0) === undefined) return notFound();
}
