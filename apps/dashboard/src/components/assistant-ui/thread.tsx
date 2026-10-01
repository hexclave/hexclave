import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button, useToast } from "@/components/ui";
import { getPublicEnvVar } from "@/lib/env";
import { cn } from "@/lib/utils";
import {
  validateComposerImageCount,
} from "./image-attachment-validation";
import {
  type Attachment,
  type AttachmentAdapter,
  type CompleteAttachment,
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useComposer,
  useComposerRuntime,
  useMessage,
  useThreadRuntime,
  type PendingAttachment,
  type ThreadMessage,
} from "@assistant-ui/react";
import { ArrowClockwiseIcon, ArrowDownIcon, CaretLeftIcon, CaretRightIcon, CheckIcon, CopyIcon, ImageIcon, PaperPlaneRightIcon, PencilSimpleIcon, PlugsConnectedIcon, WarningCircle, XIcon } from "@phosphor-icons/react";
import {
  MAX_IMAGES_PER_MESSAGE,
} from "@hexclave/shared/dist/ai/image-limits";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type FC, type ReactNode } from "react";

type AssistantContentComponents = ComponentProps<typeof MessagePrimitive.Content>["components"];
const AssistantContentComponentsContext = createContext<AssistantContentComponents | undefined>(undefined);

const HideMessageActionsContext = createContext(false);
const HasRunningStatusContext = createContext(false);

const ComposerAttachmentsEnabledContext = createContext(false);
const ComposerAttachmentAdapterContext = createContext<AttachmentAdapter | null>(null);

function useComposerAttachmentsEnabled() {
  return useContext(ComposerAttachmentsEnabledContext);
}

function useComposerAttachmentAdapter() {
  return useContext(ComposerAttachmentAdapterContext);
}

/** Static placeholder string, or config for the typing-animation input. */
export type ComposerPlaceholder =
  | string
  | {
      prefix: string,
      suffixes: readonly string[],
      typeSpeed?: number,
      deleteSpeed?: number,
      pauseAfterType?: number,
      pauseAfterDelete?: number,
    };

