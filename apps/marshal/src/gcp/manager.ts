// One place that knows how to construct a TenantProjectManager: both the per-request tenant
// context and the background pool replenishment (which runs outside any request) build one.
import { getConfig } from "../config.js";
import { GcpClient } from "./client.js";
import { TenantProjectManager } from "./projects.js";

export function createGcpClient(): GcpClient {
  const config = getConfig();
  return new GcpClient(config.gcp.mockUrl === null || config.gcp.mockToken === null
    ? undefined
    : { url: config.gcp.mockUrl, token: config.gcp.mockToken });
}

export function createTenantProjectManager(): TenantProjectManager {
  const config = getConfig();
  return new TenantProjectManager(createGcpClient(), {
    envId: config.envId,
    billingAccount: config.gcp.billingAccount,
    parent: config.gcp.projectParent,
    projectPrefix: config.gcp.projectPrefix,
  });
}
