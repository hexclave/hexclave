import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useRef, useState } from "react";
import { Button } from "./design";

export function CopyFullContextButton({ getText, subject }: {
  getText: () => string,
  subject: string,
}) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current != null) clearTimeout(resetTimerRef.current);
  }, []);

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(getText());
    setCopied(true);
    if (resetTimerRef.current != null) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Button
      size="xs"
      onClick={event => {
        event.stopPropagation();
        runAsynchronouslyWithAlert(copy());
      }}
      title={`Copy full ${subject} context for AI`}
      aria-label={`Copy full ${subject} context`}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
