import { StatusError } from "@hexclave/shared/dist/utils/errors";

/**
 * Validation for customer-defined analytics events ("custom events"), ingested
 * through POST /api/latest/analytics/events/batch alongside the reserved
 * auto-capture events. Custom events are what experiment metrics attribute
 * conversions from, so their names must stay disjoint from the reserved
 * ($-prefixed) namespace — a customer must never be able to inject e.g.
 * $feature-flag-exposure rows through the public ingestion route.
 *
 * All limits here are deliberately strict: ClickHouse stores the payload as
 * JSON and every analytics query pays for oversized/deeply-nested blobs
 * forever, so we bound name length, property depth, property count, and total
 * serialized bytes at ingest and reject (never truncate) anything beyond them.
 */

export const MAX_CUSTOM_EVENT_NAME_LENGTH = 128;
export const MAX_CUSTOM_EVENT_PROPERTY_DEPTH = 4;
export const MAX_CUSTOM_EVENT_PROPERTY_COUNT = 200;
export const MAX_CUSTOM_EVENT_PROPERTY_KEY_LENGTH = 128;
export const MAX_CUSTOM_EVENT_PROPERTIES_BYTES = 32 * 1024;

// C0 control characters (code points 0-31) and DEL (127); names/keys
// containing these are rejected so they stay unambiguous in query results and
// logs. Implemented via char codes rather than a regex character class so the
// source file contains no literal or escaped control characters.
function containsControlChars(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function isReservedEventName(name: string): boolean {
  return name.startsWith("$");
}

export function getCustomEventNameError(name: string): string | null {
  if (name.length < 1 || name.length > MAX_CUSTOM_EVENT_NAME_LENGTH) {
    return `Event names must be between 1 and ${MAX_CUSTOM_EVENT_NAME_LENGTH} characters long`;
  }
  if (isReservedEventName(name)) {
    return "Event names starting with $ are reserved for Hexclave system events";
  }
  if (containsControlChars(name)) {
    return "Event names must not contain control characters";
  }
  if (name !== name.trim()) {
    return "Event names must not start or end with whitespace";
  }
  return null;
}

type ValidatedCustomEventPayload = {
  properties: Record<string, unknown>,
  value: number | null,
};

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the payload of a single custom event. `properties` must be a flat
 * or shallowly-nested JSON object within the depth/count/byte limits above;
 * `value` (optional) must be a finite number — it is the per-event numeric
 * observation used by numeric experiment metrics (e.g. revenue).
 *
 * Throws StatusError(400) with a customer-safe message on any violation.
 */
export function validateCustomEventPayload(options: {
  eventName: string,
  properties: unknown,
  value: unknown,
}): ValidatedCustomEventPayload {
  const nameError = getCustomEventNameError(options.eventName);
  if (nameError != null) {
    throw new StatusError(StatusError.BadRequest, nameError);
  }

  if (options.value !== undefined && options.value !== null) {
    // Number.isFinite also rejects NaN and non-number types (booleans/strings
    // are not coerced) — infinities and NaN are not representable in JSON and
    // would break sum/avg aggregations downstream.
    if (typeof options.value !== "number" || !Number.isFinite(options.value)) {
      throw new StatusError(StatusError.BadRequest, `Event ${JSON.stringify(options.eventName)}: value must be a finite number`);
    }
  }

  const properties = options.properties ?? {};
  if (!isPlainJsonObject(properties)) {
    throw new StatusError(StatusError.BadRequest, `Event ${JSON.stringify(options.eventName)}: properties must be a JSON object`);
  }

  let propertyCount = 0;
  const countProperty = (): void => {
    // Count during traversal so a wide object cannot force us to walk every
    // sibling after the 200-value cap before rejecting.
    propertyCount++;
    if (propertyCount > MAX_CUSTOM_EVENT_PROPERTY_COUNT) {
      throw new StatusError(StatusError.BadRequest, `Event ${JSON.stringify(options.eventName)}: properties must contain at most ${MAX_CUSTOM_EVENT_PROPERTY_COUNT} values`);
    }
  };
  const validateNode = (node: unknown, depth: number): void => {
    if (depth > MAX_CUSTOM_EVENT_PROPERTY_DEPTH) {
      throw new StatusError(StatusError.BadRequest, `Event ${JSON.stringify(options.eventName)}: properties must not be nested deeper than ${MAX_CUSTOM_EVENT_PROPERTY_DEPTH} levels`);
    }
    if (node === null || typeof node === "string" || typeof node === "boolean") {
      return;
    }
    if (typeof node === "number") {
      if (!Number.isFinite(node)) {
        throw new StatusError(StatusError.BadRequest, `Event ${JSON.stringify(options.eventName)}: property numbers must be finite`);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        countProperty();
        validateNode(item, depth + 1);
      }
      return;
    }
    if (typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (key.length < 1 || key.length > MAX_CUSTOM_EVENT_PROPERTY_KEY_LENGTH) {
          throw new StatusError(StatusError.BadRequest, `Event ${JSON.stringify(options.eventName)}: property keys must be between 1 and ${MAX_CUSTOM_EVENT_PROPERTY_KEY_LENGTH} characters long`);
        }
        if (key.startsWith("$")) {
          throw new StatusError(StatusError.BadRequest, `Event ${JSON.stringify(options.eventName)}: property keys starting with $ are reserved`);
        }
        if (containsControlChars(key)) {
          throw new StatusError(StatusError.BadRequest, `Event ${JSON.stringify(options.eventName)}: property keys must not contain control characters`);
        }
        countProperty();
        validateNode(child, depth + 1);
      }
      return;
    }
    // Functions, symbols, bigints, undefined-in-arrays, ... — anything JSON.parse can't produce.
    throw new StatusError(StatusError.BadRequest, `Event ${JSON.stringify(options.eventName)}: properties must only contain JSON values`);
  };
  validateNode(properties, 1);

  const serialized = JSON.stringify(properties);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CUSTOM_EVENT_PROPERTIES_BYTES) {
    throw new StatusError(StatusError.BadRequest, `Event ${JSON.stringify(options.eventName)}: properties must serialize to at most ${MAX_CUSTOM_EVENT_PROPERTIES_BYTES} bytes`);
  }

  return {
    properties,
    value: typeof options.value === "number" ? options.value : null,
  };
}
