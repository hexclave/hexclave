// One place that knows how to construct a TenantProjectManager: both the per-request tenant
// context and the background pool replenishment (which runs outside any request) build one.
import { gcpConfig, getConfig } from "../config.js";
import { GcpClient } from "./client.js";
import { TenantProjectManager } from "./projects.js";

export function createGcpClient(): GcpClient {
  const config = gcpConfig();
  return new GcpClient(config.mockUrl === null || config.mockToken === null
    ? undefined
    : { url: config.mockUrl, token: config.mockToken });
}

export function createTenantProjectManager(): TenantProjectManager {
  const gcp = gcpConfig();
  return new TenantProjectManager(createGcpClient(), {
    envId: getConfig().envId,
    billingAccount: gcp.billingAccount,
    parent: gcp.projectParent,
    projectPrefix: gcp.projectPrefix,
  });
}
