import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const STS_TOKEN_URL = "https://sts.googleapis.com/v1/token";
const IAM_CREDENTIALS_URL = "https://iamcredentials.googleapis.com/v1";
// Where the platform-injected OIDC assertion comes from. On Vercel these are two DIFFERENT
// places depending on context, which is the whole reason for the request hook below: the env
// var is populated during builds and in local development, but a running Function receives the
// assertion as a per-invocation REQUEST HEADER and has no such variable
// (https://vercel.com/docs/oidc/reference). Reading only the env var authenticates fine
// locally and then fails every call in production.
const OIDC_TOKEN_HEADER = "x-vercel-oidc-token";
const DEFAULT_OIDC_TOKEN_ENV_VAR = "VERCEL_OIDC_TOKEN";
const TOKEN_REFRESH_SKEW_MILLIS = 5 * 60 * 1000;

type AccessToken = {
  value: string,
  expiresAtMillis: number,
};

// Workload Identity Federation: the host proves its identity with a short-lived OIDC
// assertion, Google exchanges it for a federated token, and that token impersonates the
// controller service account. There is no long-lived key anywhere in this path, which is why
// it is preferred over GOOGLE_APPLICATION_CREDENTIALS for a hosted deployment — the
// controller identity can create, bill, and delete every tenant project, so a static key for
// it is the most valuable secret the system would otherwise hold.
type WorkloadIdentityConfig = {
  audience: string,
  serviceAccountEmail: string,
  tokenEnvVar: string,
};

type ServiceAccountCredential = {
  clientEmail: string,
  privateKey: string,
  tokenUri: string,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseServiceAccountCredential(value: unknown, path: string): ServiceAccountCredential {
  if (!isRecord(value)) throw new Error(`Google application credential ${path} must contain a JSON object`);
  const clientEmail = value.client_email;
  const privateKey = value.private_key;
  const tokenUri = value.token_uri;
  if (typeof clientEmail !== "string" || clientEmail === "") throw new Error(`Google application credential ${path} has no client_email`);
  if (typeof privateKey !== "string" || privateKey === "") throw new Error(`Google application credential ${path} has no private_key`);
  if (tokenUri !== undefined && typeof tokenUri !== "string") throw new Error(`Google application credential ${path} has an invalid token_uri`);
  return { clientEmail, privateKey, tokenUri: tokenUri ?? TOKEN_URL };
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

async function serviceAccountToken(credential: ServiceAccountCredential, signal?: AbortSignal): Promise<AccessToken> {
  const issuedAtSeconds = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = issuedAtSeconds + 3600;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: credential.clientEmail,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: credential.tokenUri,
    iat: issuedAtSeconds,
    exp: expiresAtSeconds,
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${base64Url(signer.sign(credential.privateKey))}`;
  const response = await fetch(credential.tokenUri, {
    method: "POST",
    signal,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body: unknown = await response.json();
  if (!response.ok || !isRecord(body) || typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
    throw new Error(`Google OAuth token exchange failed with HTTP ${response.status}`);
  }
  return { value: body.access_token, expiresAtMillis: Date.now() + body.expires_in * 1000 };
}

async function metadataToken(signal?: AbortSignal): Promise<AccessToken> {
  const response = await fetch(METADATA_TOKEN_URL, { signal, headers: { "Metadata-Flavor": "Google" } });
  const body: unknown = await response.json();
  if (!response.ok || !isRecord(body) || typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
    throw new Error(`Google metadata token request failed with HTTP ${response.status}`);
  }
  return { value: body.access_token, expiresAtMillis: Date.now() + body.expires_in * 1000 };
}

/**
 * Records the OIDC assertion carried by an incoming request.
 *
 * Called once per request from the HTTP layer, because a Vercel Function's assertion lives in
 * a header rather than the environment. The most recent one is kept rather than a per-request
 * store: every request to a given deployment carries an assertion for the SAME identity, so
 * concurrent requests cannot hand each other a credential they were not already entitled to,
 * and the newest is by construction the freshest. An assertion-less request (local dev, the
 * builder webhook on a host that mints none) deliberately does not clear what is held.
 */
export function recordHostIdentityAssertion(request: Request): void {
  const assertion = (request.headers.get(OIDC_TOKEN_HEADER) || "").trim();
  // This header is read before authentication, on /health included, so ANY Internet caller can
  // set it. It grants the caller nothing — it is the platform's identity, not theirs — but an
  // unchecked value still becomes the credential the next Google token exchange presents, and
  // a caller looping junk at /health would deny every provider-backed route. Store it only if
  // it is an assertion for the identity we expect; a mismatch is someone else's header.
  if (assertion !== "" && assertionMatchesConfiguredAudience(assertion)) requestAssertion = assertion;
}

// The audience is what ties an assertion to THIS workload identity pool provider: Google
// rejects any other, so anything else is noise we must not cache over a working credential.
// Signature verification belongs to Google's STS, not here — this only decides which header
// is worth presenting to it.
function assertionMatchesConfiguredAudience(assertion: string): boolean {
  const config = workloadIdentityConfig();
  if (config === null) return false;
  const segments = assertion.split(".");
  if (segments.length !== 3) return false;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (!isRecord(claims)) return false;
  const audience = claims.aud;
  return typeof audience === "string"
    ? audience === config.audience
    : Array.isArray(audience) && audience.includes(config.audience);
}

function hostIdentityAssertion(tokenEnvVar: string): string {
  // The header wins: where both exist, the request-borne one is the current invocation's.
  return requestAssertion ?? (process.env[tokenEnvVar] || "").trim();
}

function workloadIdentityConfig(): WorkloadIdentityConfig | null {
  const audience = (process.env.HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_AUDIENCE || "").trim();
  const serviceAccountEmail = (process.env.HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_SERVICE_ACCOUNT || "").trim();
  if (audience === "" && serviceAccountEmail === "") return null;
  // Half-configured federation must fail loudly rather than silently falling through to the
  // metadata server, which on a host that has none would surface as an unrelated fetch error.
  if (audience === "" || serviceAccountEmail === "") {
    throw new Error("workload identity federation needs both HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_AUDIENCE and HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_SERVICE_ACCOUNT");
  }
  return {
    audience,
    serviceAccountEmail,
    tokenEnvVar: (process.env.HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_TOKEN_ENV || "").trim() || DEFAULT_OIDC_TOKEN_ENV_VAR,
  };
}

async function workloadIdentityToken(config: WorkloadIdentityConfig, signal?: AbortSignal): Promise<AccessToken> {
  // Deliberately read at every refresh rather than cached with the credential: the host
  // re-injects this assertion per invocation and the previous one expires within the hour, so
  // a value captured at import time would start failing partway through the process's life.
  const subjectToken = hostIdentityAssertion(config.tokenEnvVar);
  if (subjectToken === "") {
    throw new Error(`workload identity federation is configured but no OIDC assertion is available: neither the ${OIDC_TOKEN_HEADER} request header nor ${config.tokenEnvVar} carried one`);
  }

  const exchange = await fetch(STS_TOKEN_URL, {
    method: "POST",
    signal,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: config.audience,
      scope: CLOUD_PLATFORM_SCOPE,
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: subjectToken,
    }),
  });
  // Status checked BEFORE the body is parsed: a proxy's HTML error page would otherwise throw
  // a SyntaxError carrying a snippet of that page instead of this message.
  if (!exchange.ok) throw new Error(`Google STS token exchange failed with HTTP ${exchange.status}`);
  const exchanged: unknown = await exchange.json().catch(() => null);
  // Status only, never the body: an STS error can echo the assertion back.
  if (!isRecord(exchanged) || typeof exchanged.access_token !== "string") {
    throw new Error("Google STS token exchange returned no access token");
  }

  const impersonation = await fetch(
    `${IAM_CREDENTIALS_URL}/projects/-/serviceAccounts/${encodeURIComponent(config.serviceAccountEmail)}:generateAccessToken`,
    {
      method: "POST",
      signal,
      headers: { authorization: `Bearer ${exchanged.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: [CLOUD_PLATFORM_SCOPE] }),
    },
  );
  if (!impersonation.ok) throw new Error(`Google service account impersonation failed with HTTP ${impersonation.status}`);
  const impersonated: unknown = await impersonation.json().catch(() => null);
  if (!isRecord(impersonated) || typeof impersonated.accessToken !== "string" || typeof impersonated.expireTime !== "string") {
    throw new Error("Google service account impersonation returned no access token");
  }
  const expiresAtMillis = Date.parse(impersonated.expireTime);
  // An unparseable expiry must not be treated as far future: that would cache a token past its
  // life and turn every later call into a 401 with no refresh.
  if (!Number.isFinite(expiresAtMillis)) throw new Error("Google service account impersonation returned an unparseable expiry");
  return { value: impersonated.accessToken, expiresAtMillis };
}

