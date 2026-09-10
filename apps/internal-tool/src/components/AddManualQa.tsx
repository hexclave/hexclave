import { useRef, useState } from "react";
import { Alert, Button, FieldLabel, Input, Textarea } from "./design";

export function AddManualQa({ onClose, onSave }: {
  onClose: () => void;
  onSave: (question: string, answer: string, publish: boolean, requestId: string) => Promise<void>;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [saved, setSaved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setTimeout(() => {
        setSaved(false);
        if (publish) {
          onClose();
        }
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-8 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-black/[0.06] bg-popover text-popover-foreground shadow-2xl dark:border-white/[0.08]">
        {/* Header */}
        {/* No close affordance here: the footer's Cancel already dismisses the
            dialog, and two ways out of a short form is one too many. */}
        <div className="border-b border-black/[0.06] px-5 py-3 dark:border-white/[0.06]">
          <h2 className="text-sm font-semibold text-foreground">Add Q&A</h2>
        </div>

        {/* Form */}
        <div className="p-5 space-y-4">
          {saved && (
            <Alert variant="info" className="border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              Saved successfully
            </Alert>
          )}
          {error && (
            <Alert className="px-3 py-1.5 text-xs font-medium">{error}</Alert>
          )}

          <div>
            <FieldLabel className="mb-1 block">Question</FieldLabel>
            <Input
              type="text"
              className="h-9 px-3 text-sm"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. How do I set up OAuth with Hexclave?"
            />
          </div>

          <div>
            <FieldLabel className="mb-1 block">Answer</FieldLabel>
            <Textarea
              className="h-48 resize-y px-3 py-2 font-mono text-sm"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Write the answer (supports markdown)..."
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={() => void handleSave(false)} disabled={!canSave}>
              Save Draft
            </Button>
            <Button variant="default" onClick={() => void handleSave(true)} disabled={!canSave}>
              Save & Publish
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
