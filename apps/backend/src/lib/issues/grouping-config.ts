export const GROUPING_CONFIG_IDS = ["hexclave-js:2026-08-01", "hexclave-js:2026-08-20"] as const;

export type GroupingConfigId = typeof GROUPING_CONFIG_IDS[number];

export type GroupingConfig = {
  id: GroupingConfigId,
  introducedAt: string,
  description: string,
};

export const GROUPING_CONFIGS: ReadonlyMap<GroupingConfigId, GroupingConfig> = new Map<GroupingConfigId, GroupingConfig>([
  [
    "hexclave-js:2026-08-01",
    {
      id: "hexclave-js:2026-08-01",
      introducedAt: "2026-08-01",
      description: "Initial JS/Node grouping: exception type + normalized stack frames, app/system variants, length-prefixed SHA-256 leaves.",
    },
  ],
  [
    "hexclave-js:2026-08-20",
    {
      id: "hexclave-js:2026-08-20",
      introducedAt: "2026-08-20",
      description: "JS/Node grouping with checkout-root-independent source paths so same-named files in different directories remain distinct.",
    },
  ],
]);

export const DEFAULT_GROUPING_CONFIG_ID: GroupingConfigId = "hexclave-js:2026-08-01";

export type GroupingRuntimeConfig = {
  activeConfigId?: string,
  readableConfigIds?: Readonly<Record<string, { enabled?: boolean } | undefined>>,
};

export type GroupingConfigResolutionSource = "default" | "configured";

export type GroupingConfigResolution = {
  activeConfigId: GroupingConfigId,
  readableConfigIds: GroupingConfigId[],
  provenance: {
    active: GroupingConfigResolutionSource,
    readable: GroupingConfigResolutionSource,
  },
};

export function isGroupingConfigId(value: unknown): value is GroupingConfigId {
  return typeof value === "string" && GROUPING_CONFIG_IDS.some((id): boolean => id === value);
}

export function resolveGroupingConfig(settings: GroupingRuntimeConfig | undefined): GroupingConfigResolution {
  const configuredActive = settings?.activeConfigId;
  const activeConfigId = resolveActiveGroupingConfigId(settings);

  // Readable ids only widen lookups, so retired ids are ignored rather than failing ingestion.
  const configuredReadable = settings?.readableConfigIds;

  const activeIds = new Set<GroupingConfigId>([activeConfigId]);
  const readableConfigIds = configuredReadable === undefined
    ? [...GROUPING_CONFIG_IDS].reverse().filter((id) => !activeIds.has(id))
    : [...GROUPING_CONFIG_IDS]
      .reverse()
      .filter((id) => !activeIds.has(id) && configuredReadable[id]?.enabled === true);

  return {
    activeConfigId,
    readableConfigIds,
    provenance: {
      active: configuredActive === undefined ? "default" : "configured",
      readable: configuredReadable === undefined ? "default" : "configured",
    },
  };
}

export function resolveActiveGroupingConfigId(settings: GroupingRuntimeConfig | undefined): GroupingConfigId {
  const configured = settings?.activeConfigId;
  if (configured === undefined) return DEFAULT_GROUPING_CONFIG_ID;
  if (!isGroupingConfigId(configured)) {
    throw new Error(`Unknown active grouping config id ${JSON.stringify(configured)}`);
  }
  return configured;
}
