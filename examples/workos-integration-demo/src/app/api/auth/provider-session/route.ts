import { withAuth } from "@workos-inc/authkit-nextjs";
import { NextResponse } from "next/server";

export async function GET() {
  const { accessToken, sessionId, user } = await withAuth();
  if (accessToken == null || sessionId == null) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.json({
    // The browser-side external token store must read this provider JWT to exchange it with Hexclave.
    accessToken,
    sessionId,
    user: user == null ? null : {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
    },
  }, {
    // The response carries a live bearer token, so it must never be served from a browser or proxy cache.
    headers: { "Cache-Control": "no-store" },
  });
}
