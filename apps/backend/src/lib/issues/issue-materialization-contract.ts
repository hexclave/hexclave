import type { GroupingConfigId } from "./grouping-config";
import type { GroupingHashProvenance } from "./types";

export type IssueBatchDelta = {
  ownerHash: string,
  aliasHashes: string[],
  occurrenceId?: string,
  groupingConfigId: GroupingConfigId,
  groupingProvenance: GroupingHashProvenance[],
  type: string,
  value: string,
  culprit: string,
  platform: string,
  count: number,
  firstEventAt: Date,
  lastEventAt: Date,
  serviceName: string | null,
  deploymentEnvironmentName: string | null,
  release: string | null,
  level: string,
  handled: boolean,
  synthetic: boolean,
};
