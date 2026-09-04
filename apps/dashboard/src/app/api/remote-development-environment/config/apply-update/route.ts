import { NextRequest, NextResponse } from "next/server";
import { applyRemoteDevelopmentEnvironmentConfigUpdate } from "@/lib/remote-development-environment/manager";
import { isJsonObjectBody, readRemoteDevelopmentEnvironmentJsonBody } from "@/lib/remote-development-environment/route-json";
import { assertRemoteDevelopmentEnvironmentBrowserRequest, assertRemoteDevelopmentEnvironmentRequest } from "@/lib/remote-development-environment/security";
import { isValidConfig } from "@hexclave/shared/dist/config/format";


export async function POST(req: NextRequest) {
  const securityResponse = req.headers.has("authorization")
    ? assertRemoteDevelopmentEnvironmentRequest(req)
    : assertRemoteDevelopmentEnvironmentBrowserRequest(req);
  if (securityResponse != null) return securityResponse;

  const parsedBody = await readRemoteDevelopmentEnvironmentJsonBody(req);
  if (parsedBody instanceof NextResponse) return parsedBody;

  if (!isJsonObjectBody(parsedBody)) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }
  const body = parsedBody;
  if (
    (body.session_id !== undefined && typeof body.session_id !== "string") ||
    (body.project_id !== undefined && typeof body.project_id !== "string") ||
    (body.wait_for_sync !== undefined && typeof body.wait_for_sync !== "boolean") ||
    (body.session_id === undefined && body.project_id === undefined) ||
    body.config_update == null ||
    typeof body.config_update !== "object" ||
    Array.isArray(body.config_update)
  ) {
    return NextResponse.json({ error: "session_id or project_id, and config_update object are required." }, { status: 400 });
  }
  if (!isValidConfig(body.config_update)) {
    return NextResponse.json({ error: "config_update must be a valid Hexclave config object." }, { status: 400 });
  }

  await applyRemoteDevelopmentEnvironmentConfigUpdate({
    sessionId: body.session_id,
    projectId: body.project_id,
    configUpdate: body.config_update,
    waitForSync: body.wait_for_sync ?? true,
  });
  return NextResponse.json({ ok: true });
}
