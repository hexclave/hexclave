import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { describe, expect, it } from "vitest";
import {
  MAX_CUSTOM_EVENT_NAME_LENGTH,
  MAX_CUSTOM_EVENT_PROPERTIES_BYTES,
  MAX_CUSTOM_EVENT_PROPERTY_COUNT,
  getCustomEventNameError,
  validateCustomEventPayload,
} from "./analytics-custom-events";

// Asserts that `fn` throws a StatusError with the given status code and returns
// the error so callers can additionally snapshot its message.
function expectStatusError(fn: () => unknown, statusCode: number): StatusError {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof StatusError)) throw error;
    expect(error.statusCode).toBe(statusCode);
    return error;
  }
  throw new Error("Expected function to throw a StatusError, but it did not throw");
}

describe("getCustomEventNameError", () => {
  it("accepts valid names", () => {
    expect(getCustomEventNameError("purchase")).toBeNull();
    expect(getCustomEventNameError("Signed Up")).toBeNull();
    expect(getCustomEventNameError("compra-finalizada äöü 購入")).toBeNull();
    expect(getCustomEventNameError("a")).toBeNull();
    expect(getCustomEventNameError("x".repeat(MAX_CUSTOM_EVENT_NAME_LENGTH))).toBeNull();
  });

  it("rejects empty names", () => {
    expect(getCustomEventNameError("")).toMatchInlineSnapshot(`"Event names must be between 1 and 128 characters long"`);
  });

  it("rejects names longer than the maximum length", () => {
    expect(getCustomEventNameError("x".repeat(MAX_CUSTOM_EVENT_NAME_LENGTH + 1))).toMatchInlineSnapshot(`"Event names must be between 1 and 128 characters long"`);
  });

  it("rejects names starting with $ as reserved", () => {
    expect(getCustomEventNameError("$page-view")).toMatchInlineSnapshot(`"Event names starting with $ are reserved for Hexclave system events"`);
    expect(getCustomEventNameError("$")).not.toBeNull();
  });

  it("rejects names containing control characters", () => {
    // Control characters are built via char codes so this source file itself
    // contains no literal or escaped control characters.
    const nul = String.fromCharCode(0);
    const newline = String.fromCharCode(10);
    const del = String.fromCharCode(127);
    expect(getCustomEventNameError(`foo${nul}bar`)).toMatchInlineSnapshot(`"Event names must not contain control characters"`);
    expect(getCustomEventNameError(`foo${newline}bar`)).not.toBeNull();
    expect(getCustomEventNameError(`foo${del}bar`)).not.toBeNull();
  });

  it("rejects names with leading or trailing whitespace", () => {
    expect(getCustomEventNameError(" purchase")).toMatchInlineSnapshot(`"Event names must not start or end with whitespace"`);
    expect(getCustomEventNameError("purchase ")).not.toBeNull();
    expect(getCustomEventNameError(" purchase ")).not.toBeNull();
  });
});

