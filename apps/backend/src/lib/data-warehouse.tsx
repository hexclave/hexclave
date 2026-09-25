// Core logic for the Data Warehouse app (`data-warehouse-alpha`): a per-project
// ClickHouse database plus a dedicated ClickHouse user, on the same ClickHouse
// instance that serves analytics.
//
// Isolation has to come from the connecting user, not the database: row policies
// filter rows but don't restrict which databases a query may name, so granting
// the shared `limited_user` access to one project's warehouse would expose it to
// every other project. Each warehouse user also holds the `analytics_reader`
// role (see scripts/clickhouse-migrations.ts), so it keeps the project's usual
// analytics access and can join it against the project's own tables, with
// `SQL_project_id`/`SQL_branch_id` pinned as CONST settings.
//
// Alpha limitations, all deliberate:
// - TODO(data-warehouse-ga): no storage accounting; ClickHouse has no per-database
//   size limit, so a project can fill disk shared with analytics.
// - TODO(data-warehouse-ga): no deprovisioning; deleting a tenancy or uninstalling
//   the app leaves the ClickHouse database and user in place.
// - No downgrade enforcement: losing the entitlement blocks provisioning and
//   rotation, but an existing ClickHouse user stays active.
// - Per-user ClickHouse settings are a snapshot taken at provision/rotation time,
//   so a plan upgrade only takes effect on the next rotation. That includes the
//   `max_execution_time` ceiling: until then, an `/analytics/query` request asking
//   for more than the old plan's timeout is rejected by the ceiling (the dashboard
//   never asks for more than any warehouse-eligible plan allows).
// - One database per project, not per branch (the database is named after the
//   project id, so a second branch would collide).

import { getHexclaveServerApp } from "@/hexclave";
import { ANALYTICS_READER_ROLE, getClickhouseAdminClient, type ClickHouseClient } from "@/lib/clickhouse";
import { arePlanLimitsEnforced, getBillingTeamId } from "@/lib/plan-entitlements";
import type { Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, type PrismaClientTransaction } from "@/prisma-client";
import type { DataWarehouse } from "@/generated/prisma/client";
import { KnownErrors } from "@hexclave/shared";
import { decryptWithKms, encryptWithKms } from "@hexclave/shared/dist/helpers/vault/server-side";
import { ITEM_IDS, PLAN_LIMITS } from "@hexclave/shared/dist/plans";
import { yupObject, yupString, yupValidate } from "@hexclave/shared/dist/schema-fields";
import { generateSecureRandomString } from "@hexclave/shared/dist/utils/crypto";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError, StatusError, captureError } from "@hexclave/shared/dist/utils/errors";

/**
 * Upper bound for the plan-derived `max_execution_time`, and the value used when
 * plan limits are not enforced. The plan's own timeout is both the default and the
 * ceiling for a warehouse user, so a direct connection cannot `SET` its way past
 * the plan it pays for (see `applyWarehouseDdl`).
 */
const MAX_EXECUTION_TIME_SECONDS = Math.max(...Object.values(PLAN_LIMITS).map(p => p.analyticsTimeoutSeconds));

/**
 * Per-query memory ceiling, well below the cluster's OvercommitTracker budget:
 * these queries share an instance with our analytics and, unlike
 * `/analytics/query`, we cannot shape a direct connection per request.
 */
const MAX_MEMORY_USAGE_BYTES = 4_000_000_000;

/**
 * Aggregate memory ceiling across one user's concurrent queries. Kept equal to the
 * per-query ceiling so concurrency cannot multiply one customer's footprint.
 */
const MAX_MEMORY_USAGE_FOR_USER_BYTES = MAX_MEMORY_USAGE_BYTES;

/** CPU/admission-control backstop for one customer's direct connections. */
const MAX_CONCURRENT_QUERIES_FOR_USER = 10;

/** Per-query CPU parallelism ceiling, so one query cannot occupy every core. */
const MAX_THREADS = 4;

/**
 * Floors for the ceilings above. ClickHouse reads `0` as "unlimited" for these
 * settings, so a MAX alone is not a ceiling — a connection could `SET
 * max_memory_usage = 0` and pass the MAX check. They are low on purpose: a
 * customer may want a tighter budget than ours, just not an unbounded one.
 */