export const Thread: FC<{
  useOffWhiteLightMode?: boolean,
  composerPlaceholder?: ComposerPlaceholder,
  hideMessageActions?: boolean,
  runningStatusMessages?: string[],
  composerAttachments?: boolean,
  attachmentAdapter?: AttachmentAdapter,
  composerTopContent?: React.ReactNode,
  /** Custom welcome / empty-state node. Defaults to the email-template welcome. */
  welcome?: ReactNode,
  /** Overrides for the assistant message content slots (Text / tools / etc.). */
  assistantContentComponents?: AssistantContentComponents,
  autoFocusComposer?: boolean,
  /**
   * Shows a subtle line beneath the composer inviting the user to continue the
   * conversation in their own coding agent (via the Hexclave MCP server) or to
   * copy the chat transcript so they can paste it elsewhere. Enable this on the
   * general-purpose dashboard AI chats (command center, companion widget).
   */
  agentEjectFooter?: boolean,
}> = ({ useOffWhiteLightMode = false, composerPlaceholder, hideMessageActions = false, runningStatusMessages, composerAttachments = false, attachmentAdapter, composerTopContent, welcome, assistantContentComponents, autoFocusComposer = true, agentEjectFooter = false }) => {
  return (
    <HideMessageActionsContext.Provider value={hideMessageActions}>
      <HasRunningStatusContext.Provider value={!!runningStatusMessages}>
        <AssistantContentComponentsContext.Provider value={assistantContentComponents}>
          <ComposerAttachmentAdapterContext.Provider value={attachmentAdapter ?? null}>
            <ComposerAttachmentsEnabledContext.Provider value={composerAttachments}>
              <ThreadPrimitive.Root
                className="box-border flex h-0 flex-grow flex-col overflow-hidden bg-transparent"
                style={{
                  ["--thread-max-width" as string]: "100%",
                }}
              >
                <ThreadPrimitive.Viewport
                  className="flex h-full flex-col items-center overflow-y-auto scroll-smooth px-3 bg-inherit"
                >
                  {welcome ? (
                    <ThreadPrimitive.Empty>{welcome}</ThreadPrimitive.Empty>
                  ) : (
                    <ThreadWelcome />
                  )}

                  <ThreadPrimitive.Messages
                    components={{
                      UserMessage: UserMessage,
                      EditComposer: EditComposer,
                      AssistantMessage: AssistantMessage,
                    }}
                  />

                  {runningStatusMessages && (
                    <ThreadPrimitive.If running>
                      <ThreadRunningStatus messages={runningStatusMessages} />
                    </ThreadPrimitive.If>
                  )}

                  <ThreadPrimitive.If empty={false}>
                    <div className="min-h-6 flex-grow" />
                  </ThreadPrimitive.If>

                  <div className="sticky bottom-0 mt-2 flex w-full max-w-[var(--thread-max-width)] flex-col items-center justify-end pt-6 pb-3">
                    <ThreadScrollToBottom />
                    <Composer placeholder={composerPlaceholder} topContent={composerTopContent} autoFocus={autoFocusComposer} useOffWhiteLightMode={useOffWhiteLightMode} />
                    {agentEjectFooter && <AgentEjectFooter />}
                  </div>
                </ThreadPrimitive.Viewport>
              </ThreadPrimitive.Root>
            </ComposerAttachmentsEnabledContext.Provider>
          </ComposerAttachmentAdapterContext.Provider>
        </AssistantContentComponentsContext.Provider>
      </HasRunningStatusContext.Provider>
    </HideMessageActionsContext.Provider>
  );
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="absolute -top-10 rounded-full disabled:invisible shadow-lg bg-background/80 backdrop-blur-sm ring-1 ring-foreground/[0.06]"
      >
        <ArrowDownIcon size={14} />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <ThreadPrimitive.Empty>
      <div className="flex w-full max-w-[var(--thread-max-width)] flex-grow flex-col">
        <div className="flex w-full flex-grow flex-col items-center justify-center py-16">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500/20 to-blue-600/10 flex items-center justify-center mb-5 ring-1 ring-blue-500/20 shadow-lg shadow-blue-500/10">
            <PaperPlaneRightIcon className="w-7 h-7 text-blue-500" weight="duotone" />
          </div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground mb-2">
            Hello! 👋
          </h2>
          <p className="text-sm text-muted-foreground text-center max-w-[260px] leading-relaxed">
            I&apos;m here to help you create beautiful, modern email templates. Describe what you&apos;d like to build.
          </p>
        </div>
      </div>
    </ThreadPrimitive.Empty>
  );
};

const ThreadWelcomeSuggestions: FC = () => {
  return (
    <div className="mt-3 flex w-full items-stretch justify-center gap-4">
      <ThreadPrimitive.Suggestion
        className="hover:bg-muted/80 flex max-w-sm grow basis-0 flex-col items-center justify-center rounded-lg border p-3 transition-colors ease-in"
        prompt="Make a modern email theme with a blue color scheme"
        method="replace"
        autoSend
      >
        <span className="line-clamp-2 text-ellipsis text-sm font-semibold">
          Make a blue theme
        </span>
      </ThreadPrimitive.Suggestion>
      <ThreadPrimitive.Suggestion
        className="hover:bg-muted/80 flex max-w-sm grow basis-0 flex-col items-center justify-center rounded-lg border p-3 transition-colors ease-in"
        prompt="Make a modern email theme in dark mode"
        method="replace"
        autoSend
      >
        <span className="line-clamp-2 text-ellipsis text-sm font-semibold">
          Make a dark theme
        </span>
      </ThreadPrimitive.Suggestion>
    </div>
  );
};

type DisplayableAttachment = {
  id: string,
  name: string,
  file?: File,
  content?: readonly unknown[],
};

function extractImageUrlFromContent(content: readonly unknown[] | undefined): string | null {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: unknown }).type === "image") {
      const image = (part as { image?: unknown }).image;
      if (typeof image === "string") return image;
    }
  }
  return null;
}

