import { describe, expect, it } from "vitest";
import { isPiledriverHeapObjectSymbol, PiledriverHeapObject } from "../../index.js";
import { encodePiledriverObject } from "./codec.js";
import { planHeapObjects } from "./heap-plan.js";

const decodePlanned = (value: Parameters<typeof encodePiledriverObject>[0]) => {
  return JSON.parse(new TextDecoder().decode(encodePiledriverObject(value)));
};

describe("Breezy heap planning", () => {
  it("plans locally created shared objects synchronously in child-first order", () => {
    let childGets = 0;
    let firstParentGets = 0;
    let secondParentGets = 0;
    const child: PiledriverHeapObject = {
      async get() {
        childGets++;
        return { value: "child" };
      },
      getValueIfLocallyCreated() {
        return { status: "locally-created", value: { value: "child" } };
      },
      [isPiledriverHeapObjectSymbol]: true,
    };
    const firstParent: PiledriverHeapObject = {
      async get() {
        firstParentGets++;
        return { child };
      },
      getValueIfLocallyCreated() {
        return { status: "locally-created", value: { child } };
      },
      [isPiledriverHeapObjectSymbol]: true,
    };
    const secondParent: PiledriverHeapObject = {
      async get() {
        secondParentGets++;
        return { child };
      },
      getValueIfLocallyCreated() {
        return { status: "locally-created", value: { child } };
      },
      [isPiledriverHeapObjectSymbol]: true,
    };
    let nextKey = 0;

    const planned = planHeapObjects(
      { firstParent, secondParent },
      () => undefined,
      () => new Uint8Array([nextKey++]).buffer,
    );

    expect(planned.heapObjects.map(({ object }) => object)).toEqual([child, firstParent, secondParent]);
    expect(planned.heapObjects.map(({ key }) => [...new Uint8Array(key)])).toEqual([[1], [0], [2]]);
    expect(planned.heapObjects.map(({ value }) => decodePlanned(value))).toEqual([
      { value: "child" },
      { child: ["heap-reference", "AQ=="] },
      { child: ["heap-reference", "AQ=="] },
    ]);
    expect(decodePlanned(planned.root)).toEqual({
      firstParent: ["heap-reference", "AA=="],
      secondParent: ["heap-reference", "Ag=="],
    });
    expect([childGets, firstParentGets, secondParentGets]).toEqual([0, 0, 0]);
  });

  it("does not traverse known heap objects", () => {
    let gets = 0;
    const known: PiledriverHeapObject = {
      async get() {
        gets++;
        return { value: "already stored" };
      },
      getValueIfLocallyCreated() {
        return { status: "database-reference" };
      },
      [isPiledriverHeapObjectSymbol]: true,
    };

    const plan = planHeapObjects(
      { known },
      object => object === known
        ? { key: new Uint8Array([7]).buffer, dependency: "known-seq" }
        : undefined,
      () => new ArrayBuffer(1),
    );

    expect(plan.heapObjects).toEqual([]);
    expect(plan.dependencies).toEqual(["known-seq"]);
    expect(decodePlanned(plan.root)).toEqual({ known: ["heap-reference", "Bw=="] });
    expect(gets).toBe(0);
  });

  it("rejects references owned by another database", () => {
    const foreign: PiledriverHeapObject = {
      async get() {
        return { value: "foreign" };
      },
      getValueIfLocallyCreated() {
        return { status: "database-reference" };
      },
      [isPiledriverHeapObjectSymbol]: true,
    };

    expect(() => planHeapObjects(
      { foreign },
      () => undefined,
      () => new ArrayBuffer(1),
    )).toThrow("heap object read from another Piledriver database");
  });
});
