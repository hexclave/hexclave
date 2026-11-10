"use client";

import { useState } from "react";
import { cn } from "../../../components/design/cn";
import { useScheduledTimeout } from "../../../hooks/useScheduledTimeout";
import { Button } from "../../ui/primitives";

/** Four-up read-out under a detail panel's header (result, score, duration, …). */
export function DetailStats({ items }: { items: ReadonlyArray<{ label: string, value: string, className?: string }> }) {
  return (
    <dl className="grid grid-cols-2 border-y border-border sm:grid-cols-4">
      {items.map(item => (
        <div key={item.label} className="min-w-0 border-border px-5 py-2.5 [&:not(:last-child)]:border-r max-sm:[&:nth-child(2)]:border-r-0 max-sm:[&:nth-child(-n+2)]:border-b">
          <dt className="text-[11px] text-muted-foreground">{item.label}</dt>
          <dd className={cn("mt-0.5 truncate font-mono text-[13px] font-medium tabular-nums", item.className ?? "text-foreground")}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyButton({ getText, label = "Copy", title }: { getText: () => string, label?: string, title?: string }) {
  const [copied, setCopied] = useState(false);
  const scheduleTimeout = useScheduledTimeout();
  return (
    <Button
      icon={copied ? "check" : "copy"}
      title={title}
      onClick={async () => {
        await navigator.clipboard.writeText(getText());
        setCopied(true);
        scheduleTimeout(() => setCopied(false), 1800);
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}
