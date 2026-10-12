// Uploads the packaged source tarball to the presigned object-storage slot.
//
// WHY node:http(s) AND NOT fetch. Global fetch is undici, and undici arms
// `headersTimeout` (300s by default) the moment the request goes on the wire —
// it is a socket READ timeout, and the object store sends nothing until it has
// the whole body, so nothing resets it while the body is still uploading. That
// makes it a wall-clock cap on the entire PUT rather than a cap on waiting for
// a reply: an upload that takes longer than five minutes to push dies with a
// bare `TypeError: fetch failed` on a perfectly healthy connection. At that cap
// a 39 MB source needs a sustained ~1.1 Mbit/s and the 50 MB ceiling needs
// ~1.4 Mbit/s, which is why shrinking a repository "fixed" it for anyone on a
// slower link. node:http has no default client-side timeout, so the deadlines
// below are ours to choose.
//
// The deadline that matters is the SLOT's: the presigned URL expires, and
// nothing can be written to a dead URL, so there is no reason to keep pushing
// past that moment and no reason to give up before it. That budget covers the
// upload as a whole, retries included — see DEFAULT_MAX_ATTEMPTS for why a
// retry re-sends everything rather than resuming.

import http from "node:http";
import https from "node:https";
import { CliError } from "./errors.js";

// Used when the API did not say when the slot expires. Marshal's own
// UPLOAD_EXPIRY_SECONDS; duplicated rather than imported because the CLI takes
// no dependency on the runtime, and it is only a fallback — the real value
// travels with the upload slot.
export const DEFAULT_UPLOAD_DEADLINE_MS = 15 * 60 * 1000;
// Clamps on the deadline the API hands us: a slot that already expired is not a
// reason to skip the attempt entirely (clocks differ), and one that claims to
// last for hours is not a reason to hang for hours.
const MIN_UPLOAD_DEADLINE_MS = 60 * 1000;
const MAX_UPLOAD_DEADLINE_MS = 30 * 60 * 1000;
// No bytes FLUSHED for this long while the body is still being written. Reset
// by every chunk the stream confirms, so "slow" never trips it — only "stopped"
// does: a connection that died without a TCP reset (a suspended laptop, a
// dropped NAT mapping) fails in a minute instead of occupying the whole
// deadline above.
//
// Deliberately armed ONLY while writing. Once the body is out, the client is
// idle by definition — it is waiting for a reply, and the store says nothing
// until it has finished receiving what is still in flight. Timing out THAT
// window on inactivity is precisely undici's headersTimeout bug, which is what
// this module exists to avoid; past the last chunk the deadline is the only
// clock.
const DEFAULT_STALL_TIMEOUT_MS = 60 * 1000;
// The body is handed to the socket in pieces rather than in one call, so that
// backpressure is respected and a failure can say how far it got.
//
// The size is load-bearing for the stall timer, not just for memory: a flush
// callback is the only "still alive" signal there is, so the gap between them
// is CHUNK / throughput, and any link slower than CHUNK / stall-timeout gets
// mistaken for a dead one. At 64 KB and a 60s timeout that floor is ~1.1 KB/s,
// which is dead by any reading. At 1 MB it would be ~17 KB/s — fast enough to
// false-positive on the very slow links this module exists to keep working.
const WRITE_CHUNK_BYTES = 64 * 1024;
// An error body from object storage is XML and small; enough of it to name the
// problem, never enough to be worth streaming.
const MAX_ERROR_BODY_BYTES = 8 * 1024;

