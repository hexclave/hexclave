import { HexclaveAssertionError } from "./errors";
import { identity } from "./functions";
import { stringCompare } from "./strings";
import { typeAssertIs } from "./types";

export function isNotNull<T>(value: T): value is NonNullable<T> {
  return value !== null && value !== undefined;
}
import.meta.vitest?.test("isNotNull", ({ expect }) => {
  expect(isNotNull(null)).toBe(false);
  expect(isNotNull(undefined)).toBe(false);
  expect(isNotNull(0)).toBe(true);
  expect(isNotNull("")).toBe(true);
  expect(isNotNull(false)).toBe(true);
  expect(isNotNull({})).toBe(true);
  expect(isNotNull([])).toBe(true);
});

export type DeepPartial<T> = T extends object ? (T extends any[] ? { [P in keyof T]: DeepPartial<T[P]> } : { [P in keyof T]?: DeepPartial<T[P]> }) : T;
export type DeepRequired<T> = T extends object ? { [P in keyof T]-?: DeepRequired<T[P]> } : T;
export type DeepRequiredOrUndefined<T> = T extends object ? { [P in keyof { [K in keyof T]-?: K}]: DeepRequiredOrUndefined<T[P]> } : T;


/**
 * Assumes both objects are primitives, arrays, or non-function plain objects, and compares them deeply.
 *
 * Note that since they are assumed to be plain objects, this function does not compare prototypes.
 */
