import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformDomainApiError, PlatformDomainDnsClient, PlatformDomainFlyClient, retryAfterMillis } from "./platform-domain-api.js";
import { platformHostname } from "./platform-domain-names.js";
import { MutationOutcomeUnknownError } from "./mutation-safety.js";

vi.mock("./config.js", () => ({
  flyConfig: () => ({ machinesApiUrl: "https://api.machines.dev" }),
  resolveNamespaceOrg: () => ({ token: "fly-test-token" }),
}));

const hostname = platformHostname("test", "namespace", "group/web");
const name = hostname.split(".")[0];
const comment = `hexclave-platform-domain:${hostname}`;
const lease = { assertOwned: vi.fn(async () => {}) };
const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
const dns = () => new PlatformDomainDnsClient(hostname, lease);
const fly = () => new PlatformDomainFlyClient("namespace", "fly-app", lease);
const page = (records: unknown[], next: number | null = null) => Response.json({ records, pagination: { next } });
const record = (overrides: object = {}) => ({ id: "record-id", name, type: "CNAME", value: "fly-app.fly.dev", comment, ...overrides });

beforeEach(() => {
  vi.stubEnv("HEXCLAVE_VERCEL_DNS_TOKEN", "vercel-test-token");
  vi.stubEnv("HEXCLAVE_VERCEL_DNS_TEAM_ID", "team-test");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  lease.assertOwned.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Vercel platform DNS", () => {
  it("uses the documented API versions, team scope, and relative record names", async () => {
    fetchMock.mockResolvedValueOnce(page([])).mockResolvedValueOnce(Response.json({ uid: "new-record", updated: 1 }));
    await dns().ensure(hostname, "fly-app.fly.dev");
    const calls = fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method, headers: init?.headers, body: init?.body }));
    expect(calls).toEqual([
      { url: "https://api.vercel.com/v5/domains/built-with-hexclave.com/records?teamId=team-test&limit=100", method: "GET", headers: { authorization: "Bearer vercel-test-token", "content-type": "application/json" }, body: undefined },
      { url: "https://api.vercel.com/v2/domains/built-with-hexclave.com/records?teamId=team-test", method: "POST", headers: { authorization: "Bearer vercel-test-token", "content-type": "application/json" }, body: JSON.stringify({ name, type: "CNAME", value: "fly-app.fly.dev", ttl: 60, comment }) },
    ]);
  });

  it("paginates before deciding to create, and accepts trailing dots", async () => {
    fetchMock.mockResolvedValueOnce(page([record({ name: "*", comment: "hosted components" })], 123))
      .mockResolvedValueOnce(page([record({ value: "fly-app.fly.dev." })]));
    await dns().ensure(hostname, "fly-app.fly.dev");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("until=123");
  });

  it("repairs only an owned record using PATCH", async () => {
    fetchMock.mockResolvedValueOnce(page([record()])).mockResolvedValueOnce(Response.json({}));
    await dns().ensure(hostname, "new-target.fly.dev");
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://api.vercel.com/v1/domains/records/record-id?teamId=team-test");
    expect(fetchMock.mock.calls[1][1]?.method).toBe("PATCH");
  });

  it("refuses to overwrite or adopt unowned DNS, even with the right target", async () => {
    fetchMock.mockResolvedValueOnce(page([record({ comment: null })]));
    await expect(dns().ensure(hostname, "fly-app.fly.dev")).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses another hostname before making an API call", async () => {
    await expect(dns().ensure("project-id.built-with-hexclave.com", "fly-app.fly.dev")).rejects.toThrow("outside");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes only its own two records, preserving hosted components and unrelated records", async () => {
    fetchMock.mockResolvedValueOnce(page([
      record(), record({ id: "challenge", name: `_acme-challenge.${name}` }),
      record({ id: "wildcard", name: "*" }), record({ id: "auth", name: "project-id" }),
      record({ id: "manual", name: "deploy-other", comment: "manually replaced" }),
    ])).mockResolvedValue(new Response(null, { status: 204 }));
    await dns().delete();
    expect(fetchMock.mock.calls.slice(1).map(([url]) => String(url))).toEqual([
      "https://api.vercel.com/v2/domains/built-with-hexclave.com/records/record-id?teamId=team-test",
      "https://api.vercel.com/v2/domains/built-with-hexclave.com/records/challenge?teamId=team-test",
    ]);
  });

  it("blocks teardown when its DNS was manually replaced, rather than leaving a dangling app target", async () => {
    fetchMock.mockResolvedValueOnce(page([record({ comment: "manually replaced" })]));
    await expect(dns().delete()).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed on invalid pagination rather than creating duplicates", async () => {
    fetchMock.mockResolvedValueOnce(page([], 123)).mockResolvedValueOnce(page([], 123));
    await expect(dns().ensure(hostname, "fly-app.fly.dev")).rejects.toMatchObject({ status: 502 });
  });
});

describe("Fly platform certificates", () => {
  it("parses the documented ACME response and uses its routing target", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      hostname, configured: false, status: "pending_validation", rate_limited_until: null,
      dns_requirements: { cname: "unique.fly.dev", acme_challenge: { name: `_acme-challenge.${hostname}`, target: "challenge.flydns.net" } },
    }, { status: 201 }));
    await expect(fly().create(hostname)).resolves.toEqual({ hostname, ready: false, retryAt: null, cname: "unique.fly.dev", challengeName: `_acme-challenge.${hostname}`, challengeTarget: "challenge.flydns.net" });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.machines.dev/v1/apps/fly-app/certificates/acme");
    expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify({ hostname }));
  });

  it.each([400, 422, 429])("recognizes certificate quota errors with HTTP %s without leaking the body", async (status) => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "too many certificates (50) already issued for this registered domain; private-provider-detail" }, { status }));
    await expect(fly().create(hostname)).rejects.toMatchObject({ status: 429, retryAt: expect.any(Number), message: "fly domain provisioning request failed (429)" });
  });

  it("honors Retry-After instead of immediately retrying issuance", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": "3600" } }));
    const before = Date.now();
    try {
      await fly().create(hostname);
      expect.fail("request should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformDomainApiError);
      if (!(error instanceof PlatformDomainApiError)) throw error;
      expect(error.retryAt).toBeGreaterThanOrEqual(before + 3_600_000);
    }
  });

  it("preserves uncertain mutations for lease draining", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("connection reset"));
    await expect(fly().create(hostname)).rejects.toBeInstanceOf(MutationOutcomeUnknownError);
  });

  it("does not allow upstream challenge names to select another DNS record", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ hostname, status: "active", configured: true, dns_requirements: { cname: "fly-app.fly.dev", acme_challenge: { name: "_acme-challenge.built-with-hexclave.com", target: "challenge.flydns.net" } } }));
    await expect(fly().get(hostname)).rejects.toMatchObject({ status: 502 });
  });

  it("parses both Retry-After formats", () => {
    expect(retryAfterMillis("60", 1000)).toBe(61_000);
    expect(retryAfterMillis("Wed, 01 Jan 2031 00:00:00 GMT", 0)).toBe(Date.UTC(2031, 0, 1));
    expect(retryAfterMillis("invalid", 0)).toBeNull();
  });
});
