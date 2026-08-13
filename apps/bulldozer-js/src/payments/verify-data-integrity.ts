import { decodeBase64, encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { deserializeDatabaseSeq, serializeDatabaseSeq } from "../databases/index.js";
import type { BulldozerDatabase } from "../databases/bulldozer/index.js";
import {
  collectSerializedHeapReferences,
  InvalidPiledriverSerializedObjectError,
  isPiledriverHeapObjectSymbol,
  type PiledriverObject,
} from "../databases/piledriver/index.js";

const CURSOR_VERSION = 6;
const DEFAULT_STEP_COUNT = 100;
const MAX_STEP_COUNT = 1_000;
const MAX_ERRORS = 100;
const HEAP_PAGE_SIZE = 100;
const textDecoder = new TextDecoder();
const rootKey = new TextEncoder().encode("bulldozer-database-root").buffer;

export type VerificationIssue = {
  phase: string,
  code: string,
  message: string,
  context?: Record<string, string | number | boolean | null>,
};

type VerificationPhase = "root" | "heap-scan" | "done";
type VerificationCursor = {
  version: number,
  processStartedAtMillis: number,
  root: { bufferBase64: string, seq: string },
  phase: VerificationPhase,
  afterHeapKeyBase64: string | null,
  rootChecked: boolean,
  rootDeserialized: boolean,
  rootReferenceIndex: number,
};

export type VerifyDataIntegrityRequest = { continue?: string, step_count?: number };
export type VerifyDataIntegrityResponse = {
  success: boolean,
  done: boolean,
  next_cursor: string | null,
  steps_taken: number,
  errors: VerificationIssue[],
  errors_truncated: boolean,
  skipped_checks: VerificationIssue[],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && !(isPiledriverHeapObjectSymbol in value);
}

function isPiledriverValue(value: unknown): value is PiledriverObject {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (typeof value === "object" && isPiledriverHeapObjectSymbol in value) return true;
  if (Array.isArray(value)) return value.every(isPiledriverValue);
  return isRecord(value) && Object.values(value).every(isPiledriverValue);
}

function parsePiledriverValue(buffer: ArrayBuffer): PiledriverObject {
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(buffer));
  } catch (error) {
    if (error instanceof SyntaxError) throw new InvalidPiledriverSerializedObjectError();
    throw error;
  }
  if (!isPiledriverValue(value)) throw new InvalidPiledriverSerializedObjectError();
  return value;
}

function keyBytes(value: string): ArrayBuffer {
  return decodeBase64(value).buffer;
}

function keyBase64(value: ArrayBuffer): string {
  return encodeBase64(new Uint8Array(value));
}

function encodeCursor(cursor: VerificationCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function isVerificationPhase(value: unknown): value is VerificationPhase {
  return value === "root" || value === "heap-scan" || value === "done";
}

export function decodeVerificationCursor(value: string): VerificationCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid verification cursor");
  }
  if (!isRecord(parsed) || parsed.version !== CURSOR_VERSION) {
    throw new Error(`Invalid verification cursor version; expected ${CURSOR_VERSION}`);
  }
  if (
    typeof parsed.processStartedAtMillis !== "number"
    || !Number.isSafeInteger(parsed.processStartedAtMillis)
    || parsed.processStartedAtMillis < 0
    || !isRecord(parsed.root)
    || typeof parsed.root.bufferBase64 !== "string"
    || typeof parsed.root.seq !== "string"
    || !isVerificationPhase(parsed.phase)
    || (parsed.afterHeapKeyBase64 !== null && typeof parsed.afterHeapKeyBase64 !== "string")
    || typeof parsed.rootChecked !== "boolean"
    || typeof parsed.rootDeserialized !== "boolean"
    || typeof parsed.rootReferenceIndex !== "number"
    || !Number.isSafeInteger(parsed.rootReferenceIndex)
    || parsed.rootReferenceIndex < 0
  ) throw new Error("Invalid verification cursor state");
  try {
    keyBytes(parsed.root.bufferBase64);
    if (parsed.afterHeapKeyBase64 !== null) keyBytes(parsed.afterHeapKeyBase64);
  } catch {
    throw new Error("Invalid verification cursor state");
  }
  deserializeDatabaseSeq(parsed.root.seq);
  return {
    version: CURSOR_VERSION,
    processStartedAtMillis: parsed.processStartedAtMillis,
    root: { bufferBase64: parsed.root.bufferBase64, seq: parsed.root.seq },
    phase: parsed.phase,
    afterHeapKeyBase64: parsed.afterHeapKeyBase64,
    rootChecked: parsed.rootChecked,
    rootDeserialized: parsed.rootDeserialized,
    rootReferenceIndex: parsed.rootReferenceIndex,
  };
}

