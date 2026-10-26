import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { isPiledriverHeapObjectSymbol, PiledriverHeapObject, PiledriverObject } from "../../index.js";
import { cannotSaveError, unsavableTypeName } from "../../savable-values.js";
import { plannedHeapReference, PlannedPiledriverObject } from "./codec.js";
import { defineOwnProperty, fillSlot, type PendingSlot } from "./pending-slots.js";

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

  /**
   * Copies a value, replacing each heap object in it with a key reference (without entering them).
   *
   * Walks with a loop (see pending-slots.ts) in the same order recursion would: children are pushed
   * in reverse so the first one is converted first, and heap objects are found in reading order.
   * A "leave" step, pushed before an object's children, takes it off the current path once all of
   * them are done, so only a real cycle (an object inside itself) is reported, not sharing.
   */
  const replaceHeapObjectsWithKeyReferences = (value: PiledriverObject, newHeapObjectsFound: PiledriverHeapObject[]): PlannedPiledriverObject => {
    type Step =
      | { kind: "convert", slot: PendingSlot<PiledriverObject, PlannedPiledriverObject> }
      | { kind: "leave", plainObject: object };
    const root: PlannedPiledriverObject[] = [null];
    const steps: Step[] = [{ kind: "convert", slot: { input: value, containerType: "array", container: root, key: 0 } }];
    const plainObjectsOnCurrentPath = new Set<object>();
    for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
      if (step.kind === "leave") {
        plainObjectsOnCurrentPath.delete(step.plainObject);
        continue;
      }
      const { slot } = step;
      const input = slot.input;
      // A backstop for writes that don't come through Bulldozer's checked entry points.
      const unsavableType = unsavableTypeName(input);
      if (unsavableType !== null) throw cannotSaveError(unsavableType);
      if (input === null || typeof input !== "object") {
        fillSlot(slot, input);
        continue;
      }
      if (isPiledriverHeapObjectSymbol in input) {
        fillSlot(slot, keyReferenceFor(input, newHeapObjectsFound));
        continue;
      }
      if (plainObjectsOnCurrentPath.has(input)) throw new Error("Piledriver objects must not contain cycles");
      plainObjectsOnCurrentPath.add(input);
      steps.push({ kind: "leave", plainObject: input });
      if (Array.isArray(input)) {
        const items: PlannedPiledriverObject[] = input.map(() => null);
        fillSlot(slot, items);
        for (let i = input.length - 1; i >= 0; i--) steps.push({ kind: "convert", slot: { input: input[i], containerType: "array", container: items, key: i } });
      } else {
        const keys = Object.keys(input);
        const object: { [key: string]: PlannedPiledriverObject } = {};
        for (const key of keys) defineOwnProperty(object, key, null);
        fillSlot(slot, object);
        for (let i = keys.length - 1; i >= 0; i--) steps.push({ kind: "convert", slot: { input: input[keys[i]], containerType: "object", container: object, key: keys[i] } });
      }
    }
    return root[0];
  };

  // Pushed in reverse so the first heap object found is popped (prepared) first.
  const pushPrepareSteps = (heapObjectsToPrepare: PiledriverHeapObject[]) => {
    for (let i = heapObjectsToPrepare.length - 1; i >= 0; i--) {
      planningStack.push({ kind: "prepare-value", heapObject: heapObjectsToPrepare[i] });
    }
  };

  const newHeapObjectsInRoot: PiledriverHeapObject[] = [];
  const plannedRoot = replaceHeapObjectsWithKeyReferences(root, newHeapObjectsInRoot);
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
    const preparedValue = replaceHeapObjectsWithKeyReferences(state.originalValue, newHeapObjectsInValue);
    // "mark-done" goes below the children, so it's popped only after all of them are done.
    planningStack.push({ kind: "mark-done", heapObject: step.heapObject, preparedValue });
    pushPrepareSteps(newHeapObjectsInValue);
  }

  return { root: plannedRoot, heapObjects, dependencies: [...dependencies] };
}
