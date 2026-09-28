import { createHash } from "node:crypto";

// Fly app names are global across ALL of Fly (not per-org), ≤30 chars for reliable cert
// issuance, lowercase alnum + hyphen. Readable fragments are deliberately tiny so the
// full identity gets a 72-bit hash; the former 24-bit suffix collided at realistic scale.

function sanitize(value: string, maxLength: number): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (cleaned || "x").slice(0, maxLength);
}

function hashHex(parts: string[], length: number): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, length);
}

// hxc-<env1>-<ns2>-<key2>-<hash18> — exactly 30 chars at the maximum.
export function appNameForService(envId: string, ns: string, key: string): string {
  return `hxc-${sanitize(envId, 1)}-${sanitize(ns, 2)}-${sanitize(key, 2)}-${hashHex([envId, ns, key], 18)}`;
}

// One custom 6PN network per namespace: cross-tenant traffic is unroutable (smoke-verified:
// .flycast/.internal are NXDOMAIN from another network).
export function networkForNamespace(envId: string, ns: string): string {
  return `hxcn-${sanitize(envId, 1)}-${hashHex([envId, ns], 12)}`;
}

// The builder app is per environment, on its own network (it never needs to reach tenant
// apps — only R2, the registry, and Marshal's public webhook).
export function builderAppName(envId: string): string {
  return `hxc-b-${sanitize(envId, 4)}-${hashHex([envId, "builder"], 12)}`;
}

export function builderNetworkName(envId: string): string {
  return `hxcn-b-${sanitize(envId, 4)}-${hashHex([envId, "builder-network"], 12)}`;
}

// The service's private DNS name, which resolves to the stable private IPv6
// (Flycast) address of its app. A pure function of the service identity, so it
// answers before the service has ever been deployed.
export function hostnameForService(envId: string, ns: string, key: string): string {
  return `${appNameForService(envId, ns, key)}.flycast`;
}
