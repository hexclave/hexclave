import { useHexclaveApp, useUser } from "@hexclave/next";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AddManualQa } from "../components/AddManualQa";
import { Analytics } from "../components/Analytics";
import { AppSidebar, appTabLabel, isAppTab, type AppTab } from "../components/AppSidebar";
import { CallLogDetail } from "../components/CallLogDetail";
import { CallLogList } from "../components/CallLogList";
import { DetailSidebar } from "../components/DetailSidebar";
import { FeedbackDetail } from "../components/FeedbackDetail";
import { FeedbackList } from "../components/FeedbackList";
import { FeatureRequests } from "../components/FeatureRequests";
import { KnowledgeBase } from "../components/KnowledgeBase";
import { Usage } from "../components/Usage";
import { UsageDetail } from "../components/UsageDetail";
import { Button } from "../components/design";
import { type GetSpacetimeToken, useAiQueryLogs, useFeedbackLog, useMcpCallLogs, useQaEntries } from "../hooks/useSpacetimeDB";
import { retryReview } from "../lib/mcp-review-api";
import type { AiQueryLogRow, FeedbackLogRow, McpCallLogRow } from "../types";

const TAB_STORAGE_KEY = "internal-tool-active-tab";
function readInitialTab(): AppTab {
  // sessionStorage is per-tab: reload preserves the active tab, but a brand-new
  // browser tab gets the high-level overview.
  if (typeof window === "undefined") return "overview";
  const saved = window.sessionStorage.getItem(TAB_STORAGE_KEY);
  if (saved != null && isAppTab(saved)) return saved;
  return "overview";
}

