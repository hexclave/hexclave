// Stage-1 build-log redaction, shared by the providers (which read the raw logs) and the
// generic layer (which decides what to scrub). In its own module so a provider can import
// it without importing services.ts.
import { redactSecrets } from "./redact.js";

export function redactBuildLogText(text: string, values: string[]): string {
  return redactSecrets(text, values)
    // Presigned URL signatures (the tarball GET) — scrub by shape since the exact URL
    // isn't persisted anywhere Marshal can recompute.
    .replace(/X-Amz-Signature=[A-Za-z0-9%]+/gi, "X-Amz-Signature=<redacted>")
    .replace(/X-Amz-Credential=[A-Za-z0-9%/]+/gi, "X-Amz-Credential=<redacted>");
}

export function redactBuildLogLines(serialOutput: string, values: string[]): string[] {
  // This ordering is a security boundary: multiline values must be removed while they are
  // still contiguous in the original stream, before callers turn it into line records.
  return redactBuildLogText(serialOutput, values).split("\n").filter((line) => line !== "");
}
