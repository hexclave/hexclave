import { HexclaveClientApp } from "@hexclave/next";
import { envOrDevDefault, hexclaveApiUrl } from "./lib/env";

function createHexclaveClientApp() {
  const projectId = envOrDevDefault(
    process.env.NEXT_PUBLIC_HEXCLAVE_PROJECT_ID,
    "internal",
    "NEXT_PUBLIC_HEXCLAVE_PROJECT_ID",
  );
  const apiUrl = hexclaveApiUrl();

  return new HexclaveClientApp({
    projectId,
    tokenStore: "cookie",
    redirectMethod: "window",
    baseUrl: apiUrl,
    urls: {
      handler: "/handler",
      afterSignIn: "/",
      afterSignUp: "/",
      afterSignOut: "/handler/sign-in",
    },
  });
}

// The config above comes from NEXT_PUBLIC_HEXCLAVE_* env vars that are injected at container startup
// via the sentinel-replacement model (the build bakes in REPLACE_ME placeholders). HexclaveClientApp
// eagerly validates projectId as a UUID at construction, so building the app while the value is still
// the unreplaced sentinel throws. Construct lazily and only once, so it happens at first runtime use —
// on the client, after the real values are in place — and the routes stay statically prerenderable.
let cachedApp: ReturnType<typeof createHexclaveClientApp> | undefined;
export function getHexclaveClientApp() {
  return cachedApp ??= createHexclaveClientApp();
}