let cachedToken: AccessToken | null = null;
// Which resolution mode minted `cachedToken`. Without this a token minted under one mode is
// served for its whole life after the configuration changes, which also silently skips the
// half-configured error above for as long as the cache holds.
let cachedTokenMode: "federation" | "credential-file" | "metadata" | null = null;
let cachedCredential: ServiceAccountCredential | null = null;
let cachedCredentialPath: string | null = null;
let requestAssertion: string | null = null;

async function applicationCredential(signal?: AbortSignal): Promise<ServiceAccountCredential | null> {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (path === undefined || path === "") return null;
  if (cachedCredential !== null && cachedCredentialPath === path) return cachedCredential;
  const serialized = await readFile(path, { encoding: "utf8", signal });
  // Never include credential contents in errors. The path is operational configuration;
  // private key material remains confined to this module and the OAuth assertion.
  const parsed: unknown = JSON.parse(serialized);
  cachedCredential = parseServiceAccountCredential(parsed, path);
  cachedCredentialPath = path;
  return cachedCredential;
}

// Federation first, then an explicit credential file, then the metadata server. Federation
// leads because it is the only one of the three a hosted platform can offer without a stored
// secret, and a host that has it configured never wants either fallback.
export async function googleAccessToken(signal?: AbortSignal): Promise<string> {
  const federation = workloadIdentityConfig();
  const credential = federation === null ? await applicationCredential(signal) : null;
  const mode = federation !== null ? "federation" : credential !== null ? "credential-file" : "metadata";
  // The mode is resolved BEFORE the cache is consulted so that a configuration change
  // invalidates the token it minted, and so a half-configured federation throws immediately
  // rather than only once the previous token expires.
  if (cachedToken !== null && cachedTokenMode === mode && cachedToken.expiresAtMillis - TOKEN_REFRESH_SKEW_MILLIS > Date.now()) {
    return cachedToken.value;
  }
  const token = federation !== null
    ? await workloadIdentityToken(federation, signal)
    : credential !== null ? await serviceAccountToken(credential, signal) : await metadataToken(signal);
  cachedToken = token;
  cachedTokenMode = mode;
  return token.value;
}

export function resetGoogleAuthCacheForTests(): void {
  cachedToken = null;
  cachedTokenMode = null;
  requestAssertion = null;
  cachedCredential = null;
  cachedCredentialPath = null;
}
