import { utf8ByteLength } from "@/lib/utf8";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { parameterizeMessage } from "./parameterize";
import type {
  GroupingFingerprintProvenance,
  GroupingFingerprintType,
  GroupingInput,
  ParsedFrame,
} from "./types";

export const GROUPING_FINGERPRINT_TOKENS = [
  "{{ default }}",
  "{{ type }}",
  "{{ message }}",
  "{{ stack }}",
  "{{ stack.function }}",
  "{{ stack.filename }}",
  "{{ stack.abs_path }}",
  "{{ stack.module }}",
] as const;

export type GroupingFingerprintToken = typeof GROUPING_FINGERPRINT_TOKENS[number];

type GroupingFingerprintTokenName =
  | "default"
  | "type"
  | "message"
  | "stack"
  | "stack.function"
  | "stack.filename"
  | "stack.abs_path"
  | "stack.module";

export type GroupingFingerprintResolution = {
  provenance: GroupingFingerprintProvenance,
  resolvedValues: string[],
};

export const MAX_GROUPING_FINGERPRINT_TOKENS = 32;
export const MAX_GROUPING_FINGERPRINT_TOKEN_BYTES = 512;
export const MAX_GROUPING_FINGERPRINT_PROVENANCE_BYTES = 64 * 1024;

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_GROUPING_FINGERPRINT_TOKENS) return undefined;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    if (utf8ByteLength(item) > MAX_GROUPING_FINGERPRINT_TOKEN_BYTES) return undefined;
    result.push(item);
  }
  return result;
}

export function readGroupingFingerprint(data: unknown): readonly string[] | undefined {
  if (!isRecord(data)) return undefined;
  const rawOverride = data.fingerprint_override;
  if (rawOverride !== undefined) {
    return readStringArray(rawOverride);
  }
  return readStringArray(data.fingerprint);
}

export function classifyGroupingFingerprint(fingerprint: readonly string[] | undefined): GroupingFingerprintType {
  if (fingerprint === undefined || fingerprint.length === 0) return "default";

  let hasDefault = false;
  for (const value of fingerprint) {
    if (parseTokenName(value) === "default") hasDefault = true;
  }

  if (!hasDefault) return "custom";
  return fingerprint.length === 1 ? "default" : "hybrid";
}

export function resolveGroupingFingerprint(
  fingerprint: readonly string[] | undefined,
  input: GroupingInput,
  frames: readonly ParsedFrame[],
): GroupingFingerprintResolution {
  const tokens = fingerprint === undefined ? [] : [...fingerprint];
  const type = classifyGroupingFingerprint(fingerprint);
  const resolvedValues: string[] = [];

  for (const token of tokens) {
    const name = parseTokenName(token);
    if (name === null) {
      resolvedValues.push(token);
      continue;
    }
    if (name === "default") continue;
    resolvedValues.push(resolveToken(name, token, input, frames));
  }

  const durableFingerprint = {
    type,
    source: type === "default" ? "default" : "event",
    tokens,
    resolved_tokens: resolvedValues,
  };
  if (utf8ByteLength(JSON.stringify(durableFingerprint)) > MAX_GROUPING_FINGERPRINT_PROVENANCE_BYTES) {
    return {
      resolvedValues: [],
      provenance: {
        type: "default",
        source: "degraded",
        tokens: [],
        resolvedTokens: [],
      },
    };
  }

  return {
    resolvedValues,
    provenance: {
      type,
      source: type === "default" ? "default" : "event",
      tokens,
      resolvedTokens: [...resolvedValues],
    },
  };
}

export class GroupingParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupingParseError";
  }
}

function parseTokenName(value: string): GroupingFingerprintTokenName | null {
  const match = /^\{\{\s*([^{}\s]+)\s*\}\}$/.exec(value);
  if (match === null) return null;

  const name = match[1];
  if (!isGroupingFingerprintTokenName(name)) {
    throw new GroupingParseError(`Unsupported grouping fingerprint token ${JSON.stringify(value)}`);
  }
  return name;
}

function isGroupingFingerprintTokenName(value: string): value is GroupingFingerprintTokenName {
  return GROUPING_FINGERPRINT_TOKENS.some((token) => token.slice(3, -3).trim() === value);
}

function resolveToken(
  name: GroupingFingerprintTokenName,
  originalToken: string,
  input: GroupingInput,
  frames: readonly ParsedFrame[],
): string {
  switch (name) {
    case "type": {
      return input.type;
    }
    case "message": {
      return parameterizeMessage(input.message);
    }
    case "stack": {
      return normalizedStackValue(frames);
    }
    case "stack.function": {
      return frames.at(-1)?.function ?? "<no-stack-function>";
    }
    case "stack.filename": {
      return frames.at(-1)?.filename ?? "<no-stack-filename>";
    }
    case "stack.abs_path": {
      return frames.at(-1)?.absPath ?? "<no-stack-abs-path>";
    }
    case "stack.module": {
      return frames.at(-1)?.module ?? "<no-stack-module>";
    }
    case "default": {
      throw new Error(`Unexpected default grouping fingerprint token ${JSON.stringify(originalToken)}`);
    }
  }
}

function normalizedStackValue(frames: readonly ParsedFrame[]): string {
  return JSON.stringify(frames.map((frame) => [
    frame.module ?? frame.filename ?? "<no-stack-filename>",
    frame.function ?? "<no-stack-function>",
    frame.inApp ? "app" : "system",
  ]));
}