export function deepPlainEquals<T>(obj1: T, obj2: unknown, options: { ignoreUndefinedValues?: boolean } = {}): obj2 is T {
  if (typeof obj1 !== typeof obj2) return false;
  if (obj1 === obj2) return true;

  switch (typeof obj1) {
    case 'object': {
      if (!obj1 || !obj2) return false;

      if (Array.isArray(obj1) || Array.isArray(obj2)) {
        if (!Array.isArray(obj1) || !Array.isArray(obj2)) return false;
        if (obj1.length !== obj2.length) return false;
        return obj1.every((v, i) => deepPlainEquals(v, obj2[i], options));
      }

      const entries1 = Object.entries(obj1).filter(([k, v]) => !options.ignoreUndefinedValues || v !== undefined);
      const entries2 = Object.entries(obj2).filter(([k, v]) => !options.ignoreUndefinedValues || v !== undefined);
      if (entries1.length !== entries2.length) return false;
      return entries1.every(([k, v1]) => {
        const e2 = entries2.find(([k2]) => k === k2);
        if (!e2) return false;
        return deepPlainEquals(v1, e2[1], options);
      });
    }
    case 'undefined':
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
    case 'function':{
      return false;
    }
    default: {
      throw new Error("Unexpected typeof " + typeof obj1);
    }
  }
}
import.meta.vitest?.test("deepPlainEquals", ({ expect }) => {
  // Simple values
  expect(deepPlainEquals(1, 1)).toBe(true);
  expect(deepPlainEquals("test", "test")).toBe(true);
  expect(deepPlainEquals(1, 2)).toBe(false);
  expect(deepPlainEquals("test", "other")).toBe(false);

  // Arrays
  expect(deepPlainEquals([1, 2, 3], [1, 2, 3])).toBe(true);
  expect(deepPlainEquals([1, 2, 3], [1, 2, 4])).toBe(false);
  expect(deepPlainEquals([1, 2, 3], [1, 2])).toBe(false);

  // Objects
  expect(deepPlainEquals({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  expect(deepPlainEquals({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
  expect(deepPlainEquals({ a: 1, b: 2 }, { a: 1 })).toBe(false);

  // Nested structures
  expect(deepPlainEquals({ a: 1, b: [1, 2, { c: 3 }] }, { a: 1, b: [1, 2, { c: 3 }] })).toBe(true);
  expect(deepPlainEquals({ a: 1, b: [1, 2, { c: 3 }] }, { a: 1, b: [1, 2, { c: 4 }] })).toBe(false);

  // With options
  expect(deepPlainEquals({ a: 1, b: undefined }, { a: 1 }, { ignoreUndefinedValues: true })).toBe(true);
  expect(deepPlainEquals({ a: 1, b: undefined }, { a: 1 })).toBe(false);
});

export function isCloneable<T>(obj: T): obj is Exclude<T, symbol | Function> {
  return typeof obj !== 'symbol' && typeof obj !== 'function';
}

export function shallowClone<T extends object>(obj: T): T {
  if (!isCloneable(obj)) throw new HexclaveAssertionError("shallowClone does not support symbols or functions", { obj });

  if (Array.isArray(obj)) return obj.map(identity) as T;
  return { ...obj };
}
import.meta.vitest?.test("shallowClone", ({ expect }) => {
  expect(shallowClone({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  expect(shallowClone([1, 2, 3])).toEqual([1, 2, 3]);
  expect(() => shallowClone(() => {})).toThrow();
});

export function deepPlainClone<T>(obj: T): T {
  if (typeof obj === 'function') throw new HexclaveAssertionError("deepPlainClone does not support functions");
  if (typeof obj === 'symbol') throw new HexclaveAssertionError("deepPlainClone does not support symbols");
  if (typeof obj !== 'object' || !obj) return obj;
  if (Array.isArray(obj)) return obj.map(deepPlainClone) as any;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, deepPlainClone(v)])) as any;
}
import.meta.vitest?.test("deepPlainClone", ({ expect }) => {
  // Primitive values
  expect(deepPlainClone(1)).toBe(1);
  expect(deepPlainClone("test")).toBe("test");
  expect(deepPlainClone(null)).toBe(null);
  expect(deepPlainClone(undefined)).toBe(undefined);

  // Arrays
  const arr = [1, 2, 3];
  const clonedArr = deepPlainClone(arr);
  expect(clonedArr).toEqual(arr);
  expect(clonedArr).not.toBe(arr); // Different reference

  // Objects
  const obj = { a: 1, b: 2 };
  const clonedObj = deepPlainClone(obj);
  expect(clonedObj).toEqual(obj);
  expect(clonedObj).not.toBe(obj); // Different reference

  // Nested structures
  const nested = { a: 1, b: [1, 2, { c: 3 }] };
  const clonedNested = deepPlainClone(nested);
  expect(clonedNested).toEqual(nested);
  expect(clonedNested).not.toBe(nested); // Different reference
  expect(clonedNested.b).not.toBe(nested.b); // Different reference for nested array
  expect(clonedNested.b[2]).not.toBe(nested.b[2]); // Different reference for nested object

  // Error cases
  expect(() => deepPlainClone(() => {})).toThrow();
  expect(() => deepPlainClone(Symbol())).toThrow();
});

export type DeepMerge<T, U> = U extends any ? DeepMergeNonDistributive<T, U> : never;  // distributive conditional type https://www.typescriptlang.org/docs/handbook/2/conditional-types.html#distributive-conditional-types
type DeepMergeNonDistributive<T, U> = Omit<T, keyof U> & Omit<U, keyof T> & DeepMergeInner<Pick<T, keyof U & keyof T>, Pick<U, keyof U & keyof T>>;
type DeepMergeInner<T, U> = {
  [K in { [Ki in keyof U]-?: Ki }[keyof U]]:  // we use this weird construct instead of just `keyof U` because TypeScript automatically removes the `undefined` key when using `-?` as a modifier; this is a workaround to make TypeScript not recognize the -? and for us to get the `undefined` key back
    undefined extends U[K]
      ? K extends keyof T
          ? T[K] extends object
              ? Exclude<U[K], undefined> extends object
                  ? DeepMerge<T[K], Exclude<U[K], undefined>>
                  : T[K] | Exclude<U[K], undefined>
              : T[K] | Exclude<U[K], undefined>
          : Exclude<U[K], undefined>
      : K extends keyof T
          ? T[K] extends object
              ? U[K] extends object
                  ? DeepMerge<T[K], U[K]>
                  : U[K]
              : U[K]
          : U[K];
};
export function deepMerge<T extends {}, U extends {}>(baseObj: T, mergeObj: U): DeepMerge<T, U> {
  if ([baseObj, mergeObj, ...Object.values(baseObj), ...Object.values(mergeObj)].some(o => !isCloneable(o))) throw new HexclaveAssertionError("deepMerge does not support functions or symbols", { baseObj, mergeObj });

  const res: any = shallowClone(baseObj);
  for (const [key, mergeValue] of Object.entries(mergeObj)) {
    if (has(res, key as any)) {
      const baseValue = get(res, key as any);
      if (isObjectLike(baseValue) && isObjectLike(mergeValue)) {
        set(res, key, deepMerge(baseValue, mergeValue));
        continue;
      }
    }
    set(res, key, mergeValue);
  }
  // SAFETY: deepMerge only writes cloned values from baseObj/mergeObj and
  // recursively applies the DeepMerge operation for nested object pairs.
  return res as any;
}
import.meta.vitest?.test("deepMerge", ({ expect }) => {
  // Test merging flat objects
  expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  expect(deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });

  // Test with nested objects
  expect(deepMerge(
    { a: { x: 1, y: 2 }, b: 3 },
    { a: { y: 3, z: 4 }, c: 5 }
  )).toEqual({ a: { x: 1, y: 3, z: 4 }, b: 3, c: 5 });

  // Test with arrays
  expect(deepMerge(
    { a: [1, 2], b: 3 },
    { a: [3, 4], c: 5 }
  )).toEqual({ a: [3, 4], b: 3, c: 5 });

  // Test with null values
  expect(deepMerge(
    { a: { x: 1 }, b: null },
    { a: { y: 2 }, b: { z: 3 } }
  )).toEqual({ a: { x: 1, y: 2 }, b: { z: 3 } });

  // Test with undefined values
  expect(deepMerge(
    { a: 1, b: undefined },
    { b: 2, c: 3 }
  )).toEqual({ a: 1, b: 2, c: 3 });

  // Test deeply nested structures
  expect(deepMerge(
    {
      a: {
        x: { deep: 1 },
        y: [1, 2]
      },
      b: 2
    },
    {
      a: {
        x: { deeper: 3 },
        y: [3, 4]
      },
      c: 3
    }
  )).toEqual({
    a: {
      x: { deep: 1, deeper: 3 },
      y: [3, 4]
    },
    b: 2,
    c: 3
  });

  // Test with empty objects
  expect(deepMerge({}, { a: 1 })).toEqual({ a: 1 });
  expect(deepMerge({ a: 1 }, {})).toEqual({ a: 1 });
  expect(deepMerge({}, {})).toEqual({});

  // Test that original objects are not modified
  const base = { a: { x: 1 }, b: 2 };
  const merge = { a: { y: 2 }, c: 3 };
  const baseClone = deepPlainClone(base);
  const mergeClone = deepPlainClone(merge);

  const result = deepMerge(base, merge);
  expect(base).toEqual(baseClone);
  expect(merge).toEqual(mergeClone);
  expect(result).toEqual({ a: { x: 1, y: 2 }, b: 2, c: 3 });

  // Test error cases
  expect(() => deepMerge({ a: () => {} }, { b: 2 })).toThrow();
  expect(() => deepMerge({ a: 1 }, { b: () => {} })).toThrow();
  expect(() => deepMerge({ a: Symbol() }, { b: 2 })).toThrow();
  expect(() => deepMerge({ a: 1 }, { b: Symbol() })).toThrow();
});

export type DeepOmit<T, U> = T extends object ? { [K in keyof T]: K extends keyof U ? (T[K] extends U[K] ? undefined : T[K]) : T[K] } : (T extends U ? undefined : T);

export function typedEntries<T extends {}>(obj: T): [Exclude<keyof T, number>, T[keyof T]][] {
  return Object.entries(obj) as any;
}
import.meta.vitest?.test("typedEntries", ({ expect }) => {
  expect(typedEntries({})).toEqual([]);
  expect(typedEntries({ a: 1, b: 2 })).toEqual([["a", 1], ["b", 2]]);
  expect(typedEntries({ a: "hello", b: true, c: null })).toEqual([["a", "hello"], ["b", true], ["c", null]]);

  // Test with object containing methods
  const objWithMethod = { a: 1, b: () => "test" };
  const entries = typedEntries(objWithMethod);
  expect(entries.length).toBe(2);
  expect(entries[0][0]).toBe("a");
  expect(entries[0][1]).toBe(1);
  expect(entries[1][0]).toBe("b");
  expect(typeof entries[1][1]).toBe("function");
});

export function typedFromEntries<K extends PropertyKey, V>(entries: (readonly [K, V])[]): Record<K, V> {
  return Object.fromEntries(entries) as any;
}
import.meta.vitest?.test("typedFromEntries", ({ expect }) => {
  expect(typedFromEntries([])).toEqual({});
  expect(typedFromEntries([["a", 1], ["b", 2]])).toEqual({ a: 1, b: 2 });

  // Test with mixed types (using type assertion)
  const mixedEntries = [["a", "hello"], ["b", true], ["c", null]] as [string, string | boolean | null][];
  const mixedObj = typedFromEntries(mixedEntries);
  expect(mixedObj).toEqual({ a: "hello", b: true, c: null });

  // Test with function values
  const fn = () => "test";
  type MixedValue = number | (() => string);
  const fnEntries: [string, MixedValue][] = [["a", 1], ["b", fn]];
  const obj = typedFromEntries(fnEntries);
  expect(obj.a).toBe(1);
  expect(typeof obj.b).toBe("function");
  // Type assertion needed for the function call
  expect((obj.b as () => string)()).toBe("test");
});

export function typedKeys<T extends {}>(obj: T): (Exclude<keyof T, number>)[] {
  return Object.keys(obj) as any;
}
import.meta.vitest?.test("typedKeys", ({ expect }) => {
  expect(typedKeys({})).toEqual([]);
  expect(typedKeys({ a: 1, b: 2 })).toEqual(["a", "b"]);
  expect(typedKeys({ a: "hello", b: true, c: null })).toEqual(["a", "b", "c"]);

  // Test with object containing methods
  const objWithMethod = { a: 1, b: () => "test" };
  expect(typedKeys(objWithMethod)).toEqual(["a", "b"]);
});

export function typedValues<T extends {}>(obj: T): T[keyof T][] {
  return Object.values(obj) as any;
}
import.meta.vitest?.test("typedValues", ({ expect }) => {
  expect(typedValues({})).toEqual([]);
  expect(typedValues({ a: 1, b: 2 })).toEqual([1, 2]);

  // Test with mixed types
  type MixedObj = { a: string, b: boolean, c: null };
  const mixedObj: MixedObj = { a: "hello", b: true, c: null };
  expect(typedValues(mixedObj)).toEqual(["hello", true, null]);

  // Test with object containing methods
  type ObjWithFn = { a: number, b: () => string };
  const fn = () => "test";
  const objWithMethod: ObjWithFn = { a: 1, b: fn };
  const values = typedValues(objWithMethod);
  expect(values.length).toBe(2);
  expect(values[0]).toBe(1);
  expect(typeof values[1]).toBe("function");
  // Need to cast to the correct type
  const fnValue = values[1] as () => string;
  expect(fnValue()).toBe("test");
});

export function typedAssign<T extends {}, U extends {}>(target: T, source: U): T & U {
  return Object.assign(target, source);
}
import.meta.vitest?.test("typedAssign", ({ expect }) => {
  // Test with empty objects
  const emptyTarget = {};
  const emptyResult = typedAssign(emptyTarget, { a: 1 });
  expect(emptyResult).toEqual({ a: 1 });
  expect(emptyResult).toBe(emptyTarget); // Same reference

  // Test with non-empty target
  const target = { a: 1, b: 2 };
  const result = typedAssign(target, { c: 3, d: 4 });
  expect(result).toEqual({ a: 1, b: 2, c: 3, d: 4 });
  expect(result).toBe(target); // Same reference

  // Test with overlapping properties
  const targetWithOverlap = { a: 1, b: 2 };
  const resultWithOverlap = typedAssign(targetWithOverlap, { b: 3, c: 4 });
  expect(resultWithOverlap).toEqual({ a: 1, b: 3, c: 4 });
  expect(resultWithOverlap).toBe(targetWithOverlap); // Same reference
});

export type FilterUndefined<T> =
  & { [k in keyof T as (undefined extends T[k] ? (T[k] extends undefined | void ? never : k) : never)]+?: T[k] & ({} | null) }
  & { [k in keyof T as (undefined extends T[k] ? never : k)]: T[k] & ({} | null) }

/**
 * Returns a new object with all undefined values removed. Useful when spreading optional parameters on an object, as
 * TypeScript's `Partial<XYZ>` type allows `undefined` values.
 */
export function filterUndefined<T extends object>(obj: T): FilterUndefined<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as any;
}
import.meta.vitest?.test("filterUndefined", ({ expect }) => {
  expect(filterUndefined({})).toEqual({});
  expect(filterUndefined({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  expect(filterUndefined({ a: 1, b: undefined })).toEqual({ a: 1 });
  expect(filterUndefined({ a: undefined, b: undefined })).toEqual({});
  expect(filterUndefined({ a: null, b: undefined })).toEqual({ a: null });
  expect(filterUndefined({ a: 0, b: "", c: false, d: undefined })).toEqual({ a: 0, b: "", c: false });
});

export type FilterUndefinedOrNull<T> = FilterUndefined<{ [k in keyof T]: null extends T[k] ? NonNullable<T[k]> | undefined : T[k] }>;

/**
 * Returns a new object with all undefined and null values removed. Useful when spreading optional parameters on an object, as
 * TypeScript's `Partial<XYZ>` type allows `undefined` values.
 */
export function filterUndefinedOrNull<T extends object>(obj: T): FilterUndefinedOrNull<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)) as any;
}
import.meta.vitest?.test("filterUndefinedOrNull", ({ expect }) => {
  expect(filterUndefinedOrNull({})).toEqual({});
  expect(filterUndefinedOrNull({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
});

export type DeepFilterUndefined<T> = T extends object ? FilterUndefined<{ [K in keyof T]: DeepFilterUndefined<T[K]> }> : T;
typeAssertIs<DeepFilterUndefined<{ a: { b: { c?: undefined, d?: 123 } } }>, { a: { b: { d?: 123 } } }>()();

export function deepFilterUndefined<T extends object>(obj: T): DeepFilterUndefined<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [k, isObjectLike(v) ? deepFilterUndefined(v) : v])) as any;
}
import.meta.vitest?.test("deepFilterUndefined", ({ expect }) => {
  expect(deepFilterUndefined({ a: 1, b: undefined })).toEqual({ a: 1 });
});

export function pick<T extends {}, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k as K))) as any;
}
import.meta.vitest?.test("pick", ({ expect }) => {
  const obj = { a: 1, b: 2, c: 3, d: 4 };
  expect(pick(obj, ["a", "c"])).toEqual({ a: 1, c: 3 });
  expect(pick(obj, [])).toEqual({});
  expect(pick(obj, ["a", "e" as keyof typeof obj])).toEqual({ a: 1 });
  // Use type assertion for empty object to avoid TypeScript error
  expect(pick({} as Record<string, unknown>, ["a"])).toEqual({});
});

