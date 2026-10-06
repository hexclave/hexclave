import { NextResponse } from "next/server";

type ExchangeResponse = {
  access_token: string,
  session_id: string,
  user_id: string,
  is_new_user?: boolean,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseExchangeResponse(value: unknown): ExchangeResponse | null {
  if (
    !isRecord(value)
    || typeof value.access_token !== "string"
    || typeof value.session_id !== "string"
    || typeof value.user_id !== "string"
    || (value.is_new_user !== undefined && typeof value.is_new_user !== "boolean")
  ) return null;
  return {
    access_token: value.access_token,
    session_id: value.session_id,
    user_id: value.user_id,
    is_new_user: value.is_new_user,
  };
}

function parseProfileResponse(value: unknown): { primary_email: string | null, display_name: string | null } | null {
  if (
    !isRecord(value)
    || (value.primary_email != null && typeof value.primary_email !== "string")
    || (value.display_name != null && typeof value.display_name !== "string")
  ) return null;
  return {
    primary_email: typeof value.primary_email === "string" ? value.primary_email : null,
    display_name: typeof value.display_name === "string" ? value.display_name : null,
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
  // The README promises a same-origin exchange, so enforce it like the other demos do.
  const origin = request.headers.get("origin");
  if (origin == null || origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Cross-origin exchange requests are not allowed" }, { status: 403 });
  }
  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body) || typeof body.token !== "string" || body.token.length === 0) {
    return NextResponse.json({ error: "A Clerk session token is required" }, { status: 400 });
  }
  const apiUrl = process.env.NEXT_PUBLIC_HEXCLAVE_API_URL;
  const projectId = process.env.NEXT_PUBLIC_HEXCLAVE_PROJECT_ID;
  if (apiUrl == null || apiUrl.length === 0 || projectId == null || projectId.length === 0) {
    throw new Error("Missing required Hexclave environment variables");
  }
  let response: Response;
  try {
    response = await fetchWithTimeout(request, new URL("/api/latest/auth/external/token", apiUrl).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hexclave-access-type": "client",
        "x-hexclave-project-id": projectId,
      },
      body: JSON.stringify({ provider_id: "clerk-integration", token: body.token }),
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return NextResponse.json({ error: "Hexclave token exchange timed out" }, { status: 504 });
    }
    throw error;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("application/json")) {
    return NextResponse.json({ error: "Hexclave rejected the Clerk token exchange" }, { status: response.ok ? 502 : response.status });
  }
  const result = parseExchangeResponse(await response.json().catch(() => null));
  if (result == null) return NextResponse.json({ error: "Hexclave returned an invalid token exchange response" }, { status: 502 });
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
  const profile = parseProfileResponse(await profileResponse.json().catch(() => null));
  if (profile == null) return NextResponse.json({ error: "Hexclave returned an invalid user profile response" }, { status: 502 });
  return NextResponse.json({
    sessionId: result.session_id,
    userId: result.user_id,
    isNewUser: result.is_new_user ?? false,
    primaryEmail: profile.primary_email,
    displayName: profile.display_name,
  });
}