const MIN_EXECUTION_TIME_SECONDS = 1;
const MIN_MEMORY_USAGE_BYTES = 1_000_000;
const MIN_CONCURRENT_QUERIES_FOR_USER = 1;
const MIN_THREADS = 1;

/** Hourly quota per warehouse user. Generous — this is an abuse backstop, not a product limit. */
const QUOTA_INTERVAL_HOURS = 1;
const QUOTA_MAX_QUERIES = 10_000;
const QUOTA_MAX_ERRORS = 1_000;
const QUOTA_MAX_EXECUTION_TIME_SECONDS = 3_600;

/** PostgreSQL advisory-lock namespace for per-warehouse mutations. */
const DATA_WAREHOUSE_OPERATION_LOCK_CLASS = 247_911;
const DATA_WAREHOUSE_OPERATION_TIMEOUT_MS = 60_000;

const encryptedWarehousePasswordSchema = yupObject({
  edkBase64: yupString().defined(),
  ciphertextBase64: yupString().defined(),
}).defined();

/**
 * Local-only engines a customer warehouse needs. Only granted where the server
 * enforces engine grants (`table_engines_require_grant`, e.g. our local docker
 * setup); see `getAdminCanGrantTableEngines`. ClickHouse Cloud does not support
 * engine grants and allows these engines without one.
 *
 * There is deliberately no deny-list of engines: it goes stale with every release,
 * and engine revokes are not enforced where engine grants are not. Engines that
 * reach outside the instance are gated by source privileges instead, which
 * provisioning revokes wholesale with `REVOKE SOURCES`.
 */
const ALLOWED_TABLE_ENGINES = [
  "MergeTree", "ReplacingMergeTree", "SummingMergeTree", "AggregatingMergeTree",
  "CollapsingMergeTree", "VersionedCollapsingMergeTree", "GraphiteMergeTree",
  "Log", "TinyLog", "StripeLog", "Memory", "Set", "Join", "Buffer", "Null",
] as const;

/**
 * Privileges the warehouse user gets on its own database, and nothing outside it.
 * Dictionaries are omitted on purpose: their HTTP and database-backed sources open
 * server-side connections that the source revokes above do not cover, which would
 * make CREATE DICTIONARY an SSRF primitive on the shared instance.
 */
const OWN_DATABASE_PRIVILEGES = [
  "SELECT", "INSERT", "ALTER", "CREATE TABLE", "CREATE VIEW",
  "DROP TABLE", "DROP VIEW", "TRUNCATE", "OPTIMIZE",
  "SHOW TABLES", "SHOW COLUMNS",
] as const;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The single point where a project id becomes a ClickHouse identifier. Identifiers
 * cannot be parameterized, so every name is interpolated into DDL — this UUID check
 * plus the backtick quoting is what makes that safe.
 *
 * It also rejects the `internal` project (whose id is not a UUID), which should
 * never provision a customer warehouse.
 */
function quoteClickhouseIdentifierFromProjectId(projectId: string): string {
  if (!UUID_REGEX.test(projectId)) {
    throw new StatusError(400, "The Data Warehouse app is only available for regular projects.");
  }
  return `\`${projectId}\``;
}

export function getDataWarehouseNames(projectId: string): { databaseName: string, userName: string } {
  // Database and user share the project id; they live in different ClickHouse
  // namespaces, so there is no conflict, and stray objects stay traceable.
  return { databaseName: projectId, userName: projectId };
}

export async function getDataWarehouse(tenancy: Tenancy): Promise<DataWarehouse | null> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  return await prisma.dataWarehouse.findUnique({ where: { tenancyId: tenancy.id } });
}

/** Throws unless the project's billing team is on the team plan or higher. */
export async function ensureDataWarehouseEntitlement(tenancy: Tenancy): Promise<void> {
  if (!arePlanLimitsEnforced()) return;
  const billingTeamId = getBillingTeamId(tenancy.project);
  if (billingTeamId == null) return;
  const app = getHexclaveServerApp();
  const item = await app.getItem({ itemId: ITEM_IDS.dataWarehouse, teamId: billingTeamId });
  if (item.quantity < 1) {
    throw new KnownErrors.ItemQuantityInsufficientAmount(ITEM_IDS.dataWarehouse, billingTeamId, 1);
  }
}

/**
 * The project's analytics timeout entitlement, used as the ClickHouse-side default
 * for direct connections. Falls back to the platform maximum when plan limits are
 * disabled or there is no billing team (self-hosted, internal tenancy).
 */