function isCompleteAttachment(attachment: Attachment): attachment is CompleteAttachment {
  return attachment.status.type === "complete";
}

function isPendingAttachment(attachment: Attachment): attachment is PendingAttachment {
  return attachment.status.type !== "complete";
}

function getAttachmentIdentityKey(attachment: Attachment): string {
  return attachment.id;
}

function haveAttachmentListsChanged(
  currentAttachments: readonly Attachment[],
  originalAttachments: readonly Attachment[],
): boolean {
  if (currentAttachments.length !== originalAttachments.length) {
    return true;
  }
  return currentAttachments.some((attachment, index) => (
    getAttachmentIdentityKey(attachment) !== getAttachmentIdentityKey(originalAttachments[index]!)
  ));
}

function getTextContent(parts: readonly { type: string, text?: string }[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}

async function resolveComposerAttachments(
  attachments: readonly Attachment[],
  attachmentAdapter: AttachmentAdapter | null,
): Promise<readonly CompleteAttachment[]> {
  if (attachments.length === 0) {
    return [];
  }
  if (attachmentAdapter == null) {
    if (attachments.some(isPendingAttachment)) {
      throw new Error("Image attachments are not available in this composer.");
    }
    return attachments.filter(isCompleteAttachment);
  }

  const resolved: CompleteAttachment[] = [];
  for (const attachment of attachments) {
    if (isCompleteAttachment(attachment)) {
      resolved.push(attachment);
      continue;
    }
    resolved.push(await attachmentAdapter.send(attachment));
  }
  return resolved;
}

const AttachmentThumb: FC<{
  attachment: DisplayableAttachment,
  onRemove?: () => void,
}> = ({ attachment, onRemove }) => {
  const { file, name, content } = attachment;

  const liveFile = file instanceof Blob ? file : null;

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!liveFile) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(liveFile);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [liveFile]);

  const contentUrl = useMemo(() => extractImageUrlFromContent(content), [content]);
  const displayUrl = objectUrl ?? contentUrl;

  return (
    <div className="group/attachment relative h-14 w-14 overflow-hidden rounded-xl ring-1 ring-foreground/[0.08] bg-foreground/[0.03] shadow-sm">
      {displayUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={displayUrl} alt={name} className="h-full w-full object-cover" draggable={false} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <ImageIcon className="h-5 w-5" />
        </div>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
          className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-background/95 text-foreground/80 ring-1 ring-foreground/[0.1] shadow opacity-0 group-hover/attachment:opacity-100 focus-visible:opacity-100 transition-opacity hover:text-foreground"
        >
          <XIcon className="h-3 w-3" weight="bold" />
        </button>
      )}
    </div>
  );
};

const ComposerAttachmentsRow: FC = () => {
  const composerRuntime = useComposerRuntime();
  const attachments = useComposer((s) => s.attachments);
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pt-3 pb-1 border-b border-foreground/[0.04]">
      {attachments.map((attachment, index) => (
        <AttachmentThumb
          key={attachment.id}
          attachment={attachment as DisplayableAttachment}
          onRemove={() =>
            runAsynchronously(composerRuntime.getAttachmentByIndex(index).remove())
          }
        />
      ))}
    </div>
  );
};

const UserMessageAttachmentsRow: FC = () => {
  const attachments = useMessage((m) =>
    m.role === "user" ? m.attachments : undefined,
  );
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-end gap-2 mb-1.5">
      {attachments.map((attachment) => (
        <AttachmentThumb
          key={attachment.id}
          attachment={attachment as DisplayableAttachment}
        />
      ))}
    </div>
  );
};

