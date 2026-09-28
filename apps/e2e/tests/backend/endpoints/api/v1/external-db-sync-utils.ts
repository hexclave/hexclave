import { Client, ClientConfig } from 'pg';
import { expect } from 'vitest';
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { niceFetch, STACK_BACKEND_BASE_URL } from '../../../../helpers';
import { InternalApiKey, Project } from '../../../backend-helpers';


const PORT_PREFIX = process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX || '81';
export const POSTGRES_HOST = process.env.EXTERNAL_DB_TEST_HOST || `localhost:${PORT_PREFIX}28`;
export const POSTGRES_USER = process.env.EXTERNAL_DB_TEST_USER || 'postgres';
export const POSTGRES_PASSWORD = process.env.EXTERNAL_DB_TEST_PASSWORD || 'PASSWORD-PLACEHOLDER--uqfEC1hmmv';
export const TEST_TIMEOUT = 240000;
export const HIGH_VOLUME_TIMEOUT = 600000; // 10 minutes for 1500+ users

export function getInternalDatabaseConnectionString(): string {
  const connectionString = getEnvVariable(
    "HEXCLAVE_DATABASE_CONNECTION_STRING",
    getEnvVariable("STACK_DATABASE_CONNECTION_STRING", ""),
  );
  if (connectionString === "") {
    throw new HexclaveAssertionError("E2E tests require a configured internal database connection string");
  }
  return connectionString;
}

export async function withInternalDatabase<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: getInternalDatabaseConnectionString(),
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const syncedCleanupTableConfig = {
  EmailOutbox: {
    primaryKey: `jsonb_build_object('tenancyId', "tenancyId", 'id', "id")`,
  },
  ProjectUser: {
    primaryKey: `jsonb_build_object('tenancyId', "tenancyId", 'projectUserId', "projectUserId")`,
  },
} as const;

export async function deleteSyncedRowsWithTombstones(client: Client, options: {
  table: keyof typeof syncedCleanupTableConfig,
  whereClause: string,
  values: unknown[],
}): Promise<void> {
  const tableConfig = syncedCleanupTableConfig[options.table];
  await client.query(
    `
      WITH deleted_rows AS (
        DELETE FROM "${options.table}"
        WHERE ${options.whereClause}
        RETURNING *
      )
      INSERT INTO "DeletedRow"
        ("id", "tenancyId", "tableName", "primaryKey", "data", "deletedAt", "shouldUpdateSequenceId")
      SELECT
        gen_random_uuid(),
        "tenancyId",
        '${options.table}',
        ${tableConfig.primaryKey},
        to_jsonb(deleted_rows),
        now(),
        true
      FROM deleted_rows
    `,
    options.values,
  );
}

// Connection settings to prevent connection leaks
const CLIENT_CONFIG: Partial<ClientConfig> = {
  // Timeout for connecting (10 seconds)
  connectionTimeoutMillis: 10000,
  // Timeout for queries (30 seconds)
  query_timeout: 30000,
  // Timeout for idle connections (60 seconds)
  idle_in_transaction_session_timeout: 60000,
};

// Track all projects created with external DB configs for cleanup
export type ProjectContext = {
  projectId: string,
  superSecretAdminKey: string,
};

/**
 * Helper class to manage external test databases
 */
export class TestDbManager {
  private setupClient: Client | null = null;
  private databases: Map<string, Client> = new Map();
  private databaseNames: Set<string> = new Set();
  public readonly createdProjects: ProjectContext[] = [];

  async init() {
    this.setupClient = new Client({
      connectionString: `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}/postgres`,
      ...CLIENT_CONFIG,
    });
    await this.setupClient.connect();
  }