async function getPlanTimeoutSeconds(tenancy: Tenancy): Promise<number> {
  const billingTeamId = getBillingTeamId(tenancy.project);
  if (billingTeamId == null || !arePlanLimitsEnforced()) return MAX_EXECUTION_TIME_SECONDS;
  const app = getHexclaveServerApp();
  const item = await app.getItem({ itemId: ITEM_IDS.analyticsTimeoutSeconds, teamId: billingTeamId });
  // Zero would mean "unlimited" to ClickHouse, so clamp to at least a second.
  return Math.min(Math.max(item.quantity, 1), MAX_EXECUTION_TIME_SECONDS);
}

/**
 * Whether the ClickHouse admin can hand `TABLE ENGINE` grants to warehouse users.
 *
 * On a self-managed server with `table_engines_require_grant` it holds the privilege
 * WITH GRANT OPTION and the grants are required, since safe engines are denied until
 * granted. On ClickHouse Cloud it does not, and the grants are unnecessary: Cloud
 * does not support engine grants and allows the safe engines without one. So we
 * decide from the admin's actual capability rather than a deployment label. The
 * `REVOKE SOURCES` in provisioning stays unconditional — it never needs grant
 * option, and it is the real security boundary.
 *
 * Memoized: the admin's own privileges do not change between requests.
 */
let adminCanGrantTableEnginesCache: boolean | undefined;

async function getAdminCanGrantTableEngines(client: ClickHouseClient): Promise<boolean> {
  if (adminCanGrantTableEnginesCache !== undefined) {
    return adminCanGrantTableEnginesCache;
  }
  const result = await client.query({
    query: `
      SELECT count() AS can_grant
      FROM system.grants
      WHERE access_type IN ('TABLE ENGINE', 'ALL')
        AND grant_option = 1
        AND (user_name = currentUser() OR role_name IN (SELECT role_name FROM system.enabled_roles))
    `,
    format: "JSON",
  });
  const rows = await result.json<{ can_grant: string }>();
  const canGrant = Number(rows.data[0]?.can_grant ?? 0) > 0;
  adminCanGrantTableEnginesCache = canGrant;
  return canGrant;
}

async function runClickhouseCleanupSteps(
  context: string,
  steps: ReadonlyArray<() => Promise<unknown>>,
  reportError: (context: string, error: unknown) => void = (errorContext, error) => captureError(errorContext, error),
): Promise<boolean> {
  let succeeded = true;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      succeeded = false;
      reportError(context, error);
    }
  }
  return succeeded;
}

import.meta.vitest?.test("ClickHouse cleanup attempts every step after a failure", async ({ expect }) => {
  const attempts: string[] = [];
  const reportedErrors: unknown[] = [];
  const firstError = new Error("first cleanup failed");
  const succeeded = await runClickhouseCleanupSteps("test-cleanup", [
    async () => {
      attempts.push("first");
      throw firstError;
    },
    async () => {
      attempts.push("second");
    },
    async () => {
      attempts.push("close");
    },
  ], (_context, error) => reportedErrors.push(error));

  expect(succeeded).toBe(false);
  expect(attempts).toEqual(["first", "second", "close"]);
  expect(reportedErrors).toEqual([firstError]);
});

/**
 * Creates (or repairs) the ClickHouse database, user, grants, settings and quota
 * for a project, and sets the user's password.
 *
 * Every statement is idempotent, so this doubles as the retry path for a
 * provisioning run that died halfway.
 */
