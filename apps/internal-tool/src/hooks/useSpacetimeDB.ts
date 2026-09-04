import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useRef, useState } from "react";
import { createPendingCallRegistry } from "../lib/pending-call-registry";
import { spacetimeDbName } from "../lib/spacetimedb-constants";
import { DbConnection, type ErrorContext, type EventContext } from "../module_bindings";
import type { AiQueryLogRow, FeedbackLogRow, McpCallLogRow, PublishedQaRow, QaEntriesRow } from "../types";

export type GetSpacetimeToken = () => Promise<string>;

const PLACEHOLDER_ENV_VALUE = "REPLACE_ME";

function requireEnv(value: string | undefined, name: string): string {
  if (value == null || value === "" || value === PLACEHOLDER_ENV_VALUE) {
    throw new Error(`${name} is not configured. Set it in apps/internal-tool/.env.development or your local env.`);
  }
  return value;
}

let cachedConfig: { host: string, dbName: string } | null = null;
function getConfig() {
  if (cachedConfig) return cachedConfig;
  const host = requireEnv(process.env.NEXT_PUBLIC_SPACETIMEDB_HOST, "NEXT_PUBLIC_SPACETIMEDB_HOST");
  if (process.env.NODE_ENV !== "development" && !host.startsWith("wss://")) {
    throw new Error("NEXT_PUBLIC_SPACETIMEDB_HOST must use wss:// in production");
  }
  cachedConfig = { host, dbName: spacetimeDbName() };
  return cachedConfig;
}

const RETRIES_BEFORE_ERROR_STATE = 5;
const RETRY_DELAY_MS = 2000;
const MAX_RETRY_DELAY_MS = 30_000;
const TOKEN_RECONNECT_INTERVAL_MS = 8 * 60 * 1000;

type ConnectionState = "connecting" | "connected" | "error";

function formatUnknownError(value: unknown, fallback: string, depth = 0): string {
  if (value instanceof Error) {
    return value.message !== "" ? value.message : value.name;
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value == null) return fallback;
  if (typeof value !== "object") return fallback;

  for (const property of ["message", "error", "reason", "statusText"]) {
    const propertyValue = value[property];
    if (typeof propertyValue === "string" && propertyValue !== "") {
      return propertyValue;
    }
  }

  if (depth < 2) {
    for (const property of ["error", "cause", "event"]) {
      const propertyValue: unknown = value[property];
      if (propertyValue != null && propertyValue !== value) {
        const nestedMessage = formatUnknownError(propertyValue, "", depth + 1);
        if (nestedMessage !== "") {
          return nestedMessage;
        }
      }
    }
  }

  try {
    const serialized = JSON.stringify(value, (_key, nestedValue: unknown) => (
      typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue
    ));
    if (serialized !== "{}") {
      return serialized;
    }
  } catch {
    // Fall through to the best generic representation below.
  }

  const stringified = String(value);
  return stringified !== "[object Object]" ? stringified : fallback;
}

// The row callbacks intentionally take no arguments: React state is always
// rebuilt from the SDK's table cache (see resyncFromCache below), never
// patched row-by-row from event payloads.
type TableBinding<Row extends { id: bigint }> = {
  tableName: string,
  iter: (conn: DbConnection) => Iterable<Row>,
  onInsert: (conn: DbConnection, cb: () => void) => void,
  onDelete: (conn: DbConnection, cb: () => void) => void,
  onUpdate?: (conn: DbConnection, cb: () => void) => void,

  pageOlder?: (conn: DbConnection, cursor: PageCursor | null, limit: number) => Promise<PagedRows<Row>>,

  cursorFromRow?: (row: Row) => PageCursor,
};

export type PageCursor = { beforeCreatedAtMicros: bigint, beforeId: bigint | undefined };
type PagedRows<Row> = {
  rows: Row[],
  nextBeforeCreatedAtMicros: bigint | undefined,
  nextBeforeId: bigint | undefined,
};

const HISTORY_PAGE_SIZE = 50;