  async createDatabase(dbName: string): Promise<string> {
    if (!this.setupClient) throw new Error('TestDbManager not initialized');

    const uniqueDbName = `${dbName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.setupClient.query(`CREATE DATABASE "${uniqueDbName}"`);
    const connectionString = `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}/${uniqueDbName}`;
    const client = new Client({
      connectionString,
      ...CLIENT_CONFIG,
    });
    await client.connect();

    this.databases.set(dbName, client);
    this.databaseNames.add(uniqueDbName);
    return connectionString;
  }

  getClient(dbName: string): Client {
    const client = this.databases.get(dbName);
    if (!client) throw new Error(`Database ${dbName} not found`);
    return client;
  }

  async cleanup() {
    // First, clean up all project configs to stop the sync cron from trying to connect
    await cleanupProjectConfigs(this.createdProjects);
    this.createdProjects.length = 0;

    // Close all tracked database clients
    const closePromises = Array.from(this.databases.values()).map(async (client) => {
      try {
        await Promise.race([
          client.end(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Client close timeout')), 5000)),
        ]);
      } catch (err) {
        // Ignore errors when closing clients - they may already be closed or timed out
      }
    });
    await Promise.all(closePromises);
    this.databases.clear();

    if (this.setupClient) {
      // Terminate all connections and drop databases
      for (const dbName of this.databaseNames) {
        try {
          // Forcefully terminate ALL connections to this database
          await this.setupClient.query(`
            SELECT pg_terminate_backend(pg_stat_activity.pid)
            FROM pg_stat_activity
            WHERE pg_stat_activity.datname = $1
              AND pid <> pg_backend_pid()
          `, [dbName]);

          // Small delay to ensure connections are terminated
          await new Promise(r => setTimeout(r, 100));

          await this.setupClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        } catch (err) {
          console.warn(`Failed to drop database ${dbName}:`, err);
        }
      }
      this.databaseNames.clear();

      try {
        await this.setupClient.end();
      } catch (err) {
        // Ignore errors when closing setup client
      }
      this.setupClient = null;
    }
  }
}


/**
 * Wait for a condition to be true by polling, with timeout
 */
export async function waitForCondition(
  checkFn: () => Promise<boolean>,
  options: { timeoutMs?: number, intervalMs?: number, description?: string } = {}
): Promise<void> {
  const { timeoutMs = 10000, intervalMs = 100, description = 'condition' } = options;
  const startTime = performance.now();

  while (performance.now() - startTime < timeoutMs) {
    try {
      if (await checkFn()) {
        return;
      }
    } catch (err: any) {
      // If the error is a connection error, wait and retry
      if (err?.code === '57P01' || err?.code === '08006' || err?.code === '53300') {
        // Connection terminated, connection failure, or too many clients
        await new Promise(r => setTimeout(r, intervalMs));
        continue;
      }
      throw err;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
}

/**
 * Generic helper to wait for a row to appear or disappear in the external DB.
 * Handles the common pattern of catching "table does not exist" (42P01) errors.
 */
async function waitForExternalDbRow(
  client: Client,
  query: string,
  params: unknown[],
  opts: { shouldExist: boolean, description: string, checkRow?: (row: Record<string, unknown>) => boolean },
) {
  await waitForCondition(
    async () => {
      let res;
      try {
        res = await client.query(query, params);
      } catch (err: any) {
        if (err && err.code === '42P01') {
          return false;
        }
        throw err;
      }
      if (opts.shouldExist) {
        if (res.rows.length === 0) return false;
        if (opts.checkRow && !opts.checkRow(res.rows[0])) return false;
        return true;
      }
      return res.rows.length === 0;
    },
    {
      description: opts.description,
      timeoutMs: 180000,
      intervalMs: 500,
    }
  );
}

/**
 * Wait for data to appear in external DB (relies on automatic cron job)
 */
export async function waitForSyncedData(client: Client, email: string, expectedName?: string) {
  await waitForExternalDbRow(
    client,
    `SELECT * FROM "users" WHERE "primary_email" = $1`,
    [email],
    {
      shouldExist: true,
      description: `data for ${email} to appear in external DB`,
      checkRow: expectedName ? (row) => row.display_name === expectedName : undefined,
    },
  );
}

/**
 * Wait for data to be removed from external DB (relies on automatic cron job)
 */
export async function waitForSyncedDeletion(client: Client, email: string) {
  await waitForExternalDbRow(
    client,
    `SELECT * FROM "users" WHERE "primary_email" = $1`,
    [email],
    { shouldExist: false, description: `data for ${email} to be removed from external DB` },
  );
}

/**
 * Wait for table to be created (relies on automatic cron job)
 */
export async function waitForTable(client: Client, tableName: string) {
  await waitForCondition(
    async () => {
      const res = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = $1
        );
      `, [tableName]);
      const exists = res.rows[0].exists;
      return exists;
    },
    {
      description: `table ${tableName} to be created`,
      timeoutMs: 180000,
      intervalMs: 500,
    }
  );
}

