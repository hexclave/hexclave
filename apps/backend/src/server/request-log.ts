import { getInboundRequestHost } from "@/lib/request-api-url";
import { getEnvVariable, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";

export type RequestCompletionLog = {
  event: "backend.request.completed",
  service: "stack-backend",
  method: string,
  path: string,
  host: string | null,
  status: number | string | undefined,
  durationMs: number | null,
  requestId: string | null,
  environment: string,
  commit: string | null,
  region: string | null,
  runtime: string,
};

export function createRequestCompletionLog(input: {
  request: Request,
  response: unknown,
  fallbackStatus: number | string | undefined,
  startedAt: number | undefined,
  normalizedPath: string,
}): RequestCompletionLog {
  const status = input.response instanceof Response ? input.response.status : input.fallbackStatus;
  const requestId = input.response instanceof Response
    ? input.response.headers.get("x-hexclave-request-id") ?? input.response.headers.get("x-stack-request-id")
    : null;

  return {
    event: "backend.request.completed",
    service: "stack-backend",
    method: input.request.method,
    path: input.normalizedPath,
    host: getInboundRequestHost(input.request) ?? null,
    status,
    durationMs: input.startedAt == null ? null : Number((performance.now() - input.startedAt).toFixed(1)),
    requestId,
    environment: getNodeEnvironment(),
    commit: getEnvVariable("VERCEL_GIT_COMMIT_SHA", getEnvVariable("GITHUB_SHA", "")) || null,
    // The Cloud Run fallback deployment sets GOOGLE_CLOUD_REGION instead of VERCEL_REGION.
    region: getEnvVariable("VERCEL_REGION", getEnvVariable("GOOGLE_CLOUD_REGION", "")) || null,
    runtime: process.version,
  };
}