const ComposerAttachmentsAddButton: FC = () => {
  const composerRuntime = useComposerRuntime();
  const count = useComposer((s) => s.attachments.length);
  const { toast } = useToast();
  const atLimit = count >= MAX_IMAGES_PER_MESSAGE;

  const handleClick = () => {
    const countValidation = validateComposerImageCount(composerRuntime.getState().attachments.length + 1);
    if (!countValidation.ok) {
      toast({
        variant: "destructive",
        description: countValidation.reason,
      });
      return;
    }

    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.hidden = true;
    document.body.appendChild(input);

    input.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        const liveCount = composerRuntime.getState().attachments.length;
        const remaining = Math.max(0, MAX_IMAGES_PER_MESSAGE - liveCount);
        const picked = Array.from(files);
        const selected = picked.slice(0, remaining);

        const countValidation = validateComposerImageCount(liveCount + picked.length);
        if (!countValidation.ok) {
          toast({
            variant: "destructive",
            description: countValidation.reason,
          });
        }

        runAsynchronously(
          (async () => {
            for (const file of selected) {
              if (composerRuntime.getState().attachments.length >= MAX_IMAGES_PER_MESSAGE) {
                break;
              }
              try {
                await composerRuntime.addAttachment(file);
              } catch (err) {
                toast({
                  variant: "destructive",
                  description:
                    err instanceof Error ? err.message : `Failed to attach "${file.name}".`,
                });
              }
            }
          })(),
        );
      }
      document.body.removeChild(input);
    };

    input.oncancel = () => {
      if (!input.files || input.files.length === 0) {
        if (input.parentNode) document.body.removeChild(input);
      }
    };
    input.click();
  };

  const tooltipText = atLimit
    ? `Limit reached (${MAX_IMAGES_PER_MESSAGE}/${MAX_IMAGES_PER_MESSAGE})`
    : `Attach image (${count}/${MAX_IMAGES_PER_MESSAGE})`;

  return (
    <TooltipIconButton
      tooltip={tooltipText}
      side="top"
      onClick={handleClick}
      className={cn(
        "h-7 w-7 rounded-lg text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
        atLimit && "text-muted-foreground/70",
      )}
    >
      <ImageIcon className="h-[15px] w-[15px]" weight="regular" />
    </TooltipIconButton>
  );
};

const COMPOSER_INPUT_CLASS =
  "placeholder:text-muted-foreground/60 max-h-32 w-full resize-none border-none bg-transparent px-4 py-3 text-sm outline-none focus:ring-0 disabled:cursor-not-allowed leading-relaxed";

const ComposerAnimatedInput: FC<{
  prefix: string,
  suffixes: readonly string[],
  typeSpeed: number,
  deleteSpeed: number,
  pauseAfterType: number,
  pauseAfterDelete: number,
  autoFocus?: boolean,
}> = ({ prefix, suffixes, typeSpeed, deleteSpeed, pauseAfterType, pauseAfterDelete, autoFocus = true }) => {
  const [suffixText, setSuffixText] = useState("");
  const stateRef = useRef({
    suffixIndex: 0,
    charIndex: 0,
    phase: "typing" as "typing" | "pausing" | "deleting" | "waiting",
  });

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;

    function tick() {
      const s = stateRef.current;
      const target = suffixes[s.suffixIndex % suffixes.length];
      switch (s.phase) {
        case "typing": {
          if (s.charIndex < target.length) {
            s.charIndex++;
            setSuffixText(target.slice(0, s.charIndex));
            timeoutId = setTimeout(tick, typeSpeed);
          } else {
            s.phase = "pausing";
            timeoutId = setTimeout(tick, pauseAfterType);
          }
          break;
        }
        case "pausing": {
          s.phase = "deleting";
          timeoutId = setTimeout(tick, deleteSpeed);
          break;
        }
        case "deleting": {
          if (s.charIndex > 0) {
            s.charIndex--;
            setSuffixText(target.slice(0, s.charIndex));
            timeoutId = setTimeout(tick, deleteSpeed);
          } else {
            s.phase = "waiting";
            timeoutId = setTimeout(tick, pauseAfterDelete);
          }
          break;
        }
        case "waiting": {
          s.suffixIndex = (s.suffixIndex + 1) % suffixes.length;
          s.charIndex = 0;
          s.phase = "typing";
          timeoutId = setTimeout(tick, typeSpeed);
          break;
        }
      }
    }

    timeoutId = setTimeout(tick, 500);
    return () => clearTimeout(timeoutId);
  }, [suffixes, typeSpeed, deleteSpeed, pauseAfterType, pauseAfterDelete]);

  return (
    <ComposerPrimitive.Input
      rows={1}
      autoFocus={autoFocus}
      placeholder={prefix + suffixText}
      className={COMPOSER_INPUT_CLASS}
    />
  );
};