async function applyWarehouseDdl(options: {
  tenancy: Tenancy,
  databaseName: string,
  userName: string,
  password: string,
}): Promise<void> {
  const { tenancy, databaseName, userName, password } = options;
  const quotedDatabase = quoteClickhouseIdentifierFromProjectId(databaseName);
  const quotedUser = quoteClickhouseIdentifierFromProjectId(userName);
  const quotaName = `\`${userName}_quota\``;
  const timeoutSeconds = await getPlanTimeoutSeconds(tenancy);
  const client = getClickhouseAdminClient();

  try {
    await client.command({ query: `CREATE DATABASE IF NOT EXISTS ${quotedDatabase}` });

    // CREATE IF NOT EXISTS + ALTER, not CREATE OR REPLACE: replacing a user drops
    // its grants and detaches its quota, breaking the warehouse on every rotation.
    await client.command({
      query: `CREATE USER IF NOT EXISTS ${quotedUser} IDENTIFIED WITH sha256_password BY {password:String}`,
      query_params: { password },
    });
    // SETTINGS clauses cannot take query parameters, so the identity settings are
    // interpolated. The project id is UUID-validated above; check the branch id here
    // so neither can carry a quote.
    if (!/^[a-zA-Z0-9_-]+$/.test(tenancy.branchId)) {
      throw new HexclaveAssertionError("Unexpected branch id shape for a ClickHouse setting", { branchId: tenancy.branchId });
    }
    // Start from nothing, so a re-run also removes grants an older version issued.
    await client.command({ query: `REVOKE ALL PRIVILEGES ON *.* FROM ${quotedUser}` });
    await client.command({ query: `REVOKE ALL FROM ${quotedUser}` });

    await client.command({ query: `GRANT ${ANALYTICS_READER_ROLE} TO ${quotedUser}` });
    await client.command({
      query: `GRANT ${OWN_DATABASE_PRIVILEGES.join(", ")} ON ${quotedDatabase}.* TO ${quotedUser}`,
    });
    // Clients that introspect before querying (clickhouse-client, BI tools, dbt).
    await client.command({ query: `GRANT SHOW DATABASES ON ${quotedDatabase}.* TO ${quotedUser}` });

    // Skipped on Cloud, where the admin cannot grant them and they are unnecessary
    // anyway; see `getAdminCanGrantTableEngines`.
    if (await getAdminCanGrantTableEngines(client)) {
      for (const engine of ALLOWED_TABLE_ENGINES) {
        await client.command({ query: `GRANT TABLE ENGINE ON ${engine} TO ${quotedUser}` });
      }
    }
    // Gates the table functions (`url()`, `s3()`, `remote()`, …) and every engine
    // backed by an outside source. `SOURCES` is the parent of all source privileges,
    // so this also covers sources a newer server adds; naming them one by one would
    // go stale, and a name the server does not know is a syntax error that would
    // break provisioning. Engines are only mapped to their source from ClickHouse
    // 26.5 on, so full engine coverage needs a server at least that new.
    await client.command({ query: `REVOKE SOURCES ON *.* FROM ${quotedUser}` });

    await client.command({
      query: `
        CREATE QUOTA OR REPLACE ${quotaName}
        KEYED BY user_name
        FOR INTERVAL ${QUOTA_INTERVAL_HOURS} HOUR
          MAX queries = ${QUOTA_MAX_QUERIES},
              errors = ${QUOTA_MAX_ERRORS},
              execution_time = ${QUOTA_MAX_EXECUTION_TIME_SECONDS}
        TO ${quotedUser}
      `,
    });

    // Password last: if any grant or quota command above fails, the old password
    // still works, so a rotation can repair the rest instead of locking everyone out.
    await client.command({
      query: `
        ALTER USER ${quotedUser}
        IDENTIFIED WITH sha256_password BY {password:String}
        DEFAULT ROLE ALL
        SETTINGS
          SQL_project_id = '${tenancy.project.id}' CONST,
          SQL_branch_id = '${tenancy.branchId}' CONST,
          max_execution_time = ${timeoutSeconds} MIN ${MIN_EXECUTION_TIME_SECONDS} MAX ${timeoutSeconds},
          max_memory_usage = ${MAX_MEMORY_USAGE_BYTES} MIN ${MIN_MEMORY_USAGE_BYTES} MAX ${MAX_MEMORY_USAGE_BYTES},
          max_memory_usage_for_user = ${MAX_MEMORY_USAGE_FOR_USER_BYTES} MIN ${MIN_MEMORY_USAGE_BYTES} MAX ${MAX_MEMORY_USAGE_FOR_USER_BYTES},
          max_concurrent_queries_for_user = ${MAX_CONCURRENT_QUERIES_FOR_USER} MIN ${MIN_CONCURRENT_QUERIES_FOR_USER} MAX ${MAX_CONCURRENT_QUERIES_FOR_USER},
          max_threads = ${MAX_THREADS} MIN ${MIN_THREADS} MAX ${MAX_THREADS}
      `,
      query_params: { password },
    });
  } finally {
    await client.close();
  }
}

