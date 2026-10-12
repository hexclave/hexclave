import { createClient, type ClickHouseClient, type ClickHouseSettings } from "@clickhouse/client";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { Result } from "@hexclave/shared/dist/utils/results";

// Re-exported so other modules can hold a typed ClickHouse client (e.g. to
// thread a single warmed client through helpers) without taking a direct
// dependency on the @clickhouse/client package.
export type { ClickHouseClient } from "@clickhouse/client";

function getAdminAuth() {
  return {
    username: getEnvVariable("STACK_CLICKHOUSE_ADMIN_USER", "stackframe"),
    password: getEnvVariable("STACK_CLICKHOUSE_ADMIN_PASSWORD"),
  };
}

export function createClickhouseClient(
  authType: "admin" | "external",
  database?: string,
  clickhouse_settings?: ClickHouseSettings,
) {
  return createClient({
    url: getEnvVariable("STACK_CLICKHOUSE_URL"),
    ...authType === "admin" ? getAdminAuth() : {
      username: "limited_user",
      password: getEnvVariable("STACK_CLICKHOUSE_EXTERNAL_PASSWORD"),
    },
    database,
    request_timeout: 10 * 60 * 1000, // 10 minutes
    clickhouse_settings,
  });
}

const PRE_CONNECTION_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"]);
// Node raises this (with code ECONNRESET) when the peer drops the connection mid TLS handshake.
// The HTTP request is only written after the handshake completes, so ClickHouse never saw it.
const TLS_HANDSHAKE_DISCONNECT_MESSAGE = "Client network socket disconnected before secure TLS connection was established";

/**
 * Whether a ClickHouse call failed before its request could have reached the server, which makes
 * it safe to retry even for non-idempotent statements like inserts. A plain ECONNRESET (e.g. a
 * reused keep-alive socket reset mid-request) is deliberately not included: the server may already
 * have received and applied the request.
 */
export function isClickhousePreConnectionError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    const code = Reflect.get(current, "code");
    if (typeof code === "string" && PRE_CONNECTION_ERROR_CODES.has(code)) return true;
    if (current instanceof Error && code === "ECONNRESET" && current.message.startsWith(TLS_HANDSHAKE_DISCONNECT_MESSAGE)) return true;
    current = Reflect.get(current, "cause");
  }
  return false;
}

/**
 * Runs a ClickHouse call, retrying up to `retries` times when it fails before the request reached
 * the server (see isClickhousePreConnectionError). Any other error is rethrown immediately.
 */
export async function withClickhousePreConnectionRetries<T>(
  fn: () => Promise<T>,
  { retries = 2, exponentialDelayBase = 250 }: { retries?: number, exponentialDelayBase?: number } = {},
): Promise<T> {
  const result = await Result.retry(async () => {
    const attempt = await Result.fromPromise(fn());
    if (attempt.status === "error" && !isClickhousePreConnectionError(attempt.error)) {
      throw attempt.error;
    }
    return attempt;
  }, retries + 1, { exponentialDelayBase });
  if (result.status === "error") {
    // Rethrow the last attempt's own error rather than Result.retry's RetryError wrapper, so callers
    // and alerting still see the original ClickHouse error (code, message) once retries run out.
    throw result.error.errors.at(-1) ?? throwErr("Result.retry failed without recording an attempt error; retries must be >= 0");
  }
  return result.data;
}

export function getClickhouseAdminClient() {
  return createClickhouseClient("admin", getEnvVariable("STACK_CLICKHOUSE_DATABASE", "default"));
}

const BOUNDED_ANALYTICS_CLICKHOUSE_SETTINGS: ClickHouseSettings = {
  max_bytes_before_external_group_by: "256000000",
  max_memory_usage: "512000000",
  max_memory_usage_for_user: "9000000000",
  // SDK type narrows to a single algorithm; the server accepts a fallback list.
  join_algorithm: "grace_hash,parallel_hash,hash" as ClickHouseSettings["join_algorithm"],
};

