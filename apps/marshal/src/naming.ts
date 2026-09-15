import { createHash } from "node:crypto";

// GCP resource names are project-local, lowercase alnum + hyphen. We still hash the full
// identity: it keeps names stable across renames of display fragments and avoids exposing a
// tenant namespace in public Cloud Run URLs.

function sanitize(value: string, maxLength: number): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (cleaned || "x").slice(0, maxLength);
}

function hashHex(parts: string[], length: number): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, length);
}

// hxc-<env1>-<ns2>-<key2>-<hash18> — exactly 30 chars at the maximum.
export function serviceName(envId: string, ns: string, key: string): string {
  return `hxc-${sanitize(envId, 1)}-${sanitize(ns, 2)}-${sanitize(key, 2)}-${hashHex([envId, ns, key], 18)}`;
}

export function instanceNameForService(envId: string, ns: string, key: string): string {
  return `${serviceName(envId, ns, key)}-vm`;
}

export function diskNameForVolume(envId: string, ns: string, key: string, volumeId: string): string {
  return `hxv-${sanitize(key, 5)}-${hashHex([envId, ns, key, volumeId], 18)}`;
}

export function builderInstanceName(envId: string, deploymentId: string): string {
  return `hxb-${sanitize(envId, 4)}-${deploymentId.toLowerCase().slice(-20)}`.slice(0, 63).replace(/-$/, "0");
}

export function privateHostnameForService(envId: string, ns: string, key: string): string {
  return `${serviceName(envId, ns, key)}.internal`;
}
