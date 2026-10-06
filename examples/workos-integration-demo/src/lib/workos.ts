export function getWorkOSRedirectUri(): string {
  const redirectUri = process.env.WORKOS_REDIRECT_URI;
  if (redirectUri == null || redirectUri.length === 0) {
    throw new Error("Missing required environment variable: WORKOS_REDIRECT_URI");
  }
  if (!URL.canParse(redirectUri)) {
    throw new Error("WORKOS_REDIRECT_URI must be a valid URL");
  }
  const parsed = new URL(redirectUri);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("WORKOS_REDIRECT_URI must use http: or https:");
  }
  return redirectUri;
}

export function getWorkOSBaseUrl(): string {
  return new URL(getWorkOSRedirectUri()).origin;
}