// Every query through limited_user is ultimately user- or agent-authored, including the dashboard
// analytics endpoint and both AI SQL tools. Keep the resource ceiling at the client boundary so a
// new caller cannot accidentally bypass it by omitting per-query settings. GROUP BYs spill before
// reaching the per-query cap, large joins use bounded partitions, and the shared-user cap prevents
// concurrent external queries from exhausting the whole ClickHouse cluster.
export const EXTERNAL_CLICKHOUSE_SETTINGS: ClickHouseSettings = {
  ...BOUNDED_ANALYTICS_CLICKHOUSE_SETTINGS,
};

export function getClickhouseExternalClient() {
  return createClickhouseClient(
    "external",
    getEnvVariable("STACK_CLICKHOUSE_DATABASE", "default"),
    EXTERNAL_CLICKHOUSE_SETTINGS,
  );
}

// Safety net for heavy analytical reads against `analytics_internal.events`:
// GROUP BY spills to disk at ~50% of the per-query cap (leaving headroom for
// the post-spill merge), grace_hash partitions large join build sides instead
// of allocating one giant hash table, and the per-user cap bounds total
// concurrent memory against the cluster's 10.8 GiB OvercommitTracker. Values
// are decimal bytes (how ClickHouse parses digit strings).
//
// Note: max_memory_usage_for_user is enforced ClickHouse-side per *connecting
// user* (the shared `stackframe` admin), so all admin queries — not just this
// client's — count toward the same 9 GB budget. With the 30-day bounds each
// metrics query peaks well under 100 MiB, so practical interference is low.
export const METRICS_CLICKHOUSE_SETTINGS: ClickHouseSettings = {
  ...BOUNDED_ANALYTICS_CLICKHOUSE_SETTINGS,
};

export function getClickhouseAdminClientForMetrics() {
  return createClickhouseClient(
    "admin",
    getEnvVariable("STACK_CLICKHOUSE_DATABASE", "default"),
    METRICS_CLICKHOUSE_SETTINGS,
  );
}

export const getQueryTimingStats = async (client: ClickHouseClient, queryId: string) => {
  // Flush logs to ensure system.query_log has latest query result.
  // Todo: for performance we should instead poll for this row to become available asynchronously after returning result. Flushed every 7.5 seconds by default
  await client.exec({
    query: "SYSTEM FLUSH LOGS",
    auth: getAdminAuth(),
  });
  const queryProfile = async () => {
    const profile = await client.query({
      query: `
      SELECT
        ProfileEvents['CPUTimeMicroseconds'] / 1000 AS cpu_time_ms,
        ProfileEvents['RealTimeMicroseconds'] / 1000 AS wall_clock_time_ms
      FROM system.query_log
      WHERE query_id = {query_id:String} AND type = 'QueryFinish'
      ORDER BY event_time DESC
      LIMIT 1
    `,
      query_params: { query_id: queryId },
      auth: getAdminAuth(),
      format: "JSON",
    });

    return await profile.json<{
      cpu_time_ms: number,
      wall_clock_time_ms: number,
    }>();
  };

  const retryDelaysMs = [75, 150, 300, 600, 1200];
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const stats = await queryProfile();
    if (stats.data.length === 1) {
      return stats.data[0];
    }
    if (stats.data.length > 1) {
      throw new HexclaveAssertionError(`Unexpected number of query log results: ${stats.data.length}`, { data: stats.data });
    }
    if (attempt < retryDelaysMs.length) {
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    }
  }

  throw new HexclaveAssertionError("Unexpected number of query log results: 0", { data: [] });
};

export const getQueryTimingStatsForProject = async (
  client: ClickHouseClient,
  queryId: string,
) => {
  const queryProfile = async () => {
    const profile = await client.query({
      query: `
      SELECT
        ProfileEvents['CPUTimeMicroseconds'] / 1000 AS cpu_time_ms,
        ProfileEvents['RealTimeMicroseconds'] / 1000 AS wall_clock_time_ms
      FROM system.query_log
      WHERE query_id = {query_id:String}
        AND type = 'QueryFinish'
      ORDER BY event_time DESC
      LIMIT 1
    `,
      query_params: {
        query_id: queryId,
      },
      auth: getAdminAuth(),
      format: "JSON",
    });

    return await profile.json<{
      cpu_time_ms: number,
      wall_clock_time_ms: number,
    }>();
  };

  const retryDelaysMs = [75, 150, 300, 600, 1200, 2400, 4800];
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const stats = await queryProfile();
    if (stats.data.length === 1) {
      return stats.data[0];
    }
    if (stats.data.length > 1) {
      throw new HexclaveAssertionError(`Unexpected number of query log results: ${stats.data.length}`, { data: stats.data });
    }
    if (attempt < retryDelaysMs.length) {
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    }
  }

  return null;
};

