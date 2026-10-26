import "server-only";

import { createTvBoxQaResponse } from "./response";

export function GET(request: Request): Response {
  const fixture = new URL(request.url).searchParams.get("fixture");
  return createTvBoxQaResponse({
    enabled: process.env.HEXCLAVE_TV_BOX_QA_ENABLED,
    fixture,
    nodeEnvironment: process.env.NODE_ENV,
  });
}
