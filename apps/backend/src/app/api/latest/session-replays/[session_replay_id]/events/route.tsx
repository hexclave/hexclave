import { generatePreviewReplayEvents, isPreviewModeEnabled } from "@/lib/preview-mode";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { downloadBytes } from "@/s3";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupArray, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { promisify } from "node:util";
import { gunzip as gunzipCb } from "node:zlib";

const gunzip = promisify(gunzipCb);

const S3_CONCURRENCY = 10;

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Get session replay events",
    description: "Returns chunks of a session replay together with their raw rrweb events, in a single request. Use the offset and limit parameters to page through a long recording.",
    tags: ["Session Replays"],
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      session_replay_id: yupString().uuid().defined(),
    }).defined(),
    query: yupObject({
      offset: yupString().optional(),
      limit: yupString().optional(),
    }).optional(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      chunks: yupArray(yupObject({
        id: yupString().defined(),
        batch_id: yupString().defined(),
        session_replay_segment_id: yupString().nullable().defined(),
        event_count: yupNumber().defined(),
        byte_length: yupNumber().defined(),
        first_event_at_millis: yupNumber().defined(),
        last_event_at_millis: yupNumber().defined(),
        created_at_millis: yupNumber().defined(),
      }).defined()).defined(),
      chunk_events: yupArray(yupObject({
        chunk_id: yupString().defined(),
        events: yupArray(yupMixed().defined()).defined(),
      }).defined()).defined(),
    }).defined(),
  }),
  async handler({ auth, params, query }) {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    const sessionReplayId = params.session_replay_id;
    const exists = await prisma.sessionReplay.findUnique({
      where: { tenancyId_id: { tenancyId: auth.tenancy.id, id: sessionReplayId } },
      select: { id: true },
    });
    if (!exists) {
      throw new KnownErrors.ItemNotFound(sessionReplayId);
    }

    const chunks = await prisma.sessionReplayChunk.findMany({
      where: {
        tenancyId: auth.tenancy.id,
        sessionReplayId,
      },
      orderBy: [{ firstEventAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        batchId: true,
        sessionReplaySegmentId: true,
        eventCount: true,
        byteLength: true,
        firstEventAt: true,
        lastEventAt: true,
        createdAt: true,
        s3Key: true,
      },
    });

    // Determine the slice of chunks to download events for.
    const parsedOffset = query.offset != null ? Number.parseInt(query.offset, 10) : 0;
    const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
    const parsedLimit = query.limit != null ? Number.parseInt(query.limit, 10) : chunks.length;
    const limit = Number.isFinite(parsedLimit) && parsedLimit >= 1 ? parsedLimit : chunks.length;
    const sliceEnd = Math.min(offset + limit, chunks.length);
    const chunksToDownload = chunks.slice(offset, sliceEnd);

    // Download and decompress S3 objects only for the requested range.
    const chunkEvents: Array<{ chunk_id: string, events: any[] }> = new Array(chunksToDownload.length);
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < chunksToDownload.length) {
        const idx = nextIndex++;
        const chunk = chunksToDownload[idx];

        let events: any[];

        if (isPreviewModeEnabled() && chunk.s3Key.startsWith("preview://")) {
          // In preview mode, return canned replay events instead of downloading from S3
          events = generatePreviewReplayEvents(chunk.firstEventAt.getTime());
        } else {
          let bytes: Uint8Array;
          try {
            bytes = await downloadBytes({ key: chunk.s3Key, private: true });
          } catch (e: any) {
            const status = e?.$metadata?.httpStatusCode;
            if (status === 404) {
              throw new KnownErrors.ItemNotFound(chunk.id);
            }
            throw e;
          }
          const unzipped = new Uint8Array(await gunzip(bytes));

          let parsed: any;
          try {
            parsed = JSON.parse(new TextDecoder().decode(unzipped));
          } catch (e) {
            throw new HexclaveAssertionError("Failed to decode session replay chunk JSON", { cause: e });
          }

          if (typeof parsed !== "object" || parsed === null) {
            throw new HexclaveAssertionError("Decoded session replay chunk is not an object");
          }
          if (parsed.session_replay_id !== sessionReplayId) {
            throw new HexclaveAssertionError("Decoded session replay chunk session_replay_id mismatch", {
              expected: sessionReplayId,
              actual: parsed.session_replay_id,
            });
          }
          if (!Array.isArray(parsed.events)) {
            throw new HexclaveAssertionError("Decoded session replay chunk events is not an array");
          }
          events = parsed.events as any[];
        }

        chunkEvents[idx] = { chunk_id: chunk.id, events };
      }
    }

    const workers = Array.from(
      { length: Math.min(S3_CONCURRENCY, chunksToDownload.length) },
      () => worker(),
    );
    await Promise.all(workers);

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        chunks: chunks.map((c) => ({
          id: c.id,
          batch_id: c.batchId,
          session_replay_segment_id: c.sessionReplaySegmentId,
          event_count: c.eventCount,
          byte_length: c.byteLength,
          first_event_at_millis: c.firstEventAt.getTime(),
          last_event_at_millis: c.lastEventAt.getTime(),
          created_at_millis: c.createdAt.getTime(),
        })),
        chunk_events: chunkEvents,
      },
    };
  },
});