const ComposerStaticInput: FC<{ placeholder?: string, autoFocus?: boolean }> = ({ placeholder, autoFocus = true }) => {
  return (
    <ComposerPrimitive.Input
      rows={1}
      autoFocus={autoFocus}
      placeholder={placeholder ?? "Describe what you want..."}
      className={COMPOSER_INPUT_CLASS}
    />
  );
};

const Composer: FC<{ placeholder?: ComposerPlaceholder, topContent?: React.ReactNode, autoFocus?: boolean, useOffWhiteLightMode?: boolean }> = ({ placeholder, topContent, autoFocus = true, useOffWhiteLightMode = false }) => {
  const attachmentsEnabled = useComposerAttachmentsEnabled();
  return (
    <ComposerPrimitive.Root className={cn(
      "group/composer relative flex w-full flex-col rounded-2xl border border-border/20 dark:border-foreground/[0.08] shadow-sm ring-1 ring-foreground/[0.04] transition-all duration-150 hover:transition-none focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500/30",
      useOffWhiteLightMode ? "bg-card backdrop-blur-xl dark:bg-background/80" : "bg-background/95 dark:bg-background/80",
    )}>
      {attachmentsEnabled && <ComposerAttachmentsRow />}
      {topContent}
      {typeof placeholder === "object" ? (
        <ComposerAnimatedInput
          prefix={placeholder.prefix}
          suffixes={placeholder.suffixes}
          typeSpeed={placeholder.typeSpeed ?? 70}
          deleteSpeed={placeholder.deleteSpeed ?? 40}
          pauseAfterType={placeholder.pauseAfterType ?? 2000}
          pauseAfterDelete={placeholder.pauseAfterDelete ?? 400}
          autoFocus={autoFocus}
        />
      ) : (
        <ComposerStaticInput placeholder={placeholder} autoFocus={autoFocus} />
      )}
      <div className="flex items-center justify-between px-3 pb-2.5 gap-2">
        <div className="flex items-center gap-1">
          {attachmentsEnabled && <ComposerAttachmentsAddButton />}
        </div>
        <ComposerAction />
      </div>
    </ComposerPrimitive.Root>
  );
};

/**
 * Canonical link to the "set up the Hexclave MCP server" docs. Uses the docs
 * base URL when configured (so it points at localhost:8104 in dev) and falls
 * back to the public docs site otherwise.
 */
function getMcpDocsUrl(): string {
  const base = (getPublicEnvVar("NEXT_PUBLIC_STACK_DOCS_BASE_URL") ?? "https://docs.hexclave.com").replace(/\/$/, "");
  return `${base}/guides/getting-started/ai-integration#option-3-mcp`;
}

/**
 * Empty-state variant of the agent-eject CTA: an "or" divider followed by a
 * card inviting the user to continue the chat in their own coding agent via
 * the Hexclave MCP server. Rendered inside the welcome node of general-purpose
 * dashboard AI chats, where there is no transcript to copy yet.
 */
