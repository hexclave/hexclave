import { appNameForService } from "./fly/naming.js";

export const PLATFORM_DOMAIN = "built-with-hexclave.com";

export function platformHostname(envId: string, ns: string, key: string): string {
  // Hosted components routes deploy-<suffix> to hxc-<suffix>.fly.dev. Use the
  // existing app identity so neither redeploys nor this change rename Fly apps.
  const appName = appNameForService(envId, ns, key);
  if (!appName.startsWith("hxc-")) throw new Error("Fly deployment app names must start with hxc-");
  return `deploy-${appName.slice(4)}.${PLATFORM_DOMAIN}`;
}

export function isPlatformHostname(hostname: string): boolean {
  return /^deploy-[^.]+\.built-with-hexclave\.com$/i.test(hostname.replace(/\.$/, ""));
}
