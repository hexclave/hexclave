import { throwErr } from "@hexclave/shared/dist/utils/errors";

const EVENT_ID_RE = /^[0-9a-f]{32}$/;

export function getErrorAttachmentEventId(occurrenceId: string): string {
  return EVENT_ID_RE.test(occurrenceId)
    ? occurrenceId
    : throwErr(`Occurrence id ${JSON.stringify(occurrenceId)} is not a 32-hex event id; ingest derives every occurrence id from the client event id or a SHA-256 digest, so this row was written by a broken writer`);
}
