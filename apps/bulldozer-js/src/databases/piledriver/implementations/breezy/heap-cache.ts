import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { DatabaseSeq } from "../../../index.js";
import { isPiledriverHeapObjectSymbol, PiledriverHeapObject, PiledriverObject } from "../../index.js";

/**
 * The location is write-side metadata: it lets Piledriver serialize an existing lazy heap object
 * as its original key without loading and rewriting the payload. `seq` proves that the referenced
 * payload is available before a new parent or root becomes visible.
 */
export type PiledriverHeapLocation = { key: ArrayBuffer, seq: DatabaseSeq };

/**
 * Maintains the two independent identity relationships needed by heap references:
 *
 * - object → location is a WeakMap so reserialization can reuse immutable heap records without
 *   retaining application objects.
 * - key → object is a weak read cache so repeated references share one lazy wrapper and one load.
 *
 * Disabling the cache only disables the second relationship. Location tracking remains necessary
 * for structural sharing and causal write ordering.
 */
export function createPiledriverHeapCache(options: {
  disabled: boolean,
  load: (key: ArrayBuffer, keyBase64: string) => Promise<PiledriverObject>,
}) {
  const locations = new WeakMap<PiledriverHeapObject, PiledriverHeapLocation>();
  const objectsByKey = new Map<string, WeakRef<PiledriverHeapObject>>();
  const finalizer = new FinalizationRegistry<string>(key => {
    // A finalizer for an older wrapper must not remove a newer live wrapper for the same key.
    if (objectsByKey.get(key)?.deref() === undefined) objectsByKey.delete(key);
  });
  const keyId = (key: ArrayBuffer) => encodeBase64(new Uint8Array(key));

  const remember = (object: PiledriverHeapObject, location: PiledriverHeapLocation) => {
    // Always retain the write-side relationship, even when read interning is disabled.
    locations.set(object, location);
    if (options.disabled) return;
    const id = keyId(location.key);
    objectsByKey.set(id, new WeakRef(object));
    finalizer.register(object, id);
  };

  const resolve = (key: ArrayBuffer, seq: DatabaseSeq): PiledriverHeapObject => {
    const id = keyId(key);
    const cached = options.disabled ? undefined : objectsByKey.get(id)?.deref();
    if (cached !== undefined) return cached;
    let loading: Promise<PiledriverObject> | undefined;
    const object: PiledriverHeapObject = {
      async get() {
        // Successful loads remain memoized; a transient failure is evicted so callers can retry.
        loading ??= options.load(key, id);
        try {
          return await loading;
        } catch (error) {
          loading = undefined;
          throw error;
        }
      },
      getValueIfLocallyCreated() {
        return { status: "database-reference" };
      },
      [isPiledriverHeapObjectSymbol]: true,
    };
    remember(object, { key, seq });
    return object;
  };

  const forget = (object: PiledriverHeapObject, location: PiledriverHeapLocation) => {
    // Publication failure makes the location unsafe to reuse; retrying must serialize it afresh.
    if (locations.get(object) === location) locations.delete(object);
    const id = keyId(location.key);
    if (objectsByKey.get(id)?.deref() === object) objectsByKey.delete(id);
  };

  return {
    locations,
    objectsByKey,
    getLocation: (object: PiledriverHeapObject) => locations.get(object),
    remember,
    resolve,
    forget,
  };
}
