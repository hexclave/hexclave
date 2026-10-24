import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { isPiledriverHeapObjectSymbol, PiledriverHeapObject, PiledriverObject } from "../../index.js";
import { cannotSaveError, unsavableTypeName } from "../../savable-values.js";
import { plannedHeapReference, PlannedPiledriverObject } from "./codec.js";

export type PlannedHeapObject = {
  object: PiledriverHeapObject,
  key: ArrayBuffer,
  value: PlannedPiledriverObject,
};

export type HeapObjectPlan<Dependency> = {
  root: PlannedPiledriverObject,
  heapObjects: PlannedHeapObject[],
  dependencies: Dependency[],
};

const defineOwn = (object: { [key: string]: PlannedPiledriverObject }, key: string, value: PlannedPiledriverObject) => {
  if (key === "__proto__") {
    Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
  } else {
    object[key] = value;
  }
};

/**
 * Prepares a value for saving by replacing every heap object in it with a reference to its key.
 *
 * A heap object (made with `asHeapObject`) is a value that's saved as its own database entry; its
 * parent stores only the child's key, like a pointer. Heap objects that are already saved are
 * replaced with their existing key without being loaded. New ones get a freshly reserved key, and
 * their own values are prepared the same way and returned in `heapObjects`, children before parents.
 *
 * New heap objects are handled depth-first with an explicit stack instead of recursion, so one write
 * can create an arbitrarily deep chain of them without overflowing the call stack. Recursion is kept
 * only for plain arrays and objects nested inside a single heap object's value.
 */
export function planHeapObjects<Dependency>(
  root: PiledriverObject,
  locateKnown: (object: PiledriverHeapObject) => { key: ArrayBuffer, dependency: Dependency } | undefined,
  reserveKey: () => ArrayBuffer,
): HeapObjectPlan<Dependency> {
  type NewHeapObjectPlanningState = {
    reservedKeyReference: ReturnType<typeof plannedHeapReference>,
    originalValue: PiledriverObject,
    // "in-progress": its value has been prepared, but not every new heap object inside it yet. So it's
    // an ancestor of whatever is being prepared now, and meeting it again means it contains itself.
    status: "not-started" | "in-progress" | "done",
  };
  const newHeapObjectToPlanningState = new Map<PiledriverHeapObject, NewHeapObjectPlanningState>();
  const dependencies = new Set<Dependency>();
  const heapObjects: PlannedHeapObject[] = [];
  type PlanningStep =
    | { kind: "prepare-value", heapObject: PiledriverHeapObject }
    | { kind: "mark-done", heapObject: PiledriverHeapObject, preparedValue: PlannedPiledriverObject };
  const planningStack: PlanningStep[] = [];

  /**
   * Returns the key reference that replaces `heapObject` in its parent's saved value. New heap
   * objects that still need preparing are appended to `newHeapObjectsFound`.
   */
  const keyReferenceFor = (heapObject: PiledriverHeapObject, newHeapObjectsFound: PiledriverHeapObject[]) => {
    const known = locateKnown(heapObject);
    if (known !== undefined) {
      dependencies.add(known.dependency);
      return plannedHeapReference(known.key);
    }

    let state = newHeapObjectToPlanningState.get(heapObject);
    if (state === undefined) {
      const localValue = heapObject.getValueIfLocallyCreated();
      if (localValue.status === "database-reference") {
        throw new Error("Cannot write a heap object read from another Piledriver database");
      }
      state = { reservedKeyReference: plannedHeapReference(reserveKey()), originalValue: localValue.value, status: "not-started" };
      newHeapObjectToPlanningState.set(heapObject, state);
    }
    if (state.status === "in-progress") throw new Error("Piledriver objects must not contain cycles (found a cycle of heap objects)");
    // Also report heap objects that were found earlier but not started yet: they must be prepared
    // beneath this parent, as recursion would, or a cycle through them would go unnoticed.
    if (state.status === "not-started") newHeapObjectsFound.push(heapObject);
    return state.reservedKeyReference;
  };

  /** Copies a value, replacing each heap object in it with a key reference (without entering them). */
  const replaceHeapObjectsWithKeyReferences = (
    value: PiledriverObject,
    newHeapObjectsFound: PiledriverHeapObject[],
    plainObjectsOnCurrentPath: Set<object>,
  ): PlannedPiledriverObject => {
    // A backstop for writes that don't come through Bulldozer's checked entry points.
    const unsavableType = unsavableTypeName(value);
    if (unsavableType !== null) throw cannotSaveError(unsavableType);
    if (value === null || typeof value !== "object") return value;
    if (isPiledriverHeapObjectSymbol in value) return keyReferenceFor(value, newHeapObjectsFound);

    if (plainObjectsOnCurrentPath.has(value)) throw new Error("Piledriver objects must not contain cycles");
    plainObjectsOnCurrentPath.add(value);
    let result: PlannedPiledriverObject;
    if (Array.isArray(value)) {
      result = [];
      for (const child of value) result.push(replaceHeapObjectsWithKeyReferences(child, newHeapObjectsFound, plainObjectsOnCurrentPath));
    } else {
      const object: { [key: string]: PlannedPiledriverObject } = {};
      for (const key of Object.keys(value)) {
        defineOwn(object, key, replaceHeapObjectsWithKeyReferences(value[key], newHeapObjectsFound, plainObjectsOnCurrentPath));
      }
      result = object;
    }
    plainObjectsOnCurrentPath.delete(value);
    return result;
  };

  // Pushed in reverse so the first heap object found is popped (prepared) first.
  const pushPrepareSteps = (heapObjectsToPrepare: PiledriverHeapObject[]) => {
    for (let i = heapObjectsToPrepare.length - 1; i >= 0; i--) {
      planningStack.push({ kind: "prepare-value", heapObject: heapObjectsToPrepare[i] });
    }
  };

  const newHeapObjectsInRoot: PiledriverHeapObject[] = [];
  const plannedRoot = replaceHeapObjectsWithKeyReferences(root, newHeapObjectsInRoot, new Set());
  pushPrepareSteps(newHeapObjectsInRoot);

  for (let step = planningStack.pop(); step !== undefined; step = planningStack.pop()) {
    const state = newHeapObjectToPlanningState.get(step.heapObject) ?? throwErr("Every heap object on the planning stack must have a planning state");
    if (step.kind === "mark-done") {
      state.status = "done";
      heapObjects.push({ object: step.heapObject, key: state.reservedKeyReference.key, value: step.preparedValue });
      continue;
    }
    // A heap object can be pushed more than once; only its first visit prepares it.
    if (state.status === "done") continue;

    state.status = "in-progress";
    const newHeapObjectsInValue: PiledriverHeapObject[] = [];
    const preparedValue = replaceHeapObjectsWithKeyReferences(state.originalValue, newHeapObjectsInValue, new Set());
    // "mark-done" goes below the children, so it's popped only after all of them are done.
    planningStack.push({ kind: "mark-done", heapObject: step.heapObject, preparedValue });
    pushPrepareSteps(newHeapObjectsInValue);
  }

  return { root: plannedRoot, heapObjects, dependencies: [...dependencies] };
}