export function omit<T extends {}, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  if (!Array.isArray(keys)) throw new HexclaveAssertionError("omit: keys must be an array", { obj, keys });
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k as K))) as any;
}
import.meta.vitest?.test("omit", ({ expect }) => {
  const obj = { a: 1, b: 2, c: 3, d: 4 };
  expect(omit(obj, ["a", "c"])).toEqual({ b: 2, d: 4 });
  expect(omit(obj, [])).toEqual(obj);
  expect(omit(obj, ["a", "e" as keyof typeof obj])).toEqual({ b: 2, c: 3, d: 4 });
  // Use type assertion for empty object to avoid TypeScript error
  expect(omit({} as Record<string, unknown>, ["a"])).toEqual({});
});

export function split<T extends {}, K extends keyof T>(obj: T, keys: K[]): [Pick<T, K>, Omit<T, K>] {
  return [pick(obj, keys), omit(obj, keys)];
}
import.meta.vitest?.test("split", ({ expect }) => {
  const obj = { a: 1, b: 2, c: 3, d: 4 };
  expect(split(obj, ["a", "c"])).toEqual([{ a: 1, c: 3 }, { b: 2, d: 4 }]);
  expect(split(obj, [])).toEqual([{}, obj]);
  expect(split(obj, ["a", "e" as keyof typeof obj])).toEqual([{ a: 1 }, { b: 2, c: 3, d: 4 }]);
  // Use type assertion for empty object to avoid TypeScript error
  expect(split({} as Record<string, unknown>, ["a"])).toEqual([{}, {}]);
});

