import { createHmac } from "node:crypto";
import { appNameForService } from "./fly/naming.js";

const DEFAULT_PLATFORM_DOMAIN = "deploy.built-with-hexclave.com";

// Public, development-only key shared with the local gateway test. Marshal refuses it
// unless MARSHAL_ALLOW_MOCKS=1 (see config.ts), like the development data-encryption key.
export const DEVELOPMENT_PLATFORM_HOSTNAME_KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f9000112233445566778899aabbccddeeff";
// 64 bits: every guess is a full HTTPS request the gateway answers with 421, and an attacker
// holding K registered hxc-* apps only gets a K-fold speedup. The label stays at 43
// characters, well under the 63-character DNS limit.
export const PLATFORM_HOSTNAME_MAC_HEX_LENGTH = 16;
const PLATFORM_HOSTNAME_MAC_CONTEXT = "hexclave-deployment-hostname/v1";

export function platformDomain(): string {
  // `||`, not `??`: the documented placeholder in .env loads as an empty string.
  const domain = process.env.HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN || DEFAULT_PLATFORM_DOMAIN;
  if (domain.length > 190 || /[^a-z0-9.-]/.test(domain) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error("HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN must be a lowercase DNS domain of at most 190 characters");
  }
  return domain;
}

// The key the deployment gateway also holds. Only a holder can mint a platform hostname the
// gateway routes, which is what makes a globally claimable `hxc-*` Fly app name unreachable
// under our domain. Rotating it renames every platform URL, so it is rotated on compromise,
// not on a schedule.
export function platformHostnameKey(): Buffer {
  const value = process.env.HEXCLAVE_DEPLOYMENT_HOSTNAME_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("HEXCLAVE_DEPLOYMENT_HOSTNAME_KEY must be exactly 64 hexadecimal characters (32 bytes)");
  }
  return Buffer.from(value, "hex");
}

// Must match apps/deployment-gateway/gateway.js byte for byte: the gateway recomputes this
// from the hostname alone. The domain is bound in so a name minted for one gateway (say
// a preproduction domain sharing a key by mistake) is not valid on another.
export function platformHostnameMac(domain: string, appSuffix: string, key: Buffer): string {
  return createHmac("sha256", key)
    .update(`${PLATFORM_HOSTNAME_MAC_CONTEXT}\0${domain}\0${appSuffix}`, "utf8")
    .digest("hex")
    .slice(0, PLATFORM_HOSTNAME_MAC_HEX_LENGTH);
}

export function platformHostname(envId: string, ns: string, key: string): string {
  // The dedicated gateway routes <suffix>-<mac>.deploy.built-with-hexclave.com to
  // hxc-<suffix>.fly.dev after checking the mac, and accepts only suffixes shaped like
  // appNameForService's output (apps/deployment-gateway/gateway.js) — changing that shape
  // means changing the gateway too. Use the existing app identity so neither redeploys nor
  // this change rename Fly apps.
  const domain = platformDomain();
  const appName = appNameForService(envId, ns, key);
  if (!appName.startsWith("hxc-")) throw new Error("Fly deployment app names must start with hxc-");
  const appSuffix = appName.slice(4);
  return `${appSuffix}-${platformHostnameMac(domain, appSuffix, platformHostnameKey())}.${domain}`;
}

export function isPlatformHostname(hostname: string): boolean {
  const normalized = hostname.replace(/\.$/, "").toLowerCase();
  return normalized === platformDomain() || normalized.endsWith(`.${platformDomain()}`);
}