export const AgentEjectWelcomeCta: FC = () => {
  const mcpDocsUrl = useMemo(() => getMcpDocsUrl(), []);

  return (
    <div className="mt-8 flex w-full max-w-[280px] flex-col items-center">
      <div className="flex w-full items-center gap-3 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground/40">
        <div className="h-px flex-1 bg-border/60" />
        <span>or</span>
        <div className="h-px flex-1 bg-border/60" />
      </div>
      <a
        href={mcpDocsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="group mt-4 inline-flex items-center gap-2.5 rounded-xl border border-border/60 bg-muted/20 px-3.5 py-2.5 text-center text-xs leading-snug text-muted-foreground transition-colors hover:transition-none hover:border-border hover:bg-muted/50 hover:text-foreground"
      >
        <PlugsConnectedIcon className="h-4 w-4 shrink-0 text-purple-400" weight="bold" />
        <span>
          Chat with Hexclave in your own agent with our{" "}
          <span className="font-medium text-foreground/80 underline decoration-foreground/20 underline-offset-2 group-hover:decoration-foreground/40">
            MCP server
          </span>
        </span>
      </a>
    </div>
  );
};

function serializeThreadToMarkdown(messages: readonly ThreadMessage[]): string {
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = (typeof message.content === "string"
      ? message.content
      : message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
    ).trim();
    if (text.length === 0) continue;
    blocks.push(`## ${message.role === "user" ? "User" : "Assistant"}\n\n${text}`);
  }
  return blocks.join("\n\n");
}

/**
 * Subtle call-to-action beneath the composer that lets a user "eject" a chat
 * they started in the dashboard into their own coding agent — either by wiring
 * up the Hexclave MCP server (live docs + tools) or by copying the transcript
 * to paste wherever they like.
 */
const AgentEjectFooter: FC = () => {
  const threadRuntime = useThreadRuntime();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [messageCount, setMessageCount] = useState(() => threadRuntime.getState().messages.length);

  useEffect(() => {
    const sync = () => setMessageCount(threadRuntime.getState().messages.length);
    sync();
    return threadRuntime.subscribe(sync);
  }, [threadRuntime]);

  const mcpDocsUrl = useMemo(() => getMcpDocsUrl(), []);

  const hasMessages = messageCount > 0;

  const handleCopy = useCallback(async () => {
    const markdown = serializeThreadToMarkdown(threadRuntime.getState().messages);
    if (markdown.length === 0) {
      toast({ description: "No chat history to copy yet." });
      return;
    }
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [threadRuntime, toast]);

  const linkClass = "inline-flex items-center gap-1 font-medium underline decoration-foreground/20 underline-offset-2 transition-colors hover:transition-none hover:text-foreground hover:decoration-foreground/40";

  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 px-2 text-center text-[11px] leading-relaxed text-muted-foreground/50">
      <span>Want to continue in your own agent?</span>
      <a
        href={mcpDocsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(linkClass, "text-foreground/70")}
      >
        <PlugsConnectedIcon className="h-3 w-3" weight="bold" />
        Install our MCP server
      </a>
      <span className="text-muted-foreground/40">or</span>
      <button
        type="button"
        onClick={() => runAsynchronously(handleCopy())}
        disabled={!hasMessages}
        className={cn(
          hasMessages
            ? cn(linkClass, "text-foreground/70")
            : "inline-flex cursor-not-allowed items-center gap-1 font-medium text-muted-foreground/40",
        )}
      >
        {copied ? (
          <CheckIcon className="h-3 w-3 text-green-500" weight="bold" />
        ) : (
          <CopyIcon className="h-3 w-3" />
        )}
        {copied ? "Copied!" : "Copy chat history"}
      </button>
    </div>
  );
};