/**
 * Helper to verify data does NOT exist in external DB
 */
export async function verifyNotInExternalDb(client: Client, email: string) {
  const res = await client.query(`SELECT * FROM "users" WHERE "primary_email" = $1`, [email]);
  expect(res.rows.length).toBe(0);
}

/**
 * Helper to verify data DOES exist in external DB
 */
export async function verifyInExternalDb(client: Client, email: string, expectedName?: string) {
  const res = await client.query(`SELECT * FROM "users" WHERE "primary_email" = $1`, [email]);
  expect(res.rows.length).toBe(1);
  if (expectedName) {
    expect(res.rows[0].display_name).toBe(expectedName);
  }
  return res.rows[0];
}

/**
 * Helper to count total users in external DB
 */
export async function countUsersInExternalDb(client: Client): Promise<number> {
  try {
    const res = await client.query(`SELECT COUNT(*) FROM "users"`);
    return parseInt(res.rows[0].count, 10);
  } catch (err: any) {
    if (err && err.code === '42P01') {
      return 0;
    }
    throw err;
  }
}

export async function waitForSyncedTeam(client: Client, displayName: string) {
  await waitForExternalDbRow(client, `SELECT * FROM "teams" WHERE "display_name" = $1`, [displayName], {
    shouldExist: true,
    description: `team "${displayName}" to appear in external DB`,
  });
}

export async function waitForSyncedTeamDeletion(client: Client, teamId: string) {
  await waitForExternalDbRow(client, `SELECT * FROM "teams" WHERE "id" = $1`, [teamId], {
    shouldExist: false,
    description: `team ${teamId} to be removed from external DB`,
  });
}

export async function waitForSyncedTeamMember(client: Client, teamId: string, userId: string) {
  await waitForExternalDbRow(client, `SELECT * FROM "team_member_profiles" WHERE "team_id" = $1 AND "user_id" = $2`, [teamId, userId], {
    shouldExist: true,
    description: `team member (team=${teamId}, user=${userId}) to appear in external DB`,
  });
}

export async function waitForSyncedTeamMemberDeletion(client: Client, teamId: string, userId: string) {
  await waitForExternalDbRow(client, `SELECT * FROM "team_member_profiles" WHERE "team_id" = $1 AND "user_id" = $2`, [teamId, userId], {
    shouldExist: false,
    description: `team member (team=${teamId}, user=${userId}) to be removed from external DB`,
  });
}

export async function waitForSyncedContactChannel(client: Client, value: string) {
  await waitForExternalDbRow(client, `SELECT * FROM "contact_channels" WHERE "value" = $1`, [value], {
    shouldExist: true,
    description: `contact channel "${value}" to appear in external DB`,
  });
}

export async function waitForSyncedContactChannelDeletion(client: Client, value: string) {
  await waitForExternalDbRow(client, `SELECT * FROM "contact_channels" WHERE "value" = $1`, [value], {
    shouldExist: false,
    description: `contact channel "${value}" to be removed from external DB`,
  });
}