// How many times the whole PUT may be re-sent.
//
// WHY THE WHOLE THING AND NOT JUST THE MISSING PART. The slot is a SigV4-signed
// `PutObjectCommand` URL (Marshal's `createUploadSlot`), which is one URL for
// one whole-object PUT. Real multipart needs `CreateMultipartUpload`, a signed
// URL per part carrying `uploadId`/`partNumber`, and `CompleteMultipartUpload`
// — and those query parameters are inside the signature, so a client cannot
// forge them onto this URL. Resuming a part therefore needs Marshal to expose
// multipart; re-sending does not, and is what turns a link that drops one
// connection in six into one that finishes.
//
// Re-sending is safe to do blindly: an aborted PUT stores nothing (the object
// only appears when the store has all of it), and a repeat writes the same key,
// so no attempt can leave a partial or orphaned object behind.
const DEFAULT_MAX_ATTEMPTS = 5;
// Backoff between attempts, doubling. Short at the start because the common
// case is a single dropped connection rather than an outage, and capped so a
// late attempt does not spend more of the deadline waiting than uploading.
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 15 * 1_000;

/**
 * An attempt's failure, and whether re-sending could plausibly do better.
 *
 * Retryable: the connection died, stalled, or the store 5xx'd — none of which
 * the same bytes will provoke again. Not retryable: the deadline (no budget
 * left), a 4xx (a bad signature or an oversize body is deterministic), and a
 * middlebox that answers 2xx without taking the body (re-sending just feeds it
 * again).
 */
class UploadAttemptError extends CliError {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    // Deliberately not a distinct name: this is an implementation detail of the
    // retry loop, and every caller handles it as the CliError it is.
    this.name = "CliError";
  }
}

function retryDelayMs(attempt: number, baseDelayMs: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * 2 ** (attempt - 1));
}

/** What `onRetry` is told, so the CLI can say why it is going round again. */
export type UploadRetryInfo = {
  /** The attempt that just failed, 1-based. */
  attempt: number,
  maxAttempts: number,
  error: CliError,
  delayMs: number,
};

export type UploadSourceOptions = {
  uploadUrl: string,
  contentType: string,
  bytes: Uint8Array,
  /**
   * When the presigned slot expires, as the API reported it. This is the
   * upload's deadline. Null/undefined falls back to DEFAULT_UPLOAD_DEADLINE_MS.
   */
  expiresAtMillis?: number | null,
  /** Overridable for tests; see DEFAULT_STALL_TIMEOUT_MS. */
  stallTimeoutMs?: number,
  /**
   * The deadline to enforce, bypassing `expiresAtMillis` and its clamps.
   * Overridable for tests — the clamp floor is a minute, which no test can wait
   * for, and the deadline's teardown is exactly what needs covering.
   *
   * This is the budget for the upload as a whole, retries included: it is when
   * the slot dies, and no attempt can write to a dead URL.
   */
  deadlineMs?: number,
  /** Total attempts, retries included. Overridable for tests; see DEFAULT_MAX_ATTEMPTS. */
  maxAttempts?: number,
  /** Overridable for tests; see DEFAULT_RETRY_BASE_DELAY_MS. */
  retryBaseDelayMs?: number,
  /** Called before each retry, so the caller can report the wait rather than looking hung. */
  onRetry?: (info: UploadRetryInfo) => void,
};

/**
 * The deadline to enforce, in ms from now.
 *
 * A slot that reads as already expired — or as expiring implausibly soon — is
 * almost always a skewed CLIENT clock, not a dead slot: the slot is minted
 * seconds before the upload with fifteen minutes of life. So that case falls
 * back to the default rather than to the floor. Clamping it to the floor was
 * worse than useless: a laptop resumed from suspend got a SIXTY-SECOND deadline,
 * shorter than if the API had said nothing at all, on exactly the slow upload
 * this module exists to keep alive.
 */
export function uploadDeadlineMs(expiresAtMillis: number | null | undefined, now: number): number {
  if (typeof expiresAtMillis !== "number" || !Number.isFinite(expiresAtMillis)) return DEFAULT_UPLOAD_DEADLINE_MS;
  const remaining = expiresAtMillis - now;
  if (remaining < MIN_UPLOAD_DEADLINE_MS) return DEFAULT_UPLOAD_DEADLINE_MS;
  return Math.min(MAX_UPLOAD_DEADLINE_MS, remaining);
}

/**
 * Whether the deadline really is the moment the slot dies.
 *
 * Only then may a timeout claim the slot expired. On the other two paths — the
 * upper clamp, and the default when the API said nothing — the slot outlives the
 * deadline, and saying otherwise tells the user their upload was impossible when
 * retrying it would have worked.
 */
