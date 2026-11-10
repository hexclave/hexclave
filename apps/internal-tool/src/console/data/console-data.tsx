"use client";

import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { type GetSpacetimeToken, useAiQueryLogs, useFeedbackLog, useMcpCallLogs, useQaEntries } from "../../hooks/useSpacetimeDB";
import type { HistoryLoadOptions } from "../../lib/load-history";
import { retryReview } from "../../lib/mcp-review-api";
import type { AiQueryLogRow, FeedbackLogRow, McpCallLogRow, QaEntriesRow } from "../../types";

export type ConnectionState = "connecting" | "connected" | "error";

/** One live log stream: rows currently loaded (live window + any older pages) plus history paging. */
export type LogSource<Row> = {
  rows: Row[],
  connectionState: ConnectionState,
  connectionErrorMessage: string | null,
  hasMoreHistory: boolean,
  isLoadingOlder: boolean,
  loadOlder: (options?: HistoryLoadOptions) => Promise<void>,
};

type McpSource = LogSource<McpCallLogRow> & {
  queryFilteredPage: ReturnType<typeof useMcpCallLogs>["queryFilteredPage"],
};

type AiSource = LogSource<AiQueryLogRow> & {
  queryFilteredPage: ReturnType<typeof useAiQueryLogs>["queryFilteredPage"],
};

type QaSource = {
  rows: QaEntriesRow[],
  connectionState: ConnectionState,
  connectionErrorMessage: string | null,
};

export type ConsoleActions = {
  setHumanReviewed: (correlationId: string, reviewed: boolean) => Promise<void>,
  saveCorrection: (correlationId: string, question: string, answer: string, publish: boolean) => Promise<void>,
  retryAiReview: (row: McpCallLogRow) => Promise<void>,
  saveQaEntry: (qaId: bigint, question: string, answer: string, publish: boolean) => Promise<void>,
  deleteQaEntry: (qaId: bigint) => Promise<void>,
  addManualQa: (question: string, answer: string, publish: boolean, requestId: string) => Promise<void>,
};

type ConsoleData = {
  mcp: McpSource,
  ai: AiSource,
  qa: QaSource,
  feedback: LogSource<FeedbackLogRow>,
  actions: ConsoleActions,
  /** Worst state across every subscription, for the global connection indicator. */
  connection: { state: ConnectionState, errors: ReadonlyArray<{ source: string, message: string }> },
};

const ConsoleDataContext = createContext<ConsoleData | null>(null);

/**
 * Any signed-in user may use the tool: membership in the Stack Auth project is the authorization.
 * The server verifies the cookie session and mints a short-lived SpacetimeDB JWT under the tool's
 * own OIDC issuer (Stack Auth session tokens aren't OIDC-discoverable by SpacetimeDB). Same
 * endpoint and contract as the legacy UI in app/app-client.tsx.
 */
const getSpacetimeToken: GetSpacetimeToken = async () => {
  const res = await fetch("/api/spacetimedb-token", { method: "POST", credentials: "same-origin" });
  if (!res.ok) {
    throw new Error(`SpacetimeDB token mint failed (${res.status}): ${await res.text()}`);
  }
  const body: unknown = await res.json();
  const token = typeof body === "object" && body != null && "token" in body ? body.token : undefined;
  if (typeof token !== "string" || token === "") throw new Error("SpacetimeDB token mint returned no token");
  return token;
};

/**
 * Owns every SpacetimeDB subscription the console needs, once, at the layout level. Pages under
 * /console are separate routes, but the layout persists across client navigations, so switching
 * pages never tears down a connection or drops already-loaded history.
 */
