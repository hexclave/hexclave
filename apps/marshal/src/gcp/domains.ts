import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { DnsRecord } from "../types.js";
import { GcpApiError, GcpClient, parseGcpOperation } from "./client.js";

export type DomainLoadBalancerConfig = {
  tenantProjectId: string,
  platformProjectId: string,
  environmentId: string,
  region: string,
};

export type DomainLoadBalancerState = {
  hostname: string,
  verified: boolean,
  dnsRecords: DnsRecord[],
};

type ComputeOperation = { selfLink: string, status: string, error: string | null };
type UrlMap = {
  name: string,
  defaultService: string,
  fingerprint?: string,
  hostRules: { hosts: string[], pathMatcher: string }[],
  pathMatchers: { name: string, defaultService: string }[],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseComputeOperation(value: unknown): ComputeOperation {
  if (!isRecord(value) || typeof value.selfLink !== "string" || typeof value.status !== "string") throw new Error("Compute Engine returned an invalid load-balancer operation");
  const messages = isRecord(value.error) && Array.isArray(value.error.errors)
    ? value.error.errors.flatMap((entry) => isRecord(entry) && typeof entry.message === "string" ? [entry.message] : [])
    : [];
  return { selfLink: value.selfLink, status: value.status, error: messages.length === 0 ? null : messages.join("; ") };
}

function parseUrlMap(value: unknown): UrlMap {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.defaultService !== "string") throw new Error("Compute Engine returned an invalid shared URL map");
  if (value.fingerprint !== undefined && typeof value.fingerprint !== "string") throw new Error("Compute Engine returned an invalid shared URL map fingerprint");
  if (value.hostRules !== undefined && !Array.isArray(value.hostRules)) throw new Error("Compute Engine returned invalid shared URL map host rules");
  if (value.pathMatchers !== undefined && !Array.isArray(value.pathMatchers)) throw new Error("Compute Engine returned invalid shared URL map path matchers");
  const hostRules = (value.hostRules ?? []).map((rule) => {
    if (!isRecord(rule) || !Array.isArray(rule.hosts) || !rule.hosts.every((host) => typeof host === "string") || typeof rule.pathMatcher !== "string") throw new Error("Compute Engine returned an invalid shared URL map host rule");
    return { hosts: rule.hosts, pathMatcher: rule.pathMatcher };
  });
  const pathMatchers = (value.pathMatchers ?? []).map((matcher) => {
    if (!isRecord(matcher) || typeof matcher.name !== "string" || typeof matcher.defaultService !== "string") throw new Error("Compute Engine returned an invalid shared URL map path matcher");
    return { name: matcher.name, defaultService: matcher.defaultService };
  });
  return { name: value.name, defaultService: value.defaultService, ...(value.fingerprint === undefined ? {} : { fingerprint: value.fingerprint }), hostRules, pathMatchers };
}