function deadlineIsSlotExpiry(expiresAtMillis: number | null | undefined, now: number, deadlineMs: number): boolean {
  if (typeof expiresAtMillis !== "number" || !Number.isFinite(expiresAtMillis)) return false;
  return expiresAtMillis - now === deadlineMs;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(millis: number): string {
  // Sub-second gets a decimal: a connection cut at "0s" reads as a bug in the
  // message, and how fast it died is part of the diagnosis.
  if (millis < 1000) return `${(millis / 1000).toFixed(1)}s`;
  const seconds = Math.round(millis / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Throughput as a reader would state it, or null when the sample is too short
 * to mean anything — a socket reset a few hundred milliseconds in "measures"
 * gigabits per second, which is the buffer emptying, not the link.
 */
export function formatRate(bytes: number, millis: number): string | null {
  if (millis < 1000 || bytes <= 0) return null;
  return `${formatBytes(Math.round(bytes / (millis / 1000)))}/s`;
}

/**
 * "12.3 MB of 39.0 MB in 5m00s (about 41.9 KB/s)" — the three numbers that turn
 * a failed upload into a diagnosis: how far it got, how long that took, and
 * therefore whether the connection or the source size is the problem.
 */
function progressSummary(sent: number, total: number, elapsedMillis: number): string {
  const rate = formatRate(sent, elapsedMillis);
  return `${formatBytes(sent)} of ${formatBytes(total)} in ${formatDuration(elapsedMillis)}${rate === null ? "" : ` (about ${rate})`}`;
}

const TOO_LARGE_HINT = "Check your .gitignore/.dockerignore — build outputs and large assets shouldn't be uploaded.";

/** One HTTP exchange against the object store, as the retry loop needs to see it. */
type RequestSpec = {
  url: URL,
  method: "PUT" | "POST" | "DELETE",
  /** Signed into the presigned URL where it matters; null sends no header. */
  contentType: string | null,
  bytes: Uint8Array,
};

/** Everything the retry loop needs that is not the request itself. */
type RetrySettings = {
  deadlineMs: number,
  deadlineAt: number,
  slotExpiryIsTheDeadline: boolean,
  stallTimeoutMs: number,
  maxAttempts: number,
  baseDelayMs: number,
  onRetry?: (info: UploadRetryInfo) => void,
};

type AttemptResult = {
  /** The store's ETag for what it stored — a multipart complete needs it per part. */
  etag: string | null,
  body: string,
};

function transportFor(url: URL): typeof http | typeof https {
  const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
  if (transport === null) {
    throw new CliError("The Hexclave API returned an upload URL with an unsupported protocol.");
  }
  return transport;
}

function parseStoreUrl(rawUrl: string): URL {
  try {
    return new URL(rawUrl);
  } catch {
    throw new CliError("The Hexclave API returned an invalid object-storage upload URL.");
  }
}

/**
 * The one shared budget and the retry policy, derived from a slot's expiry.
 *
 * Computed ONCE per upload, so a multipart upload's parts, its complete and its
 * abort all draw down the same clock rather than each getting a fresh one.
 */
function retrySettingsFor(options: UploadSourceOptions): RetrySettings {
  // Two clocks on purpose. The DEADLINE is derived from a wall-clock instant the
  // server chose (`expires_at_millis`), so it has to be compared against the
  // wall clock. Everything measured here is a duration, so it uses the monotonic
  // one: an upload may legitimately run for fifteen minutes, which is ample room
  // for an NTP step or a resume-from-suspend to invent a negative elapsed time.
  const deadlineWallClock = Date.now();
  const deadlineMs = options.deadlineMs ?? uploadDeadlineMs(options.expiresAtMillis, deadlineWallClock);
  return {
    deadlineMs,
    // The deadline belongs to the upload, not to an attempt: it is when the URL
    // dies, so every retry shares the one budget and the last attempt gets
    // whatever is left of it.
    deadlineAt: performance.now() + deadlineMs,
    slotExpiryIsTheDeadline: options.deadlineMs === undefined
      && deadlineIsSlotExpiry(options.expiresAtMillis, deadlineWallClock, deadlineMs),
    stallTimeoutMs: options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
    maxAttempts: Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    baseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    onRetry: options.onRetry,
  };
}

/**
 * Sends `request`, re-sending it while the failure is one a fresh connection
 * could survive and the shared deadline still has room.
 */
async function sendWithRetry(request: RequestSpec, settings: RetrySettings): Promise<AttemptResult> {
  let lastError: UploadAttemptError | undefined;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= settings.maxAttempts; attempt++) {
    attemptsMade = attempt;
    try {
      return await attemptUpload(request, settings);
    } catch (error) {
      if (!(error instanceof UploadAttemptError)) throw error;
      lastError = error;
      if (!error.retryable || attempt === settings.maxAttempts) break;
      const delayMs = retryDelayMs(attempt, settings.baseDelayMs);
      // Waiting only to run out of clock mid-attempt would replace a useful
      // error with the deadline's, so stop here and report what actually failed.
      if (settings.deadlineAt - performance.now() - delayMs <= 0) break;
      settings.onRetry?.({ attempt, maxAttempts: settings.maxAttempts, error, delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  /* istanbul ignore next -- the loop cannot exit without setting this */
  if (lastError === undefined) throw new CliError("The source upload failed for an unknown reason.");
  // The count is the diagnosis when it is more than one: a link that dropped
  // five connections in a row is a different problem from one that 403'd once.
  throw attemptsMade > 1
    ? new CliError(`${lastError.message}\nGave up after ${attemptsMade} attempts.`)
    : lastError;
}

/**
 * PUTs `bytes` to the presigned URL in ONE request, or throws a CliError that
 * says what went wrong in the terms the user can act on.
 *
 * Every failure path here used to surface as an unwrapped `TypeError: fetch
 * failed` printed by the CLI's top-level handler, which named neither the
 * upload, nor its size, nor the deadline it hit.
 */
export async function uploadSource(options: UploadSourceOptions): Promise<void> {
  const url = parseStoreUrl(options.uploadUrl);
  transportFor(url);
  await sendWithRetry(
    { url, method: "PUT", contentType: options.contentType, bytes: options.bytes },
    retrySettingsFor(options),
  );
}

/** The presigned multipart lifecycle, exactly as the API hands it over. */
export type MultipartUploadSlot = {
  part_size_bytes: number,
  part_urls: string[],
  complete_url: string,
  abort_url: string,
};

export type UploadSourceMultipartOptions = UploadSourceOptions & {
  multipart: MultipartUploadSlot,
  /** Called as each part lands, so a long upload shows progress. */
  onPartUploaded?: (info: { part: number, partCount: number }) => void,
};

// How many parts are in flight at once. Enough to keep a link busy while one
// part is retrying, few enough that a shared uplink is not the bottleneck and a
// failure does not discard much concurrent work.
const PART_CONCURRENCY = 3;

/**
 * Uploads the source in parts, then asks the store to assemble it.
 *
 * WHY THIS EXISTS. A single PUT has to hold one connection for the whole source,
 * so on a link that drops every few seconds a big source can never land — the
 * measured case was a 30 MB tarball against a median connection life of ~9s,
 * which failed 15 attempts out of 15. A part is a fraction of that on the wire
 * and retries on its own, so a drop costs one part rather than everything.
 *
 * Every URL here is presigned, so this talks to the object store directly: no
 * part, complete or abort call goes through the Hexclave API.
 */
export async function uploadSourceMultipart(options: UploadSourceMultipartOptions): Promise<void> {
  const { multipart, bytes, contentType } = options;
  const settings = retrySettingsFor(options);
  const partCount = multipart.part_urls.length;
  const expectedParts = Math.ceil(bytes.byteLength / multipart.part_size_bytes);
  if (partCount !== expectedParts) {
    throw new CliError(`The Hexclave API offered ${partCount} upload parts for a source that needs ${expectedParts}.`);
  }

  const etags = new Array<string | null>(partCount).fill(null);
  let nextPart = 0;
  let uploaded = 0;
  const uploadNextParts = async (): Promise<void> => {
    for (;;) {
      const index = nextPart++;
      if (index >= partCount) return;
      const start = index * multipart.part_size_bytes;
      // subarray, not slice: a view costs nothing, and the tarball is already
      // wholly in memory — copying each part would double the peak.
      const partBytes = bytes.subarray(start, Math.min(start + multipart.part_size_bytes, bytes.byteLength));
      const result = await withPartContext(index + 1, partCount, async () => await sendWithRetry(
        { url: parseStoreUrl(multipart.part_urls[index]), method: "PUT", contentType, bytes: partBytes },
        // Renamed per part so the retry line says which one is going again.
        { ...settings, onRetry: (info) => options.onRetry?.({ ...info, error: prefixPart(index + 1, partCount, info.error) }) },
      ));
      if (result.etag === null) {
        // Without it the part list cannot be assembled, and a complete built
        // from a missing ETag fails far less legibly than this does.
        throw new CliError(`The object store accepted part ${index + 1} of ${partCount} without returning an ETag, so the source cannot be assembled.`);
      }
      etags[index] = result.etag;
      uploaded += 1;
      options.onPartUploaded?.({ part: uploaded, partCount });
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, partCount) }, async () => await uploadNextParts()));
    await completeMultipartUpload(multipart, etags as string[], settings);
  } catch (error) {
    // Best-effort: the parts are billed until something removes them, and the
    // bucket's AbortIncompleteMultipartUpload lifecycle rule is only the
    // backstop for a client that never got the chance to say so.
    await abortMultipartUpload(multipart, settings);
    throw error;
  }
}

/** Runs `body`, tagging whatever it throws with which part failed. */
async function withPartContext<T>(part: number, partCount: number, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof CliError) throw prefixPart(part, partCount, error);
    throw error;
  }
}

function prefixPart(part: number, partCount: number, error: CliError): CliError {
  return new CliError(`Part ${part} of ${partCount}: ${error.message}`);
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => `&#${character.codePointAt(0)};`);
}