import.meta.vitest?.describe("ClickHouse pre-connection retries", (test) => {
  // A TCP server that accepts and immediately closes every connection, so a TLS client sees the
  // same "disconnected before secure TLS connection was established" error as in production.
  async function startClosingServer() {
    const net = await import("node:net");
    let connections = 0;
    const sockets = new Set<import("node:net").Socket>();
    const server = net.createServer((socket) => {
      connections++;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.end();
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error(`Expected a TCP address, got ${JSON.stringify(address)}`));
          return;
        }
        resolve(address.port);
      });
    });
    return {
      port,
      get connections() { return connections; },
      // The client never finishes closing its half of the dropped sockets, so server.close() would
      // wait on them forever.
      close: () => new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
    };
  }

  function insertVia(port: number) {
    const client = createClient({ url: `https://127.0.0.1:${port}`, username: "test", password: "test" });
    return client.insert({ table: "t", values: [{ a: 1 }], format: "JSONEachRow" });
  }

  test("classifies the real client's TLS handshake disconnect as pre-connection", async ({ expect }) => {
    const server = await startClosingServer();
    try {
      const result = await Result.fromPromise(insertVia(server.port));
      if (result.status === "ok") throw new Error("Expected the insert to fail against a closing server");
      expect(result.error).toMatchObject({ code: "ECONNRESET" });
      expect(isClickhousePreConnectionError(result.error)).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("retries a TLS handshake disconnect twice before giving up", async ({ expect }) => {
    const server = await startClosingServer();
    try {
      const result = await Result.fromPromise(withClickhousePreConnectionRetries(() => insertVia(server.port), { exponentialDelayBase: 0 }));
      if (result.status === "ok") throw new Error("Expected the insert to fail against a closing server");
      expect(server.connections).toBe(3);
      // Callers see the original connect error, not Result.retry's RetryError wrapper.
      expect(result.error).toMatchObject({ code: "ECONNRESET" });
      expect(result.error).not.toBeInstanceOf(AggregateError);
      expect(isClickhousePreConnectionError(result.error)).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("returns the result once a retry succeeds", async ({ expect }) => {
    let calls = 0;
    const value = await withClickhousePreConnectionRetries(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
      return "inserted";
    }, { exponentialDelayBase: 0 });
    expect(value).toBe("inserted");
    expect(calls).toBe(3);
  });

  test("rethrows the last attempt's error once retries are exhausted", async ({ expect }) => {
    const attemptErrors = [1, 2, 3].map((i) => Object.assign(new Error(`connect ECONNREFUSED (attempt ${i})`), { code: "ECONNREFUSED" }));
    let calls = 0;
    const result = await Result.fromPromise(withClickhousePreConnectionRetries(async () => {
      throw attemptErrors[calls++];
    }, { exponentialDelayBase: 0 }));
    if (result.status === "ok") throw new Error("Expected every attempt to fail");
    expect(result.error).toBe(attemptErrors[2]);
    expect(calls).toBe(3);
  });

  test("does not retry errors that may have happened after the request was sent", async ({ expect }) => {
    let calls = 0;
    const midRequestReset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const result = await Result.fromPromise(withClickhousePreConnectionRetries(async () => {
      calls++;
      throw midRequestReset;
    }, { exponentialDelayBase: 0 }));
    expect(result).toEqual({ status: "error", error: midRequestReset });
    expect(calls).toBe(1);
  });

  test("finds pre-connection errors in the cause chain", ({ expect }) => {
    const wrapped = new Error("insert failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    expect(isClickhousePreConnectionError(wrapped)).toBe(true);
    expect(isClickhousePreConnectionError(new Error("Code: 62. Syntax error"))).toBe(false);
  });
});
