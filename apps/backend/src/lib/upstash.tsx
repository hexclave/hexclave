import { SmartRequest } from "@/route-handlers/smart-request";
import { getEnvVariable, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { Client, Receiver } from "@upstash/qstash";

export const upstash = new Client({
  baseUrl: getEnvVariable("STACK_QSTASH_URL", ""),
  token: getEnvVariable("STACK_QSTASH_TOKEN", ""),
});

function getQstashSigningKey(name: string): string {
  const value = getEnvVariable(name, "");
  if (value === "") {
    throw new HexclaveAssertionError(`${name} (or its HEXCLAVE_ equivalent) is not configured, so QStash request signatures cannot be verified.`);
  }
  if (!value.startsWith("sig_")) {
    throw new HexclaveAssertionError(`${name} (or its HEXCLAVE_ equivalent) is misconfigured: QStash signing keys must start with "sig_".`);
  }
  return value;
}

// Constructed lazily (rather than at module load) because this module is also imported for the
// QStash `Client`, and deployments that never receive QStash callbacks shouldn't fail to boot.
// Without this validation, a missing or malformed key would make every verification fail and
// surface as a misleading "Invalid Upstash signature" 400 instead of a server misconfiguration.
let upstashReceiver: Receiver | undefined;
function getUpstashReceiver(): Receiver {
  upstashReceiver ??= new Receiver({
    currentSigningKey: getQstashSigningKey("STACK_QSTASH_CURRENT_SIGNING_KEY"),
    nextSigningKey: getQstashSigningKey("STACK_QSTASH_NEXT_SIGNING_KEY"),
  });
  return upstashReceiver;
}

export async function ensureUpstashSignature(fullReq: SmartRequest): Promise<void> {
  const upstashSignature = fullReq.headers["upstash-signature"]?.[0];
  if (!upstashSignature) {
    throw new StatusError(400, "upstash-signature header is required");
  }

  const nodeEnv = getNodeEnvironment();
  if ((nodeEnv.includes("development") || nodeEnv.includes("test")) && upstashSignature === "test-bypass") {
    return;
  }

  const url = new URL(fullReq.url);
  if ((nodeEnv.includes("development") || nodeEnv.includes("test")) && url.hostname === "localhost") {
    url.hostname = "host.docker.internal";
  }
  // The backend binds to 0.0.0.0, so Next.js reports the incoming URL with that
  // hostname. QStash signs the URL we told it to call (e.g. localhost), so
  // normalize 0.0.0.0 back to localhost for signature verification.
  if (url.hostname === "0.0.0.0") {
    url.hostname = "localhost";
  }

  const isValid = await getUpstashReceiver().verify({
    signature: upstashSignature,
    url: url.toString(),
    body: new TextDecoder().decode(fullReq.bodyBuffer),
  });
  if (!isValid) {
    throw new StatusError(400, "Invalid Upstash signature");
  }
}
