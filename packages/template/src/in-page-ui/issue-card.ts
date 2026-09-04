// Shared renderer for Hexclave's in-page issue cards: the modal-style card (plus its minimized pill) that the SDK uses
// to tell developers about problems it cannot recover from, like a broken pushed config or an untrusted auth domain.
// Every issue surface renders the same shape, so the markup, styles and clipboard handling live here and each feature
// only supplies its copy and callbacks.

import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { getInPageUiBaseCSS } from "./base-styles";
import { h, setHtml } from "./dom";
import { HEXCLAVE_LOGO_SVG } from "./logo";

export type IssueCardKind = "error" | "warning";

const COPY_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

export function getIssueCardCSS(scopeSelector: string): string {
  return getInPageUiBaseCSS(scopeSelector) + `
  ${scopeSelector} .hic-backdrop {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.46);
    backdrop-filter: blur(6px);
    overflow: auto;
  }

  ${scopeSelector} .hic-card {
    --hic-status: var(--sdt-error);
    width: min(720px, calc(100vw - 32px));
    max-height: min(640px, calc(100dvh - 48px));
    border: 1px solid color-mix(in srgb, var(--hic-status) 35%, var(--sdt-border));
    border-radius: 18px;
    background: var(--sdt-overlay-bg);
    box-shadow: var(--sdt-shadow);
    backdrop-filter: blur(18px);
    display: flex;
    overflow: hidden;
  }

  ${scopeSelector} .hic-card-warning {
    --hic-status: var(--sdt-warning);
  }

  ${scopeSelector} .hic-card-inner {
    padding: 18px;
    width: 100%;
    overflow: auto;
  }

  ${scopeSelector} .hic-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  ${scopeSelector} .hic-title-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-width: 0;
  }

  ${scopeSelector} .hic-logo {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: var(--hic-status);
    color: white;
    box-shadow: 0 10px 30px color-mix(in srgb, var(--hic-status) 32%, transparent);
  }

  ${scopeSelector} .hic-badge {
    display: inline-flex;
    flex-shrink: 0;
    padding: 2px 6px;
    border-radius: 999px;
    background: var(--hic-status);
    color: white;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  ${scopeSelector} .hic-title {
    color: var(--sdt-text);
    margin-top: 4px;
    font-size: 18px;
    font-weight: 700;
    line-height: 1.25;
  }

  ${scopeSelector} .hic-actions {
    display: flex;
    gap: 4px;
  }

  ${scopeSelector} .hic-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--sdt-border);
    border-radius: 8px;
    background: var(--sdt-bg-elevated);
    color: var(--sdt-text-secondary);
    cursor: pointer;
    font: inherit;
    line-height: 1;
    vertical-align: top;
  }

  ${scopeSelector} .hic-icon-btn svg {
    display: block;
    flex-shrink: 0;
  }

  ${scopeSelector} .hic-text-btn {
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 0 10px;
    width: auto;
    font-size: 12px;
    line-height: 1;
  }

  ${scopeSelector} .hic-icon-btn:hover {
    background: var(--sdt-bg-hover);
    color: var(--sdt-text);
  }

  ${scopeSelector} .hic-body {
    color: var(--sdt-text-secondary);
    font-size: 14px;
    line-height: 1.5;
  }

  ${scopeSelector} .hic-message-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-top: 14px;
    margin-bottom: 8px;
  }

  ${scopeSelector} .hic-message-label {
    color: var(--sdt-text);
    font-size: 12px;
    font-weight: 650;
  }

  ${scopeSelector} .hic-message {
    padding: 12px;
    max-height: min(260px, max(96px, 30dvh));
    overflow: auto;
    border: 1px solid var(--sdt-border-subtle);
    border-radius: 10px;
    background: var(--sdt-bg-subtle);
    color: var(--sdt-text);
    font-family: var(--sdt-font-mono);
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  ${scopeSelector} .hic-fix-list {
    margin: 8px 0 0;
    padding-left: 18px;
    color: var(--sdt-text);
    font-size: 13px;
  }

  ${scopeSelector} .hic-fix-list li + li {
    margin-top: 4px;
  }

  ${scopeSelector} .hic-footer {
    margin-top: 10px;
    color: var(--sdt-text-tertiary);
    font-size: 12px;
  }

  ${scopeSelector} .hic-pill {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px 8px 8px;
    --hic-status: var(--sdt-error);
    border: 1px solid color-mix(in srgb, var(--hic-status) 35%, var(--sdt-border));
    border-radius: 999px;
    background: var(--sdt-overlay-bg);
    box-shadow: var(--sdt-trigger-shadow);
    color: var(--sdt-text);
    cursor: pointer;
    font: inherit;
    backdrop-filter: blur(18px);
  }

  ${scopeSelector} .hic-pill-warning {
    --hic-status: var(--sdt-warning);
  }

  ${scopeSelector} .hic-pill-logo {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 999px;
    background: var(--hic-status);
    color: white;
  }

  @media (max-height: 520px) {
    ${scopeSelector} .hic-backdrop {
      align-items: flex-start;
      padding: 12px;
    }

    ${scopeSelector} .hic-card {
      width: min(720px, calc(100vw - 24px));
      max-height: calc(100dvh - 24px);
    }

    ${scopeSelector} .hic-card-inner {
      padding: 12px;
    }

    ${scopeSelector} .hic-header {
      margin-bottom: 8px;
    }

    ${scopeSelector} .hic-title {
      font-size: 16px;
    }

    ${scopeSelector} .hic-body {
      font-size: 13px;
    }

    ${scopeSelector} .hic-message {
      max-height: max(80px, 24dvh);
    }
  }
`;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  const clipboard: unknown = navigator["clipboard"];
  const writeText = clipboard != null && typeof clipboard === "object"
    ? clipboard["writeText"]
    : null;
  if (typeof writeText === "function") {
    await writeText.call(clipboard, text);
    return;
  }

  const textarea = h("textarea", {
    style: {
      position: "fixed",
      left: "-9999px",
      top: "0",
      opacity: "0",
    },
    readonly: "true",
  });
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("Browser refused to copy the message.");
  }
}

