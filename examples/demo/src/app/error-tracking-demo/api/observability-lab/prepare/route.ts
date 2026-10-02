import { captureError } from "@hexclave/shared/dist/utils/errors";
import { prepareObservabilityLab } from "../../../observability-lab-upload";

export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function POST(): Promise<Response> {
  try {
    const result = await prepareObservabilityLab(readLabApiAuth());
    return Response.json({
      ok: true,
      release: result.release,
      releaseId: result.releaseId,
      debugId: result.debugId,
      codeFile: result.codeFile,
      manifestSha256: result.manifestSha256,
      sourceMaps: result.sourceMaps,
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    captureError("observability-lab-prepare", error);
    return Response.json({ ok: false, message: "Failed to prepare the observability lab" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

function readLabApiAuth(): {
  apiUrl: string,
  projectId: string,
  secretServerKey: string,
} {
  return {
    apiUrl: requireEnv("NEXT_PUBLIC_HEXCLAVE_API_URL"),
    projectId: requireEnv("NEXT_PUBLIC_HEXCLAVE_PROJECT_ID"),
    secretServerKey: requireEnv("HEXCLAVE_SECRET_SERVER_KEY"),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value == null || value === "") {
    throw new Error(`${name} must be set to register the observability lab release and source maps.`);
  }
  return value;
}
