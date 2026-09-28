import { resolveTxt } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { getConfig } from "./config.js";
import type { DnsRecord } from "./types.js";

const VERIFICATION_PREFIX = "hexclave-domain-verification=";

export function createDomainVerificationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function domainVerificationRecord(hostname: string, token: string): DnsRecord {
  return {
    type: "TXT",
    name: `_hexclave-verification.${hostname}`,
    value: `${VERIFICATION_PREFIX}${token}`,
  };
}

function isDnsNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENODATA" || error.code === "ENOTFOUND" || error.code === "ESERVFAIL";
}

export async function hasDomainVerificationRecord(hostname: string, token: string): Promise<boolean> {
  // The GCP simulator already uses this suffix to model an active managed certificate. Keep
  // its DNS side deterministic too, but only when mock mode is explicitly configured.
  if (getConfig().gcp?.mockUrl != null && hostname.endsWith(".verified.test")) return true;
  const expected = domainVerificationRecord(hostname, token);
  try {
    const records = await resolveTxt(expected.name);
    return records.some((segments) => segments.join("") === expected.value);
  } catch (error) {
    if (isDnsNotFound(error)) return false;
    throw error;
  }
}
