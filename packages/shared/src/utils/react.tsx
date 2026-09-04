import React, { SetStateAction } from "react";
import { neverResolve, runAsynchronously } from "./promises";
import { AsyncResult } from "./results";

export function componentWrapper<
  C extends React.ComponentType<any> | keyof React.JSX.IntrinsicElements,
  ExtraProps extends {} = {}
>(displayName: string, render: React.ForwardRefRenderFunction<RefFromComponent<C>, React.ComponentPropsWithRef<C> & ExtraProps>) {
  const Component = forwardRefIfNeeded(render);
  Component.displayName = displayName;
  return Component;
}
type RefFromComponent<C extends React.ComponentType<any> | keyof React.JSX.IntrinsicElements> = NonNullable<RefFromComponentDistCond<React.ComponentPropsWithRef<C>["ref"]>>;
type RefFromComponentDistCond<A> = A extends React.RefObject<infer T> ? T : never;  // distributive conditional type; see https://www.typescriptlang.org/docs/handbook/2/conditional-types.html#distributive-conditional-types

const react18PromiseCache = new WeakMap<Promise<unknown>, AsyncResult<unknown, unknown>>();
export function use<T>(promise: Promise<T>): T {
  if ("use" in React) {
    return React.use(promise);
  } else {
    if (react18PromiseCache.has(promise)) {
      const result = react18PromiseCache.get(promise)!;
      if (result.status === "pending") {
        throw promise;
      } else if (result.status === "ok") {
        // SAFETY: The cache is keyed by this Promise<T>; its erased AsyncResult
        // value is therefore the same T associated with the function argument.
        return result.data as T;
      } else {
        throw result.error;
      }
    } else {
      react18PromiseCache.set(promise, { "status": "pending", progress: undefined });
      runAsynchronously(async () => {
        try {
          const res = await promise;
          react18PromiseCache.set(promise, { "status": "ok", data: res });
        } catch (e) {
          react18PromiseCache.set(promise, { "status": "error", error: e });
        }
      });
      throw promise;
    }
  }
}

export function forwardRefIfNeeded<T, P = {}>(render: React.ForwardRefRenderFunction<T, P>): React.FC<P & { ref?: React.Ref<T> }> {
  // TODO: when we drop support for react 18, remove this

  const version = React.version;
  const major = parseInt(version.split(".")[0]);
  if (major < 19) {
    return React.forwardRef<T, P>(render as any) as any;
  } else {
    return ((props: P) => render(props, (props as any).ref)) as any;
  }
}

export function getNodeText(node: React.ReactNode): string {
  if (["number", "string"].includes(typeof node)) {
    return `${node}`;
  }
  if (!node) {
    return "";
  }
  if (Array.isArray(node)) {
    return node.map(getNodeText).join("");
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return getNodeText(node.props.children);
  }
  throw new Error(`Unknown node type: ${typeof node}`);
}
import.meta.vitest?.test("getNodeText", ({ expect }) => {
  // Test with string
  expect(getNodeText("hello")).toBe("hello");

  // Test with number
  expect(getNodeText(42)).toBe("42");

  // Test with null/undefined
  expect(getNodeText(null)).toBe("");
  expect(getNodeText(undefined)).toBe("");

  // Test with array
  expect(getNodeText(["hello", " ", "world"])).toBe("hello world");
  expect(getNodeText([1, 2, 3])).toBe("123");

  // Test with mixed array
  expect(getNodeText(["hello", 42, null])).toBe("hello42");

  // Test with React element
  const mockElement = React.createElement("span", null, "child text");
  expect(getNodeText(mockElement)).toBe("child text");

  // Test with nested React elements
  const nestedElement = React.createElement("div", null, React.createElement("span", null, "nested text"));
  expect(getNodeText(nestedElement)).toBe("nested text");

  // Test with array of React elements
  const arrayOfElements = [
    React.createElement("span", null, "first"),
    React.createElement("span", null, "second"),
  ];
  expect(getNodeText(arrayOfElements)).toBe("firstsecond");
});

/**
 * Suspends the currently rendered component indefinitely. Will not unsuspend unless the component rerenders.
 *
 * You can use this to translate older query- or AsyncResult-based code to new the Suspense system, for example: `if (query.isLoading) suspend();`
 */
export function suspend(): never {
  use(neverResolve());
  throw new Error("Somehow a Promise that never resolves was resolved?");
}

export function mapRef<T, R>(ref: ReadonlyRef<T>, mapper: (value: T) => R): ReadonlyRef<R> {
  let last: [T, R] | null = null;
  return {
    get current() {
      const input = ref.current;
      if (last === null || input !== last[0]) {
        last = [input, mapper(input)];
      }
      return last[1];
    },
  };
}

export type ReadonlyRef<T> = {
  readonly current: T,
};

export type RefState<T> = ReadonlyRef<T> & {
  set: (updater: SetStateAction<T>) => void,
};

/**
 * Like useState, but its value is immediately available on refState.current after being set.
 *
 * Like useRef, but setting the value will cause a rerender.
 *
 * Note that useRefState returns a new object every time a rerender happens due to a value change, which is intentional
 * as it allows you to specify it in a dependency array like this:
 *
 * ```tsx
 * useEffect(() => {
 *   // do something with refState.current
 * }, [refState]);  // instead of refState.current
 * ```
 *
 * If you don't want this, you can wrap the result in a useMemo call.
 */
export function useRefState<T>(initialValue: T | (() => T)): RefState<T> {
  // Support lazy initialization like React.useState does: if initialValue is a function,
  // call it once to get the actual initial value (React.useRef does NOT do this automatically).
  const lazyInitRef = React.useRef<{ v: T } | null>(null);
  if (lazyInitRef.current === null) {
    lazyInitRef.current = {
      v: typeof initialValue === "function" ? (initialValue as () => T)() : initialValue,
    };
  }
  const resolvedInitialValue = lazyInitRef.current.v;
  const [, setState] = React.useState<T>(() => resolvedInitialValue);
  const ref = React.useRef(resolvedInitialValue);
  const setValue = React.useCallback((updater: SetStateAction<T>) => {
    const value: T = typeof updater === "function" ? (updater as any)(ref.current) : updater;
    ref.current = value;
    setState(value);
  }, []);
  const res = React.useMemo(() => ({
    get current() {
      return ref.current;
    },
    set: setValue,
  }), [setValue]);
  return res;
}

export function mapRefState<T, R>(refState: RefState<T>, mapper: (value: T) => R, reverseMapper: (oldT: T, newR: R) => T): RefState<R> {
  let last: [T, R] | null = null;
  return {
    get current() {
      const input = refState.current;
      if (last === null || input !== last[0]) {
        last = [input, mapper(input)];
      }
      return last[1];
    },
    set(updater: SetStateAction<R>) {
      const value: R = typeof updater === "function" ? (updater as any)(this.current) : updater;
      refState.set(reverseMapper(refState.current, value));
    },
  };
}

export function useQueryState(key: string, defaultValue?: string) {
  const getValue = () => new URLSearchParams(window.location.search).get(key) ?? defaultValue ?? null;

  const [value, setValue] = React.useState(getValue);

  React.useEffect(() => {
    const onPopState = () => setValue(getValue());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const update = (next: string | null) => {
    const params = new URLSearchParams(window.location.search);
    if (next !== null) {
      params.set(key, next);
    } else {
      params.delete(key);
    }
    const newUrl = params.toString()
      ? `${window.location.pathname}?${params.toString()}`
      : window.location.pathname;
    window.history.pushState(null, "", newUrl);
    setValue(next);
  };

  return [value, update] as const;
}
