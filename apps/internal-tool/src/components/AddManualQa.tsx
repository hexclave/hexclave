import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useId, useRef, useState } from "react";
import { useScheduledTimeout } from "../hooks/useScheduledTimeout";
import { Alert, Button, FieldLabel, Input, ModalDialog, Textarea } from "./design";

const SAVED_FLASH_MS = 1500;

export function AddManualQa({ onClose, onSave }: {
  onClose: () => void;
  onSave: (question: string, answer: string, publish: boolean, requestId: string) => Promise<void>;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [saved, setSaved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const scheduleTimeout = useScheduledTimeout();

  const pendingRequestIdRef = useRef<string | null>(null);

  const canSave = question.trim().length > 0 && answer.trim().length > 0 && !isSaving;

  const handleSave = async (publish: boolean) => {
    if (!canSave) return;
    setIsSaving(true);
    setError(null);
    if (pendingRequestIdRef.current == null) {
      pendingRequestIdRef.current = crypto.randomUUID();
    }
    const requestId = pendingRequestIdRef.current;
    try {
      await onSave(question.trim(), answer.trim(), publish, requestId);
      pendingRequestIdRef.current = null;
      setQuestion("");
      setAnswer("");
      setSaved(true);
      scheduleTimeout(() => {
        setSaved(false);
        if (publish) {
          onClose();
        }
      }, SAVED_FLASH_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <ModalDialog labelledBy={titleId} onClose={onClose}>
      {/* Header */}
      {/* No close affordance here: the footer's Cancel already dismisses the
          dialog, and two ways out of a short form is one too many. */}
      <div className="border-b border-black/[0.06] px-5 py-3 dark:border-white/[0.06]">
        <h2 id={titleId} className="text-sm font-semibold text-foreground">Add Q&A</h2>
      </div>

      {/* Form */}
      <div className="p-5 space-y-4">
        {saved && (
          <Alert variant="success" size="sm">Saved successfully</Alert>
        )}
        {error != null && (
          <Alert size="sm">{error}</Alert>
        )}

        <label className="block">
          <FieldLabel className="mb-1 block">Question</FieldLabel>
          <Input
            type="text"
            autoFocus
            className="h-9 px-3 text-sm"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. How do I set up OAuth with Hexclave?"
          />
        </label>

        <label className="block">
          <FieldLabel className="mb-1 block">Answer</FieldLabel>
          <Textarea
            className="h-48 resize-y px-3 py-2 font-mono text-sm"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Write the answer (supports markdown)..."
          />
        </label>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => runAsynchronously(handleSave(false))} disabled={!canSave}>
            Save Draft
          </Button>
          <Button variant="default" onClick={() => runAsynchronously(handleSave(true))} disabled={!canSave}>
            Save & Publish
          </Button>
        </div>
      </div>
    </ModalDialog>
  );
}
