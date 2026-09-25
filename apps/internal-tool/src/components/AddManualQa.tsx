import { useRef, useState } from "react";
import { clsx } from "clsx";

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
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-8">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900">Add Q&A</h2>
          <button className="text-gray-400 hover:text-gray-600 text-sm" onClick={onClose}>
            close
          </button>
        </div>

        {/* Form */}
        <div className="p-5 space-y-4">
          {saved && (
            <div className="px-3 py-1.5 rounded text-xs font-medium bg-green-50 text-green-700">
              Saved successfully
            </div>
          )}
          {error && (
            <div className="px-3 py-1.5 rounded text-xs font-medium bg-red-50 text-red-700">
              {error}
            </div>
          )}

          <div>
            <label className="text-[10px] uppercase text-gray-400 font-medium mb-1 block tracking-wider">Question</label>
            <input
              type="text"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. How do I set up OAuth with Hexclave?"
            />
          </div>

          <div>
            <label className="text-[10px] uppercase text-gray-400 font-medium mb-1 block tracking-wider">Answer</label>
            <textarea
              className="w-full h-48 px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Write the answer (supports markdown)..."
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSave(false)}
              disabled={!canSave}
              className={clsx(
                "px-3 py-1.5 text-xs font-medium rounded-md",
                canSave ? "text-gray-700 bg-gray-100 hover:bg-gray-200" : "text-gray-400 bg-gray-50 cursor-not-allowed"
              )}
            >
              Save Draft
            </button>
            <button
              onClick={() => void handleSave(true)}
              disabled={!canSave}
              className={clsx(
                "px-3 py-1.5 text-xs font-medium rounded-md",
                canSave ? "text-white bg-blue-600 hover:bg-blue-700" : "text-gray-400 bg-gray-200 cursor-not-allowed"
              )}
            >
              Save & Publish
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
