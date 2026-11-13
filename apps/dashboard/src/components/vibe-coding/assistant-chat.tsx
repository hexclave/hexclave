import { ImageAttachmentAdapter } from "@/components/assistant-ui/image-attachment-adapter";
import { Thread, type ComposerPlaceholder } from "@/components/assistant-ui/thread";
import {
  AssistantRuntimeProvider,
  useComposerRuntime,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadHistoryAdapter,
} from "@assistant-ui/react";
import { useEffect, useMemo } from "react";
import { TooltipProvider } from "@/components/ui";

/**
 * Imperative handle the parent can use to drive the thread composer from outside the
 * assistant-ui runtime — e.g. pre-filling it with a crash report captured from the
 * dashboard sandbox iframe. We keep it small on purpose: anything beyond "set the
 * current draft" is a smell.
 */
export type AssistantComposerApi = {
  setText: (text: string) => void,
  getText: () => string,
};

type AssistantChatProps = {
  chatAdapter: ChatModelAdapter,
  historyAdapter: ThreadHistoryAdapter,
  toolComponents: React.ReactNode,
  useOffWhiteLightMode?: boolean,
  /** Static string, or `{ prefix, suffixes }` for a typing animation isolated to a leaf input. */
  composerPlaceholder?: ComposerPlaceholder,
  hideMessageActions?: boolean,
  runningStatusMessages?: string[],
  /** Enable image attachment UI (subject to shared MAX_IMAGES_PER_MESSAGE/MAX_IMAGE_BYTES_PER_FILE). */
  composerAttachments?: boolean,
  /** Content rendered inside the composer box, above the textarea. Used for widget chips. */
  composerTopContent?: React.ReactNode,
  /**
   * Called once the composer runtime is mounted. Parent stores the handle in a ref
   * and can then call `setText(...)` imperatively. Fires inside the runtime provider
   * so the hook contract is honored.
   */
  onComposerReady?: (api: AssistantComposerApi) => void,
}

/**
 * Lives INSIDE `AssistantRuntimeProvider` so `useComposerRuntime()` resolves. All it
 * does is forward a tiny imperative handle upward on mount — no rendered output.
 */
function ComposerBridge({ onReady }: { onReady: (api: AssistantComposerApi) => void }) {
  const composerRuntime = useComposerRuntime();
  useEffect(() => {
    onReady({
      setText: (text: string) => composerRuntime.setText(text),
      getText: () => composerRuntime.getState().text,
    });
  }, [composerRuntime, onReady]);
  return null;
}

export default function AssistantChat({
  chatAdapter,
  historyAdapter,
  toolComponents,
  useOffWhiteLightMode = false,
  composerPlaceholder,
  hideMessageActions = false,
  runningStatusMessages,
  composerAttachments = false,
  composerTopContent,
  onComposerReady,
}: AssistantChatProps) {
  const attachmentAdapter = useMemo(
    () => (composerAttachments ? new ImageAttachmentAdapter() : undefined),
    [composerAttachments],
  );

  const runtime = useLocalRuntime(
    chatAdapter,
    {
      adapters: {
        history: historyAdapter,
        ...(attachmentAdapter ? { attachments: attachmentAdapter } : {}),
      },
    }
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex flex-col h-full w-full overflow-hidden border-l border-border/10 dark:border-foreground/[0.06]">
        <TooltipProvider delayDuration={300}>
          <Thread
            useOffWhiteLightMode={useOffWhiteLightMode}
            composerPlaceholder={composerPlaceholder}
            hideMessageActions={hideMessageActions}
            runningStatusMessages={runningStatusMessages}
            composerAttachments={composerAttachments}
            attachmentAdapter={attachmentAdapter}
            composerTopContent={composerTopContent}
          />
        </TooltipProvider>
        {toolComponents}
        {onComposerReady ? <ComposerBridge onReady={onComposerReady} /> : null}
      </div>
    </AssistantRuntimeProvider>
  );
}
