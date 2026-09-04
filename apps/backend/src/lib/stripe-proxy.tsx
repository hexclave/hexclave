import Stripe from "stripe";
import { getOrUndefined } from "@hexclave/shared/dist/utils/objects";
import type { Json } from "@hexclave/shared/dist/utils/json";
export type StripeOverridesMap = Record<string, Record<string, Json>>;

export function createStripeProxy<T extends object = Stripe>(
  target: T,
  overrides: StripeOverridesMap = {},
  path: string[] = []
): T {
  return new Proxy(target, {
    get(currTarget, prop, receiver) {
      if (typeof prop === "symbol") {
        return Reflect.get(currTarget, prop, receiver);
      }

      const value = Reflect.get(currTarget, prop, receiver);

      if (typeof value === "function") {
        return (...args: any[]) => {
          const result = value.apply(currTarget, args);
          const key = [...path, String(prop)].join(".");

          if (result && typeof (result as any).then === "function") {
            return (result as Promise<any>).then((resolved) =>
              applyOverrideForKey(key, resolved, overrides)
            );
          }

          // sync method
          return applyOverrideForKey(key, result, overrides);
        };
      }

      // Recurse into sub-objects
      if (typeof value === "object") {
        return createStripeProxy(value as object, overrides, [...path, String(prop)]);
      }

      return value;
    },
  }) as T;
}

function applyOverrideForKey(key: string, result: any, overrides: StripeOverridesMap) {
  const override = getOrUndefined(overrides, key);
  if (!override || !result || typeof result !== "object") return result;

  return {
    ...result,
    ...override,
  };
}