/**
 * Asks the store to assemble the parts into the object the deploy will consume.
 *
 * Two traps, both found the hard way against R2: the POST must declare
 * `application/xml` or the store answers 415, and a FAILED assembly can come
 * back as 200 with an `<Error>` document rather than an error status — so the
 * body has to be read on success too.
 */
async function completeMultipartUpload(multipart: MultipartUploadSlot, etags: string[], settings: RetrySettings): Promise<void> {
  const xml = `<CompleteMultipartUpload>${etags
    .map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`)
    .join("")}</CompleteMultipartUpload>`;
  const result = await sendWithRetry({
    url: parseStoreUrl(multipart.complete_url),
    method: "POST",
    contentType: "application/xml",
    bytes: Buffer.from(xml, "utf-8"),
  }, settings);
  if (result.body.includes("<Error>")) {
    throw new CliError(`The object store could not assemble the uploaded source: ${result.body.slice(0, 500)}`);
  }
}

async function abortMultipartUpload(multipart: MultipartUploadSlot, settings: RetrySettings): Promise<void> {
  try {
    await sendWithRetry({
      url: parseStoreUrl(multipart.abort_url),
      method: "DELETE",
      contentType: null,
      bytes: new Uint8Array(0),
    }, { ...settings, maxAttempts: 1, onRetry: undefined });
  } catch {
    // Nothing useful to say and nothing to do: the upload has already failed,
    // and the lifecycle rule sweeps what this would have removed.
  }
}

/**
 * One request. Resolves when the store has confirmed all of it, and otherwise
 * throws an `UploadAttemptError` saying whether going again is worth anything.
 */
async function attemptUpload(request: RequestSpec, settings: RetrySettings): Promise<AttemptResult> {
  const { url: parsedUrl, method, contentType, bytes } = request;
  const { deadlineMs, deadlineAt, slotExpiryIsTheDeadline, stallTimeoutMs } = settings;
  const transport = transportFor(parsedUrl);
  const total = bytes.byteLength;
  const startedAt = performance.now();
  const elapsed = () => performance.now() - startedAt;
  // Bytes the stream has confirmed it flushed, not bytes handed to write() —
  // the difference is a socket buffer, and overstating progress in a timeout
  // message is exactly the wrong direction.
  let sent = 0;

  return await new Promise<AttemptResult>((resolve, reject) => {
    const request = transport.request(parsedUrl, {
      method,
      headers: {
        // Signed into the R2/S3 URL where it is signed at all: it must then
        // match exactly or the store 403s. An abort sends no body and no type.
        ...(contentType === null ? {} : { "content-type": contentType }),
        "content-length": String(total),
      },
    });

    let settled = false;
    // What is LEFT of the shared budget, not the whole of it: an earlier attempt
    // has already spent some, and re-arming the full deadline per attempt would
    // let a retrying upload run for a multiple of the slot's life.
    let deadlineTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      // Never retryable: the budget it names is the whole upload's, so there is
      // nothing left for another attempt to use.
      fail(new UploadAttemptError([
        `Uploading the packaged source timed out after ${formatDuration(deadlineMs)}: ${progressSummary(sent, total, elapsed())}.`,
        slotExpiryIsTheDeadline
          ? `The upload slot expires after that, so a slower upload cannot finish. ${TOO_LARGE_HINT}`
          : `Your connection may be too slow for a source this size. ${TOO_LARGE_HINT}`,
      ].join("\n"), false));
    }, Math.max(0, deadlineAt - performance.now()));
    // Never let the deadline hold the event loop open on its own; the request
    // does that, and the timer is cleared with it.
    deadlineTimer.unref();

    function settle(action: () => void): void {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
      disarmStall();
      action();
    }
    function fail(error: Error): void {
      settle(() => {
        request.destroy();
        reject(error);
      });
    }

    // Armed while writing, disarmed at the last chunk — see DEFAULT_STALL_TIMEOUT_MS.
    // `bodyWritten` is what makes the disarm stick: a chunk's flush callback
    // fires AFTER end() for the final chunk, so without it that callback would
    // re-arm the timer over the response wait and reintroduce the very timeout
    // this module removes.
    let bodyWritten = false;
    let stallTimer: NodeJS.Timeout | undefined;
    function disarmStall(): void {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = undefined;
    }
    function armStall(): void {
      if (settled || bodyWritten) return;
      disarmStall();
      stallTimer = setTimeout(() => {
        // A connection that died without a reset. A fresh one is exactly what it
        // needs, so this is the most retryable failure there is.
        fail(new UploadAttemptError(
          `The source upload stalled: no data was sent for ${formatDuration(stallTimeoutMs)}, after ${progressSummary(sent, total, elapsed())}. Check your network connection and try again.`,
          true,
        ));
      }, stallTimeoutMs);
      stallTimer.unref();
    }

    request.on("error", (error: NodeJS.ErrnoException) => {
      // Reached only for a real transport failure — every deliberate teardown
      // above has already settled, and `settle` makes this a no-op afterwards.
      const code = typeof error.code === "string" ? ` (${error.code})` : "";
      // How far it got is the diagnosis when it got somewhere; on a connection
      // that never opened it is just "0 B of 39.0 MB in 0s", which says nothing.
      const progress = sent === 0 ? "" : ` after ${progressSummary(sent, total, elapsed())}`;
      // Trimmed: OpenSSL's messages end in a newline, which otherwise strands
      // the sentence below on a line of its own starting with a full stop.
      const cause = error.message.trim();
      // A dropped, reset or refused connection — the failure a retry exists for.
      fail(new UploadAttemptError(
        `The source upload failed${code}${progress}: ${cause}. Check your network connection and try again.`,
        true,
      ));
    });

    // Backstop. Everything above settles on `error` or `response`; if the socket
    // were ever to close without either, the promise would stay pending with
    // both timers unref'd and nothing else on the loop — so node would exit 0
    // with no output, and a deploy that uploaded nothing would read as success.
    // No known path reaches this; that is exactly why it is cheap to keep.
    request.on("close", () => {
      fail(new UploadAttemptError(`The source upload connection closed unexpectedly after ${progressSummary(sent, total, elapsed())}. Check your network connection and try again.`, true));
    });

    request.on("response", (response) => {
      const status = response.statusCode ?? 0;
      const ok = status >= 200 && status < 300;
      const chunks: Buffer[] = [];
      let bodyBytes = 0;
      response.on("data", (chunk: Buffer) => {
        // Kept up to the cap whether or not the status is ok: a failure body
        // carries the store's own explanation, and a SUCCESS body matters too —
        // CompleteMultipartUpload answers 200 with an <Error> document when the
        // assembly fails, so discarding it would read as a completed upload.
        if (bodyBytes >= MAX_ERROR_BODY_BYTES) return;
        bodyBytes += chunk.length;
        chunks.push(chunk);
      });
      response.on("error", (error: NodeJS.ErrnoException) => {
        // The body may well be in the store already, but nothing confirmed it,
        // so the only safe reading is "unknown" — and re-sending settles it.
        fail(new UploadAttemptError(`The source upload failed while reading the object store's reply: ${error.message.trim()}.`, true));
      });
      response.on("end", () => {
        if (ok) {
          // A 2xx is only a success if the store has the WHOLE body. A proxy or
          // CDN that answers on headers — an upload cap, a misrouted request —
          // otherwise resolves this in milliseconds having sent a fraction of
          // the tarball, and the deploy carries on against a truncated archive
          // that fails minutes later in the builder, saying nothing about the
          // upload. Destroyed rather than left to the agent pool: the request
          // was never ended, so the socket is not reusable.
          if (!bodyWritten || sent < total) {
            // Not retryable: whatever answered early will answer early again,
            // and each retry would feed it the whole tarball to no purpose.
            fail(new UploadAttemptError(
              `The object store answered ${status} after only ${progressSummary(sent, total, elapsed())} — it did not receive the whole source. Check for a proxy or upload size limit between you and the object store, then try again.`,
              false,
            ));
            return;
          }
          const etag = response.headers.etag;
          settle(() => {
            request.destroy();
            resolve({
              etag: typeof etag === "string" ? etag : null,
              body: Buffer.concat(chunks).toString("utf-8"),
            });
          });
          return;
        }
        const body = Buffer.concat(chunks).toString("utf-8").slice(0, 1000);
        // 5xx and 429 are the store having a moment; a 4xx is the request being
        // wrong (a bad signature, an oversize body) and says the same every time.
        fail(new UploadAttemptError(`Source upload failed (${status} from object storage): ${body}`, status >= 500 || status === 429));
      });
    });

    // Chunked rather than one write() call: it honours backpressure instead of
    // handing the socket up to 50 MB at once, and it is what makes `sent`
    // meaningful when something goes wrong mid-upload.
    let offset = 0;
    function writeNext(): void {
      if (settled) return;
      if (offset >= total) {
        bodyWritten = true;
        disarmStall();
        request.end();
        return;
      }
      const end = Math.min(offset + WRITE_CHUNK_BYTES, total);
      const chunk = bytes.subarray(offset, end);
      offset = end;
      const flushed = request.write(chunk, () => {
        sent = end;
        armStall();
      });
      if (flushed) {
        // Yield rather than recursing: the whole body would otherwise be pushed
        // synchronously, starving the timers and the response handler.
        setImmediate(writeNext);
      } else {
        request.once("drain", writeNext);
      }
    }
    // NOT armed before the first flush: until then nothing has been sent, and a
    // connection that never opens would be reported as a stall "after 0 B of
    // 39.0 MB" — the exact noise the request-error path above strips on purpose.
    // Connecting is the deadline's to bound, not the stall timer's.
    writeNext();
  });
}