export function mapValues<T extends object, U>(obj: T, fn: (value: T extends (infer E)[] ? E : T[keyof T], key: keyof T) => U): Record<keyof T, U> {
  if (Array.isArray(obj)) {
    return obj.map((v, i) => fn(v, i as keyof T)) as any;
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v, k as keyof T)])) as any;
}
import.meta.vitest?.test("mapValues", ({ expect }) => {
  expect(mapValues({ a: 1, b: 2 }, v => v * 2)).toEqual({ a: 2, b: 4 });
  expect(mapValues([1, 2, 3], v => v * 2)).toEqual([2, 4, 6]);
});

export function sortKeys<T extends object>(obj: T): T {
  if (Array.isArray(obj)) {
    return [...obj] as any;
  }
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => stringCompare(a, b))) as any;
}
import.meta.vitest?.test("sortKeys", ({ expect }) => {
  const obj = {
    "1": 0,
    "10": 1,
    b: 2,
    "2": 3,
    a: 4,
    "-3.33": 5,
    "-4": 6,
    "-3": 7,
    abc: 8,
    "a-b": 9,
    ab: 10,
    ac: 11,
    aa: 12,
    aab: 13,
  };
  expect(Object.entries(sortKeys(obj))).toEqual([
    ["1", 0],
    ["2", 3],
    ["10", 1],
    ["-3", 7],
    ["-3.33", 5],
    ["-4", 6],
    ["a", 4],
    ["a-b", 9],
    ["aa", 12],
    ["aab", 13],
    ["ab", 10],
    ["abc", 8],
    ["ac", 11],
    ["b", 2],
  ]);
});