export default function App() {
  const hexclaveApp = useHexclaveApp();
  const user = useUser({ or: "redirect" });
  const [selectedRow, setSelectedRow] = useState<McpCallLogRow | null>(null);
  const [selectedUsageRow, setSelectedUsageRow] = useState<AiQueryLogRow | null>(null);
  const [selectedFeedbackRow, setSelectedFeedbackRow] = useState<FeedbackLogRow | null>(null);
  const [showAddQa, setShowAddQa] = useState(false);
  const [tab, setTab] = useState<AppTab>(readInitialTab);

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
    queryFilteredPage: queryFilteredMcpPage,
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
    queryFilteredPage: queryFilteredUsagePage,
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

  const relatedFeedbackForCall = currentSelectedRow?.conversationId == null
    ? []
    : feedbackRows.filter(feedback => feedback.conversationId === currentSelectedRow.conversationId);

  const relatedCallForFeedback = currentSelectedFeedbackRow?.conversationId == null
    ? null
    : rows.find(r => r.conversationId === currentSelectedFeedbackRow.conversationId) ?? null;
  return (
    <div className="flex h-dvh overflow-hidden">
      <AppSidebar
        activeTab={tab}
        displayName={user.displayName}
        email={user.primaryEmail}
        onOpenAccountSettings={async () => await hexclaveApp.redirectToAccountSettings()}
        onSignOut={async () => await user.signOut()}
        onNavigate={nextTab => {
          setTab(nextTab);
          setSelectedRow(null);
          setSelectedUsageRow(null);
          setSelectedFeedbackRow(null);
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-black/[0.06] bg-card/60 px-4 backdrop-blur-xl dark:border-white/[0.06] md:px-6">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-foreground">{appTabLabel(tab)}</h2>
            <p className="text-[10px] text-muted-foreground">AI operations and quality review</p>
          </div>
          {tab === "knowledge" && (
            <Button variant="default" onClick={() => setShowAddQa(true)}>
              + Add Q&A
            </Button>
          )}
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

        <div className="relative flex flex-1 overflow-hidden">
          {tab === "overview" && (
            <main className="flex-1 overflow-y-auto">
              <div className="mx-auto max-w-[1440px] p-6 pb-12">
                <section aria-labelledby="mcp-overview-heading" className="space-y-5">
                  <h3 id="mcp-overview-heading" className="text-base font-semibold tracking-tight text-foreground">MCP analytics</h3>
                  <Analytics rows={rows} qaEntries={qaRows} hasMoreHistory={hasMoreHistory} />
                </section>

                <section aria-labelledby="usage-overview-heading" className="mt-12 space-y-5 border-t border-black/[0.06] pt-8 dark:border-white/[0.06]">
                  <h3 id="usage-overview-heading" className="text-base font-semibold tracking-tight text-foreground">Unified AI Endpoint analytics</h3>
                  <Usage
                    view="overview"
                    rows={usageRows}
                    connectionState={usageConnectionState}
                    connectionErrorMessage={usageConnectionErrorMessage}
                    onSelect={setSelectedUsageRow}
                    queryFilteredPage={queryFilteredUsagePage}
                    hasMoreHistory={usageHasMoreHistory}
                    isLoadingOlder={usageIsLoadingOlder}
                    onLoadOlder={loadOlderUsage}
                  />
                </section>
              </div>
            </main>
          )}

          {tab === "calls" && (
            <>
              <main className="flex-1 overflow-y-auto p-6">
                <CallLogList
                  rows={rows}
                  connectionState={connectionState}
                  connectionErrorMessage={connectionErrorMessage}
                  onSelect={setSelectedRow}
                  queryFilteredPage={queryFilteredMcpPage}
                  hasMoreHistory={hasMoreHistory}
                  isLoadingOlder={isLoadingOlder}
                  onLoadOlder={loadOlder}
                />
              </main>
              {currentSelectedRow && (
                <DetailSidebar label="MCP call details" onClose={() => setSelectedRow(null)}>
                  <CallLogDetail
                    key={String(currentSelectedRow.id)}
                    row={currentSelectedRow}
                    allRows={rows}
                    qaEntries={qaRows}
                    relatedFeedback={relatedFeedbackForCall}
                    onClose={() => setSelectedRow(null)}
                    onOpenFeedback={feedback => {
                      setSelectedRow(null);
                      setSelectedFeedbackRow(feedback);
                      setTab("feedback");
                    }}
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
                </DetailSidebar>
              )}
            </>
          )}

          {tab === "knowledge" && (
            <main className="flex-1 overflow-y-auto">
              <div className="mx-auto max-w-[1440px] p-6">
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

          {tab === "feature-requests" && (
            <main className="flex-1 overflow-y-auto p-6">
              <FeatureRequests
                connectionState={connectionState}
                connectionErrorMessage={connectionErrorMessage}
                queryFilteredPage={queryFilteredMcpPage}
                onOpenConversation={row => {
                  setSelectedRow(row);
                  setTab("calls");
                }}
              />
            </main>
          )}

          {tab === "usage" && (
            <>
              <main className="flex-1 overflow-y-auto p-6">
                <Usage
                  view="logs"
                  rows={usageRows}
                  connectionState={usageConnectionState}
                  connectionErrorMessage={usageConnectionErrorMessage}
                  onSelect={setSelectedUsageRow}
                  queryFilteredPage={queryFilteredUsagePage}
                  hasMoreHistory={usageHasMoreHistory}
                  isLoadingOlder={usageIsLoadingOlder}
                  onLoadOlder={loadOlderUsage}
                />
              </main>
              {selectedUsageRow && (
                <DetailSidebar label="AI usage details" onClose={() => setSelectedUsageRow(null)}>
                  <UsageDetail
                    row={usageRows.find(r => r.id === selectedUsageRow.id) ?? selectedUsageRow}
                    onClose={() => setSelectedUsageRow(null)}
                  />
                </DetailSidebar>
              )}
            </>
          )}

          {tab === "feedback" && (
            <>
              <main className="flex-1 overflow-y-auto">
                <div className="mx-auto max-w-[1440px] p-6">
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
                <DetailSidebar label="Feedback details" onClose={() => setSelectedFeedbackRow(null)}>
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
                </DetailSidebar>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
