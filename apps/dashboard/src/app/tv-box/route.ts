import { getPublicEnvVar } from "@/lib/env";
import { createTvBoxDocument, resolveTvBoxApiConfiguration } from "./document";

export function GET(): Response {
  const api = resolveTvBoxApiConfiguration({
    configuredApiUrl: getPublicEnvVar("NEXT_PUBLIC_STACK_API_URL"),
    configuredBrowserApiUrl: getPublicEnvVar("NEXT_PUBLIC_BROWSER_STACK_API_URL"),
    nodeEnvironment: process.env.NODE_ENV,
    quickTunnelEnabled: getPublicEnvVar("NEXT_PUBLIC_HEXCLAVE_TV_QUICK_TUNNEL_ENABLED") === "true",
  });

  return new Response(createTvBoxDocument({ mode: "live", api }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
  });
}