function hashedName(prefix: string, value: string, length: number): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, length)}`;
}

export class DomainLoadBalancerClient {
  private readonly sharedStem: string;

  constructor(
    private readonly client: GcpClient,
    private readonly config: DomainLoadBalancerConfig,
  ) {
    this.sharedStem = hashedName("hxp", config.environmentId, 16);
  }

  private computeUrl(projectId: string, path: string): string {
    return `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(projectId)}${path}`;
  }

  private certificateManagerUrl(path: string): string {
    return `https://certificatemanager.googleapis.com/v1/projects/${encodeURIComponent(this.config.platformProjectId)}/locations/global${path}`;
  }

  private async waitCompute(value: unknown): Promise<void> {
    let operation = parseComputeOperation(value);
    const startedAt = performance.now();
    while (operation.status !== "DONE") {
      if (performance.now() - startedAt > 10 * 60 * 1000) throw new GcpApiError(408, operation.selfLink, "timed out reconciling the custom-domain load balancer");
      await delay(1000);
      operation = parseComputeOperation(await this.client.request(operation.selfLink));
    }
    if (operation.error !== null) throw new GcpApiError(502, operation.selfLink, operation.error);
  }

  private async waitCertificateManager(value: unknown): Promise<void> {
    await this.client.waitForOperation(parseGcpOperation(value), { apiBaseUrl: "https://certificatemanager.googleapis.com/v1/" });
  }

  private async ensureComputeResource(projectId: string, path: string, collectionPath: string, body: unknown): Promise<unknown> {
    const existing = await this.client.request(this.computeUrl(projectId, path), { allow404: true });
    if (existing !== null) return existing;
    await this.waitCompute(await this.client.request(this.computeUrl(projectId, collectionPath), { method: "POST", body }));
    return await this.client.request(this.computeUrl(projectId, path)) ?? throwError(`Compute Engine resource ${path} disappeared after creation`);
  }

  private async ensureCertificateManagerResource(path: string, collectionPath: string, idParameter: string, id: string, body: unknown): Promise<unknown> {
    const existing = await this.client.request(this.certificateManagerUrl(path), { allow404: true });
    if (existing !== null) return existing;
    await this.waitCertificateManager(await this.client.request(`${this.certificateManagerUrl(collectionPath)}?${idParameter}=${encodeURIComponent(id)}`, { method: "POST", body }));
    return await this.client.request(this.certificateManagerUrl(path)) ?? throwError(`Certificate Manager resource ${path} disappeared after creation`);
  }

  private domainStem(hostname: string): string {
    // Include the Marshal environment so two installations sharing one platform
    // project cannot accidentally adopt each other's certificates or routes.
    return hashedName("hxd", `${this.config.environmentId}\0${hostname}`, 24);
  }

  private async ensureTenantBackend(hostname: string, cloudRunService: string): Promise<string> {
    const stem = this.domainStem(hostname);
    const negPath = `/regions/${this.config.region}/networkEndpointGroups/${stem}-neg`;
    const neg = await this.client.request(this.computeUrl(this.config.tenantProjectId, negPath), { allow404: true });
    if (neg !== null) {
      if (!isRecord(neg) || !isRecord(neg.cloudRun) || typeof neg.cloudRun.service !== "string") throw new Error(`Compute Engine returned an invalid serverless NEG for ${hostname}`);
      if (neg.cloudRun.service !== cloudRunService) {
        // A hostname move is normally preceded by delete(). This branch makes a
        // retry after an interrupted move converge instead of keeping a NEG that
        // targets the former service.
        await this.delete(hostname);
      }
    }
    const negUrl = this.computeUrl(this.config.tenantProjectId, negPath);
    await this.ensureComputeResource(this.config.tenantProjectId, negPath, `/regions/${this.config.region}/networkEndpointGroups`, {
      name: `${stem}-neg`,
      networkEndpointType: "SERVERLESS",
      cloudRun: { service: cloudRunService },
    });
    const backendPath = `/global/backendServices/${stem}-backend`;
    const backend = await this.ensureComputeResource(this.config.tenantProjectId, backendPath, "/global/backendServices", {
      name: `${stem}-backend`,
      loadBalancingScheme: "EXTERNAL_MANAGED",
      protocol: "HTTP",
      portName: "http",
      timeoutSec: 30,
      backends: [{ group: negUrl }],
      logConfig: { enable: true, sampleRate: 1 },
    });
    if (!isRecord(backend) || typeof backend.selfLink !== "string") throw new Error(`Compute Engine returned an invalid backend service for ${hostname}`);
    return backend.selfLink;
  }

  private async ensureCertificateMap(): Promise<void> {
    await this.ensureCertificateManagerResource(`/certificateMaps/${this.sharedStem}-cert-map`, "/certificateMaps", "certificateMapId", `${this.sharedStem}-cert-map`, {});
  }

  private async ensureCertificate(hostname: string): Promise<void> {
    const stem = this.domainStem(hostname);
    const certificateName = `${stem}-cert`;
    await this.ensureCertificateManagerResource(`/certificates/${certificateName}`, "/certificates", "certificateId", certificateName, {
      managed: { domains: [hostname] },
      scope: "DEFAULT",
    });
    const entryName = `${stem}-entry`;
    await this.ensureCertificateManagerResource(`/certificateMaps/${this.sharedStem}-cert-map/certificateMapEntries/${entryName}`, `/certificateMaps/${this.sharedStem}-cert-map/certificateMapEntries`, "certificateMapEntryId", entryName, {
      hostname,
      certificates: [`projects/${this.config.platformProjectId}/locations/global/certificates/${certificateName}`],
    });
  }

  private async ensureSharedFrontend(): Promise<UrlMap> {
    const fallbackName = `${this.sharedStem}-fallback`;
    const fallback = await this.ensureComputeResource(this.config.platformProjectId, `/global/backendServices/${fallbackName}`, "/global/backendServices", {
      name: fallbackName,
      loadBalancingScheme: "EXTERNAL_MANAGED",
      protocol: "HTTP",
      timeoutSec: 30,
    });
    if (!isRecord(fallback) || typeof fallback.selfLink !== "string") throw new Error("Compute Engine returned an invalid shared fallback backend service");
    const urlMapName = `${this.sharedStem}-map`;
    const urlMapValue = await this.ensureComputeResource(this.config.platformProjectId, `/global/urlMaps/${urlMapName}`, "/global/urlMaps", {
      name: urlMapName,
      defaultService: fallback.selfLink,
      hostRules: [],
      pathMatchers: [],
    });
    const urlMap = parseUrlMap(urlMapValue);
    const urlMapUrl = this.computeUrl(this.config.platformProjectId, `/global/urlMaps/${urlMapName}`);
    const proxyName = `${this.sharedStem}-proxy`;
    const proxyUrl = this.computeUrl(this.config.platformProjectId, `/global/targetHttpsProxies/${proxyName}`);
    await this.ensureComputeResource(this.config.platformProjectId, `/global/targetHttpsProxies/${proxyName}`, "/global/targetHttpsProxies", {
      name: proxyName,
      urlMap: urlMapUrl,
      certificateMap: `//certificatemanager.googleapis.com/projects/${this.config.platformProjectId}/locations/global/certificateMaps/${this.sharedStem}-cert-map`,
      quicOverride: "ENABLE",
    });
    const addressName = `${this.sharedStem}-ip`;
    const addressUrl = this.computeUrl(this.config.platformProjectId, `/global/addresses/${addressName}`);
    await this.ensureComputeResource(this.config.platformProjectId, `/global/addresses/${addressName}`, "/global/addresses", {
      name: addressName,
      addressType: "EXTERNAL",
      ipVersion: "IPV4",
      networkTier: "PREMIUM",
    });
    await this.ensureComputeResource(this.config.platformProjectId, `/global/forwardingRules/${this.sharedStem}-https`, "/global/forwardingRules", {
      name: `${this.sharedStem}-https`,
      loadBalancingScheme: "EXTERNAL_MANAGED",
      networkTier: "PREMIUM",
      IPAddress: addressUrl,
      IPProtocol: "TCP",
      portRange: "443-443",
      target: proxyUrl,
    });
    return urlMap;
  }

  async ensureFrontendDnsRecords(hostname: string): Promise<DnsRecord[]> {
    await this.ensureCertificateMap();
    await this.ensureSharedFrontend();
    const address = await this.client.request(this.computeUrl(this.config.platformProjectId, `/global/addresses/${this.sharedStem}-ip`));
    if (!isRecord(address) || typeof address.address !== "string") {
      throw new Error("Compute Engine returned an invalid shared custom-domain address");
    }
    return [{ type: "A", name: hostname, value: address.address }];
  }

  private async writeRoute(hostname: string, backendService: string | null): Promise<void> {
    const stem = this.domainStem(hostname);
    const urlMapPath = `/global/urlMaps/${this.sharedStem}-map`;
    const current = parseUrlMap(await this.client.request(this.computeUrl(this.config.platformProjectId, urlMapPath)));
    const hostRules = current.hostRules.filter((rule) => !rule.hosts.includes(hostname) && rule.pathMatcher !== stem);
    const pathMatchers = current.pathMatchers.filter((matcher) => matcher.name !== stem);
    if (backendService !== null) {
      hostRules.push({ hosts: [hostname], pathMatcher: stem });
      pathMatchers.push({ name: stem, defaultService: backendService });
    }
    await this.waitCompute(await this.client.request(this.computeUrl(this.config.platformProjectId, urlMapPath), {
      method: "PUT",
      body: {
        name: current.name,
        defaultService: current.defaultService,
        ...(current.fingerprint === undefined ? {} : { fingerprint: current.fingerprint }),
        hostRules,
        pathMatchers,
      },
    }));
  }

  async ensure(hostname: string, cloudRunService: string): Promise<DomainLoadBalancerState> {
    const backendService = await this.ensureTenantBackend(hostname, cloudRunService);
    await this.ensureCertificateMap();
    await this.ensureCertificate(hostname);
    await this.ensureSharedFrontend();
    await this.writeRoute(hostname, backendService);
    return await this.get(hostname) ?? throwError(`custom-domain load balancer for ${hostname} disappeared after creation`);
  }

  async get(hostname: string): Promise<DomainLoadBalancerState | null> {
    // TODO(reliability): include the certificate-map entry and the path matcher's backend in
    // this health observation. Today this proves certificate readiness and host-rule presence,
    // but a partially deleted or externally edited route can still appear healthy.
    const stem = this.domainStem(hostname);
    const [address, certificate, urlMapValue] = await Promise.all([
      this.client.request(this.computeUrl(this.config.platformProjectId, `/global/addresses/${this.sharedStem}-ip`), { allow404: true }),
      this.client.request(this.certificateManagerUrl(`/certificates/${stem}-cert`), { allow404: true }),
      this.client.request(this.computeUrl(this.config.platformProjectId, `/global/urlMaps/${this.sharedStem}-map`), { allow404: true }),
    ]);
    if (address === null || certificate === null || urlMapValue === null) return null;
    if (!isRecord(address) || typeof address.address !== "string") throw new Error(`Compute Engine returned an invalid shared address for ${hostname}`);
    if (!isRecord(certificate)) throw new Error(`Certificate Manager returned an invalid certificate for ${hostname}`);
    const urlMap = parseUrlMap(urlMapValue);
    if (!urlMap.hostRules.some((rule) => rule.hosts.includes(hostname) && rule.pathMatcher === stem)) return null;
    const managed = certificate.managed;
    const verified = isRecord(managed) && managed.state === "ACTIVE";
    return { hostname, verified, dnsRecords: [{ type: "A", name: hostname, value: address.address }] };
  }

  async delete(hostname: string): Promise<void> {
    const stem = this.domainStem(hostname);
    const urlMap = await this.client.request(this.computeUrl(this.config.platformProjectId, `/global/urlMaps/${this.sharedStem}-map`), { allow404: true });
    if (urlMap !== null) await this.writeRoute(hostname, null);
    const certificateResources = [
      `/certificateMaps/${this.sharedStem}-cert-map/certificateMapEntries/${stem}-entry`,
      `/certificates/${stem}-cert`,
    ];
    for (const path of certificateResources) {
      const result = await this.client.request(this.certificateManagerUrl(path), { method: "DELETE", allow404: true });
      if (result !== null) await this.waitCertificateManager(result);
    }
    const computeResources = [
      `/global/backendServices/${stem}-backend`,
      `/regions/${this.config.region}/networkEndpointGroups/${stem}-neg`,
    ];
    for (const path of computeResources) {
      const result = await this.client.request(this.computeUrl(this.config.tenantProjectId, path), { method: "DELETE", allow404: true });
      if (result !== null) await this.waitCompute(result);
    }
  }

  async deleteSharedFrontend(): Promise<void> {
    // Shared resources intentionally outlive individual domains in production.
    // Environment teardown and the disposable live test call this only after all
    // routes and certificate-map entries for this environment have been removed.
    const computeResources = [
      `/global/forwardingRules/${this.sharedStem}-https`,
      `/global/targetHttpsProxies/${this.sharedStem}-proxy`,
      `/global/addresses/${this.sharedStem}-ip`,
      `/global/urlMaps/${this.sharedStem}-map`,
      `/global/backendServices/${this.sharedStem}-fallback`,
    ];
    for (const path of computeResources) {
      const result = await this.client.request(this.computeUrl(this.config.platformProjectId, path), { method: "DELETE", allow404: true });
      if (result !== null) await this.waitCompute(result);
    }
    const certificateMap = await this.client.request(this.certificateManagerUrl(`/certificateMaps/${this.sharedStem}-cert-map`), { method: "DELETE", allow404: true });
    if (certificateMap !== null) await this.waitCertificateManager(certificateMap);
  }
}

function throwError(message: string): never {
  throw new Error(message);
}
