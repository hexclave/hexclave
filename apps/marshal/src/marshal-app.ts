// NOT named app.ts, and must not be renamed back: Vercel's Elysia preset detects the
// function entrypoint by scanning known paths — src/index.ts and src/app.ts among them —
// for a file that imports `elysia`. This file does, so as src/app.ts it tied with the real
// entrypoint and won ("Multiple entrypoints found: src/app.ts, src/index.ts. Using
// src/app.ts."), which builds a function out of a module that default-exports nothing and
// drops the maxDuration declared in src/index.ts.
import { node } from "@elysiajs/node";
import { Elysia } from "elysia";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { INTERNAL_COMPLETE_PATH_PREFIX, createMockBuilder, verifyWebhookToken, type Builder } from "./builds.js";
import { MAX_UPLOAD_BYTES, MAX_WEBHOOK_BODY_BYTES, getConfig } from "./config.js";
import { attachDomain, detachDomain, normalizeHostnameOrThrow, readDomain } from "./domains.js";
import { MarshalError } from "./errors.js";
import { MutationOutcomeUnknownError } from "./mutation-safety.js";
import { ReconciliationLeaseLostError } from "./reconciliation-lock.js";
import { FlyApiError } from "./fly/client.js";
import { recordHostIdentityAssertion } from "./gcp/auth.js";
import { GcpApiError } from "./gcp/client.js";
import { reapProjectPool, stepProjectPool } from "./project-pool.js";
import { providerForNamespace, type RuntimeProvider } from "./provider.js";
import { validateRequestedRuntime } from "./runtime.js";
import {
  BUILD_ID_REGEX,
  advanceDeployment,
  applyServiceSpec,
  completeBuild,
  deleteService,
  deploymentLogRedactionValues,
  getServiceState,
  listServices,
  maybeFinalizeStaleDeployment,
  startSourceDeployment,
  validateNamespace,
  validateServiceKey,
  validateServiceSpec,
  validateSourceId,
} from "./services.js";
import { createMultipartUploadSlot, createUploadSlot, multipartPartCount, readDeployment, readDeploymentLog, readSpec } from "./store.js";
import type { LogLine } from "./types.js";

// How long after a build goes terminal its durable log object may still be missing before
// the logs route stops pretending the build is live. persistBuildLog runs BEFORE the terminal
// record on the completeBuild paths, so the only real window is maybeFinalizeStaleBuild
// (which writes the record first); past that, a missing object means the drain was empty or
// failed and no further lines are ever coming.
const DURABLE_LOG_GRACE_MS = 30 * 1000;

// Derived from the path the builder is actually given (buildCompletionPath) so the
// pre-handler auth gate and the route can never disagree — a mismatch rejects every real
// build's completion with a 404 that no test using the in-process mock builder would see.
// The prefix is path characters only, so it needs no regex escaping.
const INTERNAL_COMPLETE_PATH_REGEX = new RegExp(`^${INTERNAL_COMPLETE_PATH_PREFIX}([^/]+)/complete$`);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(error: unknown): Response {
  if (error instanceof MarshalError) {
    return jsonResponse(error.status, { error: error.code, message: error.message });
  }
  // Fencing outcomes: another reconciliation owns this service, or a provider write's
  // outcome could not be established. Both are deliberately propagated by the
  // apply paths rather than swallowed, and neither is an internal fault — the
  // caller's move is to retry, so say that instead of "internal error" (which
  // the backend correctly escalates to an ISE).
  if (error instanceof ReconciliationLeaseLostError) {
    console.error("reconciliation fenced", error);
    return jsonResponse(409, { error: "reconciliation_conflict", message: "another reconciliation of this service is in progress; retry the request" });
  }
  if (error instanceof MutationOutcomeUnknownError) {
    // NOT 409: the write may well have landed, so this must not read as "nothing
    // happened, safely retry" — the state has to be re-read first.
    console.error("runtime mutation outcome unknown", error);
    return jsonResponse(503, { error: "mutation_outcome_unknown", message: "a runtime mutation did not confirm; re-read the service state before retrying" });
  }
  if (error instanceof FlyApiError || error instanceof GcpApiError) {
    // Report an upstream failure without describing it: the provider's 4xxes on OUR
    // requests are our bug or an infra failure from the caller's perspective, never
    // theirs, so its wording, its status code, and the org/app/project identifiers its
    // endpoints embed all stay in the server log — none of them belong in a response that
    // can be relayed onward to an end user.
    console.error(error instanceof FlyApiError ? "Fly API error" : "Google Cloud API error", error);
    return jsonResponse(502, { error: "upstream_api_error", message: "the runtime could not complete the request" });
  }
  console.error("unhandled marshal error", error);
  return jsonResponse(500, { error: "internal_error", message: "internal error" });
}

