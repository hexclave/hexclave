/**
 * Helpers for converting a nested value with a loop instead of recursion.
 *
 * A recursive conversion uses one call-stack frame per nesting level, and overflows past a few
 * thousand levels. The exact limit even varies between processes: a warmed-up server could save a
 * value that a freshly started one then couldn't read. So the codec and the write planner instead
 * keep a list of "pending slots": places in an already-created container (array or object) that
 * still need their converted value.
 *
 * Containers are created with every key already present (holding null) before any child is
 * converted, so keys keep their original order even though slots are filled in a different order.
 */

/** Sets an own property, even one named `__proto__` (plain assignment would change the prototype instead). */
export const defineOwnProperty = <Value>(object: { [key: string]: Value }, key: string, value: Value) => {
  if (key === "__proto__") {
    Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
  } else {
    object[key] = value;
  }
};

export type PendingSlot<Input, Output> =
  | { input: Input, containerType: "array", container: Output[], key: number }
  | { input: Input, containerType: "object", container: { [key: string]: Output }, key: string };

export const fillSlot = <Output>(slot: PendingSlot<unknown, Output>, value: Output) => {
  if (slot.containerType === "array") slot.container[slot.key] = value;
  else defineOwnProperty(slot.container, slot.key, value);
};
