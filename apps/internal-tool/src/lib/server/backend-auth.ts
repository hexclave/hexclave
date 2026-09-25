import "server-only";

import { StatusError, captureError } from "@hexclave/shared/dist/utils/errors";
import * as jose from "jose";
import { envOrDevDefault, hexclaveApiUrl } from "../env";


export const BACKEND_ASSERTION_SUBJECT = "__internal_tool_backend__";
export const BACKEND_ASSERTION_TOKEN_USE = "internal-tool-backend";

function apiUrl(): string {
  return hexclaveApiUrl().replace(/\/+$/, "");
}

function projectId(): string {
  return envOrDevDefault(
    process.env.NEXT_PUBLIC_HEXCLAVE_PROJECT_ID,
    "internal",
    "NEXT_PUBLIC_HEXCLAVE_PROJECT_ID",
  );
}

let cachedJwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
function remoteJwks() {
  cachedJwks ??= jose.createRemoteJWKSet(new URL(`${apiUrl()}/api/v1/projects/${projectId()}/.well-known/jwks.json`));
  return cachedJwks;
}

export async function requireBackendAssertion(req: Request): Promise<void> {
  const authorization = req.headers.get("authorization");
  if (authorization == null || !authorization.startsWith("Bearer ")) {
    throw new StatusError(StatusError.Unauthorized, "Missing backend assertion.");
  }
  const assertion = authorization.slice("Bearer ".length);

  let payload: jose.JWTPayload;
  try {
    ({ payload } = await jose.jwtVerify(assertion, remoteJwks(), {
      issuer: `${apiUrl()}/api/v1/projects/${projectId()}`,
      audience: projectId(),
    }));
  } catch (err) {
    captureError("backend-assertion-verify", new Error(
      `Backend assertion verification failed (expected issuer ${apiUrl()}/api/v1/projects/${projectId()}).`,
      { cause: err },
    ));
    throw new StatusError(StatusError.Unauthorized, "Invalid backend assertion.");
  }

  if (payload.sub !== BACKEND_ASSERTION_SUBJECT || payload.token_use !== BACKEND_ASSERTION_TOKEN_USE) {
    captureError("backend-assertion-claims", new Error(
      `Backend assertion rejected on claims (sub ${payload.sub === BACKEND_ASSERTION_SUBJECT ? "ok" : "mismatched"}, `
      + `token_use ${payload.token_use === BACKEND_ASSERTION_TOKEN_USE ? "ok" : "mismatched"}).`,
    ));
    throw new StatusError(StatusError.Unauthorized, "Invalid backend assertion.");
  }
}