// Shared by every log binding: history resumes just below a row, keyed on
// (createdAt, id) so rows sharing a timestamp are not skipped or repeated.
function cursorFromLogRow(row: { id: bigint, createdAt: { microsSinceUnixEpoch: bigint } }): PageCursor {
  return { beforeCreatedAtMicros: row.createdAt.microsSinceUnixEpoch, beforeId: row.id };
}

function useTableSubscription<Row extends { id: bigint }>(
  binding: TableBinding<Row>,
  getToken?: GetSpacetimeToken,
  requireAuth = false,
) {
  const [rows, setRows] = useState<Row[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [connectionErrorMessage, setConnectionErrorMessage] = useState<string | null>(null);
  const [conn, setConn] = useState<DbConnection | null>(null);
  const connRef = useRef<DbConnection | null>(null);
  const [olderRows, setOlderRows] = useState<Row[]>([]);
  const [historyCursor, setHistoryCursor] = useState<PageCursor | null>(null);
  const [hasMoreHistory, setHasMoreHistory] = useState(binding.pageOlder != null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  const [pendingCalls] = useState(createPendingCallRegistry);

  useEffect(() => {
    if (requireAuth && !getToken) {
      setRows([]);
      setConn(null);
      setConnectionState("connecting");
      return;
    }

    setOlderRows([]);
    setHistoryCursor(null);
    setHasMoreHistory(binding.pageOlder != null);
    loadingOlderRef.current = false;
    setIsLoadingOlder(false);

    let cancelled = false;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let lastConnectionErrorMessage: string | null = null;
    // Every connection built in this effect generation that hasn't been
    // disposed yet. Old connections are kept alive until their replacement's
    // subscription has applied (make-before-break), so the UI never blanks
    // during a token refresh; this set lets the winner (and the unmount
    // cleanup) dispose of the rest.
    const liveConns = new Set<DbConnection>();
    // Mirrors the length of the last rows array pushed to React state; used to
    // detect a non-empty view collapsing to empty (see resyncFromCache).
    let lastRenderedRowCount = 0;
    // True while a session-lapse-triggered reconnect is pending, so repeated
    // empty resyncs don't stack up reconnect attempts. Reset when any
    // subscription applies.
    let sessionRefreshInFlight = false;
    const query = `SELECT * FROM ${binding.tableName}`;

    const closedConnError = () => new Error("SpacetimeDB connection was closed while the call was in flight. The change may or may not have been applied — check the list and retry if needed.");

    function retry() {
      if (cancelled || retryTimer != null) return;
      retryCount++;
      if (retryCount >= RETRIES_BEFORE_ERROR_STATE) {
        const message = lastConnectionErrorMessage == null
          ? `Failed to connect to ${binding.tableName} after ${retryCount} attempts (still retrying)`
          : `Failed to connect to ${binding.tableName} after ${retryCount} attempts (still retrying). Last error: ${lastConnectionErrorMessage}`;
        if (retryCount === RETRIES_BEFORE_ERROR_STATE) {
          captureError("spacetimedb-connect-retries", new Error(message));
        }
        setConnectionErrorMessage(message);
        setConnectionState("error");
      }
      const delay = Math.min(RETRY_DELAY_MS * 2 ** Math.min(retryCount - 1, 5), MAX_RETRY_DELAY_MS);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!cancelled) {
          runAsynchronously(() => connect());
        }
      }, delay);
    }

    function scheduleTokenReconnect() {
      if (!getToken || reconnectTimer != null) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (cancelled) return;
        // Make-before-break: the current connection keeps serving rows until
        // the replacement's subscription has applied (see onApplied below).
        runAsynchronously(() => connect());
      }, TOKEN_RECONNECT_INTERVAL_MS);
    }

    async function connect() {
      const config = getConfig();
      let token: string | null = null;
      if (getToken) {
        try {
          token = await getToken();
        } catch (err) {
          if (cancelled) return;
          lastConnectionErrorMessage = formatUnknownError(err, "Failed to get Stack Auth access token");
          setConnectionErrorMessage(lastConnectionErrorMessage);
          captureError("spacetimedb-access-token", err);
          retry();
          return;
        }
      }
      if (cancelled) return;

      let thisConn: DbConnection | null = null;
      const builder = DbConnection.builder()
        .withUri(config.host)
        .withDatabaseName(config.dbName)
        .onConnect((connInstance: DbConnection, _identity, _token) => {
          if (cancelled) return;
          if (connRef.current !== connInstance) {
            // A newer connect() superseded this attempt while it was still in
            // flight; let the winner drive the UI and dispose of this one.
            connInstance.disconnect();
            liveConns.delete(connInstance);
            return;
          }
          retryCount = 0;
          setConn(connInstance);
          setConnectionErrorMessage(null);
          scheduleTokenReconnect();

          // Our tables are backed by function views, and view row types carry
          // no primary key on the client. For PK-less tables the SpacetimeDB
          // SDK never emits `update` events — a server-side row update arrives
          // as insert(newValue) + delete(oldValue), with inserts processed
          // FIRST. Mirroring those events into React state keyed by `id` is
          // therefore wrong: the insert replaces the row in place, then the
          // delete (same `id`, old value) removes it entirely, so every row
          // silently disappeared from the UI the moment it was updated (e.g.
          // when the OpenRouter usage refinement landed a few seconds after
          // each AI call). The SDK's own table cache refcounts by full row
          // value and stays correct through all of this, so we treat it as the
          // source of truth and rebuild React state from it on every event.
          const snapshotFromCache = () => {
            const all = Array.from(binding.iter(connInstance));
            all.sort((a, b) => Number(b.id - a.id));
            return all;
          };

          const applyRows = (all: Row[]) => {
            lastRenderedRowCount = all.length;
            setRows(all);
          };

          const resyncFromCache = () => {
            if (cancelled || connRef.current !== connInstance) return;
            const all = snapshotFromCache();
            if (all.length === 0 && lastRenderedRowCount > 0) {
              if (!sessionRefreshInFlight) {
                sessionRefreshInFlight = true;
                runAsynchronously(() => connect());
              }
              return;
            }
            applyRows(all);
          };

          const startSubscription = () => {
            if (cancelled) return;
            connInstance.subscriptionBuilder()
              .onApplied(() => {
                if (cancelled || connRef.current !== connInstance) return;
                sessionRefreshInFlight = false;
                // The new subscription is live — only now is it safe to drop
                // older connections without the UI ever missing rows.
                let droppedAny = false;
                for (const old of liveConns) {
                  if (old !== connInstance) {
                    old.disconnect();
                    liveConns.delete(old);
                    droppedAny = true;
                  }
                }
                if (droppedAny) {
                  pendingCalls.rejectAll(closedConnError());
                }
                // Unlike event-driven resyncs, a fresh subscription's snapshot
                // is authoritative even when empty (the session was just
                // re-established, so [] here means the table really is empty).
                applyRows(snapshotFromCache());
                setConnectionState("connected");
              })
              .onError((ctx: ErrorContext) => {
                if (cancelled || connRef.current !== connInstance) return;
                const message = formatUnknownError(ctx, "SpacetimeDB subscription error");
                lastConnectionErrorMessage = message;
                captureError("spacetimedb-subscription", ctx);
                setConnectionErrorMessage(message);
                setConnectionState("error");
              })
              .subscribe(query);
          };

          startSubscription();

          binding.onInsert(connInstance, resyncFromCache);
          binding.onDelete(connInstance, resyncFromCache);
          binding.onUpdate?.(connInstance, resyncFromCache);
        })
        .onConnectError((_ctx: unknown, err: unknown) => {
          if (cancelled) return;
          if (thisConn != null) liveConns.delete(thisConn);
          const message = formatUnknownError(err, "SpacetimeDB connection error");
          lastConnectionErrorMessage = message;
          setConnectionErrorMessage(message);
          captureError("spacetimedb-connect", err);
          retry();
        })
        .onDisconnect(() => {
          if (thisConn != null) liveConns.delete(thisConn);
          if (cancelled || connRef.current !== thisConn) return;
          pendingCalls.rejectAll(closedConnError());
          setConnectionState("connecting");
          retry();
        });
      if (token != null) {
        builder.withToken(token);
      }
      const newConn = builder.build();
      thisConn = newConn;
      liveConns.add(newConn);
      connRef.current = newConn;
    }

    runAsynchronously(() => connect());

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      for (const c of liveConns) {
        c.disconnect();
      }
      liveConns.clear();
      connRef.current = null;
      setConn(null);
      pendingCalls.rejectAll(closedConnError());
    };
  }, [binding, getToken, requireAuth, pendingCalls]);

  const callReducer = async <T>(call: (conn: DbConnection) => Promise<T>): Promise<T> => {
    if (conn == null) {
      throw new Error("Not connected to SpacetimeDB yet. Try again in a moment.");
    }
    return await pendingCalls.track(call(conn));
  };

  const loadOlder = async (): Promise<void> => {
    const pageOlder = binding.pageOlder;
    if (pageOlder == null || conn == null || loadingOlderRef.current || !hasMoreHistory) return;

    const oldestShown = olderRows.at(-1) ?? rows.at(-1);
    const cursor = historyCursor
      ?? (oldestShown == null || binding.cursorFromRow == null ? null : binding.cursorFromRow(oldestShown));

    loadingOlderRef.current = true;
    setIsLoadingOlder(true);
    try {
      const page = await pendingCalls.track(pageOlder(conn, cursor, HISTORY_PAGE_SIZE));
      setOlderRows((existing) => {
        const seen = new Set([...rows, ...existing].map((r) => r.id));
        return [...existing, ...page.rows.filter((r) => !seen.has(r.id))];
      });
      if (page.nextBeforeCreatedAtMicros == null) {
        setHasMoreHistory(false);
        setHistoryCursor(null);
      } else {
        setHistoryCursor({
          beforeCreatedAtMicros: page.nextBeforeCreatedAtMicros,
          beforeId: page.nextBeforeId,
        });
      }
    } finally {
      loadingOlderRef.current = false;
      setIsLoadingOlder(false);
    }
  };

  return {
    rows,
    olderRows,
    hasMoreHistory,
    isLoadingOlder,
    loadOlder,
    canPageHistory: binding.pageOlder != null,
    connectionState,
    connectionErrorMessage,
    callReducer,
  };
}

