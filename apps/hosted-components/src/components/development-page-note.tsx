import { useStackApp } from "@hexclave/react";
import { getCustomPagePrompts } from "@hexclave/shared/dist/interface/handler-urls";
import { Code2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge, Button, CopyButton } from "~/components/ui";

export type DevelopmentPageKey =
  | "signIn"
  | "signUp"
  | "forgotPassword"
  | "passwordReset"
  | "emailVerification"
  | "accountSettings"
  | "mfa"
  | "error"
  | "teamInvitation"
  | "cliAuthConfirm"
  | "agentAuthConfirm"
  | "onboarding";

type DevelopmentPageNoteProps = {
  pageKey?: DevelopmentPageKey,
  pageTitle?: string,
  description?: string,
};

const DISMISSED_STORAGE_KEY = "hexclave-development-page-note-dismissed";

const customPagePrompts = getCustomPagePrompts();

export function DevelopmentPageNote(props: DevelopmentPageNoteProps) {
  const project = useStackApp().useProject();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const noteRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let wasDismissed = false;
    if (typeof window !== "undefined") {
      // Storage may be unavailable in partitioned or third-party browser contexts.
      try {
        wasDismissed = window.sessionStorage.getItem(DISMISSED_STORAGE_KEY) === "true";
      } catch {
        wasDismissed = false;
      }
    }
    setDismissed(wasDismissed);
  }, []);

  useEffect(() => {
    const note = noteRef.current;
    if (note == null) {
      return;
    }

    const root = document.documentElement;
    const updateNoteHeight = () => {
      root.style.setProperty(
        "--hexclave-development-page-note-height",
        `${note.getBoundingClientRect().height}px`,
      );
      root.dataset.hexclaveDevelopmentPageNoteVisible = "true";
    };

    updateNoteHeight();
    if (typeof ResizeObserver === "undefined") {
      return () => {
        root.style.removeProperty("--hexclave-development-page-note-height");
        delete root.dataset.hexclaveDevelopmentPageNoteVisible;
      };
    }

    const observer = new ResizeObserver(updateNoteHeight);
    observer.observe(note);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--hexclave-development-page-note-height");
      delete root.dataset.hexclaveDevelopmentPageNoteVisible;
    };
  }, [dismissed, showPrompt]);

  if (!project.isDevelopmentEnvironment || dismissed !== false) {
    return null;
  }

  const prompt = props.pageKey == null ? null : customPagePrompts[props.pageKey];
  const title = props.pageTitle ?? prompt?.title;
  const description = props.description
    ?? (title == null
      ? "This is Hexclave's default hosted page. Configure your own page to customize this experience."
      : `You’re viewing Hexclave’s default ${title} page. Customize it by pasting the prompt below into your coding agent.`);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-5 sm:pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
      <section
        ref={noteRef}
        aria-label="Development information"
        className="pointer-events-auto max-h-[60vh] w-full max-w-[640px] overflow-hidden rounded-2xl border border-blue-200/70 bg-blue-50/90 p-4 text-foreground shadow-xl shadow-blue-950/[0.08] backdrop-blur-xl animate-in fade-in-0 slide-in-from-bottom-2 duration-200 dark:border-blue-400/[0.22] dark:bg-blue-950/80 dark:shadow-blue-950/40 sm:p-5"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Code2 className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-300" aria-hidden="true" />
              <p className="text-sm font-semibold tracking-tight">Development info</p>
              <Badge
                variant="secondary"
                className="rounded-full border border-blue-200/70 bg-blue-100/60 px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] text-blue-700 dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-200"
              >
                Not visible in production
              </Badge>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground sm:text-sm">
              {description}
            </p>
          </div>
          <Button
            aria-label="Dismiss development information"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground"
            onClick={() => {
              // Storage may be unavailable in partitioned or third-party browser contexts.
              try {
                window.sessionStorage.setItem(DISMISSED_STORAGE_KEY, "true");
              } catch {
                // Keep the dismissal in memory when browser storage is unavailable.
              }
              setDismissed(true);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {prompt != null && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <CopyButton
              aria-label="Copy customization prompt"
              content={prompt.fullPrompt}
              size="sm"
              className="h-8 rounded-lg px-3 text-xs"
            >
              Copy prompt
            </CopyButton>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-lg px-3 text-xs"
              aria-expanded={showPrompt}
              onClick={() => setShowPrompt((current) => !current)}
            >
              {showPrompt ? "Hide prompt" : "Show prompt"}
            </Button>
          </div>
        )}

        {prompt != null && showPrompt && (
          <pre className="mt-4 max-h-[calc(60vh-10rem)] overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-blue-200/70 bg-blue-100/40 p-3 text-[11px] leading-[1.55] text-foreground/80 ring-1 ring-inset ring-blue-200/40 dark:border-blue-400/[0.18] dark:bg-blue-900/30 dark:text-foreground/75 dark:ring-blue-300/[0.08]">
            <code>{prompt.fullPrompt}</code>
          </pre>
        )}
      </section>
    </div>
  );
}