describe("validateCustomEventPayload", () => {
  it("accepts flat properties and returns them together with the value", () => {
    const result = validateCustomEventPayload({
      eventName: "purchase",
      properties: { plan: "pro", seats: 5, trial: false, coupon: null },
      value: 49.99,
    });
    expect(result).toMatchInlineSnapshot(`
      {
        "properties": {
          "coupon": null,
          "plan": "pro",
          "seats": 5,
          "trial": false,
        },
        "value": 49.99,
      }
    `);
  });

  describe("value", () => {
    it("accepts finite numbers including zero and negatives", () => {
      expect(validateCustomEventPayload({ eventName: "e", properties: {}, value: 0 }).value).toBe(0);
      expect(validateCustomEventPayload({ eventName: "e", properties: {}, value: -12.5 }).value).toBe(-12.5);
      expect(validateCustomEventPayload({ eventName: "e", properties: {}, value: 1e10 }).value).toBe(1e10);
    });

    it("normalizes null and undefined to a null value", () => {
      expect(validateCustomEventPayload({ eventName: "e", properties: {}, value: null }).value).toBeNull();
      expect(validateCustomEventPayload({ eventName: "e", properties: {}, value: undefined }).value).toBeNull();
    });

    it("rejects non-finite numbers and non-number types with a 400", () => {
      const error = expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: {}, value: NaN }), 400);
      expect(error.message).toMatchInlineSnapshot(`"Event \"e\": value must be a finite number"`);
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: {}, value: Infinity }), 400);
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: {}, value: -Infinity }), 400);
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: {}, value: "12" }), 400);
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: {}, value: true }), 400);
    });
  });

  describe("properties", () => {
    it("rejects arrays and primitives as top-level properties", () => {
      const error = expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: [1, 2, 3], value: null }), 400);
      expect(error.message).toMatchInlineSnapshot(`"Event \"e\": properties must be a JSON object"`);
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: "hello", value: null }), 400);
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: 42, value: null }), 400);
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: true, value: null }), 400);
    });

    it("defaults null/undefined properties to an empty object", () => {
      expect(validateCustomEventPayload({ eventName: "e", properties: null, value: null }).properties).toEqual({});
      expect(validateCustomEventPayload({ eventName: "e", properties: undefined, value: null }).properties).toEqual({});
    });

    it("accepts nesting of exactly the maximum depth", () => {
      // Leaf sits at depth 4 (top-level object is depth 1).
      expect(() => validateCustomEventPayload({
        eventName: "e",
        properties: { a: { b: { c: "leaf" } } },
        value: null,
      })).not.toThrow();
    });

    it("rejects nesting deeper than the maximum depth", () => {
      const error = expectStatusError(() => validateCustomEventPayload({
        eventName: "e",
        properties: { a: { b: { c: { d: "too deep" } } } },
        value: null,
      }), 400);
      expect(error.message).toMatchInlineSnapshot(`"Event \"e\": properties must not be nested deeper than 4 levels"`);
    });

    it("accepts exactly the maximum number of values", () => {
      const properties = Object.fromEntries(Array.from({ length: MAX_CUSTOM_EVENT_PROPERTY_COUNT }, (_, i) => [`key_${i}`, i]));
      expect(() => validateCustomEventPayload({ eventName: "e", properties, value: null })).not.toThrow();
    });

    it("rejects more than the maximum number of values", () => {
      const properties = Object.fromEntries(Array.from({ length: MAX_CUSTOM_EVENT_PROPERTY_COUNT + 1 }, (_, i) => [`key_${i}`, i]));
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties, value: null }), 400);
    });

    it("rejects a wide object during traversal instead of after walking every entry", () => {
      // Far past the cap so a post-walk check would do unbounded work first.
      const properties = Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`key_${i}`, i]));
      const error = expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties, value: null }), 400);
      expect(error.message).toMatchInlineSnapshot(`"Event \"e\": properties must contain at most 200 values"`);
    });

    it("counts array items towards the value limit", () => {
      // 1 (the key) + 200 array items = 201 values > 200.
      const properties = { list: Array.from({ length: MAX_CUSTOM_EVENT_PROPERTY_COUNT }, (_, i) => i) };
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties, value: null }), 400);
    });

    it("rejects overlong keys", () => {
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: { ["k".repeat(129)]: 1 }, value: null }), 400);
    });

    it("rejects keys starting with $", () => {
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: { $reserved: 1 }, value: null }), 400);
      // ... also when nested.
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: { nested: { $reserved: 1 } }, value: null }), 400);
    });

    it("rejects keys containing control characters", () => {
      const nul = String.fromCharCode(0);
      const del = String.fromCharCode(127);
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: { [`a${nul}b`]: 1 }, value: null }), 400);
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: { [`a${del}b`]: 1 }, value: null }), 400);
    });

    it("rejects non-finite numbers nested inside properties", () => {
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: { a: NaN }, value: null }), 400);
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: { a: [Infinity] }, value: null }), 400);
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: { a: { b: -Infinity } }, value: null }), 400);
    });

    it("rejects properties serializing to more than the byte limit", () => {
      expectStatusError(() => validateCustomEventPayload({
        eventName: "e",
        properties: { big: "x".repeat(MAX_CUSTOM_EVENT_PROPERTIES_BYTES + 1) },
        value: null,
      }), 400);
    });

    it("accepts nested arrays and objects within the limits", () => {
      const result = validateCustomEventPayload({
        eventName: "checkout",
        properties: {
          items: [
            { sku: "sku_1", price: 10 },
            { sku: "sku_2", price: -2.5 },
          ],
          tags: ["a", "b", null, true],
          meta: { source: "web" },
        },
        value: null,
      });
      expect(result.value).toBeNull();
      expect(result.properties["tags"]).toEqual(["a", "b", null, true]);
    });

    it("rejects non-JSON values inside properties", () => {
      expectStatusError(() => validateCustomEventPayload({ eventName: "e", properties: { fn: () => 1 }, value: null }), 400);
    });
  });

  it("rejects invalid event names with a 400", () => {
    expectStatusError(() => validateCustomEventPayload({ eventName: "$reserved", properties: {}, value: null }), 400);
    expectStatusError(() => validateCustomEventPayload({ eventName: "", properties: {}, value: null }), 400);
  });
});
