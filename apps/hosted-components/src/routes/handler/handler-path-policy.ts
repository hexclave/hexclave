const canonicalHandlerPaths = [
  "account-settings",
  "sign-in",
  "sign-up",
  "forgot-password",
  "password-reset",
  "email-verification",
  "sign-out",
  "oauth-callback",
  "magic-link-callback",
  "team-invitation",
  "cli-auth-confirm",
  "agent-auth-confirm",
  "mfa",
  "error",
  "onboarding",
];

export function isCanonicalHandlerPathOrAlias(handlerPath: string) {
  const normalizedPath = handlerPath.toLowerCase().replaceAll("-", "");
  return canonicalHandlerPaths.some(
    (canonicalPath) => canonicalPath.replaceAll("-", "") === normalizedPath,
  ) || normalizedPath === "login" || normalizedPath === "register";
}
