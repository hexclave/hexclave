import { Buffer } from "node:buffer";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import {
  isErrorIngestScrubbedRecord,
  scrubErrorIngestPayload,
  type ErrorIngestScrubbedValue,
  type ErrorIngestScrubOverrides,
} from "./error-ingest-scrubber";
import type { ErrorIngestItemType } from "./error-ingest-outcomes";

const MAX_OVERRIDE_KEYS = 32;
const MAX_OVERRIDE_KEY_BYTES = 96;
const SAFE_OVERRIDE_KEY = /^(?:user\.(?:email|username|ip_address)|request\.url|url|tags\.[a-zA-Z0-9_.-]{1,64}|contexts\.[a-zA-Z0-9_.-]{1,64}|extra\.[a-zA-Z0-9_.-]{1,64})$/;
const SAFE_OVERRIDE_RULE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export type ErrorIngestPolicyConfig = {
  finalScrub: ErrorIngestScrubOverrides,
};

export type ErrorIngestPolicyItem = {
  itemId: string,
  itemType: Extract<ErrorIngestItemType, "event" | "log" | "span">,
  data: unknown,
};

// Policy only scrubs or rejects invalid payloads. Sentry statuses such as
// rate_limited stay on the protocol outcome union for inbound client reports.
export type ErrorIngestPolicyItemOutcome = {
  itemId: string,
  itemType: Extract<ErrorIngestItemType, "event" | "log" | "span">,
  scrubbed: boolean,
  scrubbedBytes: number,
} & (
  | { status: "accepted" }
  | { status: "rejected", reason: "invalid" }
);

export type ErrorIngestPolicyDecision = {
  acceptedItemIds: readonly string[],
  scrubbedData: ReadonlyMap<string, { [key: string]: ErrorIngestScrubbedValue }>,
  outcomes: readonly ErrorIngestPolicyItemOutcome[],
};

export class ErrorIngestPolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErrorIngestPolicyConfigError";
  }
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ErrorIngestPolicyConfigError(`${field} must be an object`);
  return value;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) throw new ErrorIngestPolicyConfigError(`Unsupported ${field} policy field`);
  }
}

function parseOverrideKeys(value: unknown, field: "dropKeys" | "urlKeys"): readonly string[] {
  if (value === undefined) return [];
  const record = requiredRecord(value, `observability.errorIngest.finalScrub.${field}`);
  const entries = Object.entries(record);
  if (entries.length > MAX_OVERRIDE_KEYS) {
    throw new ErrorIngestPolicyConfigError("Too many error-ingest scrub override keys");
  }
  const keys = new Set<string>();
  for (const [ruleId, selector] of entries) {
    if (!SAFE_OVERRIDE_RULE_ID.test(ruleId)) {
      throw new ErrorIngestPolicyConfigError("Error-ingest scrub override rule ids must be short dotless identifiers");
    }
    if (typeof selector !== "string" || Buffer.byteLength(selector, "utf8") > MAX_OVERRIDE_KEY_BYTES || !SAFE_OVERRIDE_KEY.test(selector)) {
      throw new ErrorIngestPolicyConfigError("Unsupported error-ingest scrub override key");
    }
    if (field === "dropKeys" && selector === "url") {
      throw new ErrorIngestPolicyConfigError("The url selector is only valid for URL scrubbing");
    }
    keys.add(selector);
  }
  return [...keys].sort();
}

function defaultPolicyConfig(): ErrorIngestPolicyConfig {
  return {
    finalScrub: {},
  };
}

export function parseErrorIngestPolicyConfig(config: unknown): ErrorIngestPolicyConfig {
  if (config === undefined) return defaultPolicyConfig();
  if (!isRecord(config)) throw new ErrorIngestPolicyConfigError("observability config must be an object");
  const observability = config.observability;
  if (observability === undefined) return defaultPolicyConfig();
  const observabilityRecord = requiredRecord(observability, "observability");
  const rawPolicy = observabilityRecord.errorIngest;
  if (rawPolicy === undefined) return defaultPolicyConfig();
  const policy = requiredRecord(rawPolicy, "observability.errorIngest");
  const finalScrub = policy.finalScrub === undefined
    ? {}
    : requiredRecord(policy.finalScrub, "observability.errorIngest.finalScrub");
  rejectUnknownKeys(policy, ["finalScrub"], "error-ingest");
  rejectUnknownKeys(finalScrub, ["dropKeys", "urlKeys"], "finalScrub");
  return {
    finalScrub: {
      dropKeys: parseOverrideKeys(finalScrub.dropKeys, "dropKeys"),
      urlKeys: parseOverrideKeys(finalScrub.urlKeys, "urlKeys"),
    },
  };
}

export function evaluateErrorIngestPolicy(options: {
  config: unknown,
  items: readonly ErrorIngestPolicyItem[],
}): ErrorIngestPolicyDecision {
  const config = parseErrorIngestPolicyConfig(options.config);
  const outcomes: ErrorIngestPolicyItemOutcome[] = [];
  const acceptedItemIds: string[] = [];
  const scrubbedData = new Map<string, { [key: string]: ErrorIngestScrubbedValue }>();

  for (const item of options.items) {
    const scrubbed = scrubErrorIngestPayload(item.data, { overrides: config.finalScrub });
    if (!isErrorIngestScrubbedRecord(scrubbed.value)) {
      outcomes.push({
        itemId: item.itemId,
        itemType: item.itemType,
        status: "rejected",
        reason: "invalid",
        scrubbed: scrubbed.truncated,
        scrubbedBytes: 0,
      });
      continue;
    }

    acceptedItemIds.push(item.itemId);
    scrubbedData.set(item.itemId, scrubbed.value);
    outcomes.push({
      itemId: item.itemId,
      itemType: item.itemType,
      status: "accepted",
      scrubbed: scrubbed.truncated,
      scrubbedBytes: scrubbed.byteLength,
    });
  }

  return {
    acceptedItemIds,
    scrubbedData,
    outcomes,
  };
}
