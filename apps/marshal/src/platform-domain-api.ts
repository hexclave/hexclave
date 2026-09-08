import { flyConfig, resolveNamespaceOrg } from "./config.js";
import { MutationOutcomeUnknownError } from "./mutation-safety.js";
import { PLATFORM_DOMAIN } from "./platform-domain-names.js";
import type { ReconciliationLeaseGuard } from "./reconciliation-lock.js";

export function platformDomainsEnabled(): boolean {
  return (process.env.HEXCLAVE_VERCEL_DNS_TOKEN ?? "") !== "";
}

export class PlatformDomainApiError extends Error {
  constructor(public readonly provider: "fly" | "vercel", public readonly status: number, public readonly retryAt: number | null) {
    // Upstream response bodies can contain credentials or internal identifiers.
    super(`${provider} domain provisioning request failed (${status})`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function retryAfterMillis(value: string | null, now: number): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (value.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now, date) : null;
}

async function request(provider: "fly" | "vercel", url: URL, token: string, method: string, body: unknown, lease: ReconciliationLeaseGuard): Promise<unknown> {
  await lease.assertOwned();
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    text = await response.text();
  } catch (error) {
    if (!(error instanceof TypeError || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)))) throw error;
    if (method !== "GET") throw new MutationOutcomeUnknownError(`${provider} domain mutation outcome is unknown`, { cause: error });
    throw new PlatformDomainApiError(provider, 503, null);
  }
  if (response.status === 404 && (method === "GET" || method === "DELETE")) return null;
  if (!response.ok) {
    const now = Date.now();
    // ACME rate limits can arrive as 400/422 as well as HTTP 429. Do not depend
    // on a particular error JSON shape or expose the provider's wording.
    const certificateLimit = provider === "fly" && /rate.?limit|too many certificates|certificates.*(?:per|registered).*domain/i.test(text);
    const retryAt = retryAfterMillis(response.headers.get("retry-after"), now)
      ?? (certificateLimit ? now + 7 * 24 * 60 * 60 * 1000 : null);
    throw new PlatformDomainApiError(provider, certificateLimit ? 429 : response.status, retryAt);
  }
  if (text === "") return null;
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new PlatformDomainApiError(provider, 502, null);
  }
}

export type PlatformCertificate = {
  hostname: string,
  ready: boolean,
  retryAt: number | null,
  cname: string,
  challengeName: string,
  challengeTarget: string,
};

export class PlatformDomainFlyClient {
  constructor(private readonly ns: string, private readonly app: string, private readonly lease: ReconciliationLeaseGuard) {}

  private async call(path: string, method: string, body?: unknown): Promise<unknown> {
    const url = new URL(`${flyConfig().machinesApiUrl}/v1/apps/${encodeURIComponent(this.app)}/certificates${path}`);
    return await request("fly", url, resolveNamespaceOrg(this.ns).token, method, body, this.lease);
  }

  async get(hostname: string): Promise<PlatformCertificate | null> {
    const value = await this.call(`/${encodeURIComponent(hostname)}`, "GET");
    return value === null ? null : this.parse(hostname, value);
  }

  async create(hostname: string): Promise<PlatformCertificate> {
    return this.parse(hostname, await this.call("/acme", "POST", { hostname }));
  }

  async check(hostname: string): Promise<PlatformCertificate> {
    return this.parse(hostname, await this.call(`/${encodeURIComponent(hostname)}/check`, "POST"));
  }

  async delete(hostname: string): Promise<void> {
    await this.call(`/${encodeURIComponent(hostname)}`, "DELETE");
  }

  private parse(hostname: string, value: unknown): PlatformCertificate {
    if (!isRecord(value) || value.hostname !== hostname || typeof value.status !== "string" || !isRecord(value.dns_requirements)) {
      throw new PlatformDomainApiError("fly", 502, null);
    }
    const dns = value.dns_requirements;
    const challenge = dns.acme_challenge;
    if (typeof dns.cname !== "string" || !isRecord(challenge) || typeof challenge.name !== "string" || typeof challenge.target !== "string") {
      throw new PlatformDomainApiError("fly", 502, null);
    }
    // Never use a provider-supplied record name as authority to modify another hostname.
    if (challenge.name.replace(/\.$/, "").toLowerCase() !== `_acme-challenge.${hostname}`) throw new PlatformDomainApiError("fly", 502, null);
    return {
      hostname,
      ready: value.status === "active" && value.configured === true,
      retryAt: typeof value.rate_limited_until === "string" ? retryAfterMillis(value.rate_limited_until, Date.now()) : null,
      cname: dns.cname,
      challengeName: challenge.name,
      challengeTarget: challenge.target,
    };
  }
}

