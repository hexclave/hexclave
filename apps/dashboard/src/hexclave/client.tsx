import { getPublicEnvVar } from "@/lib/env";
import { isIndependentTvDisplayPath } from "@/lib/tv-mode/routes";
import { StackClientApp } from "@hexclave/next";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import "../polyfills";

if (getPublicEnvVar("NEXT_PUBLIC_STACK_PROJECT_ID") !== "internal") {
  throw new Error("This project is not configured correctly. stack-dashboard must always use the internal project.");
}

const isPreview = getPublicEnvVar("NEXT_PUBLIC_STACK_IS_PREVIEW") === "true";
const isRemoteDevelopmentEnvironment = getPublicEnvVar("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT") === "true";

export const hexclaveClientApp = new StackClientApp({
  baseUrl: {
    browser: getPublicEnvVar("NEXT_PUBLIC_BROWSER_STACK_API_URL") ?? getPublicEnvVar("NEXT_PUBLIC_STACK_API_URL") ?? throwErr("NEXT_PUBLIC_BROWSER_STACK_API_URL is not set"),
    server: getPublicEnvVar("NEXT_PUBLIC_SERVER_STACK_API_URL") ?? getPublicEnvVar("NEXT_PUBLIC_STACK_API_URL") ?? throwErr("NEXT_PUBLIC_SERVER_STACK_API_URL is not set"),
  },
  projectId: "internal",
  publishableClientKey: getPublicEnvVar("NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY"),
  tokenStore: isPreview || isRemoteDevelopmentEnvironment ? "memory" : "nextjs-cookie",
  // The independent display is intentionally not a dashboard principal. Even
  // when Next preloads this module, it must not start dashboard identity,
  // analytics, replay, or development-overlay requests from the display.
  automaticSideEffects: typeof window === "undefined" || !isIndependentTvDisplayPath(window.location.pathname),
  urls: {
    afterSignIn: "/projects",
    afterSignUp: "/new-project",
    afterSignOut: "/",
  },
  analytics: {
    enabled: !isRemoteDevelopmentEnvironment,
    replays: {
      maskAllInputs: false,
      blockClass: "hexclave-sensitive",
      enabled: !isPreview && !isRemoteDevelopmentEnvironment,
    },
  },
});
