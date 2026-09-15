import { observeAndLog, sanitizeBody } from "@/lib/ai/ai-proxy-handlers";
import { PRODUCTION_AI_PROXY_BASE_URL } from "@/lib/ai/proxy-url";
import { handleApiRequest } from "@/route-handlers/smart-route-handler";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { captureError } from "@hexclave/shared/dist/utils/errors";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

async function proxyToOpenRouter(req: Request, options: { params: Promise<{ path?: string[] }> }) {
  const apiKey = getEnvVariable("STACK_OPENROUTER_API_KEY");
  const params = await options.params;
  const subpath = params.path?.join("/") ?? "";
  const search = new URL(req.url).search;

  const sanitized = req.method !== "GET" && req.method !== "HEAD"
    ? sanitizeBody(await req.arrayBuffer())
    : undefined;
  const body = sanitized ? Buffer.from(sanitized.bytes) : undefined;
  const callerApiKey = req.headers.get("x-api-key");
  const shouldLog = sanitized != null && callerApiKey != null && callerApiKey.startsWith("stack-auth-");
  const correlationId = crypto.randomUUID();
  const startedAt = performance.now();

  const targetUrl = apiKey === "FORWARD_TO_PRODUCTION"
    ? `${PRODUCTION_AI_PROXY_BASE_URL}/${subpath}${search}`
    : `${OPENROUTER_BASE_URL}/${subpath}${search}`;
  const forwardHeaders: Record<string, string> = apiKey === "FORWARD_TO_PRODUCTION"
    ? {}
    : {
      "Authorization": `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01",
    };
  if (body) forwardHeaders["Content-Type"] = "application/json";

  const response = await fetch(targetUrl, { method: req.method, headers: forwardHeaders, body });

  const responseHeaders: Record<string, string> = {
    "Content-Type": response.headers.get("Content-Type") ?? "application/json",
    "Cache-Control": "no-store",
  };
  const generationIdHeader = response.headers.get("X-Generation-Id");
  if (generationIdHeader != null) {
    responseHeaders["X-Generation-Id"] = generationIdHeader;
  }

  const passthrough = () => new Response(response.body, { status: response.status, headers: responseHeaders });

  if (!shouldLog) return passthrough();
  try {
    return await observeAndLog({
      response,
      sanitizedBody: sanitized!,
      callerApiKey,
      correlationId,
      startedAt,
      responseHeaders,
    });
  } catch (e) {
    captureError("ai-proxy-log-pipeline", e);
    return passthrough();
  }
}

export const GET = handleApiRequest(proxyToOpenRouter);
export const POST = handleApiRequest(proxyToOpenRouter);
