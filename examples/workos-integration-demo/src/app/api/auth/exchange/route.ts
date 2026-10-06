import { withAuth } from "@workos-inc/authkit-nextjs";
import { NextResponse } from "next/server";

type ExchangeResponse = {
  access_token: string,
  session_id: string,
  user_id: string,
  is_new_user?: boolean,
  code?: string,
  error?: string,
};

type ProfileResponse = {
  primary_email?: string | null,
  display_name?: string | null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseExchangeResponse(value: unknown): ExchangeResponse | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.access_token !== "string" || value.access_token.length === 0
    || typeof value.session_id !== "string" || value.session_id.length === 0
    || typeof value.user_id !== "string" || value.user_id.length === 0
    || (value.code !== undefined && typeof value.code !== "string")
    || (value.error !== undefined && typeof value.error !== "string")
  ) return null;
  if (value.is_new_user !== undefined && typeof value.is_new_user !== "boolean") return null;
  return {
    access_token: value.access_token,
    session_id: value.session_id,
    user_id: value.user_id,
    is_new_user: value.is_new_user,
    code: value.code,
    error: value.error,
  };
}

function parseProfileResponse(value: unknown): ProfileResponse | null {
  if (!isRecord(value)) return null;
  if (value.primary_email != null && typeof value.primary_email !== "string") return null;
  if (value.display_name != null && typeof value.display_name !== "string") return null;
  return {
    primary_email: value.primary_email,
    display_name: value.display_name,
  };
}

async function fetchWithTimeout(request: Request, input: string, init: RequestInit): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(10_000);
  return await fetch(input, {
    ...init,
    signal: AbortSignal.any([request.signal, timeoutSignal]),
  });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin == null || origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Cross-origin exchange requests are not allowed" }, { status: 403 });
  }
  const { accessToken } = await withAuth();
  if (accessToken == null) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const apiUrl = process.env.NEXT_PUBLIC_HEXCLAVE_API_URL;
  const projectId = process.env.NEXT_PUBLIC_HEXCLAVE_PROJECT_ID;
  if (apiUrl == null || apiUrl.length === 0) throw new Error("Missing required environment variable: NEXT_PUBLIC_HEXCLAVE_API_URL");
  if (projectId == null || projectId.length === 0) throw new Error("Missing required environment variable: NEXT_PUBLIC_HEXCLAVE_PROJECT_ID");
  let response: Response;
  try {
    response = await fetchWithTimeout(request, new URL("/api/latest/auth/external/token", apiUrl).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hexclave-access-type": "client",
        "x-hexclave-project-id": projectId,
      },
      body: JSON.stringify({ provider_id: "workos-integration", token: accessToken }),
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return NextResponse.json({ error: "Hexclave token exchange timed out" }, { status: 504 });
    }
    throw error;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("application/json")) {
    return NextResponse.json({
      error: "Hexclave rejected the WorkOS token exchange",
    }, { status: response.ok ? 502 : response.status });
  }
  const result = parseExchangeResponse(await response.json().catch(() => null));
  if (result == null) {
    return NextResponse.json({ error: "Hexclave returned an invalid token exchange response" }, { status: 502 });
  }
  let profileResponse: Response;
  try {
    profileResponse = await fetchWithTimeout(request, new URL("/api/v1/users/me", apiUrl).toString(), {
      headers: {
        "x-hexclave-access-token": result.access_token,
        "x-hexclave-access-type": "client",
        "x-hexclave-project-id": projectId,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return NextResponse.json({ error: "Hexclave user lookup timed out" }, { status: 504 });
    }
    throw error;
  }
  if (!profileResponse.ok || !(profileResponse.headers.get("content-type") ?? "").includes("application/json")) {
    return NextResponse.json({ error: "Hexclave user lookup failed after token exchange" }, { status: 502 });
  }
  const parsedProfile = parseProfileResponse(await profileResponse.json().catch(() => null));
  if (parsedProfile == null) {
    return NextResponse.json({ error: "Hexclave returned an invalid user profile response" }, { status: 502 });
  }
  return NextResponse.json({
    sessionId: result.session_id,
    userId: result.user_id,
    isNewUser: result.is_new_user,
    primaryEmail: parsedProfile.primary_email ?? null,
    displayName: parsedProfile.display_name ?? null,
    error: result.error ?? result.code,
  }, { status: response.status });
}
