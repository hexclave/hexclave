import { useState, memo } from "react";
import { clsx } from "clsx";

function CopyBtn({ text, size = "xs" }: { text: string; size?: "xs" | "sm" }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }, (err) => {
          console.error("Clipboard write failed:", err);
        });
      }}
      className={clsx(
        "shrink-0 rounded transition-colors hover:transition-none",
        size === "xs" ? "p-0.5" : "p-1",
        copied ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
      )}
      title={copied ? "Copied!" : "Copy"}
      type="button"
    >
      <span className={clsx("font-mono", size === "xs" ? "text-[10px]" : "text-xs")}>
        {copied ? "✓" : "⎘"}
      </span>
    </button>
  );
}

const InlineCode = memo(function InlineCode({ children }: { children?: React.ReactNode }) {
  const text = String(children || "");
  const isUrl = /^https?:\/\//.test(text);
  const isCommand = /^(npm|npx|pnpm|yarn|curl|git|docker|cd|mkdir|ls|brew|apt|pip)/.test(text);
  const isPath = /^[./~]/.test(text) && text.includes("/");
  const showCopy = isUrl || isCommand || isPath || text.length > 15;

  return (
    <code className="inline-flex max-w-full items-center gap-1 break-all rounded bg-foreground/[0.07] px-1.5 py-0.5 font-mono text-[11px] leading-relaxed">
      <span className={clsx("min-w-0", isUrl ? "text-blue-600 dark:text-blue-400" : "text-foreground")}>
        {text}
      </span>
      {showCopy && <CopyBtn text={text} size="xs" />}
    </code>
  );
});

const CodeBlock = memo(function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const text = String(children || "").replace(/\n$/, "");
  const language = className?.replace("language-", "").toUpperCase() ?? "";

  return (
    <div className="group relative my-2.5 overflow-hidden rounded-lg bg-foreground/[0.04] ring-1 ring-foreground/[0.08]">
      <div className="flex items-center justify-between border-b border-black/[0.06] bg-foreground/[0.03] px-3 py-1.5 dark:border-white/[0.06]">
        <span className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
          {language || "CODE"}
        </span>
        <CopyBtn text={text} size="xs" />
      </div>
      <div className="overflow-x-auto">
        <pre className="p-3 text-[11px] font-mono leading-relaxed">
          <code className="text-foreground">{children}</code>
        </pre>
      </div>
    </div>
  );
});

const SmartLink = memo(function SmartLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  return (
    <a
      href={href}
      className="break-all text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children ?? href ?? ""}
    </a>
  );
});

export const markdownComponents = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-2.5 text-[13px] leading-relaxed text-foreground last:mb-0">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mb-2.5 list-disc space-y-1 pl-4 text-[13px] text-foreground marker:text-muted-foreground">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="mb-2.5 list-decimal space-y-1.5 pl-4 text-[13px] text-foreground marker:text-muted-foreground">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="leading-relaxed pl-0.5">{children}</li>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    if (className) {
      return <CodeBlock className={className}>{children}</CodeBlock>;
    }
    return <InlineCode>{children}</InlineCode>;
  },
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => (
    <em className="italic text-muted-foreground">{children}</em>
  ),
  a: SmartLink,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-2.5 overflow-x-auto rounded-lg ring-1 ring-foreground/[0.08]">
      <table className="w-full text-[11px]">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="border-b border-black/[0.06] bg-foreground/[0.04] dark:border-white/[0.06]">{children}</thead>
  ),
  tbody: ({ children }: { children?: React.ReactNode }) => (
    <tbody className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">{children}</tbody>
  ),
  tr: ({ children }: { children?: React.ReactNode }) => <tr>{children}</tr>,
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-foreground">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-2.5 py-1.5 text-muted-foreground">{children}</td>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="mb-2 mt-3 text-base font-semibold text-foreground first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="mb-1.5 mt-3 text-[14px] font-semibold text-foreground first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mb-1 mt-2.5 text-[13px] font-semibold text-foreground first:mt-0">{children}</h3>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-2 border-l-2 border-purple-500/60 pl-3 italic text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
};
