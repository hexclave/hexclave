"use client";

import { createAnalyticsTableFilterChatAdapter } from "@/components/vibe-coding";
import { getPublicEnvVar } from "@/lib/env";
import { useLocalThreadRuntime, type ThreadMessage, type ToolCallContentPart } from "@assistant-ui/react";
import { useUser } from "@hexclave/next";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjectId } from "../../use-admin-app";
import { getValidatedTableFilterQuery } from "./search-bar-logic";

const QUERY_ANALYTICS_TOOL = "queryAnalytics";

type QueryToolPart = ToolCallContentPart<{ query?: string }, unknown>;

/**
 * The filter prompt tells the AI to run schema-discovery statements (DESCRIBE
 * TABLE / SHOW TABLES) through the same queryAnalytics tool before committing
 * a row filter. Those calls must never be mistaken for the committed filter.
 */
function isSchemaDiscoveryQuery(query: string): boolean {
  return /^\s*(describe|desc|show)\b/i.test(query);
}

function isQueryAnalyticsToolPart(
  part: ThreadMessage["content"][number],
): part is QueryToolPart {
  return part.type === "tool-call" && part.toolName === QUERY_ANALYTICS_TOOL;
}

function isSuccessfulQueryToolPart(part: QueryToolPart): boolean {
  if (part.result == null) return false;
  if (
    typeof part.result === "object"
    && "success" in part.result
    && part.result["success"] === false
  ) {
    return false;
  }
  return true;
}

export function extractLatestQuery(messages: readonly ThreadMessage[]): {
  query: string,
  toolCallIndex: number,
  requestText: string,
} | null {
  let toolCallIndex = 0;
  let requestText: string | null = null;
  let latest: {
    query: string,
    toolCallIndex: number,
    requestText: string,
  } | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      const textPart = msg.content.find((part) => part.type === "text");
      if (textPart?.type === "text" && textPart.text.trim().length > 0) {
        requestText = textPart.text.trim();
      }
      continue;
    }
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (!isQueryAnalyticsToolPart(part)) continue;
      toolCallIndex += 1;
      if (!isSuccessfulQueryToolPart(part)) continue;
      const query = typeof part.args.query === "string" ? part.args.query : null;
      if (query && query.trim().length > 0 && !isSchemaDiscoveryQuery(query)) {
        latest = {
          query,
          toolCallIndex,
          requestText: requestText ?? throwErr(
            "queryAnalytics returned a filter without a preceding user request",
          ),
        };
      }
    }
  }
  return latest;
}

/**
 * Extracts the trailing text of the last assistant message, so the UI can
 * surface what the AI said when it answered without committing a query
 * (e.g. "that's an aggregation, which this search can't display").
 */
function extractLastAssistantText(messages: readonly ThreadMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const part = msg.content[j]!;
      if (part.type === "text" && part.text.trim().length > 0) {
        return part.text.trim();
      }
    }
  }
  return null;
}

export type AiTableFilterChat = {
  messages: readonly ThreadMessage[],
  isResponding: boolean,
  error: Error | null,
  sendMessage: (input: { text: string }) => void,
  clearMessages: () => void,
  /** The last validated row filter committed via the queryAnalytics tool. */
  latestQuery: string | null,
  /** The user request that produced `latestQuery`. */
  latestQueryLabel: string | null,
  /** Whether the latest run produced a query that failed row-filter validation. */
  filterRejected: boolean,
  /**
   * Set when the last run finished WITHOUT committing a new query — holds the
   * assistant's text reply (or null if there was none / a query was
   * committed). Cleared on the next send/clear or via `dismissAssistantNote`.
   */
  assistantNote: string | null,
  dismissAssistantNote: () => void,
};

/**
 * AI chat thread backing the analytics table search bar's AI fallback. Uses
 * the constrained `filter-analytics-table` system prompt scoped to the given
 * table, and validates every committed tool call before exposing it as the
 * active `SELECT * FROM <table> WHERE ...` row filter.
 */
