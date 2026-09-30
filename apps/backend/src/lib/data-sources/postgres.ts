import { getSafeExternalPostgresClientOptions } from "@/lib/ssrf-protection/external-db-sync";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { Client } from "pg";

/** What the customer typed into the connect form, plus the decrypted password. */
export type DataSourceCredentials = {
  host: string,
  port: number,
  database: string,
  username: string,
  password: string,
  sslMode: string,
};

export const DATA_SOURCE_SSL_MODES = ["require", "verify-full", "no-verify", "disable"] as const;

/**
 * Queries run against a customer's production database, so they are bounded and
 * identifiable: a DBA looking at pg_stat_activity should be able to tell at a
 * glance that the query is ours and that it cannot run away.
 */
const STATEMENT_TIMEOUT_MS = 120_000;
const APPLICATION_NAME = "hexclave_data_source_sync";

function buildConnectionString(credentials: DataSourceCredentials): string {
  const url = new URL("postgresql://placeholder");
  url.hostname = credentials.host;
  url.port = String(credentials.port);
  url.pathname = `/${encodeURIComponent(credentials.database)}`;
  url.username = encodeURIComponent(credentials.username);
  url.password = encodeURIComponent(credentials.password);
  url.searchParams.set("sslmode", credentials.sslMode);
  return url.toString();
}

/**
 * Connects to the customer's database with SSRF protection and our own guard
 * rails applied, runs `fn`, and always closes the connection. Read-only: the
 * transaction default is set so a bug in a query builder cannot write to their
 * database, whatever privileges they happened to grant us.
 */
export async function withDataSourceClient<T>(
  credentials: DataSourceCredentials,
  fn: (client: Client) => Promise<T>,
  options?: {
    /**
     * Replication slot management (creating a slot, advancing it) is not a table
     * write but still refuses to run in a read-only transaction, so the CDC path
     * opts out. Everything that reads customer data keeps the default.
     */
    allowWrites?: boolean,
  },
): Promise<T> {
  const clientOptions = await getSafeExternalPostgresClientOptions(buildConnectionString(credentials));
  const client = new Client({
    ...clientOptions,
    application_name: APPLICATION_NAME,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  try {
    await client.connect();
  } catch (error) {
    throw new StatusError(
      StatusError.BadRequest,
      `Could not connect to the source database: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    if (!options?.allowWrites) {
      await client.query("SET default_transaction_read_only = on");
    }
    return await fn(client);
  } finally {
    await client.end().catch(() => {
      // The work is already done; a failure to close cleanly must not mask its result.
    });
  }
}

/** Quotes an identifier for interpolation into SQL we send to the source. */
export function quotePgIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function quotePgQualifiedName(schemaName: string, tableName: string): string {
  return `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(tableName)}`;
}
