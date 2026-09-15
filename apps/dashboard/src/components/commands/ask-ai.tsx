import { createUnifiedAiChatAdapter, getFriendlyAiErrorMessage } from "@/components/assistant-ui/chat-stream";
import { ImageAttachmentAdapter } from "@/components/assistant-ui/image-attachment-adapter";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { Thread } from "@/components/assistant-ui/thread";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { useDebouncedAction } from "@/hooks/use-debounced-action";
import { getPublicEnvVar } from "@/lib/env";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useThreadRuntime,
  type ChatModelAdapter,
} from "@assistant-ui/react";
import { useUser } from "@hexclave/next";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { usePathname } from "next/navigation";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { CmdKPreviewProps } from "../cmdk-commands";

const RUNNING_STATUS_MESSAGES = ["Thinking..."];

export function AIChatPreview({ query, ...rest }: CmdKPreviewProps) {
  return <AIChatPreviewInner key={query} query={query} {...rest} />;
}

const AIChatPreviewInner = memo(function AIChatPreview({
  query,
  registerOnFocus,
  unregisterOnFocus,
}: CmdKPreviewProps) {
  const currentUser = useUser();
  const pathname = usePathname();
  const projectId = pathname.startsWith("/projects/") ? pathname.split("/")[2] : undefined;

  const backendBaseUrl = getPublicEnvVar("NEXT_PUBLIC_STACK_API_URL")
    ?? throwErr("NEXT_PUBLIC_STACK_API_URL is not set");

  const [runError, setRunError] = useState<string | null>(null);

  const chatAdapter = useMemo<ChatModelAdapter>(() => createUnifiedAiChatAdapter({
    backendBaseUrl,
    currentUser: currentUser ?? undefined,
    systemPrompt: "command-center-ask-ai",
    tools: ["docs", "sql-query", "read-config"],
    quality: "smart",
    speed: "slow",
    projectId,
    onRunStart: () => setRunError(null),
    onError: ({ error }) => setRunError(getFriendlyAiErrorMessage(error)),
  }), [backendBaseUrl, currentUser, projectId]);

  const attachmentAdapter = useMemo(() => new ImageAttachmentAdapter(), []);

  const runtime = useLocalRuntime(chatAdapter, {
    adapters: { attachments: attachmentAdapter },
  });

  const assistantContentComponents = useMemo(() => ({
    Text: MarkdownText,
    tools: { Fallback: ToolFallback },
  }), []);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const focusHandler = () => {
      const textarea = containerRef.current?.querySelector<HTMLTextAreaElement>("textarea");
      textarea?.focus();
    };
    registerOnFocus(focusHandler);
    return () => unregisterOnFocus(focusHandler);
  }, [registerOnFocus, unregisterOnFocus]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AskAiAutoSend query={query} />
      <div ref={containerRef} className="flex flex-col h-full w-full">
        {runError && (
          <div className="mx-3 mt-2 flex items-start gap-2 text-[12px] text-red-400/90 px-3 py-2 bg-red-500/[0.08] rounded-lg ring-1 ring-red-500/20 shrink-0">
            <span className="shrink-0 mt-0.5">⚠</span>
            <span>{runError}</span>
          </div>
        )}
        <Thread
          useOffWhiteLightMode
          composerPlaceholder="Ask a follow-up question..."
          runningStatusMessages={RUNNING_STATUS_MESSAGES}
          assistantContentComponents={assistantContentComponents}
          composerAttachments
          attachmentAdapter={attachmentAdapter}
          autoFocusComposer={false}
          agentEjectFooter
        />
      </div>
    </AssistantRuntimeProvider>
  );
});

function AskAiAutoSend({ query }: { query: string }) {
  const threadRuntime = useThreadRuntime();
  const trimmed = query.trim();
  useDebouncedAction({
    action: async () => {
      threadRuntime.append({
        role: "user",
        content: [{ type: "text", text: trimmed }],
      });
    },
    delayMs: 1000,
    skip: !trimmed,
  });
  return null;
}