export async function waitForSyncedTeamPermission(client: Client, teamId: string, userId: string, permissionId: string) {
  await waitForExternalDbRow(client, `SELECT * FROM "team_permissions" WHERE "team_id" = $1 AND "user_id" = $2 AND "permission_id" = $3`, [teamId, userId, permissionId], {
    shouldExist: true,
    description: `team permission (team=${teamId}, user=${userId}, perm=${permissionId}) to appear in external DB`,
  });
}

export async function waitForSyncedTeamPermissionDeletion(client: Client, teamId: string, userId: string, permissionId: string) {
  await waitForExternalDbRow(client, `SELECT * FROM "team_permissions" WHERE "team_id" = $1 AND "user_id" = $2 AND "permission_id" = $3`, [teamId, userId, permissionId], {
    shouldExist: false,
    description: `team permission (team=${teamId}, user=${userId}, perm=${permissionId}) to be removed from external DB`,
  });
}

export async function waitForSyncedTeamInvitation(client: Client, recipientEmail: string) {
  await waitForExternalDbRow(client, `SELECT * FROM "team_invitations" WHERE "recipient_email" = $1`, [recipientEmail], {
    shouldExist: true,
    description: `team invitation for "${recipientEmail}" to appear in external DB`,
  });
}

export async function waitForSyncedTeamInvitationDeletion(client: Client, invitationId: string) {
  await waitForExternalDbRow(client, `SELECT * FROM "team_invitations" WHERE "id" = $1`, [invitationId], {
    shouldExist: false,
    description: `team invitation ${invitationId} to be removed from external DB`,
  });
}

export async function waitForSyncedEmailOutbox(client: Client, emailId: string, expectedStatus?: string) {
  await waitForExternalDbRow(
    client,
    `SELECT * FROM "email_outboxes" WHERE "id" = $1`,
    [emailId],
    {
      shouldExist: true,
      description: `email outbox "${emailId}" to appear in external DB`,
      checkRow: expectedStatus ? (row) => row.status === expectedStatus : undefined,
    },
  );
}

export async function waitForSyncedSessionReplay(client: Client, replayId: string, expectedChunkCount?: number) {
  await waitForExternalDbRow(
    client,
    `SELECT * FROM "session_replays" WHERE "id" = $1`,
    [replayId],
    {
      shouldExist: true,
      description: `session replay "${replayId}" to appear in external DB`,
      checkRow: expectedChunkCount == null ? undefined : (row) => Number(row.chunk_count) === expectedChunkCount,
    },
  );
}

export async function waitForSyncedProjectPermission(client: Client, userId: string, permissionId: string) {
  await waitForExternalDbRow(client, `SELECT * FROM "project_permissions" WHERE "user_id" = $1 AND "permission_id" = $2`, [userId, permissionId], {
    shouldExist: true,
    description: `project permission (user=${userId}, perm=${permissionId}) to appear in external DB`,
  });
}

export async function waitForSyncedProjectPermissionDeletion(client: Client, userId: string, permissionId: string) {
  await waitForExternalDbRow(client, `SELECT * FROM "project_permissions" WHERE "user_id" = $1 AND "permission_id" = $2`, [userId, permissionId], {
    shouldExist: false,
    description: `project permission (user=${userId}, perm=${permissionId}) to be removed from external DB`,
  });
}

export async function waitForSyncedNotificationPreference(client: Client, userId: string, notificationCategoryId: string) {
  await waitForExternalDbRow(client, `SELECT * FROM "notification_preferences" WHERE "user_id" = $1 AND "notification_category_id" = $2`, [userId, notificationCategoryId], {
    shouldExist: true,
    description: `notification preference (user=${userId}, category=${notificationCategoryId}) to appear in external DB`,
  });
}

export async function waitForSyncedNotificationPreferenceDeletion(client: Client, notificationPreferenceId: string) {
  await waitForExternalDbRow(client, `SELECT * FROM "notification_preferences" WHERE "id" = $1`, [notificationPreferenceId], {
    shouldExist: false,
    description: `notification preference ${notificationPreferenceId} to be removed from external DB`,
  });
}

