import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveTxt = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({ resolveTxt }));
vi.mock("./config.js", () => ({ getConfig: () => ({ gcp: { mockUrl: null } }) }));

import { domainVerificationRecord, hasDomainVerificationRecord } from "./domain-verification.js";

describe("tenant-bound domain verification", () => {
  beforeEach(() => {
    resolveTxt.mockReset();
  });

  it("requires the exact token at the hostname-specific TXT name", async () => {
    const record = domainVerificationRecord("app.example.com", "tenant-token");
    expect(record).toEqual({
      type: "TXT",
      name: "_hexclave-verification.app.example.com",
      value: "hexclave-domain-verification=tenant-token",
    });
    resolveTxt.mockResolvedValue([["hexclave-domain-", "verification=tenant-token"]]);
    await expect(hasDomainVerificationRecord("app.example.com", "tenant-token")).resolves.toBe(true);
    await expect(hasDomainVerificationRecord("app.example.com", "another-token")).resolves.toBe(false);
  });

  it("treats an absent DNS record as pending verification", async () => {
    resolveTxt.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
    await expect(hasDomainVerificationRecord("app.example.com", "tenant-token")).resolves.toBe(false);
  });
});
