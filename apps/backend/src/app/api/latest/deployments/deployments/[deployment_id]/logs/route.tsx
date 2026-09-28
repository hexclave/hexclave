import { decryptDeploymentRedactionSecrets, isTerminalDeploymentStatus, marshalNamespaceForTenancy, redactSecrets, refreshDeploymentFromMarshal } from "@/lib/deployments";
import { getMarshalClientOrThrow } from "@/lib/deployments/marshal-client";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { SmartResponse } from "@/route-handlers/smart-response";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupMixed, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError, captureError } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";

// The stream pages build logs from Marshal until the build finishes, capped so
// a stuck build can't hold the connection forever. Clients can simply
// re-request to resume (the whole log is replayed each time — build logs are
// small).
const POLL_INTERVAL_MS = 2000;
const MAX_STREAM_MS = 4 * 60 * 1000;

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Stream deployment build logs",
    description: "Streams a deployment's build logs as chunked plain text. One deploy is one build — every service of the deployment source is built by the same machine — so this is one log covering all of them. Replays from the start, then follows until the deployment reaches a terminal state (or a few minutes pass — re-request to continue following).",
    tags: ["Deploy"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      deployment_id: yupString().uuid().defined(),
    }).defined(),
  }),
  response: yupMixed<SmartResponse>().defined(),
  handler: async ({ auth, params }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const deployment = await prisma.deployment.findUnique({
      where: { tenancyId_id: { tenancyId: auth.tenancy.id, id: params.deployment_id } },
    });
    if (deployment == null) {
      throw new StatusError(404, "No deployment found with the given id.");
    }
    // Refresh first: a deployment whose build id had not been attached yet
    // would otherwise get a bare "no build logs" until the caller happened to
    // read the deployment endpoint first.
    try {
      await refreshDeploymentFromMarshal(prisma, auth.tenancy, deployment);
    } catch (e) {
      captureError("deployments-build-logs-refresh", e);
    }
    const refreshed = await prisma.deployment.findUnique({
      where: { tenancyId_id: { tenancyId: auth.tenancy.id, id: params.deployment_id } },
    });
    const marshalBuildId = refreshed?.marshalBuildId ?? deployment.marshalBuildId;
    if (marshalBuildId == null) {
      // A deployment the runtime never accepted gets a clearer message than one
      // that simply has not started building yet.
      throw new StatusError(400, isTerminalDeploymentStatus(refreshed?.status ?? deployment.status)
        ? "This deployment produced no build (it stopped before the runtime accepted it)."
        : "This deployment has no build logs yet.");
    }
    const client = getMarshalClientOrThrow();
    const ns = marshalNamespaceForTenancy(auth.tenancy);

    // Builds run user code that may print env values. Use the exact encrypted
    // snapshot captured for THIS deployment: current project secrets cannot
    // cover request-only defaults or values that were rotated/deleted
    // afterwards. Decryption and validation happen before the response starts,
    // so any failure closes the endpoint rather than serving partially-redacted
    // logs. (Marshal applies its own stage-1 redaction of runtime credentials;
    // this is stage 2, covering the backend's secrets.)
    //
    // The snapshot covers EVERY service of the deploy, which is right: they all
    // built in one machine, so any of their values could appear in this log.
    const secretValues = await decryptDeploymentRedactionSecrets(deployment.redactionSecretsEncrypted);

    const encoder = new TextEncoder();
    // Flipped by cancel() when the client disconnects: the poll loop must stop
    // hitting Marshal, and a disconnect is NOT an error worth capturing.
    let clientCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          const startedAt = performance.now();
          let sinceMillis: number | undefined = undefined;
          while (!clientCancelled) {
            const page = await client.getDeploymentLogs(ns, marshalBuildId, { sinceMillis });
            for (const line of page.lines) {
              const text = redactSecrets(line.text, secretValues);
              controller.enqueue(encoder.encode(text.endsWith("\n") ? text : `${text}\n`));
            }
            // Guard a non-advancing cursor (a bug or a bogus next_since_millis) from becoming
            // a hot loop that re-enqueues the same window until MAX_STREAM_MS. The cursor is
            // also kept strictly monotonic: out-of-order log timestamps can make Marshal hand
            // back a LOWER next_since_millis, and storing that verbatim would re-emit the same
            // lines on every poll instead of making forward progress.
            // Both annotated: `sinceMillis` feeds the getBuildLogs call above, so letting TS
            // infer either of these through the assignment below is a circular reference.
            const previousSinceMillis: number | undefined = sinceMillis;
            const cursorAdvanced: boolean = previousSinceMillis === undefined || page.next_since_millis > previousSinceMillis;
            const nextSinceMillis: number = cursorAdvanced ? page.next_since_millis : (previousSinceMillis ?? page.next_since_millis) + 1;
            sinceMillis = nextSinceMillis;

            if (page.complete) {
              break;
            }
            if (performance.now() - startedAt > MAX_STREAM_MS) {
              controller.enqueue(encoder.encode("[hexclave] Log stream timed out while the build is still running; re-request to continue following.\n"));
              break;
            }
            // Sleep whenever the build isn't complete — not only on an empty page. A chatty
            // build returns lines every page, and hammering Marshal (→ Fly's logs API) with
            // zero delay for the whole window is needless load.
            if (page.lines.length === 0 || !cursorAdvanced) {
              await wait(POLL_INTERVAL_MS);
            } else {
              await wait(Math.min(POLL_INTERVAL_MS, 500));
            }
          }
          if (!clientCancelled) {
            controller.close();
          }
        } catch (error) {
          if (clientCancelled) {
            // Enqueueing after the client went away throws; that's the normal
            // disconnect path, not an error.
            return;
          }
          // The stream has already started (status 200 is out the door), so
          // all we can do is log server-side and end the stream with a
          // generic marker that leaks nothing.
          captureError("deployment-build-log-stream", error);
          try {
            controller.enqueue(encoder.encode("[hexclave] Log stream ended unexpectedly.\n"));
            controller.close();
          } catch {
            // Controller may already be closed/errored; nothing left to do.
          }
        }
      },
      cancel: () => {
        clientCancelled = true;
      },
    });

    return {
      statusCode: 200,
      bodyType: "response" as const,
      body: new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          // no-transform keeps the compression layer (server/compression.ts)
          // from piping this stream through CompressionStream("gzip"), whose
          // internal buffering would stall the incremental log delivery this
          // route exists to provide.
          "cache-control": "no-store, no-transform",
        },
      }),
    };
  },
});