function addIssue(issues: VerificationIssue[], issue: VerificationIssue): boolean {
  if (issues.length >= MAX_ERRORS) return false;
  issues.push(issue);
  return true;
}

export async function handleVerifyDataIntegrityRequest(
  body: unknown,
  verify: (request: VerifyDataIntegrityRequest) => Promise<VerifyDataIntegrityResponse>,
): Promise<VerifyDataIntegrityResponse> {
  if (body !== undefined && (typeof body !== "object" || body === null || Array.isArray(body))) {
    throw new StatusError(StatusError.BadRequest, "Expected JSON object body");
  }
  const requestBody = body === undefined ? {} : body;
  const continuation = Reflect.get(requestBody, "continue");
  if (continuation !== undefined && typeof continuation !== "string") {
    throw new StatusError(StatusError.BadRequest, "continue must be a string");
  }
  const stepCount = Reflect.get(requestBody, "step_count");
  if (stepCount !== undefined && (typeof stepCount !== "number" || !Number.isInteger(stepCount) || stepCount <= 0)) {
    throw new StatusError(StatusError.BadRequest, "step_count must be a positive integer");
  }
  if (continuation !== undefined) {
    try {
      decodeVerificationCursor(continuation);
    } catch (error) {
      throw new StatusError(StatusError.BadRequest, error instanceof Error ? error.message : "Invalid verification cursor");
    }
  }
  return await verify({
    ...(continuation === undefined ? {} : { continue: continuation }),
    ...(stepCount === undefined ? {} : { step_count: stepCount }),
  });
}

