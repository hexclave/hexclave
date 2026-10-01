import { getPrismaClientForTenancy } from "@/prisma-client";
import { downloadBytes } from "@/s3";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupArray, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { promisify } from "node:util";
import { gunzip as gunzipCb } from "node:zlib";

const gunzip = promisify(gunzipCb);

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Get session replay chunk events",
    description: "Returns the raw rrweb events for a single chunk of a session replay. These are the events a replay player consumes.",
    tags: ["Session Replays"],
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      session_replay_id: yupString().uuid().defined(),
      chunk_id: yupString().uuid().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      events: yupArray(yupMixed().defined()).defined(),
    }).defined(),
  }),
  async handler({ auth, params }) {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    const sessionReplayId = params.session_replay_id;
    const chunkId = params.chunk_id;

    const chunk = await prisma.sessionReplayChunk.findFirst({
      where: {
        tenancyId: auth.tenancy.id,
        sessionReplayId,
        id: chunkId,
      },
      select: {
        s3Key: true,
      },
    });
    if (!chunk) {
      throw new KnownErrors.ItemNotFound(chunkId);
    }

    let bytes: Uint8Array;
    try {
      bytes = await downloadBytes({ key: chunk.s3Key, private: true });
    } catch (e: any) {
      const status = e?.$metadata?.httpStatusCode;
      if (status === 404) {
        throw new KnownErrors.ItemNotFound(chunkId);
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

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        events: parsed.events,
      },
    };
  },
});
