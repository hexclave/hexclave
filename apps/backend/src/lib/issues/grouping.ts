import { createHash } from "node:crypto";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { GROUPING_CONFIG_IDS, type GroupingConfigId, type GroupingConfigResolution } from "./grouping-config";
import { GroupingParseError, resolveGroupingFingerprint } from "./grouping-fingerprint";
import { parameterizeMessage } from "./parameterize";
import { parseStack, hasUrlOrigin, normalizeFilenameForGrouping } from "./stack-parser";
import type { GroupingHashProvenance, GroupingInput, GroupingResult, ParsedFrame } from "./types";


const LEAF_SEPARATOR = "\u001F";

const HASH_HEX_LENGTH = 32;

const NON_CONTRIBUTING_FUNCTION_NAMES = new Set(["?", "<anonymous>", "<anonymous function>", "eval", "native"]);
const NON_CONTRIBUTING_FILENAMES = new Set(["<anonymous>", "[native code]", "native", "<unknown>"]);

type GroupingImplementation = (input: GroupingInput, configId: GroupingConfigId) => GroupingResult;

const GROUPING_IMPLEMENTATIONS_BY_ID: Record<GroupingConfigId, GroupingImplementation> = {
  "hexclave-js:2026-08-01": computeGroupingHexclaveJs,
  "hexclave-js:2026-08-20": computeGroupingHexclaveJs,
};

const GROUPING_IMPLEMENTATIONS: ReadonlyMap<GroupingConfigId, GroupingImplementation> = new Map(
  GROUPING_CONFIG_IDS.map((id) => [id, GROUPING_IMPLEMENTATIONS_BY_ID[id]] as const),
);

export function computeGrouping(input: GroupingInput, configId: GroupingConfigId): GroupingResult {
  const implementation = GROUPING_IMPLEMENTATIONS.get(configId)
    ?? throwErr(`Unknown grouping config id ${JSON.stringify(configId)}; the caller must resolve a config from GROUPING_CONFIG_IDS before grouping.`);

  try {
    return implementation(input, configId);
  } catch (error) {
    if (error instanceof GroupingParseError) {
      return degradedResult(input, configId);
    }
    throw error;
  }
}

export function computeGroupingWithReadableConfigs(input: GroupingInput, resolution: GroupingConfigResolution): GroupingResult {
  const primary = computeGrouping(input, resolution.activeConfigId);
  const aliasHashes = [...primary.aliasHashes];
  const secondaryProvenance = [...primary.secondaryProvenance];
  const knownHashes = new Set<string>([primary.ownerHash, ...aliasHashes]);

  for (const readableConfigId of resolution.readableConfigIds) {
    const historical = computeGrouping(input, readableConfigId);
    for (const provenance of getGroupingHashProvenance(historical)) {
      if (knownHashes.has(provenance.hash)) continue;
      knownHashes.add(provenance.hash);
      aliasHashes.push(provenance.hash);
      secondaryProvenance.push({ ...provenance, role: "secondary" });
    }
  }

  return { ...primary, aliasHashes, secondaryProvenance };
}

function computeGroupingHexclaveJs(input: GroupingInput, configId: GroupingConfigId): GroupingResult {
  const frames = input.stack === null ? [] : parseStack(input.stack, input.platform);
  const defaultResult = computeDefaultGrouping(input, configId, frames);
  const fingerprint = resolveGroupingFingerprint(input.fingerprint, input, frames);

  if (fingerprint.provenance.type === "default") {
    return {
      ...defaultResult,
      provenance: { configId, fingerprint: fingerprint.provenance },
      secondaryProvenance: defaultResult.aliasHashes.map((hash): GroupingHashProvenance => ({
        hash,
        role: "secondary",
        configId,
        variant: "system",
        fingerprint: fingerprint.provenance,
      })),
    };
  }

  const fingerprintLeaves = fingerprint.provenance.type === "hybrid"
    ? ["custom-fingerprint", defaultResult.ownerHash, ...fingerprint.resolvedValues]
    : ["custom-fingerprint", ...fingerprint.resolvedValues];

  return {
    ...defaultResult,
    ownerHash: hashLeaves(fingerprintLeaves),
    aliasHashes: [],
    variant: "custom",
    provenance: { configId, fingerprint: fingerprint.provenance },
    secondaryProvenance: [],
  };
}

type DefaultGroupingResult = Omit<GroupingResult, "provenance" | "secondaryProvenance">;

export function getGroupingHashProvenance(grouping: GroupingResult): GroupingHashProvenance[] {
  return [
    {
      hash: grouping.ownerHash,
      role: "primary",
      configId: grouping.provenance.configId,
      variant: grouping.variant,
      fingerprint: grouping.provenance.fingerprint,
    },
    ...grouping.secondaryProvenance,
  ];
}

