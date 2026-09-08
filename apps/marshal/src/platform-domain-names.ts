import { appNameForService } from "./fly/naming.js";

export const PLATFORM_DOMAIN = "deploy.built-with-hexclave.com";

export function platformHostname(envId: string, ns: string, key: string): string {
  // The dedicated gateway routes <suffix>.deploy.built-with-hexclave.com to
  // hxc-<suffix>.fly.dev. Use the
  // existing app identity so neither redeploys nor this change rename Fly apps.
  const appName = appNameForService(envId, ns, key);
  if (!appName.startsWith("hxc-")) throw new Error("Fly deployment app names must start with hxc-");
  return `${appName.slice(4)}.${PLATFORM_DOMAIN}`;
}

export function isPlatformHostname(hostname: string): boolean {
  const normalized = hostname.replace(/\.$/, "").toLowerCase();
  return normalized === PLATFORM_DOMAIN || normalized.endsWith(`.${PLATFORM_DOMAIN}`);
}