const mcpBinding: TableBinding<McpCallLogRow> = {
  tableName: "my_visible_mcp_call_log",
  iter: (conn) => conn.db.myVisibleMcpCallLog.iter(),
  onInsert: (conn, cb) => {
    conn.db.myVisibleMcpCallLog.onInsert((_ctx: EventContext, _row: McpCallLogRow) => cb());
  },
  onDelete: (conn, cb) => {
    conn.db.myVisibleMcpCallLog.onDelete((_ctx: EventContext, _row: McpCallLogRow) => cb());
  },
  onUpdate: (conn, cb) => {
    conn.db.myVisibleMcpCallLog.onUpdate((_ctx: EventContext, _old: McpCallLogRow, _row: McpCallLogRow) => cb());
  },
  cursorFromRow: cursorFromLogRow,
  pageOlder: async (conn, cursor, limit) => await conn.procedures.pageMcpCallLog({
    beforeCreatedAtMicros: cursor?.beforeCreatedAtMicros,
    beforeId: cursor?.beforeId,
    limit,
  }),
};

const aiQueryBinding: TableBinding<AiQueryLogRow> = {
  tableName: "my_visible_ai_query_log",
  iter: (conn) => conn.db.myVisibleAiQueryLog.iter(),
  onInsert: (conn, cb) => {
    conn.db.myVisibleAiQueryLog.onInsert((_ctx: EventContext, _row: AiQueryLogRow) => cb());
  },
  onDelete: (conn, cb) => {
    conn.db.myVisibleAiQueryLog.onDelete((_ctx: EventContext, _row: AiQueryLogRow) => cb());
  },
  onUpdate: (conn, cb) => {
    conn.db.myVisibleAiQueryLog.onUpdate((_ctx: EventContext, _old: AiQueryLogRow, _row: AiQueryLogRow) => cb());
  },
  cursorFromRow: cursorFromLogRow,
  pageOlder: async (conn, cursor, limit) => await conn.procedures.pageAiQueryLog({
    beforeCreatedAtMicros: cursor?.beforeCreatedAtMicros,
    beforeId: cursor?.beforeId,
    limit,
  }),
};

