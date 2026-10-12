import { authkitMiddleware } from "@workos-inc/authkit-nextjs";
import { NextFetchEvent, NextRequest } from "next/server";
import { getWorkOSRedirectUri } from "./lib/workos";

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  return authkitMiddleware({
    debug: process.env.NODE_ENV === "development",
    redirectUri: getWorkOSRedirectUri(),
  })(request, event);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