async function decryptWarehousePassword(encryptedPassword: DataWarehouse["encryptedPassword"]): Promise<string | null> {
  if (encryptedPassword == null) return null;
  const envelope = await yupValidate(encryptedWarehousePasswordSchema, encryptedPassword);
  return await decryptWithKms(envelope);
}

async function withDataWarehouseOperationLock<T>(options: {
  prisma: Awaited<ReturnType<typeof getPrismaClientForTenancy>>,
  tenancyId: string,
  operation: (tx: PrismaClientTransaction) => Promise<T>,
}): Promise<T> {
  // This transaction spans the ClickHouse mutation, so it must not use
  // retryTransaction — a retry would replay a non-transactional side effect. The
  // advisory lock makes overlapping provision/rotation requests fail fast rather
  // than return two competing passwords.
  //
  // TODO(data-warehouse-ga): make this a durable multi-phase operation. For alpha we
  // accept that a commit failure after the callback returns is ambiguous: ClickHouse
  // may hold the new password while PostgreSQL still has the old one.
  // eslint-disable-next-line no-restricted-syntax
  return await options.prisma.$transaction(async (tx) => {
    const lockRows = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(
        ${DATA_WAREHOUSE_OPERATION_LOCK_CLASS}::int,
        hashtext(${options.tenancyId}::text)
      ) AS locked
    `;
    if (lockRows.length !== 1) {
      throw new HexclaveAssertionError("PostgreSQL returned an unexpected result count for the Data Warehouse advisory lock", {
        resultCount: lockRows.length,
      });
    }
    const [lockRow] = lockRows;
    if (!lockRow.locked) {
      throw new StatusError(409, "Another Data Warehouse operation is already in progress. Please try again.");
    }
    return await options.operation(tx);
  }, { timeout: DATA_WAREHOUSE_OPERATION_TIMEOUT_MS });
}

async function restorePreviousWarehouseDdl(options: {
  tenancy: Tenancy,
  databaseName: string,
  userName: string,
  previousPassword: string,
}): Promise<boolean> {
  try {
    await applyWarehouseDdl({
      tenancy: options.tenancy,
      databaseName: options.databaseName,
      userName: options.userName,
      password: options.previousPassword,
    });
    return true;
  } catch (error) {
    captureError("data-warehouse-restore-previous-ddl", error);
    return false;
  }
}

async function cleanUpUnpersistedWarehouseUser(userName: string): Promise<boolean> {
  const quotedUser = quoteClickhouseIdentifierFromProjectId(userName);
  const quotaName = `\`${userName}_quota\``;
  const client = getClickhouseAdminClient();
  // Keep the database and customer data so a retry stays non-destructive, but drop
  // credentials the failed request could neither return nor store. Every step runs
  // even if an earlier one fails, so a quota error cannot strand live credentials.
  return await runClickhouseCleanupSteps("data-warehouse-clean-up-unpersisted-user", [
    async () => await client.command({ query: `DROP QUOTA IF EXISTS ${quotaName}` }),
    async () => await client.command({ query: `DROP USER IF EXISTS ${quotedUser}` }),
    async () => await client.close(),
  ]);
}

async function recoverPreviousWarehouseAccess(options: {
  tenancy: Tenancy,
  databaseName: string,
  userName: string,
  previousPassword: string | null,
}): Promise<boolean> {
  return options.previousPassword == null
    ? await cleanUpUnpersistedWarehouseUser(options.userName)
    : await restorePreviousWarehouseDdl({
      tenancy: options.tenancy,
      databaseName: options.databaseName,
      userName: options.userName,
      previousPassword: options.previousPassword,
    });
}

function generateWarehousePassword(): string {
  // base32, so it survives any connection-string or CLI quoting a customer pastes
  // it into.
  return generateSecureRandomString(160);
}

/**
 * Provisions the project's warehouse and returns the password once; it is stored
 * KMS-encrypted and never returned by any read path.
 *
 * Safe to retry after a failure — the DDL is idempotent and a FAILED row is retried
 * in place. Rejected on an already-READY warehouse, which would silently invalidate
 * credentials in use; rotation is the explicit way to do that.
 */
export async function provisionDataWarehouse(tenancy: Tenancy): Promise<{ password: string, warehouse: DataWarehouse }> {
  await ensureDataWarehouseEntitlement(tenancy);

  const prisma = await getPrismaClientForTenancy(tenancy);
  const { databaseName, userName } = getDataWarehouseNames(tenancy.project.id);

  type ProvisionResult =
    | { status: "ok", password: string, warehouse: DataWarehouse }
    | { status: "failed" };

  const result = await withDataWarehouseOperationLock({
    prisma,
    tenancyId: tenancy.id,
    operation: async (tx): Promise<ProvisionResult> => {
      const existing = await tx.dataWarehouse.findUnique({ where: { tenancyId: tenancy.id } });
      if (existing?.status === "READY") {
        throw new StatusError(400, "This project already has a data warehouse. Rotate the password instead if you need new credentials.");
      }
      const previousPassword = existing == null
        ? null
        : await decryptWarehousePassword(existing.encryptedPassword);
      // The database is per project but this row is per tenancy, so a second tenancy
      // would provision over the first one's data. Not reachable until branches exist.
      const otherTenancyRow = await tx.dataWarehouse.findUnique({ where: { userName } });
      if (otherTenancyRow != null && otherTenancyRow.tenancyId !== tenancy.id) {
        throw new HexclaveAssertionError("A data warehouse for this project is already owned by another tenancy", {
          projectId: tenancy.project.id,
          tenancyId: tenancy.id,
          otherTenancyId: otherTenancyRow.tenancyId,
        });
      }
      await tx.dataWarehouse.upsert({
        where: { tenancyId: tenancy.id },
        create: { tenancyId: tenancy.id, databaseName, userName, status: "PROVISIONING" },
        update: { status: "PROVISIONING", error: null },
      });

      const password = generateWarehousePassword();
      const encryptedPassword = await encryptWithKms(password);
      try {
        await applyWarehouseDdl({ tenancy, databaseName, userName, password });
      } catch (error) {
        captureError("data-warehouse-provision-ddl", error);
        const recovered = await recoverPreviousWarehouseAccess({ tenancy, databaseName, userName, previousPassword });
        await tx.dataWarehouse.update({
          where: { tenancyId: tenancy.id },
          data: {
            status: "FAILED",
            error: recovered
              ? "Provisioning failed. Please try again."
              : "Provisioning failed and the partial credentials could not be cleaned up. Please try again.",
          },
        });
        return { status: "failed" };
      }

      try {
        const warehouse = await tx.dataWarehouse.update({
          where: { tenancyId: tenancy.id },
          data: {
            status: "READY",
            error: null,
            encryptedPassword,
            passwordUpdatedAt: new Date(),
          },
        });
        return { status: "ok", password, warehouse };
      } catch (error) {
        const recovered = await recoverPreviousWarehouseAccess({ tenancy, databaseName, userName, previousPassword });
        throw new HexclaveAssertionError(
          recovered
            ? "Failed to persist Data Warehouse credentials after ClickHouse provisioning; the previous access state was restored"
            : "Failed to persist Data Warehouse credentials after ClickHouse provisioning and could not restore the previous access state",
          { cause: error, tenancyId: tenancy.id },
        );
      }
    },
  });

  if (result.status === "failed") {
    throw new StatusError(500, "Failed to provision the data warehouse. Please try again.");
  }
  return { password: result.password, warehouse: result.warehouse };
}

/**
 * Issues a new password for an existing warehouse and returns it once. Re-applies
 * the full DDL, so rotating also repairs drifted grants or a half-failed provision.
 */
export async function rotateDataWarehousePassword(tenancy: Tenancy): Promise<{ password: string, warehouse: DataWarehouse }> {
  await ensureDataWarehouseEntitlement(tenancy);

  const prisma = await getPrismaClientForTenancy(tenancy);

  type RotationResult =
    | { status: "ok", password: string, warehouse: DataWarehouse }
    | { status: "failed" };

  const result = await withDataWarehouseOperationLock({
    prisma,
    tenancyId: tenancy.id,
    operation: async (tx): Promise<RotationResult> => {
      const existing = await tx.dataWarehouse.findUnique({ where: { tenancyId: tenancy.id } });
      if (existing == null) {
        throw new StatusError(400, "This project does not have a data warehouse yet.");
      }
      // Keyed on the stored password rather than on READY: rotation needs the old
      // password to fall back to if the new one cannot be applied, and a FAILED
      // warehouse that still has one (e.g. after a rotation that could not restore
      // it) should stay rotatable. Without one, provisioning never completed — a
      // user-reachable state after a failed first provision — and provisioning
      // (which retries FAILED rows in place) is the way forward.
      const previousPassword = await decryptWarehousePassword(existing.encryptedPassword);
      if (previousPassword == null) {
        throw new StatusError(400, "This data warehouse has not finished provisioning. Provision it instead of rotating the password.");
      }
      const password = generateWarehousePassword();
      const encryptedPassword = await encryptWithKms(password);
      try {
        await applyWarehouseDdl({
          tenancy,
          databaseName: existing.databaseName,
          userName: existing.userName,
          password,
        });
      } catch (error) {
        captureError("data-warehouse-rotate-ddl", error);
        const restored = await restorePreviousWarehouseDdl({
          tenancy,
          databaseName: existing.databaseName,
          userName: existing.userName,
          previousPassword,
        });
        if (!restored) {
          await tx.dataWarehouse.update({
            where: { tenancyId: tenancy.id },
            data: {
              status: "FAILED",
              error: "Password rotation failed and the previous credentials could not be restored. Please try again.",
            },
          });
        }
        return { status: "failed" };
      }

      try {
        const warehouse = await tx.dataWarehouse.update({
          where: { tenancyId: tenancy.id },
          data: {
            status: "READY",
            error: null,
            encryptedPassword,
            passwordUpdatedAt: new Date(),
          },
        });
        return { status: "ok", password, warehouse };
      } catch (error) {
        const restored = await restorePreviousWarehouseDdl({
          tenancy,
          databaseName: existing.databaseName,
          userName: existing.userName,
          previousPassword,
        });
        throw new HexclaveAssertionError(
          restored
            ? "Failed to persist the rotated Data Warehouse password; the previous password was restored"
            : "Failed to persist the rotated Data Warehouse password and could not restore the previous password",
          { cause: error, tenancyId: tenancy.id },
        );
      }
    },
  });

  if (result.status === "failed") {
    throw new StatusError(500, "Failed to rotate the data warehouse password. Please try again.");
  }
  return { password: result.password, warehouse: result.warehouse };
}

/**
 * The ClickHouse credentials analytics queries (`/analytics/query` and the AI SQL
 * tool, via `withAnalyticsQueryClient`) should connect with, or `null` if the
 * project has no usable warehouse (the caller then falls back to `limited_user`).
 *
 * Decrypts on every call: caching decrypted passwords would need cross-instance
 * invalidation on rotation.
 */
export async function getDataWarehouseQueryAuth(tenancy: Tenancy): Promise<{ username: string, password: string } | null> {
  const warehouse = await getDataWarehouse(tenancy);
  if (warehouse == null || warehouse.status !== "READY" || warehouse.encryptedPassword == null) {
    return null;
  }
  const password = await decryptWarehousePassword(warehouse.encryptedPassword);
  if (password == null) {
    throw new HexclaveAssertionError("A READY Data Warehouse must have an encrypted password", { tenancyId: tenancy.id });
  }
  return { username: warehouse.userName, password };
}

/**
 * Host and ports a customer points their own ClickHouse client at. Falls back to the
 * host of the backend's own ClickHouse URL, which is right locally but wrong wherever
 * the instance is reachable under a different name — hence the explicit env var.
 */
export function getDataWarehouseConnectionInfo(): { host: string, httpsPort: number, nativePort: number } {
  const configuredHost = getEnvVariable("HEXCLAVE_CLICKHOUSE_PUBLIC_HOST", "");
  const host = configuredHost || new URL(getEnvVariable("HEXCLAVE_CLICKHOUSE_URL")).hostname;
  const httpsPort = Number(getEnvVariable("HEXCLAVE_CLICKHOUSE_PUBLIC_HTTPS_PORT", "8443"));
  const nativePort = Number(getEnvVariable("HEXCLAVE_CLICKHOUSE_PUBLIC_NATIVE_PORT", "9440"));
  if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65_535) {
    throw new HexclaveAssertionError("HEXCLAVE_CLICKHOUSE_PUBLIC_HTTPS_PORT must be an integer between 1 and 65535", { httpsPort });
  }
  if (!Number.isInteger(nativePort) || nativePort < 1 || nativePort > 65_535) {
    throw new HexclaveAssertionError("HEXCLAVE_CLICKHOUSE_PUBLIC_NATIVE_PORT must be an integer between 1 and 65535", { nativePort });
  }
  return {
    host,
    httpsPort,
    nativePort,
  };
}