type DnsRecord = { id: string, name: string, type: string, value: string, comment: string | null };

export class PlatformDomainDnsClient {
  constructor(private readonly hostname: string, private readonly lease: ReconciliationLeaseGuard) {
    if (!/^deploy-[a-f0-9]{40}\.built-with-hexclave\.com$/.test(hostname)) throw new Error("DNS client requires a generated deployment hostname");
  }

  private get comment(): string { return `hexclave-platform-domain:${this.hostname}`; }

  private async call(path: string, method: string, body?: unknown, until?: number): Promise<unknown> {
    const token = process.env.HEXCLAVE_VERCEL_DNS_TOKEN;
    if (token === undefined || token === "") throw new PlatformDomainApiError("vercel", 401, null);
    const url = new URL(path, "https://api.vercel.com");
    const teamId = process.env.HEXCLAVE_VERCEL_DNS_TEAM_ID;
    if (teamId !== undefined && teamId !== "") url.searchParams.set("teamId", teamId);
    if (method === "GET") url.searchParams.set("limit", "100");
    if (until !== undefined) url.searchParams.set("until", String(until));
    return await request("vercel", url, token, method, body, this.lease);
  }

  private relativeName(hostname: string): string {
    const name = hostname.toLowerCase().replace(/\.$/, "");
    if (name !== this.hostname && name !== `_acme-challenge.${this.hostname}`) throw new Error("DNS record is outside the service's platform hostname");
    return name.slice(0, -(PLATFORM_DOMAIN.length + 1));
  }

  private async records(): Promise<DnsRecord[]> {
    const records: DnsRecord[] = [];
    let until: number | undefined;
    for (;;) {
      const page = await this.call(`/v5/domains/${PLATFORM_DOMAIN}/records`, "GET", undefined, until);
      if (!isRecord(page) || !Array.isArray(page.records) || !isRecord(page.pagination)) throw new PlatformDomainApiError("vercel", 502, null);
      for (const row of page.records) {
        if (!isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string" || typeof row.type !== "string" || typeof row.value !== "string") throw new PlatformDomainApiError("vercel", 502, null);
        records.push({ id: row.id, name: row.name, type: row.type, value: row.value, comment: typeof row.comment === "string" ? row.comment : null });
      }
      const next = page.pagination.next;
      if (next === null) return records;
      if (typeof next !== "number" || !Number.isSafeInteger(next) || (until !== undefined && next >= until)) throw new PlatformDomainApiError("vercel", 502, null);
      until = next;
    }
  }

  async ensure(hostname: string, value: string): Promise<void> {
    const name = this.relativeName(hostname);
    const existing = (await this.records()).filter((record) => record.name === name);
    for (const record of existing) {
      // Refuse to adopt or overwrite manually-created records, including hosted components.
      if (record.comment !== this.comment || record.type !== "CNAME") throw new PlatformDomainApiError("vercel", 409, null);
    }
    if (existing.length > 1) throw new PlatformDomainApiError("vercel", 409, null);
    const record = existing.at(0);
    if (record === undefined) {
      await this.call(`/v2/domains/${PLATFORM_DOMAIN}/records`, "POST", { name, type: "CNAME", value, ttl: 60, comment: this.comment });
    } else if (record.value.replace(/\.$/, "") !== value.replace(/\.$/, "")) {
      await this.call(`/v1/domains/records/${encodeURIComponent(record.id)}`, "PATCH", { value });
    }
  }

  async delete(): Promise<void> {
    const names = new Set([this.relativeName(this.hostname), this.relativeName(`_acme-challenge.${this.hostname}`)]);
    const records = (await this.records()).filter((record) => names.has(record.name));
    // A manually replaced record may still point at this app. Do not release the
    // app name with dangling DNS, and do not delete a record we no longer own.
    if (records.some((record) => record.comment !== this.comment || record.type !== "CNAME")) throw new PlatformDomainApiError("vercel", 409, null);
    for (const record of records) {
      await this.call(`/v2/domains/${PLATFORM_DOMAIN}/records/${encodeURIComponent(record.id)}`, "DELETE");
    }
  }
}