export function useAiTableFilterChat(tableName: string): AiTableFilterChat {
  const currentUser = useUser();
  const projectId = useProjectId();
  const backendBaseUrl =
    getPublicEnvVar("NEXT_PUBLIC_BROWSER_STACK_API_URL") ??
    getPublicEnvVar("NEXT_PUBLIC_STACK_API_URL") ??
    throwErr("NEXT_PUBLIC_BROWSER_STACK_API_URL is not set");

  const [error, setError] = useState<Error | null>(null);

  const adapter = useMemo(
    () => createAnalyticsTableFilterChatAdapter(
      backendBaseUrl,
      currentUser ?? undefined,
      projectId,
      tableName,
      setError,
    ),
    [backendBaseUrl, currentUser, projectId, tableName],
  );

  // Multiple steps so the AI can run DESCRIBE TABLE for schema discovery
  // before committing the actual row filter in a later tool call.
  const runtime = useLocalThreadRuntime(adapter, { maxSteps: 4 });

  const [snapshot, setSnapshot] = useState(() => {
    const s = runtime.thread.getState();
    return { messages: s.messages, isRunning: s.isRunning };
  });
  useEffect(() => {
    const update = () => {
      const s = runtime.thread.getState();
      setSnapshot((prev) =>
        prev.messages === s.messages && prev.isRunning === s.isRunning
          ? prev
          : { messages: s.messages, isRunning: s.isRunning },
      );
    };
    const unsub = runtime.thread.subscribe(update);
    update();
    return unsub;
  }, [runtime]);

  const isResponding = snapshot.isRunning;
  const messages = snapshot.messages;

  const [committed, setCommitted] = useState<{
    query: string,
    label: string,
  } | null>(null);
  const [filterRejected, setFilterRejected] = useState(false);
  const [assistantNote, setAssistantNote] = useState<string | null>(null);
  const wasRespondingRef = useRef(false);
  const runStartMessageIndexRef = useRef(0);

  useEffect(() => {
    const justFinished = wasRespondingRef.current && !isResponding;
    wasRespondingRef.current = isResponding;
    if (!justFinished) return;

    // Each falling edge is evaluated only against messages added by that run.
    // Scanning the whole thread would let a failed/text-only refinement pick
    // up and recommit an older successful query (and its unrelated reply).
    const runMessages = messages.slice(runStartMessageIndexRef.current);
    const latest = extractLatestQuery(runMessages);
    if (latest == null) {
      // The run ended without committing a new query — surface the
      // assistant's text (if any) so callers can show WHY nothing changed.
      // This must live here (not in a consuming component) because child
      // effects run before this one; a child comparing commit state on the
      // same falling edge would race the commit below.
      setAssistantNote(extractLastAssistantText(runMessages));
      return;
    }

    const validatedQuery = getValidatedTableFilterQuery(latest.query, tableName);
    if (validatedQuery == null) {
      // Keep the previous valid filter active. A rejected refinement should
      // never reset the grid to its unfiltered base query or relabel the chip.
      setFilterRejected(true);
      setAssistantNote(null);
      return;
    }

    setCommitted({ query: validatedQuery, label: latest.requestText });
    setFilterRejected(false);
    setAssistantNote(null);
  }, [isResponding, messages, tableName]);

  const sendMessage = useCallback(
    ({ text }: { text: string }) => {
      setError(null);
      setAssistantNote(null);
      setFilterRejected(false);
      runStartMessageIndexRef.current = runtime.thread.getState().messages.length;
      runtime.thread.append({
        role: "user",
        content: [{ type: "text", text }],
      });
    },
    [runtime],
  );

  const clearMessages = useCallback(() => {
    setError(null);
    setAssistantNote(null);
    setFilterRejected(false);
    setCommitted(null);
    runStartMessageIndexRef.current = 0;
    runtime.thread.import({ messages: [], headId: null });
  }, [runtime]);

  const dismissAssistantNote = useCallback(() => {
    setAssistantNote(null);
  }, []);

  return {
    messages,
    isResponding,
    error,
    sendMessage,
    clearMessages,
    latestQuery: committed?.query ?? null,
    latestQueryLabel: committed?.label ?? null,
    filterRejected,
    assistantNote,
    dismissAssistantNote,
  };
}