const ComposerAction: FC = () => {
  return (
    <div className="flex items-center gap-2">
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send asChild>
          <Button
            size="sm"
            className="rounded-xl h-7 px-3 bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-500/20 transition-all duration-150 hover:transition-none active:scale-[0.98]"
          >
            <PaperPlaneRightIcon className="mr-1.5 h-3 w-3" weight="bold" />
            <span className="text-[11px] font-semibold">Generate</span>
          </Button>
        </ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel asChild>
          <Button
            size="sm"
            variant="outline"
            className="rounded-xl h-7 px-3 border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400 hover:bg-orange-500/20"
          >
            <CircleStopIcon className="mr-1.5 h-3 w-3" />
            <span className="text-[11px] font-semibold">Stop</span>
          </Button>
        </ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </div>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="group flex flex-col items-end w-full max-w-[var(--thread-max-width)] py-3 gap-1.5">
      <UserMessageAttachmentsRow />
      <div className="flex items-start gap-2 justify-end w-full">
        <UserActionBar />
        <MessagePrimitive.If hasContent>
          <div className="bg-foreground/[0.05] text-foreground max-w-[90%] break-words rounded-2xl px-3.5 py-2.5 text-sm ring-1 ring-foreground/[0.06]">
            <MessagePrimitive.Content />
          </div>
        </MessagePrimitive.If>
      </div>
      <BranchPicker className="justify-end mr-1" />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  const hidden = useContext(HideMessageActionsContext);
  if (hidden) return null;
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="flex items-center gap-0.5 self-center opacity-0 group-hover:opacity-100 transition-opacity duration-150"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit" className="h-7 w-7 rounded-md hover:bg-foreground/[0.05]">
          <PencilSimpleIcon size={13} />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  const attachmentsEnabled = useComposerAttachmentsEnabled();
  const attachmentAdapter = useComposerAttachmentAdapter();
  const composerRuntime = useComposerRuntime();
  const threadRuntime = useThreadRuntime();
  const { toast } = useToast();
  const messageId = useMessage((m) => m.id);
  const parentId = useMessage((m) => m.parentId ?? null);
  const role = useMessage((m) => m.role);
  const originalContent = useMessage((m) => m.content);
  const originalAttachments = useMessage((m) => m.attachments ?? []);
  const composerText = useComposer((s) => s.text);
  const composerAttachments = useComposer((s) => s.attachments);
  const originalText = useMemo(() => getTextContent(originalContent), [originalContent]);
  const hasChanges = composerText !== originalText
    || haveAttachmentListsChanged(composerAttachments, originalAttachments);

  const handleSend = async () => {
    if (!hasChanges) {
      return;
    }

    try {
      const composerState = composerRuntime.getState();
      const resolvedAttachments = await resolveComposerAttachments(
        composerState.attachments,
        attachmentAdapter,
      );
      threadRuntime.append({
        parentId,
        sourceId: messageId,
        role,
        content: composerState.text ? [{ type: "text", text: composerState.text }] : [],
        attachments: resolvedAttachments,
        metadata: { custom: {} },
        runConfig: composerState.runConfig,
      });
      composerRuntime.cancel();
    } catch (error) {
      toast({
        variant: "destructive",
        description: error instanceof Error ? error.message : "Failed to send edited message.",
      });
    }
  };

  return (
    <ComposerPrimitive.Root className="bg-foreground/[0.03] my-3 flex w-full max-w-[var(--thread-max-width)] flex-col gap-2 rounded-xl ring-1 ring-foreground/[0.08]">
      {attachmentsEnabled && <ComposerAttachmentsRow />}
      <ComposerPrimitive.Input className="text-foreground flex min-h-[2.5rem] w-full resize-none bg-transparent p-3 pb-0 text-sm outline-none" />

      <div className="px-3 pb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {attachmentsEnabled && <ComposerAttachmentsAddButton />}
        </div>
        <div className="flex items-center gap-2">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs">Cancel</Button>
          </ComposerPrimitive.Cancel>
          <Button
            size="sm"
            className="h-7 px-3 text-xs bg-blue-600 hover:bg-blue-500"
            disabled={!hasChanges}
            onClick={handleSend}
          >
            Send
          </Button>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};

const AssistantMessage: FC = () => {
  const hasRunningStatus = useContext(HasRunningStatusContext);
  const overrideComponents = useContext(AssistantContentComponentsContext);
  const contentComponents: AssistantContentComponents = overrideComponents ?? { Text: MarkdownText };
  return (
    <MessagePrimitive.Root className="flex flex-col relative w-full max-w-[var(--thread-max-width)] py-4 group">
      <div className="flex items-start gap-3">
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500/20 to-blue-600/10 flex items-center justify-center shrink-0 ring-1 ring-blue-500/20 shadow-sm">
          {hasRunningStatus ? (
            <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
          ) : (
            <>
              <ThreadPrimitive.If running>
                <div className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
              </ThreadPrimitive.If>
              <ThreadPrimitive.If running={false}>
                <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
              </ThreadPrimitive.If>
            </>
          )}
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <div className="text-foreground break-words leading-relaxed text-sm">
            <MessagePrimitive.Content components={contentComponents} />
          </div>
          <MessageError />
          <AssistantActionBar />
        </div>
      </div>
      <BranchPicker className="mt-1.5 ml-10" />
    </MessagePrimitive.Root>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <div className="mt-3 rounded-xl bg-destructive/5 border border-destructive/15 p-4 flex flex-col gap-3 items-center text-center">
        <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center ring-1 ring-destructive/20">
          <WarningCircle className="w-5 h-5 text-destructive" weight="fill" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">Generation Failed</p>
          <p className="text-xs text-muted-foreground max-w-[220px] leading-relaxed">
            Something went wrong while generating your design. Please try again.
          </p>
        </div>
        <ActionBarPrimitive.Root className="w-full mt-1">
          <ActionBarPrimitive.Reload asChild>
            <Button
              variant="outline"
              size="sm"
              className="w-full h-8 gap-2 rounded-lg border-destructive/20 bg-destructive/5 text-destructive hover:bg-destructive/10 hover:text-destructive transition-all duration-150 hover:transition-none"
            >
              <ArrowClockwiseIcon className="w-3.5 h-3.5" />
              <span className="text-xs font-medium">Retry Generation</span>
            </Button>
          </ActionBarPrimitive.Reload>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Error>
  );
};

const AssistantActionBar: FC = () => {
  const hidden = useContext(HideMessageActionsContext);
  if (hidden) {
    return null;
  }

  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      autohideFloat="single-branch"
      className="text-muted-foreground flex gap-0.5 -ml-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150 data-[floating]:bg-background/95 data-[floating]:backdrop-blur-sm data-[floating]:absolute data-[floating]:rounded-lg data-[floating]:ring-1 data-[floating]:ring-foreground/[0.06] data-[floating]:p-1 data-[floating]:shadow-md"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy" className="h-7 w-7 rounded-md !text-muted-foreground hover:bg-foreground/[0.05] hover:!text-foreground">
          <MessagePrimitive.If copied>
            <CheckIcon size={14} className="text-green-500" />
          </MessagePrimitive.If>
          <MessagePrimitive.If copied={false}>
            <CopyIcon size={14} />
          </MessagePrimitive.If>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Regenerate" className="h-7 w-7 rounded-md !text-muted-foreground hover:bg-foreground/[0.05] hover:!text-foreground">
          <ArrowClockwiseIcon size={14} />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
    </ActionBarPrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn("text-muted-foreground inline-flex items-center gap-0.5 text-[11px]", className)}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous" className="h-6 w-6 rounded-md hover:bg-foreground/[0.05]">
          <CaretLeftIcon size={12} />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="font-medium tabular-nums px-1">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next" className="h-6 w-6 rounded-md hover:bg-foreground/[0.05]">
          <CaretRightIcon size={12} />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};

const ThreadRunningStatus: FC<{ messages: string[] }> = ({ messages }) => {
  const [index, setIndex] = useState(0);
  const prevMessagesRef = useRef(messages);

  useEffect(() => {
    if (prevMessagesRef.current !== messages) {
      prevMessagesRef.current = messages;
      setIndex(0);
    }
  }, [messages]);

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((prev) => (prev + 1) % messages.length);
    }, 1200);
    return () => clearInterval(interval);
  }, [messages.length]);

  return (
    <div className="flex w-full max-w-[var(--thread-max-width)] py-3">
      <div className="flex items-center gap-3 ml-10">
        <div className="flex gap-1">
          <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
          <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" style={{ animationDelay: "150ms" }} />
          <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" style={{ animationDelay: "300ms" }} />
        </div>
        <span className="text-xs text-muted-foreground transition-opacity duration-300">
          {messages[index]}
        </span>
      </div>
    </div>
  );
};

const CircleStopIcon = ({ className }: { className?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      width="16"
      height="16"
      className={className}
    >
      <rect width="10" height="10" x="3" y="3" rx="2" />
    </svg>
  );
};