export async function verifyDataIntegrity(
  bulldozerDb: BulldozerDatabase,
  request: VerifyDataIntegrityRequest,
): Promise<VerifyDataIntegrityResponse> {
  const requestedStepCount = request.step_count ?? DEFAULT_STEP_COUNT;
  if (!Number.isInteger(requestedStepCount) || requestedStepCount <= 0) throw new Error("step_count must be a positive integer");
  const budget = Math.min(requestedStepCount, MAX_STEP_COUNT);
  const errors: VerificationIssue[] = [];
  const skippedChecks: VerificationIssue[] = [];
  let errorsTruncated = false;
  const recordIssue = (issue: VerificationIssue) => {
    if (!addIssue(errors, issue)) errorsTruncated = true;
  };
  const piledriverDatabase = bulldozerDb.getPiledriverDatabase();
  // A pinned root can outlive the process that created the cursor and be collected after restart,
  // so the GC process-start timestamp is the identity that makes a continuation safe to resume.
  const processStartedAtMillis = bulldozerDb.getPiledriverGarbageCollectionProcessStartedAtMillis();
  let cursor: VerificationCursor;
  if (request.continue === undefined) {
    const root = await piledriverDatabase.getSerializedRootObject(rootKey);
    cursor = {
      version: CURSOR_VERSION,
      processStartedAtMillis,
      root: { bufferBase64: keyBase64(root.buffer), seq: serializeDatabaseSeq(root.seq) },
      phase: "root",
      afterHeapKeyBase64: null,
      rootChecked: false,
      rootDeserialized: false,
      rootReferenceIndex: 0,
    };
  } else {
    cursor = decodeVerificationCursor(request.continue);
    if (cursor.processStartedAtMillis !== processStartedAtMillis) {
      throw new StatusError(StatusError.BadRequest, "This verification was started by another Bulldozer process. Restart verification.");
    }
  }

  const rootBuffer = keyBytes(cursor.root.bufferBase64);
  const rootSeq = deserializeDatabaseSeq(cursor.root.seq);
  let rootReferences: string[] = [];
  if (cursor.phase === "root" && !cursor.rootChecked) {
    try {
      rootReferences = collectSerializedHeapReferences(parsePiledriverValue(rootBuffer));
      cursor.rootChecked = true;
    } catch (error) {
      if (error instanceof InvalidPiledriverSerializedObjectError) {
        recordIssue({ phase: "root", code: "invalid_root", message: "The pinned root could not be deserialized" });
        cursor.rootChecked = true;
        cursor.rootDeserialized = true;
        cursor.phase = "heap-scan";
      } else {
        throw error;
      }
    }
  } else if (cursor.phase === "root") {
    rootReferences = collectSerializedHeapReferences(parsePiledriverValue(rootBuffer));
  }

  let remaining = budget;
  while (remaining > 0 && cursor.phase !== "done") {
    const beforeRemaining = remaining;
    const beforePosition = JSON.stringify(cursor);
    if (cursor.phase === "root") {
      if (cursor.rootReferenceIndex < rootReferences.length) {
        const reference = rootReferences[cursor.rootReferenceIndex];
        const heapObject = await piledriverDatabase.getSerializedHeapObject(keyBytes(reference));
        if (heapObject.buffer === null) {
          recordIssue({
            phase: "root",
            code: "dangling_heap_reference",
            message: "A pinned root heap reference is missing",
            context: { referencedKey: reference },
          });
        }
        cursor.rootReferenceIndex++;
        remaining--;
      } else if (!cursor.rootDeserialized) {
        try {
          await piledriverDatabase.deserializeSerializedObject(rootBuffer, rootSeq);
        } catch (error) {
          if (error instanceof InvalidPiledriverSerializedObjectError) {
            recordIssue({ phase: "root", code: "invalid_root", message: "The pinned root could not be deserialized" });
          } else {
            throw error;
          }
        }
        cursor.rootDeserialized = true;
        cursor.phase = "heap-scan";
      } else {
        cursor.phase = "heap-scan";
      }
    } else {
      const page = await piledriverDatabase.listHeapEntries({
        ...(cursor.afterHeapKeyBase64 === null ? {} : { startAfter: keyBytes(cursor.afterHeapKeyBase64) }),
        limit: Math.min(HEAP_PAGE_SIZE, remaining),
      });
      if (page.entries.length === 0) {
        cursor.phase = "done";
      } else {
        for (const entry of page.entries) {
          const entryKey = keyBase64(entry.key);
          cursor.afterHeapKeyBase64 = entryKey;
          remaining--;
          try {
            const serializedValue = parsePiledriverValue(entry.value);
            const references = collectSerializedHeapReferences(serializedValue);
            let allReferencesPresent = true;
            for (const reference of references) {
              const referenced = await piledriverDatabase.getSerializedHeapObject(keyBytes(reference));
              if (referenced.buffer === null) {
                allReferencesPresent = false;
                recordIssue({
                  phase: "heap-scan",
                  code: "dangling_heap_reference",
                  message: "A heap reference points to a missing heap entry",
                  context: { key: entryKey, referencedKey: reference },
                });
              }
            }
            if (allReferencesPresent) await piledriverDatabase.deserializeSerializedObject(entry.value);
          } catch (error) {
            if (error instanceof InvalidPiledriverSerializedObjectError) {
              recordIssue({ phase: "heap-scan", code: "invalid_heap_entry", message: "A heap entry could not be deserialized", context: { key: entryKey } });
            } else {
              throw error;
            }
          }
          if (remaining === 0) break;
        }
      }
    }
    const afterPosition = JSON.stringify(cursor);
    if (remaining === beforeRemaining && afterPosition === beforePosition) {
      throw new Error(`Integrity verifier made no progress in phase ${cursor.phase}`);
    }
  }

  return {
    success: errors.length === 0,
    done: cursor.phase === "done",
    next_cursor: cursor.phase === "done" ? null : encodeCursor(cursor),
    steps_taken: budget - remaining,
    errors,
    errors_truncated: errorsTruncated,
    skipped_checks: skippedChecks,
  };
}