export function deepSortKeys<T extends object>(obj: T): T {
  return sortKeys(mapValues(obj, v => isObjectLike(v) ? deepSortKeys(v) : v)) as any;
}
import.meta.vitest?.test("deepSortKeys", ({ expect }) => {
  const obj = {
    h: { i: { k: 9, j: 8 }, l: 10 },
    b: { d: 3, c: 2 },
    a: 1,
    e: [4, 5, { g: 7, f: 6 }],
  };
  const sorted = deepSortKeys(obj);
  expect(Object.entries(sorted)).toEqual([
    ["a", 1],
    ["b", { c: 2, d: 3 }],
    ["e", [4, 5, { f: 6, g: 7 }]],
    ["h", { i: { j: 8, k: 9 }, l: 10 }],
  ]);
  expect(Object.entries(sorted.b)).toEqual([
    ["c", 2],
    ["d", 3],
  ]);
  expect(Object.entries(sorted.e[2])).toEqual([
    ["f", 6],
    ["g", 7],
  ]);
  expect(Object.entries(sorted.h)).toEqual([
    ["i", { j: 8, k: 9 }],
    ["l", 10],
  ]);
  expect(Object.entries(sorted.h.i)).toEqual([
    ["j", 8],
    ["k", 9],
  ]);
});

