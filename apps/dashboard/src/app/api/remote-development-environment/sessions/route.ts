import { NextRequest, NextResponse } from "next/server";
import { isAllowedRemoteDevelopmentEnvironmentApiBaseUrl } from "@/lib/remote-development-environment/api-base-url";
import { RemoteDevelopmentEnvironmentApiUnavailableError, registerRemoteDevelopmentEnvironmentSession } from "@/lib/remote-development-environment/manager";
import { isJsonObjectBody, readRemoteDevelopmentEnvironmentJsonBody } from "@/lib/remote-development-environment/route-json";
import { assertRemoteDevelopmentEnvironmentRequest } from "@/lib/remote-development-environment/security";


export async function POST(req: NextRequest) {
  const securityResponse = assertRemoteDevelopmentEnvironmentRequest(req);
  if (securityResponse != null) return securityResponse;

  const parsedBody = await readRemoteDevelopmentEnvironmentJsonBody(req);
  if (parsedBody instanceof NextResponse) return parsedBody;

  if (!isJsonObjectBody(parsedBody)) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }
  const body = parsedBody;
  if (typeof body.api_base_url !== "string" || typeof body.config_path !== "string") {
    return NextResponse.json({ error: "api_base_url and config_path are required." }, { status: 400 });
  }
  if (!isAllowedRemoteDevelopmentEnvironmentApiBaseUrl(body.api_base_url)) {
    return NextResponse.json({ error: "api_base_url is not allowed for remote development environments." }, { status: 400 });
  }

  const result = await registerRemoteDevelopmentEnvironmentSession({
    apiBaseUrl: body.api_base_url,
    configPath: body.config_path,
  }).catch((error: unknown) => {
    if (error instanceof RemoteDevelopmentEnvironmentApiUnavailableError) {
      return error;
    }
    throw error;
  });
  if (result instanceof RemoteDevelopmentEnvironmentApiUnavailableError) {
    return NextResponse.json({ error: result.message }, { status: 503 });
  }
  return NextResponse.json({
    session_id: result.sessionId,
    env: result.env,
    project_id: result.projectId,
    onboarding_outstanding: result.onboardingOutstanding,
  });
}