export function ConsoleDataProvider({ children }: { children: ReactNode }) {
  const mcpLogs = useMcpCallLogs(getSpacetimeToken);
  const aiLogs = useAiQueryLogs(getSpacetimeToken);
  const qaEntries = useQaEntries(getSpacetimeToken);
  const feedbackLog = useFeedbackLog(getSpacetimeToken);

  const mcpRows = useMemo(() => [...mcpLogs.rows, ...mcpLogs.olderRows], [mcpLogs.rows, mcpLogs.olderRows]);
  const aiRows = useMemo(() => [...aiLogs.rows, ...aiLogs.olderRows], [aiLogs.rows, aiLogs.olderRows]);
  const feedbackRows = useMemo(() => [...feedbackLog.rows, ...feedbackLog.olderRows], [feedbackLog.rows, feedbackLog.olderRows]);

  const callMcpReducer = mcpLogs.callReducer;
  const callQaReducer = qaEntries.callReducer;

  const setHumanReviewed = useCallback(async (correlationId: string, reviewed: boolean) => {
    await callMcpReducer(conn => conn.reducers.setHumanReviewed({ correlationId, reviewed }));
  }, [callMcpReducer]);
  const saveCorrection = useCallback(async (correlationId: string, question: string, answer: string, publish: boolean) => {
    await callMcpReducer(conn => conn.reducers.upsertQaFromCallAndMarkReviewed({ correlationId, question, answer, publish }));
  }, [callMcpReducer]);
  const retryAiReview = useCallback(async (row: McpCallLogRow) => {
    await retryReview({ correlationId: row.correlationId, question: row.question, reason: row.reason, response: row.response });
  }, []);
  const saveQaEntry = useCallback(async (qaId: bigint, question: string, answer: string, publish: boolean) => {
    await callQaReducer(conn => conn.reducers.updateQaEntryWithPublish({ qaId, question, answer, publish }));
  }, [callQaReducer]);
  const deleteQaEntry = useCallback(async (qaId: bigint) => {
    await callQaReducer(conn => conn.reducers.deleteQaEntry({ qaId }));
  }, [callQaReducer]);
  const addManualQa = useCallback(async (question: string, answer: string, publish: boolean, requestId: string) => {
    await callQaReducer(conn => conn.reducers.addManualQa({ question, answer, publish, requestId }));
  }, [callQaReducer]);

  const actions = useMemo<ConsoleActions>(() => ({
    setHumanReviewed, saveCorrection, retryAiReview, saveQaEntry, deleteQaEntry, addManualQa,
  }), [setHumanReviewed, saveCorrection, retryAiReview, saveQaEntry, deleteQaEntry, addManualQa]);

  const sources = [
    { source: "MCP calls", state: mcpLogs.connectionState, message: mcpLogs.connectionErrorMessage },
    { source: "AI requests", state: aiLogs.connectionState, message: aiLogs.connectionErrorMessage },
    { source: "Knowledge base", state: qaEntries.connectionState, message: qaEntries.connectionErrorMessage },
    { source: "Feedback", state: feedbackLog.connectionState, message: feedbackLog.connectionErrorMessage },
  ];
  const connectionState: ConnectionState = sources.some(source => source.state === "error")
    ? "error"
    : sources.every(source => source.state === "connected") ? "connected" : "connecting";
  const connectionErrors = sources.flatMap(source => source.state === "error"
    ? [{ source: source.source, message: source.message ?? "Connection failed" }]
    : []);

  const value: ConsoleData = {
    mcp: {
      rows: mcpRows,
      connectionState: mcpLogs.connectionState,
      connectionErrorMessage: mcpLogs.connectionErrorMessage,
      hasMoreHistory: mcpLogs.hasMoreHistory,
      isLoadingOlder: mcpLogs.isLoadingOlder,
      loadOlder: mcpLogs.loadOlder,
      queryFilteredPage: mcpLogs.queryFilteredPage,
    },
    ai: {
      rows: aiRows,
      connectionState: aiLogs.connectionState,
      connectionErrorMessage: aiLogs.connectionErrorMessage,
      hasMoreHistory: aiLogs.hasMoreHistory,
      isLoadingOlder: aiLogs.isLoadingOlder,
      loadOlder: aiLogs.loadOlder,
      queryFilteredPage: aiLogs.queryFilteredPage,
    },
    qa: {
      rows: qaEntries.rows,
      connectionState: qaEntries.connectionState,
      connectionErrorMessage: qaEntries.connectionErrorMessage,
    },
    feedback: {
      rows: feedbackRows,
      connectionState: feedbackLog.connectionState,
      connectionErrorMessage: feedbackLog.connectionErrorMessage,
      hasMoreHistory: feedbackLog.hasMoreHistory,
      isLoadingOlder: feedbackLog.isLoadingOlder,
      loadOlder: feedbackLog.loadOlder,
    },
    actions,
    connection: { state: connectionState, errors: connectionErrors },
  };

  return <ConsoleDataContext.Provider value={value}>{children}</ConsoleDataContext.Provider>;
}

export function useConsoleData(): ConsoleData {
  return useContext(ConsoleDataContext) ?? throwErr("useConsoleData must be used inside <ConsoleDataProvider> (rendered by app/console/layout.tsx)");
}