export function set<T extends object, K extends PropertyKey = keyof T>(obj: T, key: K, value: T[K & keyof T]) {
  if (!isObjectLike(obj)) throw new HexclaveAssertionError(`set: obj is not an object (found: ${(obj as any) === null ? "null" : typeof obj})`, { obj, key, value });
  Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: true });
}

export function get<T extends object, K extends PropertyKey = keyof T>(obj: T, key: K): T[K & keyof T] {
  if ((obj as any) == null) throw new HexclaveAssertionError("get: obj is null or undefined", { obj, key });
  const descriptor = Object.getOwnPropertyDescriptor(obj, key);
  if (!descriptor) throw new HexclaveAssertionError(`get: key ${String(key)} does not exist`, { obj, key });
  return descriptor.value;
}

export function getOrUndefined<T extends object, K extends PropertyKey = keyof T>(obj: T, key: K): T[K & keyof T] | undefined {
  if ((obj as any) == null) throw new HexclaveAssertionError("getOrUndefined: obj is null or undefined", { obj, key });
  return has(obj, key) ? get(obj, key) : undefined;
}

export function has<T extends object, K extends PropertyKey = keyof T>(obj: T, key: K): obj is T & { [k in K & keyof T]: unknown } {
  if ((obj as any) == null) throw new HexclaveAssertionError("has: obj is null or undefined", { obj, key });
  return Object.prototype.hasOwnProperty.call(obj, key);
}

import.meta.vitest?.test("has", ({ expect }) => {
  const obj = { a: 1, b: undefined, c: null };
  expect(has(obj, "a")).toBe(true);
  expect(has(obj, "b")).toBe(true);
  expect(has(obj, "c")).toBe(true);
  expect(has(obj, "d" as keyof typeof obj)).toBe(false);
});


export function hasAndNotUndefined<T extends object, K extends keyof T>(obj: T, key: K): obj is T & { [k in K]: Exclude<T[K], undefined> } {
  return has(obj, key) && get(obj, key) !== undefined;
}

export function deleteKey<T extends object, K extends keyof T>(obj: T, key: K) {
  if (has(obj, key)) {
    Reflect.deleteProperty(obj, key);
  } else {
    throw new HexclaveAssertionError(`deleteKey: key ${String(key)} does not exist`, { obj, key });
  }
}

/**
 * Returns true iff the value is an object or a function, but not null.
 */
export function isObjectLike(value: unknown): value is object | Function {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}
