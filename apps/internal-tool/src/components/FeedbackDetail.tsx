import { format } from "date-fns";
import type { FeedbackLogRow, McpCallLogRow } from "../types";
import { toDate } from "../utils";

function Field({ label, value }: { label: string, value: string | null | undefined }) {
  if (value == null || value === "") return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-32 shrink-0 text-gray-400">{label}</span>
      <span className="flex-1 min-w-0 break-words font-mono text-gray-700">{value}</span>
    </div>
  );
}

export function FeedbackDetail({
  row,
  relatedCall,
  onClose,
  onOpenRelatedCall,
}: {
  row: FeedbackLogRow,
  relatedCall: McpCallLogRow | null,
  onClose: () => void,
  onOpenRelatedCall: (call: McpCallLogRow) => void,
}) {
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-gray-900">{row.category}</div>
          <div className="text-[10px] text-gray-400 tabular-nums">
            {format(toDate(row.createdAt), "yyyy-MM-dd HH:mm:ss")}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 text-xs transition-colors hover:transition-none"
        >
          Close
        </button>
      </div>

      <div className="whitespace-pre-wrap break-words rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-800">
        {row.message}
      </div>

      {row.conversationId != null && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-gray-400">Related conversation</div>
          {relatedCall != null ? (
            <button
              onClick={() => onOpenRelatedCall(relatedCall)}
              className="w-full text-left rounded border border-gray-200 px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50 transition-colors hover:transition-none"
            >
              <span className="font-mono text-[10px] text-gray-400">{relatedCall.toolName}</span>
              <span className="block truncate">{relatedCall.question}</span>
            </button>
          ) : (
            <div className="rounded border border-dashed border-gray-200 px-2 py-1.5 font-mono text-[10px] text-gray-400">
              {row.conversationId} (not in the live call log window)
            </div>
          )}
        </div>
      )}

      <div className="space-y-1 border-t border-gray-100 pt-3">
        <Field label="correlationId" value={row.correlationId} />
        <Field label="conversationId" value={row.conversationId} />
        <Field label="transport" value={row.transport} />
        <Field label="requestIp" value={row.requestIp} />
        <Field label="requestIpSource" value={row.requestIpSource} />
        <Field label="requestHost" value={row.requestHost} />
        <Field label="mcpProtocolVersion" value={row.mcpProtocolVersion} />
        <Field label="userAgent" value={row.userAgent} />
      </div>
    </div>
  );
}