function computeDefaultGrouping(input: GroupingInput, configId: GroupingConfigId, frames: ParsedFrame[]): DefaultGroupingResult {
  const culprit = deriveCulprit(frames);

  if (input.synthetic === true) {
    const topFrame = frames.at(-1);
    const leaves = [
      "synthetic",
      parameterizeMessage(input.message),
      topFrame === undefined ? "" : frameFileLeaf(topFrame, configId) ?? "",
    ];
    return {
      configId,
      ownerHash: hashLeaves(leaves),
      aliasHashes: [],
      variant: "message",
      culprit,
      frames,
    };
  }

  const systemTuples = collapseConsecutive(frames.map((frame) => frameLeafTuple(frame, configId)));
  const systemFrameLeaves = systemTuples.flat();

  const appTuples = collapseConsecutive(frames.map((frame) => frame.inApp ? frameLeafTuple(frame, configId) : []));
  const appFrameLeaves = appTuples.flat();

  const systemHash = hashLeaves(buildLeaves(input, systemFrameLeaves));

  if (systemFrameLeaves.length === 0) {
    return { configId, ownerHash: systemHash, aliasHashes: [], variant: "message", culprit, frames };
  }

  const hasAppVariant = frames.some((frame) => frame.inApp) && appFrameLeaves.length > 0;
  const appHash = hasAppVariant ? hashLeaves(buildLeaves(input, appFrameLeaves)) : null;

  const appVariantWins = appHash !== null && appHash !== systemHash;

  return {
    configId,
    ownerHash: appVariantWins ? appHash : systemHash,
    aliasHashes: appVariantWins ? [systemHash] : [],
    variant: appVariantWins ? "app" : "system",
    culprit,
    frames,
  };
}

function buildLeaves(input: GroupingInput, frameLeaves: string[]): string[] {
  if (frameLeaves.length === 0) return [input.type, parameterizeMessage(input.message)];
  return [input.type, ...frameLeaves];
}

function frameLeafTuple(frame: ParsedFrame, configId: GroupingConfigId): string[] {
  const tuple: string[] = [];

  const fileLeaf = frameFileLeaf(frame, configId);
  if (fileLeaf !== null) tuple.push(fileLeaf);

  const functionLeaf = frameFunctionLeaf(frame);
  if (functionLeaf !== null) tuple.push(functionLeaf);

  return tuple;
}

function frameFileLeaf(frame: ParsedFrame, configId: GroupingConfigId): string | null {
  if (frame.module !== null && frame.module !== "") return frame.module;

  const filename = frame.filename;
  if (filename === null || filename === "") return null;

  const normalizedPath = filename.replaceAll("\\", "/");
  const pathSegments = normalizedPath.split("/").filter((segment) => segment !== "");
  const basename = pathSegments.at(-1)?.toLowerCase() ?? "";
  if (basename === "") return null;
  if (NON_CONTRIBUTING_FILENAMES.has(basename)) return null;
  if (frame.absPath !== null && hasUrlOrigin(frame.absPath)) return null;

  // The initial config used only a basename for server frames. Keep that
  // behavior immutable so existing IssueHash rows remain readable.
  if (configId === "hexclave-js:2026-08-01") return normalizeFilenameForGrouping(basename);

  if (frame.absPath !== null && !hasUrlOrigin(frame.absPath)) {
    const workspaceRoot = pathSegments.findIndex((segment) => segment === "apps" || segment === "packages" || segment === "node_modules");
    const sourceRoot = pathSegments.findLastIndex((segment) => segment === "app" || segment === "build" || segment === "dist" || segment === "lib" || segment === "server" || segment === "src");
    const stableRoot = workspaceRoot === -1 ? sourceRoot : workspaceRoot;
    const stableSegments = stableRoot === -1 ? pathSegments.slice(-3) : pathSegments.slice(stableRoot);
    const lastIndex = stableSegments.length - 1;
    const last = stableSegments.at(lastIndex);
    if (last !== undefined) stableSegments[lastIndex] = normalizeFilenameForGrouping(last.toLowerCase());
    return stableSegments.join("/");
  }

  return normalizeFilenameForGrouping(basename);
}

function frameFunctionLeaf(frame: ParsedFrame): string | null {
  const func = frame.function;
  if (func === null || func === "") return null;

  const tail = func.split(".").at(-1) ?? func;
  if (tail === "") return null;
  if (NON_CONTRIBUTING_FUNCTION_NAMES.has(tail)) return null;
  if (tail.endsWith("/<")) return null;

  return tail;
}

function collapseConsecutive(tuples: string[][]): string[][] {
  const collapsed: string[][] = [];
  for (const tuple of tuples) {
    const previous = collapsed.at(-1);
    if (previous !== undefined && previous.length === tuple.length && previous.every((leaf, index) => leaf === tuple.at(index))) {
      continue;
    }
    collapsed.push(tuple);
  }
  return collapsed;
}

function deriveCulprit(frames: ParsedFrame[]): string {
  const frame = [...frames].reverse().find((candidate) => candidate.inApp) ?? frames.at(-1);
  if (frame === undefined) return "<unknown>";
  const location = frame.filename ?? frame.absPath ?? "<unknown>";
  return frame.function === null ? location : `${frame.function} (${location})`;
}

function hashLeaves(leaves: string[]): string {
  const digest = createHash("sha256");
  for (const leaf of leaves) {
    digest.update(String(leaf.length));
    digest.update(LEAF_SEPARATOR);
    digest.update(leaf, "utf8");
  }
  return digest.digest("hex").slice(0, HASH_HEX_LENGTH);
}

function degradedResult(input: GroupingInput, configId: GroupingConfigId): GroupingResult {
  let parameterized: string;
  try {
    parameterized = parameterizeMessage(input.message);
  } catch {
    parameterized = "";
  }
  return {
    configId,
    ownerHash: hashLeaves([input.type, parameterized]),
    aliasHashes: [],
    variant: "degraded",
    culprit: "<unknown>",
    frames: [],
    provenance: {
      configId,
      fingerprint: {
        type: input.fingerprint === undefined || input.fingerprint.length === 0 ? "default" : "custom",
        source: "degraded",
        tokens: input.fingerprint === undefined ? [] : [...input.fingerprint],
        resolvedTokens: [],
      },
    },
    secondaryProvenance: [],
  };
}
