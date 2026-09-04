import { NextRequest, NextResponse } from "next/server";

export function isJsonObjectBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readRemoteDevelopmentEnvironmentJsonBody(req: NextRequest): Promise<unknown | NextResponse> {
  try {
    return await req.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Malformed JSON request body." }, { status: 400 });
    }
    throw error;
  }
}