const publishedQaBinding: TableBinding<PublishedQaRow> = {
  tableName: "published_qa",
  iter: (conn) => conn.db.publishedQa.iter(),
  onInsert: (conn, cb) => {
    conn.db.publishedQa.onInsert((_ctx: EventContext, _row: PublishedQaRow) => cb());
  },
  onDelete: (conn, cb) => {
    conn.db.publishedQa.onDelete((_ctx: EventContext, _row: PublishedQaRow) => cb());
  },
};

const qaEntriesBinding: TableBinding<QaEntriesRow> = {
  tableName: "my_visible_qa_entries",
  iter: (conn) => conn.db.myVisibleQaEntries.iter(),
  onInsert: (conn, cb) => {
    conn.db.myVisibleQaEntries.onInsert((_ctx: EventContext, _row: QaEntriesRow) => cb());
  },
  onDelete: (conn, cb) => {
    conn.db.myVisibleQaEntries.onDelete((_ctx: EventContext, _row: QaEntriesRow) => cb());
  },
  onUpdate: (conn, cb) => {
    conn.db.myVisibleQaEntries.onUpdate((_ctx: EventContext, _old: QaEntriesRow, _row: QaEntriesRow) => cb());
  },
};

const feedbackBinding: TableBinding<FeedbackLogRow> = {
  tableName: "my_visible_feedback_log",
  iter: (conn) => conn.db.myVisibleFeedbackLog.iter(),
  onInsert: (conn, cb) => {
    conn.db.myVisibleFeedbackLog.onInsert((_ctx: EventContext, _row: FeedbackLogRow) => cb());
  },
  onDelete: (conn, cb) => {
    conn.db.myVisibleFeedbackLog.onDelete((_ctx: EventContext, _row: FeedbackLogRow) => cb());
  },
  onUpdate: (conn, cb) => {
    conn.db.myVisibleFeedbackLog.onUpdate((_ctx: EventContext, _old: FeedbackLogRow, _row: FeedbackLogRow) => cb());
  },
  cursorFromRow: cursorFromLogRow,
  pageOlder: async (conn, cursor, limit) => await conn.procedures.pageFeedbackLog({
    beforeCreatedAtMicros: cursor?.beforeCreatedAtMicros,
    beforeId: cursor?.beforeId,
    limit,
  }),
};

