"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { formatAiRequestContext } from "../../../lib/copy-log-context";
import { formatSignedUsd, formatUsd } from "../../../lib/format-usd";
import { formatPacificTimestamp } from "../../../lib/pacific-time";
import type { AiQueryLogRow, McpCallLogRow } from "../../../types";
import { toDate } from "../../../utils";
import { formatAgo, formatDuration } from "../../lib/format";
import { isCallError } from "../../lib/mcp";
import { aiRequestEntries, latestUserMessage, requestedTools } from "../../lib/transcripts";
import { consoleHref } from "../../lib/url-state";
import { Icon } from "../../ui/icons";
import { Badge, Callout, PropertyList, TabPanel, Tabs } from "../../ui/primitives";
import { CopyButton, DetailStats } from "../shared/detail";
import { Transcript } from "../shared/Transcript";

export function AiRequestDetail({ row, mcpRows }: { row: AiQueryLogRow, mcpRows: readonly McpCallLogRow[] }) {
  const tabsId = useId();
  const [section, setSection] = useState<"conversation" | "request">("conversation");
  const transcript = useMemo(() => aiRequestEntries(row), [row]);
  const tools = useMemo(() => requestedTools(row), [row]);
  const message = latestUserMessage(row);
  const error = isCallError(row);
  // Requests made by an MCP conversation carry its id; link to the first MCP call of it, if loaded.
  const mcpCall = row.conversationId == null ? undefined : mcpRows.find(call => call.conversationId === row.conversationId);

  return (
    <div>
      <header className="space-y-3 px-5 pb-4 pt-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="violet" mono>{row.systemPromptId}</Badge>
          {error ? <Badge tone="red" dot>Error</Badge> : <Badge tone="green" dot>Completed</Badge>}
          <Badge>{row.mode}</Badge>
          {!row.isAuthenticated && <Badge>Anonymous</Badge>}
          {row.conversationId != null && <Badge tone="amber">MCP</Badge>}
        </div>
        <h2 className="line-clamp-3 text-[15px] font-semibold leading-6 tracking-tight text-foreground">{message === "" ? "No input message" : message}</h2>
        <p className="text-xs text-muted-foreground">
          <span className="font-mono">{row.modelId}</span>
          <span className="mx-1.5 text-muted-foreground/50">·</span>
          <span title={formatPacificTimestamp(toDate(row.createdAt))}>{formatAgo(toDate(row.createdAt))}</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton getText={() => formatAiRequestContext(row)} label="Copy context" title="Copy the full request context for pasting into an AI chat" />
          {mcpCall != null && (
            <Link
              href={consoleHref("/console/mcp", { id: String(mcpCall.id) })}
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground hover:transition-none"
            >
              <Icon name="review" size="sm" /> Open MCP conversation
            </Link>
          )}
        </div>
      </header>

      <DetailStats items={[
        { label: "Duration", value: formatDuration(row.durationMs) },
        { label: "Input", value: row.inputTokens == null ? "—" : `${row.inputTokens.toLocaleString()} tok` },
        { label: "Output", value: row.outputTokens == null ? "—" : `${row.outputTokens.toLocaleString()} tok` },
        { label: "Cost", value: row.costUsd == null ? "Unpriced" : formatUsd(row.costUsd) },
      ]} />

      <div className="px-5 pt-1">
        <Tabs
          id={tabsId}
          label="Request detail sections"
          value={section}
          onChange={setSection}
          items={[{ value: "conversation", label: "Conversation" }, { value: "request", label: "Request" }]}
        />
      </div>

      <div className="px-5 py-4">
        {error && (
          <Callout title="The request failed" className="mb-4">
            <p className="whitespace-pre-wrap break-words font-mono text-[11px]">{row.errorMessage}</p>
          </Callout>
        )}
        {section === "conversation" && (
          <TabPanel id={tabsId} value="conversation" className="space-y-5">
            <section>
              <p className="mb-3 text-xs font-medium text-foreground">Input messages</p>
              <Transcript entries={transcript.input} emptyLabel="No input messages." />
            </section>
            <section>
              <p className="mb-3 text-xs font-medium text-foreground">Model output</p>
              <Transcript entries={transcript.output} emptyLabel="No assistant output recorded." />
            </section>
          </TabPanel>
        )}
        {section === "request" && (
          <TabPanel id={tabsId} value="request" className="space-y-5">
            <section>
              <p className="mb-1 text-xs font-medium text-foreground">Routing</p>
              <PropertyList items={[
                { label: "Flow", value: row.systemPromptId, mono: true },
                { label: "Model", value: row.modelId, mono: true },
                { label: "Mode", value: row.mode },
                { label: "Quality / speed", value: `${row.quality} / ${row.speed}` },
                { label: "Steps", value: String(row.stepCount) },
                { label: "Tools requested", value: tools.length === 0 ? "None" : tools.join(", "), mono: tools.length > 0 },
              ]} />
            </section>
            <section>
              <p className="mb-1 text-xs font-medium text-foreground">Identity</p>
              <PropertyList items={[
                { label: "Authentication", value: row.isAuthenticated ? "Authenticated" : "Anonymous" },
                { label: "Project", value: row.projectId ?? "", mono: true, hidden: row.projectId == null || row.projectId === "" },
                { label: "User", value: row.userId ?? "", mono: true, hidden: row.userId == null || row.userId === "" },
                // Nullish (not truthy) check: log-ai-query stores "" as a present id, matching the MCP badge.
                { label: "Conversation", value: row.conversationId ?? "", mono: true, hidden: row.conversationId == null },
                { label: "Correlation ID", value: row.correlationId, mono: true },
                { label: "Generation ID", value: row.openrouterGenerationId ?? "", mono: true, hidden: row.openrouterGenerationId == null },
              ]} />
            </section>
            <section>
              <p className="mb-1 text-xs font-medium text-foreground">Prompt cache</p>
              <PropertyList items={[
                { label: "Cache read", value: row.cachedInputTokens == null ? "—" : `${row.cachedInputTokens.toLocaleString()} tok` },
                { label: "Cache write", value: row.cacheCreationTokens == null ? "—" : `${row.cacheCreationTokens.toLocaleString()} tok` },
                { label: "Savings", value: row.cacheDiscountUsd == null ? "—" : formatSignedUsd(row.cacheDiscountUsd) },
              ]} />
            </section>
          </TabPanel>
        )}
      </div>
    </div>
  );
}
