import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { SEQUENCE_ALLOCATION_ADVISORY_LOCK_KEY } from "@hexclave/shared/dist/config/db-sync-mappings";
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { niceFetch, STACK_BACKEND_BASE_URL, test } from '../../../../helpers';
import { withPortPrefix } from '../../../../helpers/ports';
import { Auth, backendContext, InternalApiKey, Project, User, niceBackendFetch } from '../../../backend-helpers';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import {
  TEST_TIMEOUT,
  TestDbManager,
  createProjectWithExternalDb as createProjectWithExternalDbRaw,
  verifyInExternalDb,
  verifyNotInExternalDb,
  waitForSyncedContactChannel,
  waitForSyncedContactChannelDeletion,
  waitForSyncedConnectedAccount,
  waitForSyncedConnectedAccountDeletion,
  waitForSyncedData,
  waitForSyncedDeletion,
  waitForSyncedEmailOutbox,
  waitForSyncedEmailOutboxByStatus,
  waitForSyncedRefreshToken,
  waitForSyncedRefreshTokenDeletion,

  waitForSyncedTeam,
  waitForSyncedTeamDeletion,
  waitForSyncedTeamInvitation,
  waitForSyncedTeamInvitationDeletion,
  waitForSyncedTeamMember,
  waitForSyncedTeamMemberDeletion,
  waitForSyncedTeamPermission,
  waitForSyncedTeamPermissionDeletion,
  waitForSyncedProjectPermission,
  waitForSyncedProjectPermissionDeletion,
  waitForCondition,
  waitForSyncedNotificationPreference,
  waitForTable,
  deleteSyncedRowsWithTombstones,
  getInternalDatabaseConnectionString,
  withInternalDatabase,
} from './external-db-sync-utils';

async function runQueryForCurrentProject(body: { query: string, params?: Record<string, string>, timeout_ms?: number }) {
  return await niceBackendFetch("/api/v1/analytics/query", {
    method: "POST",
    accessType: "server",
    body,
  });
}

async function waitForClickhouseUser(email: string, expectedDisplayName: string) {
  // ensure we definitely have project keys that don't expire (unlike an admin access token)
  await InternalApiKey.createAndSetProjectKeys();

  const timeoutMs = 180_000;
  const intervalMs = 2_000;
  const start = performance.now();

  let response;
  while (performance.now() - start < timeoutMs) {
    response = await runQueryForCurrentProject({
      query: "SELECT primary_email, display_name FROM users WHERE primary_email = {email:String}",
      params: {
        email,
      },
    });
    expect(response.status).toBe(200);
    if (response.body.result.length === 1 && response.body.result[0].display_name === expectedDisplayName) {
      return response;
    }
    await wait(intervalMs);
  }

  throw new HexclaveAssertionError(`Timed out waiting for ClickHouse user ${email} to sync.`, { response });
}

async function waitForClickhouseUserDeletion(email: string) {
  // ensure we definitely have project keys that don't expire (unlike an admin access token)
  await InternalApiKey.createAndSetProjectKeys();

  const timeoutMs = 180_000;
  const intervalMs = 2_000;
  const start = performance.now();

  let response;
  while (performance.now() - start < timeoutMs) {
    response = await runQueryForCurrentProject({
      query: "SELECT primary_email FROM users WHERE primary_email = {email:String}",
      params: {
        email,
      },
    });
    expect(response).toMatchObject({
      status: 200,
    });
    if (response.body.result.length === 0) {
      return response;
    }
    await wait(intervalMs);
  }

  throw new HexclaveAssertionError(`Timed out waiting for ClickHouse user ${email} to be deleted.`, { response });
}

async function waitForClickhouseEmailOutbox(id: string, expectedCount: number, deadline: number) {
  await InternalApiKey.createAndSetProjectKeys();

  const intervalMs = 2_000;

  let response;
  while (performance.now() < deadline) {
    response = await runQueryForCurrentProject({
      query: "SELECT id FROM email_outboxes WHERE id = {id:UUID}",
      params: { id },
    });
    expect(response.status).toBe(200);
    if (response.body.result.length === expectedCount) {
      return response;
    }
    await wait(intervalMs);
  }

  const state = expectedCount === 0 ? "to be deleted" : "to sync";
  throw new HexclaveAssertionError(`Timed out waiting for ClickHouse email outbox ${id} ${state}.`, { response });
}

async function allocateEmailOutboxSequence(client: Client, tenancyId: string, id: string): Promise<bigint> {
  // This mirrors the sequencer's EmailOutbox statement. Its SQL shape is pinned by the
  // backend sequence-visibility test; this e2e test only drives the real external sync path.
  const rows = await client.query<{ sequenceId: string }>(
    `
      WITH rows_to_update AS (
        SELECT "tenancyId", "id"
        FROM "EmailOutbox"
        WHERE "tenancyId" = $1::uuid
          AND "id" = $2::uuid
          AND "shouldUpdateSequenceId" = TRUE
        FOR UPDATE SKIP LOCKED
      ),
      updated_rows AS (
        UPDATE "EmailOutbox" eo
        SET "sequenceId" = nextval('global_seq_id'),
            "shouldUpdateSequenceId" = FALSE
        FROM rows_to_update r
        WHERE eo."tenancyId" = r."tenancyId"
          AND eo."id" = r."id"
        RETURNING eo."sequenceId"
      )
      SELECT "sequenceId" FROM updated_rows
    `,
    [tenancyId, id],
  );
  return BigInt(rows.rows[0]?.sequenceId ?? throwErr(`Sequencer did not update EmailOutbox ${id}`));
}

async function insertSequenceVisibilityEmail(client: Client, tenancyId: string, id: string, subject: string): Promise<void> {
  const renderedAt = new Date();
  await client.query(
    `
      INSERT INTO "EmailOutbox"
        ("tenancyId", "id", "createdAt", "updatedAt", "tsxSource", "isHighPriority", "to", "extraRenderVariables",
         "shouldSkipDeliverabilityCheck", "createdWith", "renderedByWorkerId", "startedRenderingAt",
         "finishedRenderingAt", "renderedHtml", "renderedSubject", "renderedIsTransactional",
         "scheduledAt", "isQueued", "isPaused", "startedSendingAt", "finishedSendingAt", "canHaveDeliveryInfo",
         "shouldUpdateSequenceId")
      VALUES
        ($1::uuid, $2::uuid, $3, $3, '', false, $4::jsonb, '{}'::jsonb,
         true, 'PROGRAMMATIC_CALL', $5::uuid, $3, $3, '<p>sequence visibility test</p>',
         $6, true, $3, false, true, null, null, null, false)
    `,
    [
      tenancyId,
      id,
      renderedAt,
      JSON.stringify({ type: "custom-emails", emails: [`sequence-visibility-${id}@example.com`] }),
      randomUUID(),
      subject,
    ],
  );
}

async function triggerExternalDbSync(tenancyId: string): Promise<void> {
  const response = await niceFetch(new URL("/api/latest/internal/external-db-sync/sync-engine", STACK_BACKEND_BASE_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "upstash-signature": "test-bypass",
    },
    body: JSON.stringify({ tenancyId }),
  });
  expect(response.status).toBe(200);
}