export async function waitForSyncedRefreshToken(client: Client, refreshTokenId: string) {
  await waitForExternalDbRow(
    client,
    `SELECT * FROM "refresh_tokens" WHERE "id" = $1`,
    [refreshTokenId],
    {
      shouldExist: true,
      description: `refresh token "${refreshTokenId}" to appear in external DB`,
    },
  );
}

export async function waitForSyncedRefreshTokenDeletion(client: Client, refreshTokenId: string) {
  await waitForExternalDbRow(
    client,
    `SELECT * FROM "refresh_tokens" WHERE "id" = $1`,
    [refreshTokenId],
    {
      shouldExist: false,
      description: `refresh token "${refreshTokenId}" to be removed from external DB`,
    },
  );
}

export async function waitForSyncedConnectedAccount(client: Client, accountId: string) {
  await waitForExternalDbRow(
    client,
    `SELECT * FROM "connected_accounts" WHERE "id" = $1`,
    [accountId],
    {
      shouldExist: true,
      description: `connected account "${accountId}" to appear in external DB`,
    },
  );
}

export async function waitForSyncedConnectedAccountDeletion(client: Client, accountId: string) {
  await waitForExternalDbRow(
    client,
    `SELECT * FROM "connected_accounts" WHERE "id" = $1`,
    [accountId],
    {
      shouldExist: false,
      description: `connected account "${accountId}" to be removed from external DB`,
    },
  );
}

export async function waitForSyncedEmailOutboxByStatus(client: Client, status: string) {
  await waitForExternalDbRow(
    client,
    `SELECT * FROM "email_outboxes" WHERE "status" = $1`,
    [status],
    {
      shouldExist: true,
      description: `email outbox with status "${status}" to appear in external DB`,
    },
  );
}

/**
 * Helper to create a project and update its config with external DB settings.
 * Tracks the project for cleanup later.
 */
export async function createProjectWithExternalDb(
  externalDatabases: any,
  projectOptions?: { display_name?: string, description?: string, config?: Record<string, unknown> },
  options?: { projectTracker?: ProjectContext[] }
) {
  const project = await Project.createAndSwitch(projectOptions);
  const { projectKeys } = await InternalApiKey.createAndSetProjectKeys(project.adminAccessToken);
  if (!projectKeys.superSecretAdminKey) {
    throw new Error('Expected super secret admin key to be present for external DB sync tests.');
  }
  await Project.updateConfig({
    "dbSync.externalDatabases": externalDatabases
  });

  // Track this project for cleanup
  if (options?.projectTracker) {
    options.projectTracker.push({
      projectId: project.projectId,
      superSecretAdminKey: projectKeys.superSecretAdminKey,
    });
  }

  return project;
}

/**
 * Helper to remove external DB config from current project
 */
export async function cleanupProjectExternalDb() {
  await Project.updateConfig({
    "dbSync.externalDatabases": {}
  });
}

/**
 * Clean up external DB configs for all tracked projects.
 * This prevents the sync cron from trying to connect to deleted databases.
 *
 * Note: This function makes direct HTTP calls instead of using backendContext
 * because it runs in afterAll, which is outside the test context.
 */
export async function cleanupProjectConfigs(projects: ProjectContext[]) {
  for (const project of projects) {
    try {
      // Make direct HTTP call to clear the external DB config
      await niceFetch(new URL('/api/latest/internal/config/override', STACK_BACKEND_BASE_URL), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-stack-access-type': 'admin',
          'x-stack-project-id': project.projectId,
          'x-stack-super-secret-admin-key': project.superSecretAdminKey,
        },
        body: JSON.stringify({
          config_override_string: JSON.stringify({ "dbSync.externalDatabases": {} })
        }),
      });
    } catch (err) {
      // Ignore errors - project might have been deleted or config update might fail
      console.warn(`Failed to cleanup project ${project.projectId}:`, err);
    }
  }
}
