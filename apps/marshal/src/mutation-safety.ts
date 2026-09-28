// A new reconciliation owner waits longer than the maximum lifetime of a provider write.
// Therefore, a request issued by an expired owner must finish or be aborted before the
// replacement owner can begin mutating the same service.
export const PROVIDER_MUTATION_TIMEOUT_MS = 30_000;
export const RECONCILIATION_TAKEOVER_GRACE_MS = PROVIDER_MUTATION_TIMEOUT_MS + 5_000;

// Reads get their own, longer bound. They are not covered by the takeover grace above (a read
// changes nothing, so a stale owner's read is harmless), but they must still be bounded: a
// read stalled on a dead connection holds the reconciliation lease for as long as it hangs,
// which blocks every later deploy of that service behind a request nobody can observe.
//
// Above 60s deliberately: provider operations and their response delivery can span a minute,
// seconds, so a shorter timeout would abort legitimate waits.
export const PROVIDER_READ_TIMEOUT_MS = 75_000;

export class MutationOutcomeUnknownError extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options);
    this.name = "MutationOutcomeUnknownError";
  }
}
