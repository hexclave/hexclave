import { useUser } from "@hexclave/next";
import { clsx } from "clsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AddManualQa } from "../components/AddManualQa";
import { Analytics } from "../components/Analytics";
import { CallLogDetail } from "../components/CallLogDetail";
import { CallLogList } from "../components/CallLogList";
import { FeedbackDetail } from "../components/FeedbackDetail";
import { FeedbackList } from "../components/FeedbackList";
import { KnowledgeBase } from "../components/KnowledgeBase";
import { Usage } from "../components/Usage";
import { UsageDetail } from "../components/UsageDetail";
import { type GetSpacetimeToken, useAiQueryLogs, useFeedbackLog, useMcpCallLogs, useQaEntries } from "../hooks/useSpacetimeDB";
import { retryReview } from "../lib/mcp-review-api";
import type { AiQueryLogRow, FeedbackLogRow, McpCallLogRow } from "../types";

type Tab = "calls" | "knowledge" | "usage" | "feedback";
const TAB_STORAGE_KEY = "internal-tool-active-tab";
const VALID_TABS: readonly Tab[] = ["calls", "knowledge", "usage", "feedback"];

function readInitialTab(): Tab {
  // sessionStorage is per-tab: reload preserves the active tab, but a brand-new
  // browser tab gets the default ("calls").
  if (typeof window === "undefined") return "calls";
  const saved = window.sessionStorage.getItem(TAB_STORAGE_KEY);
  if (saved != null && (VALID_TABS as readonly string[]).includes(saved)) {
    return saved as Tab;
  }
  return "calls";
}