async function handle(fn: () => Promise<Response | Record<string, unknown>>): Promise<Response | Record<string, unknown>> {
  try {
    return await fn();
  } catch (error) {
    return errorResponse(error);
  }
}

// Every candidate is compared, with no short-circuit, so that which credential matched is not
// observable in the response time.
export function isAuthorized(header: string | null, candidates: readonly (string | null)[]): boolean {
  if (header === null) return false;
  const provided = Buffer.from(header, "utf8");
  let matched = false;
  for (const candidate of candidates) {
    if (candidate === null || candidate === "") continue;
    const wanted = Buffer.from(`Bearer ${candidate}`, "utf8");
    if (provided.length === wanted.length && timingSafeEqual(provided, wanted)) matched = true;
  }
  return matched;
}


// Bounded at a safe integer AND at ~year 2255 in millis: the value is multiplied by 1e6 to
// form a nanosecond log cursor, so an unbounded number would produce exponential-notation
// (`1e+36`) tokens that break BigInt parsing downstream.
const MAX_CURSOR_MILLIS = 9_000_000_000_000; // ~2255-01-01

// Shared by the authentication gate and the routes themselves, so a cron path cannot come to
// accept CRON_SECRET without the gate agreeing that it is one.
const MAINTENANCE_PATH_PREFIX = "/v1/maintenance/";
/**
 * The `size_bytes` an upload request declared, or undefined when it said nothing
 * usable. Advisory only — it decides whether to mint a multipart slot, never
 * what may be stored, which stays the consume-time gate's job.
 */
function declaredSizeBytes(body: unknown): number | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>).size_bytes;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseOptionalMillis(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_CURSOR_MILLIS ? parsed : undefined;
}

