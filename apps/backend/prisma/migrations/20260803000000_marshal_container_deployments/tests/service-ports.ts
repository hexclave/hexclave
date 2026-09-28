import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `test-${randomUUID()}`;
  const tenancyId = randomUUID();
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Service ports migration test', '', false)
  `;
  await sql`
    INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization")
    VALUES (${tenancyId}::uuid, NOW(), NOW(), ${projectId}, 'main', 'TRUE'::"BooleanTrue")
  `;
  const existingServiceId = randomUUID();
  await sql`
    INSERT INTO "DeploymentService" ("tenancyId", "id", "updatedAt", "serviceId")
    VALUES (${tenancyId}::uuid, ${existingServiceId}::uuid, NOW(), 'pre-existing-service')
  `;
  return { tenancyId, existingServiceId };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  // A row that predates a synced definition declares no ports at all, rather
  // than being given an invented one.
  const [existing] = await sql<{ ports: unknown }[]>`
    SELECT "ports" FROM "DeploymentService" WHERE "id" = ${context.existingServiceId}::uuid
  `;
  expect(existing.ports).toEqual({});

  // ::text::jsonb, not ::jsonb — the driver sends a JS string as jsonb already,
  // so a bare cast would store the literal STRING '{...}' (jsonb_typeof
  // 'string') instead of parsing it into an object.
  const insertPorts = (ports: string) => sql`
    INSERT INTO "DeploymentService" ("tenancyId", "id", "updatedAt", "serviceId", "ports")
    VALUES (${context.tenancyId}::uuid, ${randomUUID()}::uuid, NOW(), ${`svc-${randomUUID().slice(0, 8)}`}, ${ports}::text::jsonb)
  `;

  // The shapes that must work: one HTTP port, several ports of mixed protocols,
  // and no ports at all. None of them records visibility — that is isPublic.
  await expect(insertPorts('{"3000": {"protocol": "http"}}')).resolves.toBeDefined();
  await expect(insertPorts('{"8080": {"protocol": "http"}, "5432": {"protocol": "tcp"}, "9090": {"protocol": "http"}}'))
    .resolves.toBeDefined();
  await expect(insertPorts('{}')).resolves.toBeDefined();

  // Several ports on one service are a legal port set. Which of them the runtime
  // publishes is not recorded here at all any more: visibility is the SERVICE's,
  // in the isPublic column.
  await expect(insertPorts('{"3000": {"protocol": "http"}, "4000": {"protocol": "http"}}'))
    .resolves.toBeDefined();

  // A public service must be all-HTTP, but that is enforced in CODE, not here:
  // it is a fact about Fly's addressing model rather than about what these
  // columns may contain, so this row inserts cleanly at the database level. See
  // the note where the check used to be.
  await expect(sql`
    INSERT INTO "DeploymentService" ("tenancyId", "id", "updatedAt", "serviceId", "isPublic", "ports")
    VALUES (${context.tenancyId}::uuid, ${randomUUID()}::uuid, NOW(), ${`svc-${randomUUID().slice(0, 8)}`}, true, ${'{"5432": {"protocol": "tcp"}}'}::text::jsonb)
  `).resolves.toBeDefined();

  // The column exists and defaults to private.
  const [defaulted] = await sql<{ isPublic: boolean }[]>`
    SELECT "isPublic" FROM "DeploymentService" WHERE "id" = ${context.existingServiceId}::uuid
  `;
  expect(defaulted.isPublic).toBe(false);

  // One port, ONE spelling. "80" and "080" are different keys of one JSON object
  // but the same port, so both would be stored and the runtime would declare the
  // port twice — the "duplicates are impossible because an object cannot hold one
  // key twice" property only ever covered EXACT keys.
  await expect(insertPorts('{"80": {"protocol": "http"}, "080": {"protocol": "http"}}'))
    .rejects.toThrow(/DeploymentService_ports_entries_check/);
  await expect(insertPorts('{"08080": {"protocol": "http"}}'))
    .rejects.toThrow(/DeploymentService_ports_entries_check/);

  // Inputs that must produce a NAMED constraint violation rather than a raw
  // Postgres error: a 20-digit port key overflows a bigint, which used to escape
  // as an unhandled 500 rather than a named constraint violation.
  await expect(insertPorts('{"99999999999999999999": {"protocol": "http"}}'))
    .rejects.toThrow(/DeploymentService_ports_entries_check/);

  // A repeated port needs no constraint of its own: an object cannot hold one key
  // twice, and the canonical-spelling rule above rules out the numeric aliases
  // that would otherwise smuggle one port in under two keys.
  await expect(insertPorts('[{"port": 3000}]')).rejects.toThrow(/DeploymentService_ports_is_object_check/);

  // Entry shape. The absent-key cases are the ones a `<>` comparison would let
  // through, since jsonb_typeof of a missing key is NULL.
  for (const invalidPorts of [
    '{"0": {"protocol": "http"}}',
    '{"70000": {"protocol": "http"}}',
    '{"3000.5": {"protocol": "http"}}',
    '{"web": {"protocol": "http"}}',
    '{"3000": {"protocol": "smtp"}}',
    '{"3000": {}}',
    '{"3000": "http"}',
    '{"3000": null}',
  ]) {
    await expect(insertPorts(invalidPorts), invalidPorts).rejects.toThrow(/DeploymentService_ports_entries_check/);
  }
};
