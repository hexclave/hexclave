import { appNameForService } from "./fly/naming.js";

const DEFAULT_PLATFORM_DOMAIN = "deploy.built-with-hexclave.com";

export function platformDomain(): string {
  const domain = process.env.HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN ?? DEFAULT_PLATFORM_DOMAIN;
  if (domain.length > 190 || /[^a-z0-9.-]/.test(domain) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error("HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN must be a lowercase DNS domain of at most 190 characters");
  }
  return domain;
}

export function platformHostname(envId: string, ns: string, key: string): string {
  // The dedicated gateway routes <suffix>.deploy.built-with-hexclave.com to
  // hxc-<suffix>.fly.dev. Use the
  // existing app identity so neither redeploys nor this change rename Fly apps.
  const appName = appNameForService(envId, ns, key);
  if (!appName.startsWith("hxc-")) throw new Error("Fly deployment app names must start with hxc-");
  return `${appName.slice(4)}.${platformDomain()}`;
}

export function isPlatformHostname(hostname: string): boolean {
  const normalized = hostname.replace(/\.$/, "").toLowerCase();
  return normalized === platformDomain() || normalized.endsWith(`.${platformDomain()}`);
}