export function useMcpCallLogs(getToken?: GetSpacetimeToken) {
  return useTableSubscription(mcpBinding, getToken, true);
}

/**
 * Reviewer-only. Feedback volunteered through the MCP `give_feedback` tool.
 * Read-only surface — nothing in the UI writes to `feedback_log`.
 */
export function useFeedbackLog(getToken?: GetSpacetimeToken) {
  return useTableSubscription(feedbackBinding, getToken, true);
}

export function useAiQueryLogs(getToken?: GetSpacetimeToken) {
  return useTableSubscription(aiQueryBinding, getToken, true);
}

/**
 * Public — no auth required. Backed by the `published_qa` anonymousView,
 * which returns only rows reviewers have explicitly published. Safe to call
 * from unauthenticated pages.
 */
export function usePublishedQa() {
  return useTableSubscription(publishedQaBinding);
}

/**
 * Reviewer-only. Subscribes to the curated Q&A entries table (separate from
 * mcp_call_log telemetry). Use this for the editorial surface — every row
 * here is a Q&A pair, either tied to a real MCP call (sourceMcpCorrelationId
 * non-null) or a manual entry (null).
 */
export function useQaEntries(getToken?: GetSpacetimeToken) {
  return useTableSubscription(qaEntriesBinding, getToken, true);
}
