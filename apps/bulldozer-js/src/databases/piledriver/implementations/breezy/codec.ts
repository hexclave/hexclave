/**
 * Piledriver's persisted wire codec.
 *
 * The tagged JSON representation is part of the database format, not merely an implementation
 * detail. Existing databases contain these values, so changing a tag or its shape requires an
 * explicit compatibility plan. Heap storage is deliberately injected through callbacks: this
 * module defines the format while the database implementation owns IO and sequence ordering.
 */
import { decodeBase64, encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { captureError, HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { PiledriverHeapObject, PiledriverObject } from "../../index.js";
import { defineOwnProperty, fillSlot, type PendingSlot } from "./pending-slots.js";

const encoder = new TextEncoder();
// Piledriver only ever writes valid UTF-8, so the strict decoder fails only on bytes that changed after
// they were written. The forgiving one replaces such bytes with U+FFFD instead of failing.
const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const forgivingDecoder = new TextDecoder();
const isPlannedHeapReferenceSymbol = Symbol("piledriver-planned-heap-reference");

type PlannedHeapReference = {
  key: ArrayBuffer,
  [isPlannedHeapReferenceSymbol]: true,
};

export type PlannedPiledriverObject =
  | string
  | number
  | boolean
  | null
  | PlannedPiledriverObject[]
  | { [key: string]: PlannedPiledriverObject }
  | PlannedHeapReference;

export function plannedHeapReference(key: ArrayBuffer): PlannedHeapReference {
  return { key, [isPlannedHeapReferenceSymbol]: true };
}

export function plannedHeapReferenceKeys(value: PlannedPiledriverObject): ArrayBuffer[] {
  const references: ArrayBuffer[] = [];
  const pending: PlannedPiledriverObject[] = [value];
  while (pending.length !== 0) {
    const node = pending.pop();
    if (node === undefined || node === null || typeof node !== "object") continue;
    if (isPlannedHeapReferenceSymbol in node) {
      references.push(node.key);
    } else if (Array.isArray(node)) {
      for (const child of node) pending.push(child);
    } else {
      for (const child of Object.values(node)) pending.push(child);
    }
  }
  return references;
}

/**
 * What to do when `bulldozer-js:piledriver-damaged-stored-value` is reported. Sent with the report so
 * the alert itself says how to act on it.
 */
const howToFixDamagedStoredValue = [
  "1. Many reports at once, right after a deploy or config change: LMDB compression probably doesn't match how the database was written. Restore the previous HEXCLAVE_BULLDOZER_JS_LMDB_COMPRESSION setting and restart.",
  "2. A few reports: the stored bytes were damaged. Payments data comes from Postgres, so re-run apps/backend/scripts/bulldozer-payments-init.ts for the affected tenancy; it rewrites the rows, which replaces the damaged value.",
  "3. Run POST /internal/payments/verify-data-integrity to check for other damaged values, and check the VM's disk and logs for I/O or MDB_* errors.",
];

/**
 * Turns stored bytes into the JSON value they hold. `storedAt` says where the bytes came from, for
 * error reports.
 *
 * Bytes that aren't valid UTF-8 are reported and then read with the bad bytes replaced, so the rest of
 * the value stays readable while someone repairs it. Bytes that aren't valid JSON can't be read at all,
 * so that fails, naming the likely cause.
 */
function parseStoredJson(buffer: ArrayBuffer, storedAt: string): unknown {
  let text: string;
  try {
    text = strictDecoder.decode(buffer);
  } catch (error) {
    // The strict decoder signals invalid UTF-8 with a TypeError; anything else is unexpected.
    if (!(error instanceof TypeError)) throw error;
    captureError("bulldozer-js:piledriver-damaged-stored-value", new HexclaveAssertionError(
      `Stored Piledriver value at ${storedAt} is not valid UTF-8: it was damaged after it was written, or LMDB compression doesn't match how it was written. Serving it with the bad bytes replaced`,
      { storedAt, byteLength: buffer.byteLength, howToFix: howToFixDamagedStoredValue },
    ));
    text = forgivingDecoder.decode(buffer);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    // JSON.parse signals malformed input with a SyntaxError; anything else is unexpected.
    if (!(error instanceof SyntaxError)) throw error;
    throw new HexclaveAssertionError(
      `Stored Piledriver value at ${storedAt} is not valid JSON. If many values fail like this, the database was probably written with LMDB compression on and is being read with it off; otherwise the value was damaged`,
      { storedAt, byteLength: buffer.byteLength, howToFix: howToFixDamagedStoredValue, cause: error },
    );
  }
}

/**
 * Decodes one stored value without loading referenced heap payloads.
 *
 * `resolveHeapObject` must return a lazy wrapper for a key. Keeping resolution synchronous here
 * ensures that reading a root only parses the root buffer; heap IO happens later through
 * `PiledriverHeapObject.get()`.
 */
export function decodePiledriverObject(
  buffer: ArrayBuffer,
  resolveHeapObject: (key: ArrayBuffer) => PiledriverHeapObject,
  storedAt: string,
): PiledriverObject {
  // JSON.parse itself doesn't recurse in V8, so only the conversion below needs to avoid it.
  const root: PiledriverObject[] = [null];
  const pending: PendingSlot<unknown, PiledriverObject>[] = [{ input: parseStoredJson(buffer, storedAt), containerType: "array", container: root, key: 0 }];
  while (pending.length > 0) {
    const slot = pending.pop() ?? throwErr("pending is non-empty");
    const value = slot.input;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fillSlot(slot, value);
    } else if (Array.isArray(value)) {
      // Every real array is tagged, leaving singleton arrays available for special numeric values.
      const tag: unknown = value[0];
      const payload: unknown = value[1];
      if (tag === "array" && value.length === 2 && Array.isArray(payload)) {
        const result: PiledriverObject[] = payload.map(() => null);
        fillSlot(slot, result);
        for (let i = 0; i < payload.length; i++) pending.push({ input: payload[i], containerType: "array", container: result, key: i });
      } else if (tag === "heap-reference" && value.length === 2 && typeof payload === "string") {
        fillSlot(slot, resolveHeapObject(decodeBase64(payload).buffer));
      } else if (value.length === 1 && tag === "NaN") {
        fillSlot(slot, NaN);
      } else if (value.length === 1 && tag === "Infinity") {
        fillSlot(slot, Infinity);
      } else if (value.length === 1 && tag === "-Infinity") {
        fillSlot(slot, -Infinity);
      } else if (value.length === 1 && tag === "-0") {
        fillSlot(slot, -0);
      } else {
        throw new Error("Assertion error: Invalid serialized Piledriver tagged value");
      }
    } else if (typeof value === "object") {
      const result: { [key: string]: PiledriverObject } = {};
      fillSlot(slot, result);
      for (const [key, child] of Object.entries(value)) {
        defineOwnProperty(result, key, null);
        pending.push({ input: child, containerType: "object", container: result, key });
      }
    } else {
      throw new Error(`Assertion error: Invalid serialized Piledriver value: ${typeof value}`);
    }
  }
  return root[0];
}

/**
 * Encodes one planned value whose heap objects have already been replaced by key references.
 *
 * Planning owns traversal, cycle detection, key assignment, and causal dependencies. Keeping those
 * concerns out of the codec makes this operation a synchronous conversion to the persisted format.
 *
 * Writes the JSON text itself, with a loop, instead of calling JSON.stringify on the whole value:
 * JSON.stringify recurses, and the depth where it overflows differs by machine (~6,000 levels on an
 * M-series Mac, under 5,000 on Linux CI). Only single strings, numbers and keys go through
 * JSON.stringify, so the text is exactly what JSON.stringify would have written.
 */
export function encodePiledriverObject(value: PlannedPiledriverObject): ArrayBuffer {
  // A step is either a value still to be written, or punctuation to write once the values before it
  // are. Steps are popped from the end, so a container's parts are pushed last part first.
  type Step = { kind: "value", value: PlannedPiledriverObject } | { kind: "text", text: string };
  const comma: Step = { kind: "text", text: "," };
  const steps: Step[] = [{ kind: "value", value }];
  let text = "";
  for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
    if (step.kind === "text") {
      text += step.text;
      continue;
    }
    const node = step.value;
    if (typeof node === "number") {
      // JSON would otherwise collapse NaN/infinities to null and -0 to 0.
      if (Number.isFinite(node) && !Object.is(node, -0)) text += JSON.stringify(node);
      else text += JSON.stringify([Object.is(node, -0) ? "-0" : node.toString()]);
    } else if (node === null || typeof node === "string" || typeof node === "boolean") {
      text += JSON.stringify(node);
    } else if (isPlannedHeapReferenceSymbol in node) {
      text += JSON.stringify(["heap-reference", encodeBase64(new Uint8Array(node.key))]);
    } else if (Array.isArray(node)) {
      // Every real array is tagged: ["array", [items]].
      text += '["array",[';
      steps.push({ kind: "text", text: "]]" });
      for (let i = node.length - 1; i >= 0; i--) {
        steps.push({ kind: "value", value: node[i] });
        if (i > 0) steps.push(comma);
      }
    } else {
      const keys = Object.keys(node);
      text += "{";
      steps.push({ kind: "text", text: "}" });
      for (let i = keys.length - 1; i >= 0; i--) {
        steps.push({ kind: "value", value: node[keys[i]] });
        steps.push({ kind: "text", text: `${i > 0 ? "," : ""}${JSON.stringify(keys[i])}:` });
      }
    }
  }
  return encoder.encode(text).buffer;
}
