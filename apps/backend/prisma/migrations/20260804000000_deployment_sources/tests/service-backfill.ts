import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

/**
 * Every pre-existing service joins ONE source per tenancy, named after the config file.
 *
 * The interesting case is a tenancy with several services: the backfill has to produce a
 * single source row for it, which a `SELECT DISTINCT tenancyId, gen_random_uuid()` does not
 * — the uuid is volatile and makes every row distinct, so each service inserts its own
 * source and the unique index on (tenancyId, sourceId) aborts the whole migration.
 */
export const preMigration = async (sql: Sql) => {
  const projectId = `test-${randomUUID()}`;
  const tenancyId = randomUUID();
  const otherTenancyId = randomUUID();
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Deployment sources migration test', '', false)
  `;
  for (const [id, branchId] of [[tenancyId, "main"], [otherTenancyId, "other"]] as const) {
    await sql`
      INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization")
      VALUES (${id}::uuid, NOW(), NOW(), ${projectId}, ${branchId}, 'TRUE'::"BooleanTrue")
    `;
  }
  const serviceIds: string[] = [];
  for (const [tenancy, serviceId] of [[tenancyId, "web"], [tenancyId, "api"], [otherTenancyId, "web"]] as const) {
    const id = randomUUID();
    serviceIds.push(id);
    await sql`
      INSERT INTO "DeploymentService" ("tenancyId", "id", "updatedAt", "serviceId")
      VALUES (${tenancy}::uuid, ${id}::uuid, NOW(), ${serviceId})
    `;
  }
  return { tenancyId, otherTenancyId, serviceIds };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  // One source for the two-service tenancy, and one for its neighbour — not one per service.
  const sources = await sql<{ id: string, sourceId: string }[]>`
    SELECT "id", "sourceId" FROM "DeploymentSource" WHERE "tenancyId" = ${context.tenancyId}::uuid
  `;
  expect(sources.length).toBe(1);
  expect(sources[0].sourceId).toBe("hexclave.config.ts");

  // Both of that tenancy's services point at it, and a service in another tenancy points at
  // that tenancy's own source rather than being merged across the boundary.
  const services = await sql<{ id: string, sourceRowId: string }[]>`
    SELECT "id", "sourceRowId" FROM "DeploymentService" WHERE "id" = ANY(${context.serviceIds}::uuid[])
  `;
  expect(services.length).toBe(3);
  expect(services.filter((service) => service.sourceRowId === sources[0].id).length).toBe(2);
  const [otherSource] = await sql<{ id: string }[]>`
    SELECT "id" FROM "DeploymentSource" WHERE "tenancyId" = ${context.otherTenancyId}::uuid
  `;
  expect(services.filter((service) => service.sourceRowId === otherSource.id).length).toBe(1);
};