// Return type is inferred — Elysia's route-typed instances aren't assignable to the bare
// `Elysia` type, and nothing downstream needs the route types.
export function createMarshalApp() {
  const config = getConfig();
  // The builder is chosen once the namespace's runtime is: the mock one completes in-process
  // whatever the runtime, and otherwise each runtime starts its own machine.
  const mockBuilder: Builder | null = config.builderKind === "mock" ? createMockBuilder(completeBuild) : null;
  const builderFor = (provider: RuntimeProvider): Builder => mockBuilder ?? provider.createBuilder();

  const app = new Elysia({ adapter: node() })
    .onRequest(({ request }) => {
      // Before any authentication, and on EVERY route including /health: this is the platform's
      // OIDC assertion, which is how Marshal authenticates to Google when it holds no key (see
      // recordHostIdentityAssertion). A Vercel Function receives it as a request header and has
      // no environment variable carrying it, so a deployment that never reads one off a request
      // has no Google credential at all. It is the caller's proof of the PLATFORM's identity,
      // not of the caller's, so it grants nothing here and is safe to read this early.
      recordHostIdentityAssertion(request);
      const url = new URL(request.url);
      // /health is the only unauthenticated surface.
      if (url.pathname === "/health") return;
      // /internal/deployments/* carries its own per-deployment HMAC token (the builder
      // machine never holds the backend credential), and it is authenticated HERE rather
      // than in the handler. Everything the token covers — deployment id, ns — is in the
      // URL, and the token is in a header, so nothing about this needs the body. Verifying
      // inside the handler instead meant Elysia had already buffered and parsed an arbitrary
      // body from an unauthenticated Internet client before the first credential check ran.
      //
      // The matcher, the route below and the URL the builder harness is given all derive
      // from INTERNAL_COMPLETE_PATH_PREFIX: a path this matcher does not recognize is
      // rejected here, so the handler never runs and no build can ever complete.
      if (url.pathname.startsWith("/internal/")) {
        const completeMatch = INTERNAL_COMPLETE_PATH_REGEX.exec(url.pathname);
        if (completeMatch === null) {
          // No other /internal route exists. Anything else under the prefix would otherwise
          // inherit the auth bypass without carrying a token of its own.
          return jsonResponse(404, { error: "not_found", message: "unknown internal route" });
        }
        // The webhook body is a small status/metadata document. Cap it before parsing so an
        // unauthenticated caller cannot make us allocate first and reject afterwards; the
        // large-body route (uploads) is a separate, API-key-authenticated path.
        //
        // A MISSING content-length is refused rather than treated as zero. This is the only
        // route reachable before any credential check, and a chunked request declares no
        // length — so `?? "0"` would let an unauthenticated client stream an unbounded body
        // that Elysia buffers before the cap could ever apply. The builder harness posts with
        // --post-file, which always declares a length, so nothing legitimate is refused here.
        const declaredLengthHeader = request.headers.get("content-length");
        const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
        if (declaredLength === null || !Number.isInteger(declaredLength) || declaredLength < 0) {
          return jsonResponse(411, { error: "length_required", message: "build completion requests must declare a valid content-length" });
        }
        if (declaredLength > MAX_WEBHOOK_BODY_BYTES) {
          return jsonResponse(413, { error: "payload_too_large", message: `build completion body may not exceed ${MAX_WEBHOOK_BODY_BYTES} bytes` });
        }
        const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        const ns = url.searchParams.get("ns") ?? "";
        if (ns === "" || !verifyWebhookToken(token, completeMatch[1], ns)) {
          return jsonResponse(401, { error: "unauthenticated", message: "invalid webhook token" });
        }
        return;
      }
      // The maintenance crons additionally accept CRON_SECRET, so Vercel's scheduler need not
      // be given MARSHAL_API_KEY. It is scoped to those paths alone: everywhere else, and when
      // CRON_SECRET is unset, the API key remains the only credential.
      const cronCredential = url.pathname.startsWith(MAINTENANCE_PATH_PREFIX) ? config.cronSecret : null;
      if (!isAuthorized(request.headers.get("authorization"), [config.apiKey, cronCredential])) {
        return jsonResponse(401, { error: "unauthenticated", message: "missing or invalid bearer credential" });
      }
    })
    .get("/health", () => ({ ok: true }))

    // The body is optional and advisory: `size_bytes` is how big the caller says
    // its source is, which is the only thing that decides whether a multipart
    // slot is worth starting. An older client sends no body and gets exactly the
    // response it always got.
    .post("/v1/namespaces/:ns/uploads", ({ params, body }) => handle(async () => {
      const ns = validateNamespace(params.ns);
      const id = randomUUID();
      const slot = await createUploadSlot(ns, id);
      const partCount = multipartPartCount(declaredSizeBytes(body));
      // `upload_url` is returned either way. It is the fallback when the client
      // cannot do multipart, and the only thing an older client looks at.
      const multipart = partCount === null ? null : await createMultipartUploadSlot(ns, id, partCount);
      return jsonResponse(201, {
        id,
        upload_url: slot.uploadUrl,
        content_type: "application/gzip",
        expires_at_millis: slot.expiresAtMillis,
        max_bytes: MAX_UPLOAD_BYTES,
        multipart: multipart === null ? null : {
          upload_id: multipart.uploadId,
          part_size_bytes: multipart.partSizeBytes,
          part_urls: multipart.partUrls,
          complete_url: multipart.completeUrl,
          abort_url: multipart.abortUrl,
        },
      });
    }))

    // Maintenance crons (apps/marshal/vercel.json). Deliberately under /v1/ and NOT /internal/:
    // that prefix carries the per-deployment webhook auth bypass above and 404s anything it
    // does not recognize, so a route placed there would either be unauthenticated or dead.
    // Under /v1/ they use the ordinary bearer check, which additionally accepts CRON_SECRET on
    // this prefix (see the gate above), so Vercel's scheduler authenticates without holding
    // MARSHAL_API_KEY. CRON_SECRET must still be SET in Vercel: with it unset the platform
    // sends no Authorization header at all and every invocation is rejected.
    //
    // GET because that is what Vercel Cron issues. Both are idempotent in the sense that
    // matters: each is a single leased pass over durable state, safe to repeat and safe to
    // overlap (contention is reported as skipped, not as an error).
    .get(`${MAINTENANCE_PATH_PREFIX}project-pool/step`, () => handle(async () => await stepProjectPool()))

    .get(`${MAINTENANCE_PATH_PREFIX}project-pool/reap`, () => handle(async () => await reapProjectPool()))

    .get("/v1/namespaces/:ns", ({ params }) => handle(async () => {
      const ns = validateNamespace(params.ns);
      return { services: await listServices(ns) };
    }))

    // The body may name the `runtime` the caller wants this namespace on; see runtime.ts for
    // how that is reconciled with the namespace's pin. Absent means whatever it already is.
    .put("/v1/namespaces/:ns/services/:key", ({ params, body }) => handle(async () => {
      const ns = validateNamespace(params.ns);
      const key = validateServiceKey(params.key);
      const runtime = validateRequestedRuntime((body as Record<string, unknown> | null)?.runtime);
      const provider = await providerForNamespace(ns, runtime);
      const spec = validateServiceSpec(body, provider.kind);
      const result = await applyServiceSpec(ns, key, spec, { runtime: provider.kind });
      return { revision: result.revision, changed: result.changed, state: result.state };
    }))

    .get("/v1/namespaces/:ns/services/:key", ({ params }) => handle(async () => {
      const ns = validateNamespace(params.ns);
      const key = validateServiceKey(params.key);
      return await getServiceState(ns, key) as unknown as Record<string, unknown>;
    }))

    .delete("/v1/namespaces/:ns/services/:key", ({ params }) => handle(async () => {
      const ns = validateNamespace(params.ns);
      const key = validateServiceKey(params.key);
      await deleteService(ns, key);
      return { deleted: true };
    }))

    // One `hexclave deploy` of one deployment source: build every target in one
    // machine, then apply them in the given dependency order.
    .post("/v1/namespaces/:ns/sources/:sourceId/deployments", ({ params, body }) => handle(async () => {
      const ns = validateNamespace(params.ns);
      const sourceId = validateSourceId(params.sourceId);
      const runtime = validateRequestedRuntime((body as Record<string, unknown> | null)?.runtime);
      return await startSourceDeployment(ns, sourceId, body, builderFor, runtime) as unknown as Record<string, unknown>;
    }))

    // Reading a deployment is also what ADVANCES it: there is no background
    // worker here, so each poll applies at most one more service (see
    // advanceDeployment).
    .get("/v1/namespaces/:ns/deployments/:id", ({ params }) => handle(async () => {
      const ns = validateNamespace(params.ns);
      if (!BUILD_ID_REGEX.test(params.id)) throw new MarshalError(400, "bad_request", "deployment id must be a ULID");
      return await advanceDeployment(ns, params.id) as unknown as Record<string, unknown>;
    }))

    .get("/v1/namespaces/:ns/deployments/:id/logs", ({ params, query }) => handle(async () => {
      const ns = validateNamespace(params.ns);
      // Validate the id: it flows into an S3 object key, so a traversal id must not escape
      // the deployments/ prefix (defense in depth — the only caller passes a stored ULID).
      if (!BUILD_ID_REGEX.test(params.id)) throw new MarshalError(400, "bad_request", "deployment id must be a ULID");
      const deployment = await readDeployment(ns, params.id);
      if (deployment === null) throw new MarshalError(404, "not_found", `deployment ${JSON.stringify(params.id)} not found`);
      const checked = await maybeFinalizeStaleDeployment(deployment);
      const sinceMillis = parseOptionalMillis(query.since_millis);
      // The BUILD is what produces the log, so the log is complete once the build
      // is — not once the applies are, which follow it and print nothing here.
      const terminal = checked.status !== "building";

      if (!checked.has_logs) {
        return { lines: [], next_since_millis: sinceMillis ?? Date.now(), complete: true };
      }
      // A terminal deployment whose durable object never showed up must still end its
      // stream: the live proxy below is a best-effort last look, not an open-ended follow.
      // Without this the caller polls a finished build until its own timeout and is told the
      // build is "still running" the whole way.
      const liveIsFinal = terminal && Date.now() - (checked.finished_at_millis ?? checked.started_at_millis) > DURABLE_LOG_GRACE_MS;

      if (terminal) {
        // Durable path: the bucket log object written at finalization.
        const raw = await readDeploymentLog(ns, params.id);
        // No durable object yet (persist skipped an empty drain, or it's still being written
        // in the window right after the terminal record): fall through to the live proxy
        // rather than claiming a complete-but-empty log.
        if (raw !== null) {
          // One corrupt/truncated line must not 500 the whole request — skip it.
          const parseLine = (line: string): LogLine[] => {
            try {
              return [JSON.parse(line) as LogLine];
            } catch {
              return [];
            }
          };
          const lines: LogLine[] = raw
            .split("\n")
            .filter((line) => line !== "")
            .flatMap(parseLine)
            .filter((line) => sinceMillis === undefined || line.at_millis >= sinceMillis);
          const lastAtMillis = lines.length > 0 ? lines[lines.length - 1].at_millis : undefined;
          return { lines, next_since_millis: lastAtMillis !== undefined ? lastAtMillis + 1 : sinceMillis ?? Date.now(), complete: true };
        }
      }
      // Live path: proxy the builder machine's logs, scrubbing the credentials Marshal
      // handed to the build (stage 1 of the two-stage redaction).
      if (checked.builder_app === null || checked.builder_machine_id === null) {
        return { lines: [], next_since_millis: sinceMillis ?? checked.started_at_millis, complete: liveIsFinal };
      }
      const provider = await providerForNamespace(ns);
      const page = await provider.builderLogsLive(checked, sinceMillis, deploymentLogRedactionValues(provider, checked));
      return { lines: page.lines, next_since_millis: page.nextSinceMillis, complete: liveIsFinal };
    }))

    .get("/v1/namespaces/:ns/services/:key/logs", ({ params, query }) => handle(async () => {
      const ns = validateNamespace(params.ns);
      const key = validateServiceKey(params.key);
      const stored = await readSpec(ns, key);
      if (stored === null) throw new MarshalError(404, "not_found", `service ${JSON.stringify(key)} not found`);
      const sinceMillis = parseOptionalMillis(query.since_millis);
      const page = await (await providerForNamespace(ns)).serviceLogs(stored, sinceMillis, typeof query.instance === "string" && query.instance !== "" ? query.instance : undefined);
      return { lines: page.lines, next_since_millis: page.nextSinceMillis };
    }))

    // Read-only: the "re-check verification now" primitive. A PUT would repoint the hostname,
    // so callers that only want current state must use this.
    .get("/v1/namespaces/:ns/domains/:hostname", ({ params }) => handle(async () => {
      const ns = validateNamespace(params.ns);
      const hostname = normalizeHostnameOrThrow(params.hostname);
      return await readDomain(ns, hostname) as unknown as Record<string, unknown>;
    }))

    .put("/v1/namespaces/:ns/domains/:hostname", ({ params, body }) => handle(async () => {
      const ns = validateNamespace(params.ns);
      const hostname = normalizeHostnameOrThrow(params.hostname);
      const serviceKey = (body as Record<string, unknown> | null)?.service_key;
      if (typeof serviceKey !== "string") throw new MarshalError(400, "bad_request", "body must be { service_key }");
      return await attachDomain(ns, hostname, validateServiceKey(serviceKey)) as unknown as Record<string, unknown>;
    }))

    .delete("/v1/namespaces/:ns/domains/:hostname", ({ params, query }) => handle(async () => {
      const ns = validateNamespace(params.ns);
      const hostname = normalizeHostnameOrThrow(params.hostname);
      // Optional ownership fence — see detachDomain. Absent = detach whoever holds it.
      const expectedServiceKey = typeof query.service_key === "string" && query.service_key !== ""
        ? validateServiceKey(query.service_key)
        : undefined;
      await detachDomain(ns, hostname, expectedServiceKey);
      return { deleted: true };
    }))

    // Builder completion webhook. Auth: per-build HMAC token over (buildId, ns, key).
    // Body is buildctl's metadata JSON on success, or an error text on failure.
    // `parse: "text"` so a malformed/empty JSON body still reaches the handler (Elysia's
    // default JSON parser would 400 before it, making the registry-HEAD digest fallback
    // unreachable) — the handler parses defensively.
    .post(`${INTERNAL_COMPLETE_PATH_PREFIX}:deploymentId/complete`, ({ params, query, body, request }) => handle(async () => {
      const ns = typeof query.ns === "string" ? query.ns : "";
      const status = query.status === "succeeded" ? "succeeded" : query.status === "failed" ? "failed" : null;
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (ns === "" || status === null) throw new MarshalError(400, "bad_request", "ns and status query params are required");
      // Validate ns BEFORE trusting it: it flows into S3 keys inside completeBuild, and
      // possession of the webhook secret (which defaults to the API key) must not become an
      // arbitrary-key write primitive.
      validateNamespace(ns);
      // Re-verified here as well as in onRequest: onRequest is what stops an unauthenticated
      // body from being buffered, but this check is the one tied to the ns that completeBuild
      // actually writes with, after the validator above has run on it.
      if (!verifyWebhookToken(token, params.deploymentId, ns)) {
        return jsonResponse(401, { error: "unauthenticated", message: "invalid webhook token" });
      }
      if (!BUILD_ID_REGEX.test(params.deploymentId)) throw new MarshalError(400, "bad_request", "deployment id must be a ULID");
      const bodyText = typeof body === "string" ? body : body === null || body === undefined ? null : JSON.stringify(body);
      await completeBuild({
        ns,
        deploymentId: params.deploymentId,
        status,
        metadataJson: status === "succeeded" ? bodyText : null,
        errorText: status === "failed" ? bodyText : null,
      });
      return { ok: true };
    }), { parse: "text" });

  return { app, builderFor };
}
