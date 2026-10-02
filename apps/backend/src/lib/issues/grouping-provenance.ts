import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { isGroupingConfigId } from "./grouping-config";
import type {
  GroupingFingerprintSource,
  GroupingFingerprintType,
  GroupingHashProvenance,
  GroupingVariant,
} from "./types";

export type DurableGroupingHashProvenance = {
  hash: string,
  role: "primary" | "secondary",
  config_id: string,
  variant: string,
  fingerprint: {
    type: string,
    source: string,
    tokens: string[],
    resolved_tokens: string[],
  },
};

export const MAX_GROUPING_PROVENANCE_ENTRIES = 16;

export function toDurableGroupingProvenance(
  provenance: readonly GroupingHashProvenance[],
): DurableGroupingHashProvenance[] {
  if (provenance.length > MAX_GROUPING_PROVENANCE_ENTRIES) {
    throw new Error(`Grouping provenance exceeds the ${MAX_GROUPING_PROVENANCE_ENTRIES}-entry limit`);
  }

  return provenance.map((entry) => ({
    hash: entry.hash,
    role: entry.role,
    config_id: entry.configId,
    variant: entry.variant,
    fingerprint: {
      type: entry.fingerprint.type,
      source: entry.fingerprint.source,
      tokens: [...entry.fingerprint.tokens],
      resolved_tokens: [...entry.fingerprint.resolvedTokens],
    },
  }));
}

export function serializeGroupingProvenance(
  provenance: readonly GroupingHashProvenance[],
): string {
  return JSON.stringify(toDurableGroupingProvenance(provenance));
}

const GROUPING_VARIANT_SET: Record<GroupingVariant, true> = { app: true, system: true, message: true, custom: true, degraded: true };
const GROUPING_FINGERPRINT_TYPE_SET: Record<GroupingFingerprintType, true> = { default: true, custom: true, hybrid: true };
const GROUPING_FINGERPRINT_SOURCE_SET: Record<GroupingFingerprintSource, true> = { default: true, event: true, degraded: true };

function isGroupingVariant(value: unknown): value is GroupingVariant {
  return typeof value === "string" && Object.hasOwn(GROUPING_VARIANT_SET, value);
}

function isGroupingFingerprintType(value: unknown): value is GroupingFingerprintType {
  return typeof value === "string" && Object.hasOwn(GROUPING_FINGERPRINT_TYPE_SET, value);
}

function isGroupingFingerprintSource(value: unknown): value is GroupingFingerprintSource {
  return typeof value === "string" && Object.hasOwn(GROUPING_FINGERPRINT_SOURCE_SET, value);
}


function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Stored grouping provenance has a malformed ${label} list`);
  return value.map((item) => typeof item === "string" ? item : throwErr(`Stored grouping provenance has a malformed ${label} list`));
}

export function parseDurableGroupingProvenance(raw: string): DurableGroupingHashProvenance[] {
  if (raw === "") {
    throw new Error("Stored grouping provenance is empty; every $error occurrence row carries issue_grouping_provenance at ingest");
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Stored grouping provenance must be a JSON array");
  if (parsed.length === 0 || parsed.length > MAX_GROUPING_PROVENANCE_ENTRIES) {
    throw new Error(`Stored grouping provenance must contain between 1 and ${MAX_GROUPING_PROVENANCE_ENTRIES} entries`);
  }

  return parsed.map((entry): DurableGroupingHashProvenance => {
    if (!isRecord(entry)) {
      throw new Error("Stored grouping provenance contains a malformed entry");
    }
    const fingerprint = entry.fingerprint;
    if (typeof entry.hash !== "string"
      || (entry.role !== "primary" && entry.role !== "secondary")
      || typeof entry.config_id !== "string"
      || typeof entry.variant !== "string"
      || !isRecord(fingerprint)) {
      throw new Error("Stored grouping provenance contains a malformed entry");
    }
    if (typeof fingerprint.type !== "string" || typeof fingerprint.source !== "string") {
      throw new Error("Stored grouping provenance contains a malformed entry");
    }
    return {
      hash: entry.hash,
      role: entry.role,
      config_id: entry.config_id,
      variant: entry.variant,
      fingerprint: {
        type: fingerprint.type,
        source: fingerprint.source,
        tokens: parseStringArray(fingerprint.tokens, "fingerprint token"),
        resolved_tokens: parseStringArray(fingerprint.resolved_tokens, "resolved fingerprint token"),
      },
    };
  });
}

export function fromDurableGroupingProvenance(
  entries: readonly DurableGroupingHashProvenance[],
): GroupingHashProvenance[] {
  return entries.map((entry): GroupingHashProvenance => ({
    hash: entry.hash,
    role: entry.role,
    configId: isGroupingConfigId(entry.config_id)
      ? entry.config_id
      : throwErr(`Stored grouping provenance references unknown config id ${JSON.stringify(entry.config_id)}; the caller must filter retired configs before converting`),
    variant: isGroupingVariant(entry.variant)
      ? entry.variant
      : throwErr(`Stored grouping provenance references unknown variant ${JSON.stringify(entry.variant)}`),
    fingerprint: {
      type: isGroupingFingerprintType(entry.fingerprint.type)
        ? entry.fingerprint.type
        : throwErr(`Stored grouping provenance references unknown fingerprint type ${JSON.stringify(entry.fingerprint.type)}`),
      source: isGroupingFingerprintSource(entry.fingerprint.source)
        ? entry.fingerprint.source
        : throwErr(`Stored grouping provenance references unknown fingerprint source ${JSON.stringify(entry.fingerprint.source)}`),
      tokens: [...entry.fingerprint.tokens],
      resolvedTokens: [...entry.fingerprint.resolved_tokens],
    },
  }));
}