/**
 * A button that copies `getText()` and briefly reports the outcome in its own label. Copying can fail for reasons
 * outside our control (permissions, insecure contexts), so the failure is reported inline instead of being thrown into
 * a click handler where nothing would show it.
 */
function renderCopyButton(options: {
  variant: "icon" | "text",
  title: string,
  ariaLabel: string,
  getText: () => string,
  onCopyError: (error: Error) => void,
}): HTMLElement {
  const idleHtml = options.variant === "text" ? `${COPY_ICON_SVG}Copy` : COPY_ICON_SVG;
  const button = h("button", {
    className: options.variant === "text" ? "hic-icon-btn hic-text-btn" : "hic-icon-btn",
    type: "button",
    title: options.title,
    "aria-label": options.ariaLabel,
    onClick: () => {
      runAsynchronously(async () => {
        await copyTextToClipboard(options.getText());
        button.textContent = options.variant === "text" ? "Copied" : "✓";
        setTimeout(() => setHtml(button, idleHtml), 1500);
      }, {
        noErrorLogging: true,
        onError: (error) => {
          options.onCopyError(error);
          button.textContent = options.variant === "text" ? "Copy failed" : "!";
          setTimeout(() => setHtml(button, idleHtml), 1500);
        },
      });
    },
  });
  setHtml(button, idleHtml);
  return button;
}

export type IssueCardOptions = {
  kind: IssueCardKind,
  /** Short uppercase label in the card's badge, eg. "Config error". */
  badge: string,
  title: string,
  /** One or two sentences on what this means for the running app. */
  bodyText: string,
  messageLabel: string,
  message: string,
  /** Concrete steps the developer should take; rendered as a list above the footer. */
  howToFix?: readonly string[],
  footerText: string,
  ariaLabel: string,
  /** Prompt for the "copy AI prompt" button, ie. the message plus enough context for a coding agent to fix it. */
  aiPrompt: string,
  onCopyError: (error: Error) => void,
  onCopyAiPromptError: (error: Error) => void,
  onMinimize: () => void,
};