async function triggerExternalDbSequencer(): Promise<void> {
  const cronSecret = getEnvVariable("CRON_SECRET", "") || throwErr("Sequence visibility e2e test requires CRON_SECRET");
  const url = new URL("/api/latest/internal/external-db-sync/sequencer", STACK_BACKEND_BASE_URL);
  url.searchParams.set("maxDurationMs", "500");
  const response = await niceFetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${cronSecret}`,
    },
  });
  expect(response.status).toBe(200);
}

async function waitForEmailOutboxSequence(
  id: string,
  reader: "primary" | "replica",
  retry?: () => Promise<void>,
): Promise<bigint> {
  const connectionString = reader === "replica"
    ? getEnvVariable(
      "STACK_DATABASE_REPLICA_CONNECTION_STRING",
      // Match prisma-client.tsx: use the primary when no replica is configured.
      getEnvVariable("STACK_DATABASE_CONNECTION_STRING", ""),
    )
    : null;
  if (reader === "replica" && connectionString === "") {
    throwErr("Sequence visibility e2e test requires a database replica connection string");
  }
  const client = connectionString == null ? null : new Client({ connectionString });
  if (client != null) await client.connect();
  try {
    let sequenceId: bigint | undefined;
    await waitForCondition(async () => {
      if (retry != null) await retry();
      if (client != null) {
        const result = await client.query<{ sequenceId: string | null }>(
          `SELECT "sequenceId" FROM "EmailOutbox" WHERE "id" = $1`,
          [id],
        );
        const value = result.rows[0]?.sequenceId;
        if (value != null) sequenceId = BigInt(value);
      } else {
        await withInternalDatabase(async (primaryClient) => {
          const result = await primaryClient.query<{ sequenceId: string | null }>(
            `SELECT "sequenceId" FROM "EmailOutbox" WHERE "id" = $1`,
            [id],
          );
          const value = result.rows[0]?.sequenceId;
          if (value != null) sequenceId = BigInt(value);
        });
      }
      return sequenceId != null;
    }, {
      timeoutMs: 15_000,
      intervalMs: 250,
      description: `EmailOutbox ${id} to receive a sequence ID on the ${reader} sync reader`,
    });
    return sequenceId ?? throwErr(`The ${reader} sync reader did not return a sequence ID for EmailOutbox ${id}`);
  } finally {
    if (client != null) await client.end();
  }
}

async function waitForExternalEmailOutbox(client: Client, id: string, expectedCount: number): Promise<void> {
  await waitForCondition(
    async () => (await client.query(`SELECT "id" FROM "email_outboxes" WHERE "id" = $1`, [id])).rows.length === expectedCount,
    {
      timeoutMs: 20_000,
      intervalMs: 500,
      description: `EmailOutbox ${id} to have external row count ${expectedCount}`,
    },
  );
}

// Run tests sequentially to avoid concurrency issues with shared backend state
describe.sequential('External DB Sync - Basic Tests', () => {
  let dbManager: TestDbManager;
  const createProjectWithExternalDb = (
    externalDatabases: any,
    projectOptions?: { display_name?: string, description?: string, config?: Record<string, unknown> }
  ) => {
    return createProjectWithExternalDbRaw(
      externalDatabases,
      projectOptions,
      { projectTracker: dbManager.createdProjects }
    );
  };

  beforeAll(async () => {
    dbManager = new TestDbManager();
    await dbManager.init();
  }, 30000); // 30 second timeout for init

  afterAll(async () => {
    await dbManager.cleanup();
  }, 60000); // 60 second timeout for cleanup

  test("Updates to user are synced to ClickHouse", async ({ expect }) => {
    await Project.createAndSwitch({ config: { magic_link_enabled: true } });

    const user = await User.create({ primary_email: "clickhouse-update@example.com" });
    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: "admin",
      method: "PATCH",
      body: { display_name: "Before CH Update" },
    });

    await waitForClickhouseUser("clickhouse-update@example.com", "Before CH Update");

    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: "admin",
      method: "PATCH",
      body: { display_name: "After CH Update" },
    });

    const response = await waitForClickhouseUser("clickhouse-update@example.com", "After CH Update");
    expect(response.status).toBe(200);
    expect(response.body?.result?.[0]).toMatchObject({
      display_name: "After CH Update",
      primary_email: "clickhouse-update@example.com",
    });
  }, TEST_TIMEOUT);

  test("Syncs user sign-up risk scores to ClickHouse", async ({ expect }) => {
    await Project.createAndSwitch({ config: { magic_link_enabled: true } });

    const user = await User.create({
      primary_email: "clickhouse-risk-scores@example.com",
      display_name: "ClickHouse Risk Scores User",
    });
    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: "server",
      method: "PATCH",
      body: {
        risk_scores: {
          sign_up: {
            bot: 37,
            free_trial_abuse: 82,
          },
        },
      },
    });

    await InternalApiKey.createAndSetProjectKeys();
    const timeoutMs = 180_000;
    const intervalMs = 2_000;
    const start = performance.now();
    let response;
    while (performance.now() - start < timeoutMs) {
      response = await runQueryForCurrentProject({
        query: "SELECT sign_up_risk_score_bot, sign_up_risk_score_free_trial_abuse FROM users WHERE primary_email = {email:String}",
        params: {
          email: "clickhouse-risk-scores@example.com",
        },
      });
      expect(response.status).toBe(200);
      if (
        response.body.result.length === 1
        && response.body.result[0].sign_up_risk_score_bot === 37
        && response.body.result[0].sign_up_risk_score_free_trial_abuse === 82
      ) {
        return;
      }
      await wait(intervalMs);
    }

    throw new HexclaveAssertionError("Timed out waiting for ClickHouse user sign-up risk scores to sync.", { response });
  }, TEST_TIMEOUT);

  test("Deleted user is removed from ClickHouse view", async ({ expect }) => {
    await Project.createAndSwitch({ config: { magic_link_enabled: true } });

    const user = await User.create({ primary_email: "clickhouse-delete@example.com" });
    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: "admin",
      method: "PATCH",
      body: { display_name: "CH Delete User" },
    });

    await waitForClickhouseUser("clickhouse-delete@example.com", "CH Delete User");

    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: "admin",
      method: "DELETE",
    });

    await waitForClickhouseUserDeletion("clickhouse-delete@example.com");
  }, TEST_TIMEOUT);

  test("Syncs users to ClickHouse by default", async ({ expect }) => {
    await Project.createAndSwitch({ config: { magic_link_enabled: true } });

    const user = await User.create({ primary_email: "clickhouse-sync@example.com" });
    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: "admin",
      method: "PATCH",
      body: { display_name: "ClickHouse Sync User" },
    });

    const response = await waitForClickhouseUser("clickhouse-sync@example.com", "ClickHouse Sync User");
    expect(response.status).toBe(200);
    expect(response.body?.result?.[0]).toMatchObject({
      display_name: "ClickHouse Sync User",
      primary_email: "clickhouse-sync@example.com",
    });
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a user, patches the display name, and triggers the sync once.
   * - Checks the users table for a matching row only after the sync completes.
   *
   * Why it matters:
   * - Ensures inserts never appear externally until the sync pipeline runs.
   */
  test('Insert: New user is synced to external DB', async () => {
    const dbName = 'insert_only_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    });

    const client = dbManager.getClient(dbName);

    const user = await User.create({ primary_email: 'insert-only@example.com' });
    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { display_name: 'Insert Only User' }
    });

    await waitForSyncedData(client, 'insert-only@example.com', 'Insert Only User');

    await verifyInExternalDb(client, 'insert-only@example.com', 'Insert Only User');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Exports a baseline row, mutates the display name, runs another sync, and reads users table.
   * - Compares the stored display name to guarantee it reflects the latest mutation.
   *
   * Why it matters:
   * - Proves updates propagate to the external DB instead of leaving stale data.
   */
  test('Update: Existing user changes are reflected in external DB', async () => {
    const dbName = 'update_only_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    });

    const client = dbManager.getClient(dbName);

    const user = await User.create({ primary_email: 'update-only@example.com' });
    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { display_name: 'Before Update' }
    });

    await waitForSyncedData(client, 'update-only@example.com', 'Before Update');

    await verifyInExternalDb(client, 'update-only@example.com', 'Before Update');

    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { display_name: 'After Update' }
    });

    await waitForSyncedData(client, 'update-only@example.com', 'After Update');

    await verifyInExternalDb(client, 'update-only@example.com', 'After Update');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Syncs a user into the users table, deletes the user internally, and waits for the deletion helper.
   * - Queries users table to ensure the row disappears.
   *
   * Why it matters:
   * - Validates deletion events propagate and prevent orphaned rows in external DBs.
   */
  test('Delete: Deleted user is removed from external DB', async () => {
    const dbName = 'delete_only_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    }, {
      display_name: '🗑️ Delete Test Project',
      description: 'Testing deletion sync to external database'
    });

    const client = dbManager.getClient(dbName);

    const user = await User.create({ primary_email: 'delete-only@example.com' });
    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { display_name: 'Delete Only User' }
    });

    await waitForSyncedData(client, 'delete-only@example.com', 'Delete Only User');

    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'DELETE',
    });
    const deletedUserResponse = await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'GET',
    });
    expect(deletedUserResponse.status).toBe(404);

    await waitForSyncedDeletion(client, 'delete-only@example.com');
    await verifyNotInExternalDb(client, 'delete-only@example.com');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a user while verifying the users table is absent before sync.
   * - Triggers sync, waits for table creation, and confirms the row appears afterward.
   *
   * Why it matters:
   * - Demonstrates that syncs control both table provisioning and data export timing.
   */
  test('Sync Mechanism Verification: Data appears ONLY after sync', async () => {
    const dbName = 'sync_verification_test';
    const connectionString = await dbManager.createDatabase(dbName);

    const client = dbManager.getClient(dbName);

    // Verify the fresh database has no users table BEFORE we configure sync
    const tableCheckBefore = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public'
        AND table_name = 'users'
      );
    `);
    expect(tableCheckBefore.rows[0].exists).toBe(false);

    // Now configure the external DB - this will trigger sync
    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    }, {
      display_name: '🔄 Sync Verification Test Project',
      description: 'Testing that data only appears after sync is triggered'
    });

    const user = await User.create({ primary_email: 'sync-verify@example.com' });
    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { display_name: 'Sync Verify User' }
    });

    // Wait for sync to create the table and populate data
    await waitForTable(client, 'users');

    await waitForSyncedData(client, 'sync-verify@example.com', 'Sync Verify User');
    await verifyInExternalDb(client, 'sync-verify@example.com', 'Sync Verify User');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Runs create, update, and delete actions in order while syncing between each step.
   * - Verifies the users table reflects each intermediate state.
   *
   * Why it matters:
   * - Confirms the sync handles the entire lifecycle without leaving stale records.
   */
  test('Full CRUD Lifecycle: Create, Update, Delete', async () => {
    const dbName = 'crud_lifecycle_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    });

    const client = dbManager.getClient(dbName);

    const user = await User.create({ primary_email: 'crud-test@example.com' });
    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { display_name: 'Original Name' }
    });

    await waitForSyncedData(client, 'crud-test@example.com', 'Original Name');

    await verifyInExternalDb(client, 'crud-test@example.com', 'Original Name');

    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { display_name: 'Updated Name' }
    });

    await waitForSyncedData(client, 'crud-test@example.com', 'Updated Name');
    await verifyInExternalDb(client, 'crud-test@example.com', 'Updated Name');

    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'DELETE',
    });

    await waitForSyncedDeletion(client, 'crud-test@example.com');

    await verifyNotInExternalDb(client, 'crud-test@example.com');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Syncs a user into an empty database to trigger table auto-creation.
   * - Queries `information_schema` and users table to confirm the table and row exist.
   *
   * Why it matters:
   * - Ensures mappings can provision their own schema without manual migrations.
   */
  test('Automatic Table Creation', async () => {
    const dbName = 'auto_table_creation_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    });

    const user = await User.create({ primary_email: 'auto-create@example.com' });
    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { display_name: 'Auto Create User' }
    });

    const client = dbManager.getClient(dbName);

    await waitForSyncedData(client, 'auto-create@example.com', 'Auto Create User');

    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public'
        AND table_name = 'users'
      );
    `);
    expect(tableCheck.rows[0].exists).toBe(true);
    await verifyInExternalDb(client, 'auto-create@example.com', 'Auto Create User');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Configures one valid and one invalid external DB mapping for the same project.
   * - Runs sync and verifies the healthy DB still receives the exported row.
   *
   * Why it matters:
   * - Shows a failing database connection does not block successful targets.
   */
  test('Resilience: One bad DB should not crash the sync', async () => {
    const goodDbName = 'resilience_good_db';
    const goodConnectionString = await dbManager.createDatabase(goodDbName);
    const badConnectionString = 'postgresql://invalid:invalid@invalid:5432/invalid';

    await createProjectWithExternalDb({
      good_db: {
        type: 'postgres',
        connectionString: goodConnectionString,
      },
      bad_db: {
        type: 'postgres',
        connectionString: badConnectionString,
      }
    });

    const user = await User.create({ primary_email: 'resilience@example.com' });
    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { display_name: 'Resilience User' }
    });

    await waitForSyncedData(dbManager.getClient(goodDbName), 'resilience@example.com', 'Resilience User');

    const client = dbManager.getClient(goodDbName);
    const res = await client.query(`SELECT * FROM "users" WHERE "primary_email" = $1`, ['resilience@example.com']);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].display_name).toBe('Resilience User');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a user with a primary email and adds a secondary email.
   * - Verifies only one user row exists (the new schema is user-centric, not channel-centric).
   * - Confirms the primary_email field contains the primary email.
   *
   * Why it matters:
   * - Validates that the new user-centric schema syncs users, not individual contact channels.
   */
  test('User with multiple emails: Only one row synced with primary email', async () => {
    const dbName = 'multi_email_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    });

    const client = dbManager.getClient(dbName);

    const user = await User.create({ primary_email: 'primary@example.com' });
    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { display_name: 'Multi Email User' }
    });

    // Add a secondary email
    const secondEmailResponse = await niceBackendFetch(`/api/v1/contact-channels`, {
      accessType: 'admin',
      method: 'POST',
      body: {
        user_id: user.userId,
        type: 'email',
        value: 'secondary@example.com',
        is_verified: false,
        used_for_auth: false,
      }
    });
    expect(secondEmailResponse.status).toBe(201);

    await waitForSyncedData(client, 'primary@example.com', 'Multi Email User');

    // Should only have ONE row per user (the new schema is user-centric)
    const allRows = await client.query(`SELECT * FROM "users"`);
    expect(allRows.rows.length).toBe(1);

    // The row should have the primary email
    expect(allRows.rows[0].primary_email).toBe('primary@example.com');
    expect(allRows.rows[0].display_name).toBe('Multi Email User');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a user, updates it multiple times, verifies each update is reflected.
   * - Checks that the metadata table tracks the last synced sequence_id.
   *
   * Why it matters:
   * - Demonstrates that updates are properly synced and metadata tracking works.
   */
  test('Updates are synced correctly and metadata tracks progress', async () => {
    const dbName = 'update_tracking_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    });

    const client = dbManager.getClient(dbName);

    const user = await User.create({ primary_email: 'update-test@example.com' });
    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { display_name: 'Original Name' }
    });

    await waitForSyncedData(client, 'update-test@example.com', 'Original Name');
    await verifyInExternalDb(client, 'update-test@example.com', 'Original Name');

    // Check metadata table exists and has a positive sequence_id
    const metadata1 = await client.query(
      `SELECT "last_synced_sequence_id" FROM "_stack_sync_metadata" WHERE "mapping_name" = 'users'`
    );
    expect(metadata1.rows.length).toBe(1);
    const seq1 = Number(metadata1.rows[0].last_synced_sequence_id);
    expect(seq1).toBeGreaterThan(0);

    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { display_name: 'Updated Name' }
    });

    await waitForSyncedData(client, 'update-test@example.com', 'Updated Name');
    await verifyInExternalDb(client, 'update-test@example.com', 'Updated Name');

    // Metadata should have advanced
    const metadata2 = await client.query(
      `SELECT "last_synced_sequence_id" FROM "_stack_sync_metadata" WHERE "mapping_name" = 'users'`
    );
    const seq2 = Number(metadata2.rows[0].last_synced_sequence_id);
    expect(seq2).toBeGreaterThan(seq1);
  }, TEST_TIMEOUT);


  /**
   * What it does:
   * - Creates a team, verifies it in the external DB, updates it, verifies the update,
   *   deletes it, and verifies the removal.
   */
  test('Team CRUD sync (Postgres)', async () => {
    const dbName = 'team_crud_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    });

    const client = dbManager.getClient(dbName);

    // Create a team
    const createResponse = await niceBackendFetch('/api/v1/teams', {
      accessType: 'admin',
      method: 'POST',
      body: { display_name: 'Sync Test Team' },
    });
    expect(createResponse.status).toBe(201);
    const teamId = createResponse.body.id;

    await waitForSyncedTeam(client, 'Sync Test Team');

    const res1 = await client.query(`SELECT * FROM "teams" WHERE "id" = $1`, [teamId]);
    expect(res1.rows.length).toBe(1);
    expect(res1.rows[0].display_name).toBe('Sync Test Team');

    // Update the team
    await niceBackendFetch(`/api/v1/teams/${teamId}`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { display_name: 'Updated Team Name' },
    });

    await waitForSyncedTeam(client, 'Updated Team Name');

    const res2 = await client.query(`SELECT * FROM "teams" WHERE "id" = $1`, [teamId]);
    expect(res2.rows[0].display_name).toBe('Updated Team Name');

    // Delete the team
    await niceBackendFetch(`/api/v1/teams/${teamId}`, {
      accessType: 'admin',
      method: 'DELETE',
    });

    await waitForSyncedTeamDeletion(client, teamId);
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a team and verifies it appears via the ClickHouse analytics query API.
   */
  test('Team sync (ClickHouse)', async ({ expect }) => {
    await Project.createAndSwitch({ config: { magic_link_enabled: true } });

    const createResponse = await niceBackendFetch('/api/v1/teams', {
      accessType: 'admin',
      method: 'POST',
      body: { display_name: 'CH Team Test' },
    });
    expect(createResponse.status).toBe(201);

    await InternalApiKey.createAndSetProjectKeys();

    const timeoutMs = 180_000;
    const intervalMs = 2_000;
    const start = performance.now();

    let response;
    while (performance.now() - start < timeoutMs) {
      response = await runQueryForCurrentProject({
        query: "SELECT display_name FROM teams WHERE display_name = {name:String}",
        params: { name: 'CH Team Test' },
      });
      expect(response.status).toBe(200);
      if (response.body.result.length === 1) {
        break;
      }
      await wait(intervalMs);
    }

    expect(response!.body.result.length).toBe(1);
    expect(response!.body.result[0].display_name).toBe('CH Team Test');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a user and team, adds the user as a member, verifies in external DB,
   *   removes the member, and verifies removal.
   */
  test('TeamMember CRUD sync (Postgres)', async () => {
    const dbName = 'team_member_crud_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    });

    const client = dbManager.getClient(dbName);

    const user = await User.create({ primary_email: 'tm-crud@example.com' });
    const createTeamResponse = await niceBackendFetch('/api/v1/teams', {
      accessType: 'admin',
      method: 'POST',
      body: { display_name: 'TM CRUD Team' },
    });
    expect(createTeamResponse.status).toBe(201);
    const teamId = createTeamResponse.body.id;

    // Add user as team member
    const addMemberResponse = await niceBackendFetch(`/api/v1/team-memberships/${teamId}/${user.userId}`, {
      accessType: 'admin',
      method: 'POST',
      body: {},
    });
    expect(addMemberResponse.status).toBe(201);

    await waitForSyncedTeamMember(client, teamId, user.userId);

    const res1 = await client.query(`SELECT * FROM "team_member_profiles" WHERE "team_id" = $1 AND "user_id" = $2`, [teamId, user.userId]);
    expect(res1.rows.length).toBe(1);

    // Remove member
    await niceBackendFetch(`/api/v1/team-memberships/${teamId}/${user.userId}`, {
      accessType: 'admin',
      method: 'DELETE',
    });

    await waitForSyncedTeamMemberDeletion(client, teamId, user.userId);
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a user with a primary email and verifies the contact channel appears
   *   in the external DB contact_channels table.
   */
  test('ContactChannel sync (Postgres)', async () => {
    const dbName = 'contact_channel_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    });

    const client = dbManager.getClient(dbName);

    const user = await User.create({ primary_email: 'cc-sync@example.com' });

    await waitForSyncedContactChannel(client, 'cc-sync@example.com');

    const res = await client.query(`SELECT * FROM "contact_channels" WHERE "value" = $1`, ['cc-sync@example.com']);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].user_id).toBe(user.userId);
    expect(res.rows[0].is_primary).toBe(true);
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a user in a team, deletes the user, and verifies the team_member is gone.
   */
  test('Cascade: User delete removes team members from external DB', async () => {
    const dbName = 'cascade_user_delete_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    });

    const client = dbManager.getClient(dbName);

    const user = await User.create({ primary_email: 'cascade-user-del@example.com' });
    const createTeamResponse = await niceBackendFetch('/api/v1/teams', {
      accessType: 'admin',
      method: 'POST',
      body: { display_name: 'Cascade User Team' },
    });
    const teamId = createTeamResponse.body.id;

    await niceBackendFetch(`/api/v1/team-memberships/${teamId}/${user.userId}`, {
      accessType: 'admin',
      method: 'POST',
      body: {},
    });

    await waitForSyncedTeamMember(client, teamId, user.userId);

    // Delete the user — should cascade-delete the team member
    await niceBackendFetch(`/api/v1/users/${user.userId}`, {
      accessType: 'admin',
      method: 'DELETE',
    });

    await waitForSyncedTeamMemberDeletion(client, teamId, user.userId);
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a team with a member, deletes the team, and verifies both team and member are gone.
   */
  test('Cascade: Team delete removes team and members from external DB', async () => {
    const dbName = 'cascade_team_delete_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    });

    const client = dbManager.getClient(dbName);

    const user = await User.create({ primary_email: 'cascade-team-del@example.com' });
    const createTeamResponse = await niceBackendFetch('/api/v1/teams', {
      accessType: 'admin',
      method: 'POST',
      body: { display_name: 'Cascade Team' },
    });
    const teamId = createTeamResponse.body.id;

    await niceBackendFetch(`/api/v1/team-memberships/${teamId}/${user.userId}`, {
      accessType: 'admin',
      method: 'POST',
      body: {},
    });

    await waitForSyncedTeamMember(client, teamId, user.userId);
    await waitForSyncedTeam(client, 'Cascade Team');

    // Delete the team — should cascade-delete the member too
    await niceBackendFetch(`/api/v1/teams/${teamId}`, {
      accessType: 'admin',
      method: 'DELETE',
    });

    await waitForSyncedTeamDeletion(client, teamId);
    await waitForSyncedTeamMemberDeletion(client, teamId, user.userId);
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a team, adds a member, grants a permission, verifies in external DB,
   *   revokes the permission, and verifies removal.
   */
  test('TeamPermission CRUD sync (Postgres)', async () => {
    const dbName = 'team_permission_crud_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    });

    const client = dbManager.getClient(dbName);

    const user = await User.create({ primary_email: 'tp-crud@example.com' });
    const createTeamResponse = await niceBackendFetch('/api/v1/teams', {
      accessType: 'admin',
      method: 'POST',
      body: { display_name: 'TP CRUD Team' },
    });
    expect(createTeamResponse.status).toBe(201);
    const teamId = createTeamResponse.body.id;

    // Add user as team member
    const addMemberResponse = await niceBackendFetch(`/api/v1/team-memberships/${teamId}/${user.userId}`, {
      accessType: 'admin',
      method: 'POST',
      body: {},
    });
    expect(addMemberResponse.status).toBe(201);

    // Grant a permission
    const grantResponse = await niceBackendFetch(`/api/v1/team-permissions/${teamId}/${user.userId}/$read_members`, {
      accessType: 'admin',
      method: 'POST',
      body: {},
    });
    expect(grantResponse.status).toBe(201);

    await waitForSyncedTeamPermission(client, teamId, user.userId, '$read_members');

    const res1 = await client.query(`SELECT * FROM "team_permissions" WHERE "team_id" = $1 AND "user_id" = $2 AND "permission_id" = $3`, [teamId, user.userId, '$read_members']);
    expect(res1.rows.length).toBe(1);

    // Revoke the permission
    await niceBackendFetch(`/api/v1/team-permissions/${teamId}/${user.userId}/$read_members`, {
      accessType: 'admin',
      method: 'DELETE',
    });

    await waitForSyncedTeamPermissionDeletion(client, teamId, user.userId, '$read_members');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a team + member + permission, queries ClickHouse analytics API to verify.
   */
  test('TeamPermission sync (ClickHouse)', async ({ expect }) => {
    await Project.createAndSwitch({ config: { magic_link_enabled: true } });

    const user = await User.create({ primary_email: 'tp-ch@example.com' });
    const createTeamResponse = await niceBackendFetch('/api/v1/teams', {
      accessType: 'admin',
      method: 'POST',
      body: { display_name: 'TP CH Team' },
    });
    expect(createTeamResponse.status).toBe(201);
    const teamId = createTeamResponse.body.id;

    await niceBackendFetch(`/api/v1/team-memberships/${teamId}/${user.userId}`, {
      accessType: 'admin',
      method: 'POST',
      body: {},
    });

    await niceBackendFetch(`/api/v1/team-permissions/${teamId}/${user.userId}/$read_members`, {
      accessType: 'admin',
      method: 'POST',
      body: {},
    });

    await InternalApiKey.createAndSetProjectKeys();

    const timeoutMs = 180_000;
    const intervalMs = 2_000;
    const start = performance.now();

    let response;
    while (performance.now() - start < timeoutMs) {
      response = await runQueryForCurrentProject({
        query: "SELECT team_id, user_id, id FROM team_permissions WHERE id = {perm:String}",
        params: { perm: '$read_members' },
      });
      expect(response.status).toBe(200);
      if (response.body.result.length === 1) {
        break;
      }
      await wait(intervalMs);
    }

    expect(response!.body.result.length).toBe(1);
    expect(response!.body.result[0].id).toBe('$read_members');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a user, grants a project permission, verifies in external DB,
   *   revokes the permission, and verifies removal.
   */
  test('ProjectPermission CRUD sync (Postgres)', async () => {
    const dbName = 'project_permission_crud_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    });

    const client = dbManager.getClient(dbName);

    // Create a project permission definition via config
    await Project.updateConfig({
      "rbac.permissions": { "test_perm": { scope: "project" } },
    });

    const user = await User.create({ primary_email: 'pp-crud@example.com' });

    // Grant a project permission
    const grantResponse = await niceBackendFetch(`/api/v1/project-permissions/${user.userId}/test_perm`, {
      accessType: 'admin',
      method: 'POST',
      body: {},
    });
    expect(grantResponse.status).toBe(201);

    await waitForSyncedProjectPermission(client, user.userId, 'test_perm');

    const res1 = await client.query(`SELECT * FROM "project_permissions" WHERE "user_id" = $1 AND "permission_id" = $2`, [user.userId, 'test_perm']);
    expect(res1.rows.length).toBe(1);

    // Revoke the permission
    await niceBackendFetch(`/api/v1/project-permissions/${user.userId}/test_perm`, {
      accessType: 'admin',
      method: 'DELETE',
    });

    await waitForSyncedProjectPermissionDeletion(client, user.userId, 'test_perm');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a user + project permission, queries ClickHouse analytics API to verify.
   */
  test('ProjectPermission sync (ClickHouse)', async ({ expect }) => {
    await Project.createAndSwitch({ config: { magic_link_enabled: true } });

    // Create a project permission definition via config
    await Project.updateConfig({
      "rbac.permissions": { "ch_test_perm": { scope: "project" } },
    });

    const user = await User.create({ primary_email: 'pp-ch@example.com' });

    await niceBackendFetch(`/api/v1/project-permissions/${user.userId}/ch_test_perm`, {
      accessType: 'admin',
      method: 'POST',
      body: {},
    });

    await InternalApiKey.createAndSetProjectKeys();

    const timeoutMs = 180_000;
    const intervalMs = 2_000;
    const start = performance.now();

    let response;
    while (performance.now() - start < timeoutMs) {
      response = await runQueryForCurrentProject({
        query: "SELECT user_id, id FROM project_permissions WHERE id = {perm:String}",
        params: { perm: 'ch_test_perm' },
      });
      expect(response.status).toBe(200);
      if (response.body.result.length === 1) {
        break;
      }
      await wait(intervalMs);
    }

    expect(response!.body.result.length).toBe(1);
    expect(response!.body.result[0].id).toBe('ch_test_perm');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a user, updates a notification preference, verifies in external DB.
   */
  test('NotificationPreference sync (Postgres)', async () => {
    const dbName = 'notification_pref_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    });

    const client = dbManager.getClient(dbName);

    const user = await User.create({ primary_email: 'np-crud@example.com' });

    // Update a notification preference
    const updateResponse = await niceBackendFetch(`/api/v1/emails/notification-preference/${user.userId}/4f6f8873-3d04-46bd-8bef-18338b1a1b4c`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { enabled: false },
    });
    expect(updateResponse.status).toBe(200);

    await waitForSyncedNotificationPreference(client, user.userId, '4f6f8873-3d04-46bd-8bef-18338b1a1b4c');

    const res1 = await client.query(`SELECT * FROM "notification_preferences" WHERE "user_id" = $1 AND "notification_category_id" = $2`, [user.userId, '4f6f8873-3d04-46bd-8bef-18338b1a1b4c']);
    expect(res1.rows.length).toBe(1);
    expect(res1.rows[0].enabled).toBe(false);
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a user + notification preference, queries ClickHouse analytics API to verify.
   */
  test('NotificationPreference sync (ClickHouse)', async ({ expect }) => {
    await Project.createAndSwitch({ config: { magic_link_enabled: true } });

    const user = await User.create({ primary_email: 'np-ch@example.com' });

    await niceBackendFetch(`/api/v1/emails/notification-preference/${user.userId}/4f6f8873-3d04-46bd-8bef-18338b1a1b4c`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { enabled: false },
    });

    await InternalApiKey.createAndSetProjectKeys();

    const timeoutMs = 180_000;
    const intervalMs = 2_000;
    const start = performance.now();

    let response;
    while (performance.now() - start < timeoutMs) {
      response = await runQueryForCurrentProject({
        query: "SELECT user_id, notification_category_id, enabled FROM notification_preferences WHERE notification_category_id = {cat:String}",
        params: { cat: '4f6f8873-3d04-46bd-8bef-18338b1a1b4c' },
      });
      expect(response.status).toBe(200);
      if (response.body.result.length === 1) {
        break;
      }
      await wait(intervalMs);
    }

    expect(response!.body.result.length).toBe(1);
    expect(response!.body.result[0].notification_category_id).toBe('4f6f8873-3d04-46bd-8bef-18338b1a1b4c');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Sends a team invitation, verifies in external DB, revokes it, verifies removal.
   */
  test('TeamInvitation sync (Postgres)', async () => {
    const dbName = 'team_invitation_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    }, { display_name: 'Invitation Test Project' });

    const client = dbManager.getClient(dbName);

    const createTeamResponse = await niceBackendFetch('/api/v1/teams', {
      accessType: 'admin',
      method: 'POST',
      body: { display_name: 'Invitation Team' },
    });
    expect(createTeamResponse.status).toBe(201);
    const teamId = createTeamResponse.body.id;

    // Send a team invitation
    const inviteResponse = await niceBackendFetch('/api/v1/team-invitations/send-code', {
      accessType: 'admin',
      method: 'POST',
      body: { team_id: teamId, email: 'invited@example.com', callback_url: 'http://localhost:12345/callback' },
    });
    expect(inviteResponse.status).toBe(200);

    await waitForSyncedTeamInvitation(client, 'invited@example.com');

    const res1 = await client.query(`SELECT * FROM "team_invitations" WHERE "recipient_email" = $1`, ['invited@example.com']);
    expect(res1.rows.length).toBe(1);
    expect(res1.rows[0].team_display_name).toBe('Invitation Team');
    const invitationId = res1.rows[0].id;

    // Revoke the invitation
    await niceBackendFetch(`/api/v1/team-invitations/${invitationId}?team_id=${teamId}`, {
      accessType: 'admin',
      method: 'DELETE',
    });

    await waitForSyncedTeamInvitationDeletion(client, invitationId);
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Sends a team invitation, renames the team, and verifies team_display_name updates externally.
   *
   * Why it matters:
   * - Covers the sequencer cascade that marks TEAM_INVITATION rows for re-sync on team updates.
   */
  test('TeamInvitation sync updates display name after team rename (Postgres)', async () => {
    const dbName = 'team_invitation_team_rename_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    }, { display_name: 'Invitation Rename Test Project' });

    const client = dbManager.getClient(dbName);
    const initialTeamName = 'Invitation Team Before Rename';
    const updatedTeamName = 'Invitation Team After Rename';
    const invitedEmail = `team-rename-${randomUUID()}@example.com`;

    const createTeamResponse = await niceBackendFetch('/api/v1/teams', {
      accessType: 'admin',
      method: 'POST',
      body: { display_name: initialTeamName },
    });
    expect(createTeamResponse.status).toBe(201);
    const teamId = createTeamResponse.body.id;

    const inviteResponse = await niceBackendFetch('/api/v1/team-invitations/send-code', {
      accessType: 'admin',
      method: 'POST',
      body: { team_id: teamId, email: invitedEmail, callback_url: 'http://localhost:12345/callback' },
    });
    expect(inviteResponse.status).toBe(200);

    await waitForSyncedTeamInvitation(client, invitedEmail);

    const initialInvitation = await client.query(
      `SELECT "team_display_name" FROM "team_invitations" WHERE "recipient_email" = $1`,
      [invitedEmail],
    );
    expect(initialInvitation.rows.length).toBe(1);
    expect(initialInvitation.rows[0].team_display_name).toBe(initialTeamName);

    const updateTeamResponse = await niceBackendFetch(`/api/v1/teams/${teamId}`, {
      accessType: 'admin',
      method: 'PATCH',
      body: { display_name: updatedTeamName },
    });
    expect(updateTeamResponse.status).toBe(200);

    await waitForCondition(
      async () => {
        const updatedInvitation = await client.query(
          `SELECT "team_display_name" FROM "team_invitations" WHERE "recipient_email" = $1`,
          [invitedEmail],
        );
        return updatedInvitation.rows.length === 1 && updatedInvitation.rows[0].team_display_name === updatedTeamName;
      },
      {
        timeoutMs: 180_000,
        intervalMs: 500,
        description: `team invitation for ${invitedEmail} to reflect renamed team`,
      },
    );

    const finalInvitation = await client.query(
      `SELECT "team_display_name" FROM "team_invitations" WHERE "recipient_email" = $1`,
      [invitedEmail],
    );
    expect(finalInvitation.rows.length).toBe(1);
    expect(finalInvitation.rows[0].team_display_name).toBe(updatedTeamName);
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Sends a team invitation, queries ClickHouse analytics API to verify.
   */
  test('TeamInvitation sync (ClickHouse)', async ({ expect }) => {
    await Project.createAndSwitch({ config: { magic_link_enabled: true } });

    const createTeamResponse = await niceBackendFetch('/api/v1/teams', {
      accessType: 'admin',
      method: 'POST',
      body: { display_name: 'CH Invitation Team' },
    });
    expect(createTeamResponse.status).toBe(201);
    const teamId = createTeamResponse.body.id;

    await niceBackendFetch('/api/v1/team-invitations/send-code', {
      accessType: 'admin',
      method: 'POST',
      body: { team_id: teamId, email: 'ch-invited@example.com', callback_url: 'http://localhost:12345/callback' },
    });

    await InternalApiKey.createAndSetProjectKeys();

    const timeoutMs = 180_000;
    const intervalMs = 2_000;
    const start = performance.now();

    let response;
    while (performance.now() - start < timeoutMs) {
      response = await runQueryForCurrentProject({
        query: "SELECT recipient_email, team_display_name FROM team_invitations WHERE recipient_email = {email:String}",
        params: { email: 'ch-invited@example.com' },
      });
      expect(response.status).toBe(200);
      if (response.body.result.length === 1) {
        break;
      }
      await wait(intervalMs);
    }

    expect(response!.body.result.length).toBe(1);
    expect(response!.body.result[0].recipient_email).toBe('ch-invited@example.com');
    expect(response!.body.result[0].team_display_name).toBe('CH Invitation Team');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a team with a member and permission, deletes the team,
   *   verifies team, member, and permissions are all gone.
   */
  test('Cascade: Team delete removes permissions and invitations from external DB', async () => {
    const dbName = 'cascade_team_perm_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    });

    const client = dbManager.getClient(dbName);

    const user = await User.create({ primary_email: 'cascade-perm@example.com' });
    const createTeamResponse = await niceBackendFetch('/api/v1/teams', {
      accessType: 'admin',
      method: 'POST',
      body: { display_name: 'Cascade Perm Team' },
    });
    const teamId = createTeamResponse.body.id;

    await niceBackendFetch(`/api/v1/team-memberships/${teamId}/${user.userId}`, {
      accessType: 'admin',
      method: 'POST',
      body: {},
    });

    await niceBackendFetch(`/api/v1/team-permissions/${teamId}/${user.userId}/$read_members`, {
      accessType: 'admin',
      method: 'POST',
      body: {},
    });

    await waitForSyncedTeamPermission(client, teamId, user.userId, '$read_members');
    await waitForSyncedTeam(client, 'Cascade Perm Team');

    // Delete the team — should cascade-delete permissions too
    await niceBackendFetch(`/api/v1/teams/${teamId}`, {
      accessType: 'admin',
      method: 'DELETE',
    });

    await waitForSyncedTeamDeletion(client, teamId);
    await waitForSyncedTeamPermissionDeletion(client, teamId, user.userId, '$read_members');
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a project with email config, sends an email, and verifies
   *   the email outbox row is synced to the external Postgres DB.
   */
  test('EmailOutbox sync (Postgres)', async () => {
    const dbName = 'email_outbox_pg_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    }, {
      display_name: 'Email Outbox Sync Test',
      config: {
        email_config: {
          type: "standard",
          host: "localhost",
          port: Number(withPortPrefix("29")),
          username: "test",
          password: "test",
          sender_name: "Test Project",
          sender_email: "test@example.com",
        },
      },
    });

    // Create a user
    const createUserResponse = await niceBackendFetch("/api/v1/users", {
      method: "POST",
      accessType: "server",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
        primary_email_verified: true,
      },
    });
    expect(createUserResponse.status).toBe(201);
    const userId = createUserResponse.body.id;

    // Send an email
    const sendResponse = await niceBackendFetch("/api/v1/emails/send-email", {
      method: "POST",
      accessType: "server",
      body: {
        user_ids: [userId],
        html: "<p>Sync test email</p>",
        subject: "DB Sync Test Email",
        notification_category_name: "Transactional",
      },
    });
    expect(sendResponse.status).toBe(200);

    // Poll the outbox API until the email appears
    let emailId!: string;
    await waitForCondition(
      async () => {
        const listResponse = await niceBackendFetch("/api/v1/emails/outbox", {
          method: "GET",
          accessType: "server",
        });
        if (listResponse.status !== 200 || listResponse.body.items.length === 0) return false;
        emailId = listResponse.body.items[0].id;
        return true;
      },
      { timeoutMs: 30_000, intervalMs: 500, description: 'email to appear in outbox' }
    );

    const client = dbManager.getClient(dbName);

    // Wait for the email outbox row to appear in external DB
    await waitForSyncedEmailOutbox(client, emailId);

    // Verify the synced row has expected columns
    const res = await client.query(`SELECT * FROM "email_outboxes" WHERE "id" = $1`, [emailId]);
    expect(res.rows.length).toBe(1);
    const row = res.rows[0];
    expect(row.created_with).toBe('PROGRAMMATIC_CALL');
    expect(row.is_high_priority).toBe(false);
    expect(row.is_paused).toBe(false);
  }, TEST_TIMEOUT);

  test("Sequence allocation visibility does not permanently skip an EmailOutbox row", async () => {
    const dbName = "sequence_visibility_race_test";
    const connectionString = await dbManager.createDatabase(dbName);
    const project = await createProjectWithExternalDb({
      main: {
        type: "postgres",
        connectionString,
      },
    });
    const externalClient = dbManager.getClient(dbName);
    const rowA = randomUUID();
    const rowB = randomUUID();
    const baselineRow = randomUUID();
    const transactionA = new Client({
      connectionString: getInternalDatabaseConnectionString(),
    });

    let tenancyId: string | undefined;
    let transactionAStarted = false;
    try {
      await withInternalDatabase(async (client) => {
        const tenancy = await client.query<{ id: string }>(
          `SELECT "id" FROM "Tenancy" WHERE "projectId" = $1 AND "branchId" = 'main' LIMIT 1`,
          [project.projectId],
        );
        tenancyId = tenancy.rows[0]?.id ?? throwErr("Could not find the test project's main tenancy");
        await insertSequenceVisibilityEmail(client, tenancyId, baselineRow, "Sequence visibility baseline");
      });
      const testTenancyId = tenancyId ?? throwErr("Test project's tenancy was not initialized");

      await transactionA.connect();
      await transactionA.query("BEGIN");
      transactionAStarted = true;
      await transactionA.query("SET LOCAL lock_timeout = '5000ms'");
      await transactionA.query(`SELECT pg_advisory_xact_lock($1)`, [SEQUENCE_ALLOCATION_ADVISORY_LOCK_KEY]);
      await transactionA.query(
        `UPDATE "EmailOutbox" SET "shouldUpdateSequenceId" = TRUE WHERE "tenancyId" = $1 AND "id" = $2`,
        [testTenancyId, baselineRow],
      );
      await allocateEmailOutboxSequence(transactionA, testTenancyId, baselineRow);
      await transactionA.query("COMMIT");
      transactionAStarted = false;
      await waitForEmailOutboxSequence(baselineRow, "replica");
      await triggerExternalDbSync(testTenancyId);
      await waitForExternalEmailOutbox(externalClient, baselineRow, 1);

      await withInternalDatabase(async (client) => {
        await insertSequenceVisibilityEmail(client, testTenancyId, rowA, "Sequence visibility row A");
        await insertSequenceVisibilityEmail(client, testTenancyId, rowB, "Sequence visibility row B");
      });

      await transactionA.query("BEGIN");
      transactionAStarted = true;
      await transactionA.query("SET LOCAL lock_timeout = '5000ms'");
      await transactionA.query(`SELECT pg_advisory_xact_lock($1)`, [SEQUENCE_ALLOCATION_ADVISORY_LOCK_KEY]);
      await transactionA.query(
        `UPDATE "EmailOutbox" SET "shouldUpdateSequenceId" = TRUE WHERE "tenancyId" = $1 AND "id" = $2`,
        [testTenancyId, rowA],
      );
      const sequenceA = await allocateEmailOutboxSequence(transactionA, testTenancyId, rowA);
      await withInternalDatabase(async (client) => {
        await client.query(
          `UPDATE "EmailOutbox" SET "shouldUpdateSequenceId" = TRUE WHERE "tenancyId" = $1 AND "id" = $2`,
          [testTenancyId, rowB],
        );
      });

      // T1 holds the production allocation lock after assigning A. A real sequencer invocation
      // runs while T1 is open and must skip rather than commit a higher value first.
      await triggerExternalDbSequencer();
      const rowBSequenceBeforeACommit = await withInternalDatabase(async (client) => {
        const result = await client.query<{ sequenceId: string | null }>(
          `SELECT "sequenceId" FROM "EmailOutbox" WHERE "id" = $1`,
          [rowB],
        );
        return result.rows[0]?.sequenceId;
      });
      expect(rowBSequenceBeforeACommit, "Sequencer must skip while another transaction holds the allocation lock").toBeNull();
      await triggerExternalDbSync(testTenancyId);

      await transactionA.query("COMMIT");
      transactionAStarted = false;
      const sequenceB = await waitForEmailOutboxSequence(rowB, "primary", triggerExternalDbSequencer);
      await waitForEmailOutboxSequence(rowA, "replica");
      await waitForEmailOutboxSequence(rowB, "replica");
      await triggerExternalDbSync(testTenancyId);

      expect(sequenceA).toBeLessThan(sequenceB);
      await waitForExternalEmailOutbox(externalClient, rowB, 1);
      await waitForExternalEmailOutbox(externalClient, rowA, 1);
      const externalRows = await externalClient.query<{ id: string }>(
        `SELECT "id"
         FROM "email_outboxes"
         WHERE "id" = ANY($1::uuid[])
         ORDER BY "id"`,
        [[rowA, rowB]],
      );
      expect(externalRows.rows.map(row => row.id)).toEqual([rowA, rowB].sort());
    } finally {
      if (transactionAStarted) await transactionA.query("ROLLBACK");
      await transactionA.end();

      if (tenancyId != null) {
        await withInternalDatabase(async (client) => {
          await client.query("BEGIN");
          try {
            await deleteSyncedRowsWithTombstones(client, {
              table: "EmailOutbox",
              whereClause: `"tenancyId" = $1::uuid AND "id" = ANY($2::uuid[])`,
              values: [tenancyId, [baselineRow, rowA, rowB]],
            });
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        });
      }
    }
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Creates a project, sends an email, and verifies the email outbox row
   *   is synced to ClickHouse.
   */
  test('EmailOutbox sync (ClickHouse)', async ({ expect }) => {
    await Project.createAndSwitch({
      config: {
        magic_link_enabled: true,
        email_config: {
          type: "standard",
          host: "localhost",
          port: Number(withPortPrefix("29")),
          username: "test",
          password: "test",
          sender_name: "Test Project",
          sender_email: "test@example.com",
        },
      },
    });

    // Create a user
    const createUserResponse = await niceBackendFetch("/api/v1/users", {
      method: "POST",
      accessType: "server",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
        primary_email_verified: true,
      },
    });
    expect(createUserResponse.status).toBe(201);
    const userId = createUserResponse.body.id;

    // Send an email
    const sendResponse = await niceBackendFetch("/api/v1/emails/send-email", {
      method: "POST",
      accessType: "server",
      body: {
        user_ids: [userId],
        html: "<p>ClickHouse sync test email</p>",
        subject: "CH Sync Test Email",
        notification_category_name: "Transactional",
      },
    });
    expect(sendResponse.status).toBe(200);

    await InternalApiKey.createAndSetProjectKeys();

    // Poll ClickHouse until the email_outboxes row appears
    const timeoutMs = 180_000;
    const intervalMs = 2_000;
    const start = performance.now();

    let response;
    while (performance.now() - start < timeoutMs) {
      response = await runQueryForCurrentProject({
        query: "SELECT id, status, simple_status, created_with, is_high_priority FROM email_outboxes LIMIT 10",
      });
      expect(response.status).toBe(200);
      if (response.body.result.length >= 1) {
        break;
      }
      await wait(intervalMs);
    }

    expect(response!.body.result.length).toBeGreaterThanOrEqual(1);
    const row = response!.body.result[0];
    expect(row.created_with).toBe('programmatic-call');
  }, TEST_TIMEOUT);

  test('Deleted EmailOutbox is removed from ClickHouse', async ({ expect }) => {
    const connectionString = await dbManager.createDatabase("email_outbox_delete_test");
    const project = await createProjectWithExternalDb({
      main: {
        type: "postgres",
        connectionString,
      },
    }, {
      config: {
        magic_link_enabled: true,
        email_config: {
          type: "standard",
          host: "localhost",
          port: Number(withPortPrefix("29")),
          username: "test",
          password: "test",
          sender_name: "Test Project",
          sender_email: "test@example.com",
        },
      },
    });

    const createUserResponse = await niceBackendFetch("/api/v1/users", {
      method: "POST",
      accessType: "server",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
        primary_email_verified: true,
      },
    });
    expect(createUserResponse.status).toBe(201);

    const sendResponse = await niceBackendFetch("/api/v1/emails/send-email", {
      method: "POST",
      accessType: "server",
      body: {
        user_ids: [createUserResponse.body.id],
        html: "<p>ClickHouse deletion test email</p>",
        subject: "CH Deletion Test Email",
        notification_category_name: "Transactional",
      },
    });
    expect(sendResponse.status).toBe(200);

    let emailId!: string;
    await waitForCondition(
      async () => {
        const listResponse = await niceBackendFetch("/api/v1/emails/outbox", {
          method: "GET",
          accessType: "server",
        });
        if (listResponse.status !== 200 || listResponse.body.items.length === 0) return false;
        emailId = listResponse.body.items[0].id;
        return true;
      },
      { timeoutMs: 30_000, intervalMs: 500, description: "email to appear in outbox" },
    );

    // Both ClickHouse assertions share this budget so the helper reports a useful failure before TEST_TIMEOUT.
    const clickhouseDeadline = performance.now() + 180_000;
    await InternalApiKey.createAndSetProjectKeys();
    await waitForClickhouseEmailOutbox(emailId, 1, clickhouseDeadline);

    // No production endpoint deletes EmailOutbox rows, so e2e cannot drive this over HTTP; the tombstone shape is pinned by the backend unit test.
    await withInternalDatabase(async (client) => {
      const tenancy = await client.query<{ id: string }>(
        `SELECT "id" FROM "Tenancy" WHERE "projectId" = $1 AND "branchId" = 'main' LIMIT 1`,
        [project.projectId],
      );
      const tenancyId = tenancy.rows[0]?.id ?? throwErr(`No main tenancy found for project ${project.projectId}`);

      await deleteSyncedRowsWithTombstones(client, {
        table: "EmailOutbox",
        whereClause: `"tenancyId" = $1::uuid AND "id" = $2::uuid`,
        values: [tenancyId, emailId],
      });
    });

    await waitForClickhouseEmailOutbox(emailId, 0, clickhouseDeadline);
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Sends an email, waits for it to reach a terminal state, then verifies
   *   the status update is reflected in the external Postgres DB.
   */
  test('EmailOutbox status updates are synced (Postgres)', async () => {
    const dbName = 'email_outbox_status_test';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: 'postgres',
        connectionString,
      }
    }, {
      config: {
        email_config: {
          type: "standard",
          host: "localhost",
          port: Number(withPortPrefix("29")),
          username: "test",
          password: "test",
          sender_name: "Test Project",
          sender_email: "test@example.com",
        },
      },
    });

    const createUserResponse = await niceBackendFetch("/api/v1/users", {
      method: "POST",
      accessType: "server",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
        primary_email_verified: true,
      },
    });
    expect(createUserResponse.status).toBe(201);
    const userId = createUserResponse.body.id;

    const sendResponse = await niceBackendFetch("/api/v1/emails/send-email", {
      method: "POST",
      accessType: "server",
      body: {
        user_ids: [userId],
        html: "<p>Status sync test</p>",
        subject: "Status Sync Test",
        notification_category_name: "Transactional",
      },
    });
    expect(sendResponse.status).toBe(200);

    const client = dbManager.getClient(dbName);

    // The email should eventually reach SENT status in the external DB
    await waitForSyncedEmailOutboxByStatus(client, 'SENT');

    const res = await client.query(`SELECT * FROM "email_outboxes" WHERE "status" = 'SENT'`);
    expect(res.rows.length).toBeGreaterThanOrEqual(1);
    const row = res.rows[0];
    expect(row.simple_status).toBe('OK');
    expect(row.finished_sending_at).not.toBeNull();
    expect(row.sent_at).not.toBeNull();
    expect(row.send_retries).toBe(0);
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Reads the external DB sync fusebox settings.
   * - Writes the same values back to confirm the update endpoint.
   *
   * Why it matters:
   * - Ensures internal fusebox controls are reachable and validated.
   */
  test('Fusebox endpoint returns and accepts enablement flags', async () => {
    const getResponse = await niceBackendFetch('/api/latest/internal/external-db-sync/fusebox', {
      accessType: 'admin',
    });

    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toMatchObject({
      ok: true,
      sequencer_enabled: expect.any(Boolean),
      poller_enabled: expect.any(Boolean),
    });

    const postResponse = await niceBackendFetch('/api/latest/internal/external-db-sync/fusebox', {
      accessType: 'admin',
      method: 'POST',
      body: {
        sequencer_enabled: getResponse.body.sequencer_enabled,
        poller_enabled: getResponse.body.poller_enabled,
      },
    });

    expect(postResponse.status).toBe(200);
    expect(postResponse.body).toMatchObject({
      ok: true,
      sequencer_enabled: getResponse.body.sequencer_enabled,
      poller_enabled: getResponse.body.poller_enabled,
    });
  }, TEST_TIMEOUT);

  test('Sync engine ignores missing tenancy queue items', async () => {
    const response = await niceFetch(new URL('/api/latest/internal/external-db-sync/sync-engine', STACK_BACKEND_BASE_URL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'upstash-signature': 'test-bypass',
      },
      body: JSON.stringify({
        tenancyId: randomUUID(),
      }),
    });

    expect(response.status).toBe(200);
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Signs up a user (which creates a refresh token), waits for it to sync to the external DB.
   *
   * Why it matters:
   * - Validates that refresh tokens are synced to external databases.
   */
  test('Refresh token sync to external DB', async ({ expect }) => {
    const dbName = 'refresh_token_sync';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: "postgres",
        connectionString,
      },
    }, { config: { magic_link_enabled: true } });

    const signUpRes = await Auth.Otp.signIn();

    // List sessions to get the session (refresh token) ID
    const listRes = await niceBackendFetch("/api/v1/auth/sessions", {
      accessType: "client",
      method: "GET",
      query: { user_id: signUpRes.userId },
    });
    expect(listRes.status).toBe(200);
    expect(listRes.body.items.length).toBeGreaterThanOrEqual(1);
    const sessionId = listRes.body.items[0].id;

    const client = dbManager.getClient(dbName);
    await waitForSyncedRefreshToken(client, sessionId);

    const res = await client.query(`SELECT * FROM "refresh_tokens" WHERE "id" = $1`, [sessionId]);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].user_id).toBe(signUpRes.userId);
    expect(res.rows[0].is_impersonation).toBe(false);
    expect(res.rows[0].created_at).toBeInstanceOf(Date);
    expect(res.rows[0].last_used_at).toBeInstanceOf(Date);
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Signs up a user, revokes the session, and waits for the deletion to sync.
   *
   * Why it matters:
   * - Validates that refresh token deletions are synced to external databases.
   */
  test('Refresh token deletion sync to external DB', async ({ expect }) => {
    const dbName = 'refresh_token_delete_sync';
    const connectionString = await dbManager.createDatabase(dbName);

    await createProjectWithExternalDb({
      main: {
        type: "postgres",
        connectionString,
      },
    }, { config: { magic_link_enabled: true } });

    const signUpRes = await Auth.Otp.signIn();

    // Create a second session so we can revoke one
    const newSession = await niceBackendFetch("/api/v1/auth/sessions", {
      accessType: "server",
      method: "POST",
      body: { user_id: signUpRes.userId },
    });
    expect(newSession.status).toBe(200);

    // List sessions to find the second session ID
    const listRes = await niceBackendFetch("/api/v1/auth/sessions", {
      accessType: "client",
      method: "GET",
      query: { user_id: signUpRes.userId },
    });
    expect(listRes.status).toBe(200);
    const nonCurrentSession = listRes.body.items.find((s: any) => !s.is_current_session);
    expect(nonCurrentSession).toBeDefined();

    const client = dbManager.getClient(dbName);
    await waitForSyncedRefreshToken(client, nonCurrentSession.id);

    // Revoke the non-current session
    const deleteRes = await niceBackendFetch(`/api/v1/auth/sessions/${nonCurrentSession.id}`, {
      accessType: "client",
      method: "DELETE",
      query: { user_id: signUpRes.userId },
    });
    expect(deleteRes.status).toBe(200);

    await waitForSyncedRefreshTokenDeletion(client, nonCurrentSession.id);
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Signs up a user, verifies refresh token appears in ClickHouse.
   *
   * Why it matters:
   * - Validates ClickHouse refresh_tokens table sync.
   */
  test('Refresh token sync to ClickHouse', async ({ expect }) => {
    await Project.createAndSwitch({ config: { magic_link_enabled: true } });
    await InternalApiKey.createAndSetProjectKeys();

    const signUpRes = await Auth.Otp.signIn();

    const listRes = await niceBackendFetch("/api/v1/auth/sessions", {
      accessType: "client",
      method: "GET",
      query: { user_id: signUpRes.userId },
    });
    expect(listRes.status).toBe(200);
    const sessionId = listRes.body.items[0].id;

    const timeoutMs = 180_000;
    const intervalMs = 2_000;
    const start = performance.now();

    let response;
    while (performance.now() - start < timeoutMs) {
      response = await runQueryForCurrentProject({
        query: "SELECT id, user_id, is_impersonation FROM refresh_tokens WHERE id = {session_id:UUID}",
        params: { session_id: sessionId },
      });
      expect(response.status).toBe(200);
      if (response.body.result.length === 1) {
        expect(response.body.result[0]).toMatchObject({
          id: sessionId,
          user_id: signUpRes.userId,
          is_impersonation: 0,
        });
        return;
      }
      await wait(intervalMs);
    }
    throw new HexclaveAssertionError(`Timed out waiting for ClickHouse refresh token to sync.`, { response });
  }, TEST_TIMEOUT);

  /**
   * What it does:
   * - Signs up a user, verifies connected account appears in ClickHouse.
   *
   * Why it matters:
   * - Validates ClickHouse connected_accounts table sync.
   */
  test('Connected account sync to ClickHouse', async ({ expect }) => {
    // Use default project (has spotify configured) with analytics keys
    await Auth.OAuth.signIn();
    await InternalApiKey.createAndSetProjectKeys();

    // Get the user ID
    const userRes = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "GET",
    });
    expect(userRes.status).toBe(200);
    const userId = userRes.body.id;

    // Create an additional connected account via the oauth-providers API so we have a known ID
    const createRes = await niceBackendFetch("/api/v1/oauth-providers", {
      accessType: "server",
      method: "POST",
      body: {
        user_id: userId,
        provider_config_id: "spotify",
        account_id: "ch-test-account-12345",
        email: "chuser@example.com",
        allow_sign_in: false,
        allow_connected_accounts: true,
      },
    });
    expect(createRes.status).toBe(201);
    const accountId = createRes.body.id;

    const timeoutMs = 180_000;
    const intervalMs = 2_000;
    const start = performance.now();

    let response;
    while (performance.now() - start < timeoutMs) {
      response = await runQueryForCurrentProject({
        query: "SELECT user_id, provider, provider_account_id FROM connected_accounts WHERE provider_account_id = {account_id:String} AND user_id = {user_id:UUID}",
        params: { account_id: "ch-test-account-12345", user_id: userId },
      });
      expect(response.status).toBe(200);
      if (response.body.result.length === 1) {
        expect(response.body.result[0]).toMatchObject({
          user_id: userId,
          provider: "spotify",
          provider_account_id: "ch-test-account-12345",
        });
        return;
      }
      await wait(intervalMs);
    }
    throw new HexclaveAssertionError(`Timed out waiting for ClickHouse connected account to sync.`, { response });
  }, TEST_TIMEOUT);

});