export default function App() {
  const user = useUser({ or: "redirect" });
  const [selectedRow, setSelectedRow] = useState<McpCallLogRow | null>(null);
  const [selectedUsageRow, setSelectedUsageRow] = useState<AiQueryLogRow | null>(null);
  const [selectedFeedbackRow, setSelectedFeedbackRow] = useState<FeedbackLogRow | null>(null);
  const [showAddQa, setShowAddQa] = useState(false);
  const [tab, setTab] = useState<Tab>(readInitialTab);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(TAB_STORAGE_KEY, tab);
  }, [tab]);

  // Any signed-in user may use the tool: membership in the Stack Auth project
  // is the authorization (its sign-up rules restrict membership to the team).
  // The server verifies the cookie session and mints a short-lived
  // SpacetimeDB JWT under the tool's own OIDC issuer — Stack Auth session
  // tokens themselves aren't OIDC-discoverable by SpacetimeDB.
  const getSpacetimeToken = useCallback<GetSpacetimeToken>(async () => {
    const res = await fetch("/api/spacetimedb-token", {
      method: "POST",
      credentials: "same-origin",
    });
    if (!res.ok) {
      throw new Error(`SpacetimeDB token mint failed (${res.status}): ${await res.text()}`);
    }
    const { token } = await res.json() as { token?: string };
    if (typeof token !== "string" || token === "") throw new Error("SpacetimeDB token mint returned no token");
    return token;
  }, []);

  const {
    rows: liveRows,
    olderRows,
    hasMoreHistory,
    isLoadingOlder,
    loadOlder,
    connectionState,
    connectionErrorMessage,
    callReducer: callMcpReducer,
  } = useMcpCallLogs(getSpacetimeToken);
  const rows = useMemo(() => [...liveRows, ...olderRows], [liveRows, olderRows]);
  const {
    rows: liveUsageRows,
    olderRows: olderUsageRows,
    hasMoreHistory: usageHasMoreHistory,
    isLoadingOlder: usageIsLoadingOlder,
    loadOlder: loadOlderUsage,
    connectionState: usageConnectionState,
    connectionErrorMessage: usageConnectionErrorMessage,
  } = useAiQueryLogs(getSpacetimeToken);
  const usageRows = useMemo(() => [...liveUsageRows, ...olderUsageRows], [liveUsageRows, olderUsageRows]);
  const {
    rows: qaRows,
    connectionState: qaConnectionState,
    connectionErrorMessage: qaConnectionErrorMessage,
    callReducer: callQaReducer,
  } = useQaEntries(getSpacetimeToken);

  const {
    rows: liveFeedbackRows,
    olderRows: olderFeedbackRows,
    hasMoreHistory: feedbackHasMoreHistory,
    isLoadingOlder: feedbackIsLoadingOlder,
    loadOlder: loadOlderFeedback,
    connectionState: feedbackConnectionState,
    connectionErrorMessage: feedbackConnectionErrorMessage,
  } = useFeedbackLog(getSpacetimeToken);
  const feedbackRows = useMemo(() => [...liveFeedbackRows, ...olderFeedbackRows], [liveFeedbackRows, olderFeedbackRows]);

  const currentSelectedRow = selectedRow
    ? rows.find(r => r.id === selectedRow.id) ?? selectedRow
    : null;

  const currentSelectedFeedbackRow = selectedFeedbackRow
    ? feedbackRows.find(r => r.id === selectedFeedbackRow.id) ?? selectedFeedbackRow
    : null;

  const relatedCallForFeedback = currentSelectedFeedbackRow?.conversationId == null
    ? null
    : rows.find(r => r.conversationId === currentSelectedFeedbackRow.conversationId) ?? null;

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <header className="shrink-0 bg-white border-b border-gray-200 px-6 py-3 grid grid-cols-3 items-center">
        <div className="flex items-center justify-start">
          <h1 className="text-lg font-semibold text-gray-900">MCP Review Tool</h1>
        </div>
        {/* Tabs — centered */}
        <div className="flex justify-center">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => {
                setTab("calls");
                setSelectedRow(null);
              }}
              className={clsx(
                "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                tab === "calls" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              )}
            >
              MCP Review
            </button>
            <button
              onClick={() => {
                setTab("knowledge");
                setSelectedRow(null);
              }}
              className={clsx(
                "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                tab === "knowledge" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              )}
            >
              Knowledge Base
            </button>
            <button
              onClick={() => {
                setTab("usage");
                setSelectedRow(null);
              }}
              className={clsx(
                "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                tab === "usage" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              )}
            >
              Unified AI Endpoint Analytics
            </button>
            <button
              onClick={() => {
                setTab("feedback");
                setSelectedRow(null);
              }}
              className={clsx(
                "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                tab === "feedback" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              )}
            >
              Feedback
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 justify-end">
          {tab === "knowledge" && (
            <button
              onClick={() => setShowAddQa(true)}
              className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
            >
              + Add Q&A
            </button>
          )}
          <span className="text-sm text-gray-500">{user.displayName ?? user.primaryEmail}</span>
        </div>
      </header>

      {showAddQa && (
        <AddManualQa
          onClose={() => setShowAddQa(false)}
          onSave={async (question, answer, publish, requestId) => {
            await callQaReducer(conn => conn.reducers.addManualQa({
              question,
              answer,
              publish,
              requestId,
            }));
          }}
        />
      )}

      <div className="flex-1 overflow-hidden flex">
        {tab === "calls" && (
          <>
            <main className="flex-1 overflow-y-auto p-6 space-y-6">
              <Analytics rows={rows} qaEntries={qaRows} />
              <CallLogList
                rows={rows}
                connectionState={connectionState}
                connectionErrorMessage={connectionErrorMessage}
                onSelect={setSelectedRow}
                selectedId={selectedRow?.id}
                hasMoreHistory={hasMoreHistory}
                isLoadingOlder={isLoadingOlder}
                onLoadOlder={loadOlder}
              />
            </main>
            {currentSelectedRow && (
              <aside className="w-[480px] shrink-0 border-l border-gray-200 bg-white overflow-y-auto">
                <CallLogDetail
                  key={String(currentSelectedRow.id)}
                  row={currentSelectedRow}
                  allRows={rows}
                  qaEntries={qaRows}
                  onClose={() => setSelectedRow(null)}
                  onSaveCorrection={(correlationId, correctedQuestion, correctedAnswer, publish) =>
                    callMcpReducer(conn => conn.reducers.upsertQaFromCallAndMarkReviewed({
                      correlationId,
                      question: correctedQuestion,
                      answer: correctedAnswer,
                      publish,
                    }))
                  }
                  onSetReviewed={(correlationId, reviewed) =>
                    callMcpReducer(conn => conn.reducers.setHumanReviewed({
                      correlationId,
                      reviewed,
                    }))
                  }
                  onRetryReview={(correlationId, payload) =>
                    retryReview({ correlationId, ...payload })
                  }
                />
              </aside>
            )}
          </>
        )}

        {tab === "knowledge" && (
          <main className="flex-1 overflow-y-auto">
            <div className="p-6 max-w-4xl mx-auto">
              <KnowledgeBase
                rows={qaRows}
                connectionState={qaConnectionState}
                connectionErrorMessage={qaConnectionErrorMessage}
                onSave={(qaId, question, answer, publish) =>
                  callQaReducer(conn => conn.reducers.updateQaEntryWithPublish({
                    qaId,
                    question,
                    answer,
                    publish,
                  }))
                }
                onDelete={(qaId) =>
                  callQaReducer(conn => conn.reducers.deleteQaEntry({ qaId }))
                }
              />
            </div>
          </main>
        )}

        {tab === "usage" && (
          <>
            <main className="flex-1 overflow-y-auto">
              <div className="p-6 max-w-6xl mx-auto">
                <Usage
                  rows={usageRows}
                  connectionState={usageConnectionState}
                  connectionErrorMessage={usageConnectionErrorMessage}
                  onSelect={setSelectedUsageRow}
                  selectedId={selectedUsageRow?.id}
                  hasMoreHistory={usageHasMoreHistory}
                  isLoadingOlder={usageIsLoadingOlder}
                  onLoadOlder={loadOlderUsage}
                />
              </div>
            </main>
            {selectedUsageRow && (
              <aside className="w-[480px] shrink-0 border-l border-gray-200 bg-white overflow-y-auto">
                <UsageDetail
                  row={usageRows.find(r => r.id === selectedUsageRow.id) ?? selectedUsageRow}
                  onClose={() => setSelectedUsageRow(null)}
                />
              </aside>
            )}
          </>
        )}

        {tab === "feedback" && (
          <>
            <main className="flex-1 overflow-y-auto">
              <div className="p-6 max-w-4xl mx-auto">
                <FeedbackList
                  rows={feedbackRows}
                  connectionState={feedbackConnectionState}
                  connectionErrorMessage={feedbackConnectionErrorMessage}
                  onSelect={setSelectedFeedbackRow}
                  selectedId={currentSelectedFeedbackRow?.id}
                  hasMoreHistory={feedbackHasMoreHistory}
                  isLoadingOlder={feedbackIsLoadingOlder}
                  onLoadOlder={loadOlderFeedback}
                />
              </div>
            </main>
            {currentSelectedFeedbackRow && (
              <aside className="w-[480px] shrink-0 border-l border-gray-200 bg-white overflow-y-auto">
                <FeedbackDetail
                  key={String(currentSelectedFeedbackRow.id)}
                  row={currentSelectedFeedbackRow}
                  relatedCall={relatedCallForFeedback}
                  onClose={() => setSelectedFeedbackRow(null)}
                  onOpenRelatedCall={(call) => {
                    setSelectedRow(call);
                    setTab("calls");
                  }}
                />
              </aside>
            )}
          </>
        )}
      </div>
    </div>
  );
}
