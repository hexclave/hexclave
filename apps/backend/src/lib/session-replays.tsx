import { PrismaClient } from "@/generated/prisma/client";
import { PrismaClientWithReplica } from "@/prisma-client";
import { throwErr } from "@hexclave/shared/dist/utils/errors";

export const SESSION_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
export const MAX_SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

export async function findRecentSessionReplay(prisma: PrismaClientWithReplica<PrismaClient>, options: {
  tenancyId: string,
  refreshTokenId: string,
  projectUserId?: string,
}) {
  const cutoff = new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS);
  const maxDurationCutoff = new Date(Date.now() - MAX_SESSION_DURATION_MS);
  return await prisma.sessionReplay.findFirst({
    where: {
      tenancyId: options.tenancyId,
      refreshTokenId: options.refreshTokenId,
      ...options.projectUserId !== undefined ? { projectUserId: options.projectUserId } : {},
      updatedAt: { gte: cutoff },
      startedAt: { gte: maxDurationCutoff },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, startedAt: true, lastEventAt: true },
  });
}

export async function aggregateSessionReplaySegmentBounds(prisma: Omit<PrismaClient, "$on">, options: {
  tenancyId: string,
  sessionReplayId: string,
  sessionReplaySegmentId: string,
}): Promise<{ firstEventAt: Date, lastEventAt: Date }> {
  // Callers must pass the primary client that just wrote the chunk. A replica can miss it under replication lag.
  const aggregated = await prisma.sessionReplayChunk.aggregate({
    where: {
      tenancyId: options.tenancyId,
      sessionReplayId: options.sessionReplayId,
      sessionReplaySegmentId: options.sessionReplaySegmentId,
    },
    _min: { firstEventAt: true },
    _max: { lastEventAt: true },
  });
  const firstEventAt = aggregated._min.firstEventAt ?? throwErr("aggregateSessionReplaySegmentBounds: missing firstEventAt after writing a SessionReplayChunk for this segment");
  const lastEventAt = aggregated._max.lastEventAt ?? throwErr("aggregateSessionReplaySegmentBounds: missing lastEventAt after writing a SessionReplayChunk for this segment");
  return { firstEventAt, lastEventAt };
}
