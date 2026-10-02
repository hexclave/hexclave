import { isErrorIngestScrubbedRecord, scrubErrorIngestPayload, type ErrorIngestScrubbedRecord, type ErrorIngestScrubbedValue } from "@/lib/error-ingest";

export function scrubPublicValue(value: unknown): ErrorIngestScrubbedValue | undefined {
  return scrubErrorIngestPayload(value).value;
}

export function scrubPublicText(value: string): string {
  const scrubbed = scrubPublicValue(value);
  return typeof scrubbed === "string" ? scrubbed : "";
}

export function scrubPublicOptionalText(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const scrubbed = scrubPublicValue(value);
  return typeof scrubbed === "string" && scrubbed.length > 0 ? scrubbed : null;
}

export function scrubPublicRecord(value: unknown): ErrorIngestScrubbedRecord {
  const scrubbed = scrubPublicValue(value);
  return isErrorIngestScrubbedRecord(scrubbed) ? scrubbed : {};
}