export function renderIssueCard(options: IssueCardOptions): HTMLElement {
  const logoSpan = h("span", { className: "hic-logo" });
  setHtml(logoSpan, HEXCLAVE_LOGO_SVG);

  return h("div", { className: "hic-backdrop" },
    h("div", { className: options.kind === "error" ? "hic-card" : "hic-card hic-card-warning", role: "alertdialog", "aria-modal": "true", "aria-label": options.ariaLabel, tabindex: "-1" },
      h("div", { className: "hic-card-inner" },
        h("div", { className: "hic-header" },
          h("div", { className: "hic-title-row" },
            logoSpan,
            h("div", null,
              h("span", { className: "hic-badge" }, options.badge),
              h("div", { className: "hic-title" }, options.title),
            ),
          ),
          h("div", { className: "hic-actions" },
            renderCopyButton({
              variant: "icon",
              title: "Copy AI prompt",
              ariaLabel: `Copy AI prompt for ${options.ariaLabel}`,
              getText: () => options.aiPrompt,
              onCopyError: options.onCopyAiPromptError,
            }),
            h("button", {
              className: "hic-icon-btn",
              type: "button",
              title: "Minimize",
              "aria-label": `Minimize ${options.ariaLabel}`,
              onClick: options.onMinimize,
            }, "–"),
          ),
        ),
        h("div", { className: "hic-body" },
          options.bodyText,
          h("div", { className: "hic-message-header" },
            h("div", { className: "hic-message-label" }, options.messageLabel),
            renderCopyButton({
              variant: "text",
              title: `Copy ${options.messageLabel.toLowerCase()}`,
              ariaLabel: `Copy ${options.ariaLabel} message`,
              getText: () => options.message,
              onCopyError: options.onCopyError,
            }),
          ),
          h("div", { className: "hic-message" }, options.message),
          options.howToFix == null || options.howToFix.length === 0 ? null : h("div", null,
            h("div", { className: "hic-message-header" },
              h("div", { className: "hic-message-label" }, "How to fix"),
            ),
            h("ul",
              { className: "hic-fix-list" },
              ...options.howToFix.map((step) => h("li", null, step)),
            ),
          ),
          h("div", { className: "hic-footer" }, options.footerText),
        ),
      ),
    ),
  );
}

const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export type IssueCardFocusTrap = {
  /**
   * Whatever had focus before the card first appeared. Callers that rebind the trap to a re-rendered card pass it back
   * in, so focus still returns to where the developer left it once the card is gone for good.
   */
  previouslyFocused: HTMLElement | null,
  release: (releaseOptions?: { restoreFocus?: boolean }) => void,
};

/**
 * Keeps keyboard focus inside a mounted card, which claims to be an `aria-modal` alertdialog and therefore has to behave
 * like one: the flow behind the card is dead until the problem is fixed, so tabbing into it would only let a keyboard
 * user wander through a page that cannot work while the card stays invisible to them.
 *
 * Call right after mounting the card, and release the trap when the card is minimized, replaced or removed. Releasing
 * hands focus back to `previouslyFocused` unless `restoreFocus: false` is passed, which is what a caller that is about
 * to rebind the trap to a freshly rendered card wants.
 */
export function trapFocusInIssueCard(cardRoot: HTMLElement, options: {
  moveFocusIntoCard?: boolean,
  previouslyFocused?: HTMLElement | null,
} = {}): IssueCardFocusTrap {
  const previouslyFocused = options.previouslyFocused !== undefined
    ? options.previouslyFocused
    : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const card = cardRoot.querySelector(".hic-card");
  if (!(card instanceof HTMLElement)) return { previouslyFocused, release: () => {} };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const focusable = [...card.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element): element is HTMLElement => element instanceof HTMLElement);
    const first = focusable[0] ?? card;
    const last = focusable[focusable.length - 1] ?? card;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    let target: HTMLElement | null = null;
    if (active == null || !card.contains(active)) {
      // Focus is outside the card (the page moved it, or it never got in): pull it back to the card's near end.
      target = event.shiftKey ? last : first;
    } else if (active === last && !event.shiftKey) {
      target = first;
    } else if (active === first && event.shiftKey) {
      target = last;
    }
    if (target == null) return;
    event.preventDefault();
    target.focus();
  };

  document.addEventListener("keydown", onKeyDown, true);
  if (options.moveFocusIntoCard !== false) {
    card.focus();
  }

  return {
    previouslyFocused,
    release: (releaseOptions) => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (releaseOptions?.restoreFocus === false) return;
      if (previouslyFocused != null && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    },
  };
}

export function renderIssuePill(options: {
  kind: IssueCardKind,
  label: string,
  ariaLabel: string,
  onClick: () => void,
}): HTMLElement {
  const logoSpan = h("span", { className: "hic-pill-logo" });
  setHtml(logoSpan, HEXCLAVE_LOGO_SVG);
  return h("button", {
    className: options.kind === "error" ? "hic-pill" : "hic-pill hic-pill-warning",
    type: "button",
    "aria-label": options.ariaLabel,
    onClick: options.onClick,
  },
    logoSpan,
    h("span", null, options.label),
  );
}
