import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `test-${randomUUID()}`;
  const tenancyId = randomUUID();
  const serviceId = randomUUID();
  const runId = randomUUID();

  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Deployment Definitions Migration Test', '', false)
  `;
  await sql`
    INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization")
    VALUES (${tenancyId}::uuid, NOW(), NOW(), ${projectId}, 'main', 'TRUE'::"BooleanTrue")
  `;
  // A pre-existing service row must survive the column additions and pick up
  // the new defaults.
  await sql`
    INSERT INTO "DeploymentService" ("tenancyId", "id", "updatedAt", "serviceId", "framework")
    VALUES (${tenancyId}::uuid, ${serviceId}::uuid, NOW(), 'api', 'nextjs')
  `;
  await sql`
    INSERT INTO "DeploymentRun" ("tenancyId", "id", "updatedAt", "deploymentServiceId", "target", "triggeredBy")
    VALUES (${tenancyId}::uuid, ${runId}::uuid, NOW(), ${serviceId}::uuid, 'production', 'migration-test')
  `;

  return { projectId, tenancyId, serviceId, runId };
};

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  // The pre-existing row got the new columns with their defaults. In
  // particular the definition fencing fields must be NULL: legacy rows have
  // no synced definition (their env lived in the dropped config section), and
  // the deploy route uses exactly these NULLs to refuse deploying them with an
  // empty env set.
  const services = await sql<{ env: unknown, definitionSyncedAt: Date | null, definitionSyncId: string | null }[]>`
    SELECT "env", "definitionSyncedAt", "definitionSyncId" FROM "DeploymentService" WHERE "id" = ${ctx.serviceId}::uuid
  `;
  expect(services[0]).toEqual({ env: {}, definitionSyncedAt: null, definitionSyncId: null });

  // The new columns are writable.
  const definitionSyncId = randomUUID();
  await sql`
    UPDATE "DeploymentService"
    SET "env" = ${sql.json({ API_KEY: { type: "secret", key: "API_KEY" } })},
        "definitionSyncedAt" = NOW(),
        "definitionSyncId" = ${definitionSyncId}::uuid
    WHERE "id" = ${ctx.serviceId}::uuid
  `;
  const updated = await sql<{ env: { API_KEY?: { key?: unknown } }, definitionSyncedAt: Date | null, definitionSyncId: string | null }[]>`
    SELECT "env", "definitionSyncedAt", "definitionSyncId" FROM "DeploymentService" WHERE "id" = ${ctx.serviceId}::uuid
  `;
  expect(updated[0].env.API_KEY?.key).toBe("API_KEY");
  expect(updated[0].definitionSyncedAt).not.toBeNull();
  expect(updated[0].definitionSyncId).toBe(definitionSyncId);

  // Existing runs start without redaction material and can receive the
  // encrypted snapshot shape used by newly-created runs.
  const preExistingRuns = await sql<{ redactionSecretsEncrypted: unknown | null }[]>`
    SELECT "redactionSecretsEncrypted" FROM "DeploymentRun" WHERE "id" = ${ctx.runId}::uuid
  `;
  expect(preExistingRuns[0]).toEqual({ redactionSecretsEncrypted: null });
  const encryptedRedactionSecrets = { edkBase64: "redaction-edk", ciphertextBase64: "redaction-ciphertext" };
  await sql`
    UPDATE "DeploymentRun"
    SET "redactionSecretsEncrypted" = ${sql.json(encryptedRedactionSecrets)}
    WHERE "id" = ${ctx.runId}::uuid
  `;
  const updatedRuns = await sql<{ redactionSecretsEncrypted: unknown | null }[]>`
    SELECT "redactionSecretsEncrypted" FROM "DeploymentRun" WHERE "id" = ${ctx.runId}::uuid
  `;
  expect(updatedRuns[0]).toEqual({ redactionSecretsEncrypted: encryptedRedactionSecrets });

  // The dev command is a config-file-only field, so the migration must NOT
  // have added a column for it (a stray column would invite a write path that
  // lets the stored copy drift from the config file).
  const devCommandColumns = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'DeploymentService'
      AND column_name = 'devCommand'
  `;
  expect(devCommandColumns).toHaveLength(0);

  // Secrets table exists and accepts rows.
  const secretId = randomUUID();
  await sql`
    INSERT INTO "ProjectSecret" ("projectId", "id", "updatedAt", "key", "encrypted")
    VALUES (${ctx.projectId}, ${secretId}::uuid, NOW(), 'API_KEY', ${sql.json({ edkBase64: "a", ciphertextBase64: "b" })})
  `;

  // One value per (project, key).
  await expect(sql`
    INSERT INTO "ProjectSecret" ("projectId", "id", "updatedAt", "key", "encrypted")
    VALUES (${ctx.projectId}, ${randomUUID()}::uuid, NOW(), 'API_KEY', ${sql.json({ edkBase64: "c", ciphertextBase64: "d" })})
  `).rejects.toThrow(/ProjectSecret_projectId_key_key/);

  // The same key is allowed for a different project.
  const otherProjectId = `test-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${otherProjectId}, NOW(), NOW(), 'Deployment Definitions Migration Test 2', '', false)
  `;
  await sql`
    INSERT INTO "ProjectSecret" ("projectId", "id", "updatedAt", "key", "encrypted")
    VALUES (${otherProjectId}, ${randomUUID()}::uuid, NOW(), 'API_KEY', ${sql.json({ edkBase64: "e", ciphertextBase64: "f" })})
  `;

  // Secrets require an existing project...
  await expect(sql`
    INSERT INTO "ProjectSecret" ("projectId", "id", "updatedAt", "key", "encrypted")
    VALUES ('nonexistent-project', ${randomUUID()}::uuid, NOW(), 'API_KEY', ${sql.json({ edkBase64: "g", ciphertextBase64: "h" })})
  `).rejects.toThrow(/ProjectSecret_projectId_fkey/);

  // ...and cascade away with their project.
  await sql`DELETE FROM "Project" WHERE "id" = ${otherProjectId}`;
  const remaining = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM "ProjectSecret" WHERE "projectId" = ${otherProjectId}
  `;
  expect(remaining[0].count).toBe("0");
};
