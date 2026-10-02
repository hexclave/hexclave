import type { GroupingConfigId } from "./grouping-config";

export type StackPlatform = "javascript" | "node";

export type ParsedFrame = {
  filename: string | null,
  function: string | null,
  module: string | null,
  absPath: string | null,
  lineno: number | null,
  colno: number | null,
  inApp: boolean,
  debugId?: string,
};

export type GroupingInput = {
  type: string,
  message: string,
  stack: string | null,
  platform: StackPlatform,
  fingerprint?: readonly string[],
  synthetic?: boolean,
};

export type GroupingFingerprintType = "default" | "custom" | "hybrid";

export type GroupingFingerprintSource = "default" | "event" | "degraded";

export type GroupingFingerprintProvenance = {
  type: GroupingFingerprintType,
  source: GroupingFingerprintSource,
  tokens: readonly string[],
  resolvedTokens: readonly string[],
};

export type GroupingProvenance = {
  configId: GroupingConfigId,
  fingerprint: GroupingFingerprintProvenance,
};

export type GroupingHashRole = "primary" | "secondary";

export type GroupingHashProvenance = GroupingProvenance & {
  hash: string,
  role: GroupingHashRole,
  variant: GroupingVariant,
};

export type GroupingVariant = "app" | "system" | "message" | "custom" | "degraded";

export type GroupingResult = {
  configId: GroupingConfigId,
  ownerHash: string,
  aliasHashes: string[],
  secondaryProvenance: GroupingHashProvenance[],
  variant: GroupingVariant,
  culprit: string,
  frames: ParsedFrame[],
  provenance: GroupingProvenance,
};
