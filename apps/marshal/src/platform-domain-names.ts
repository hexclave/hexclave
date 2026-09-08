import { createHash } from "node:crypto";

export const PLATFORM_DOMAIN = "built-with-hexclave.com";

export function platformHostname(envId: string, ns: string, key: string): string {
  // Service keys are unique within a namespace, including across deployment groups.
  // Keep names independent of revisions and separate from hosted-component project origins.
  const id = createHash("sha256").update(JSON.stringify([envId, ns, key])).digest("hex").slice(0, 40);
  return `deploy-${id}.${PLATFORM_DOMAIN}`;
}

export function isPlatformHostname(hostname: string): boolean {
  return /^deploy-[^.]+\.built-with-hexclave\.com$/i.test(hostname.replace(/\.$/, ""));
}
