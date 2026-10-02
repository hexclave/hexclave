import { describe, expect, it } from "vitest";
import {
  buildInternalOwnerReplayIdsQuery,
  getEmailSetup,
  getEnabledAppIds,
  getTrustedDomainBaseUrls,
  isStripeAccountSetupComplete,
  chunkProjectIds,
  mergeInternalProjectIntoCandidates,
  selectProjectsWithInternalPinned,
} from "./helpers";

describe("newly-created-projects helpers", () => {
  it("finds owner replays through the derived page-view store with branch isolation", () => {
    const query = buildInternalOwnerReplayIdsQuery();

    expect(query).toContain("FROM default.page_views");
    expect(query).not.toContain("analytics_internal.spans");
    expect(query).not.toContain("analytics_internal.events");
    expect(query.match(/branch_id = \{branchId:String\}/g)).toHaveLength(1);
  });

  it("chunks project IDs without changing their order", () => {
    expect(chunkProjectIds(["a", "b", "c", "d", "e"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ]);
    expect(chunkProjectIds([], 2)).toEqual([]);
  });

  it("reads enabled apps from normalized nested config", () => {
    expect(getEnabledAppIds({
      apps: {
        installed: {
          authentication: { enabled: true },
          teams: { enabled: true },
          rbac: { enabled: false },
          neon: { enabled: true },
        },
      },
    })).toEqual(["authentication", "neon", "teams"]);
  });

  it("reads and sorts trusted domains from normalized config", () => {
    expect(getTrustedDomainBaseUrls({
      domains: {
        trustedDomains: {
          second: { baseUrl: "https://b.example.com" },
          first: { baseUrl: "https://a.example.com" },
          incomplete: {},
        },
      },
    })).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  it("distinguishes shared servers, custom domains, and custom servers", () => {
    expect(getEmailSetup({
      emails: {
        server: {
          isShared: false,
          provider: "managed",
          managedSubdomain: "updates.example.com",
          senderEmail: "hello@updates.example.com",
        },
      },
    })).toMatchInlineSnapshot(`
      {
        "kind": "custom-domain",
        "managed_subdomain": "updates.example.com",
        "provider": "managed",
        "sender_email": "hello@updates.example.com",
      }
    `);
    expect(getEmailSetup({
      emails: {
        server: {
          isShared: false,
          provider: "smtp",
        },
      },
    }).kind).toBe("custom-server");
  });

  it("requires every Stripe onboarding capability for setup completion", () => {
    expect(isStripeAccountSetupComplete({
      charges_enabled: true,
      details_submitted: true,
      payouts_enabled: true,
    })).toBe(true);
    expect(isStripeAccountSetupComplete({
      charges_enabled: true,
      details_submitted: false,
      payouts_enabled: true,
    })).toBe(false);
  });

  it("pins the internal project inside the configured result limit", () => {
    expect(selectProjectsWithInternalPinned([
      { id: "newest" },
      { id: "second" },
      { id: "internal" },
    ], 2)).toEqual([
      { id: "newest" },
      { id: "internal" },
    ]);
  });

  it("pins the internal project when it falls outside the candidate window", () => {
    const candidates = mergeInternalProjectIntoCandidates(
      [{ id: "newest" }, { id: "second" }],
      { id: "internal" },
    );
    expect(selectProjectsWithInternalPinned(candidates, 2)).toEqual([
      { id: "newest" },
      { id: "internal" },
    ]);
    expect(mergeInternalProjectIntoCandidates(
      [{ id: "newest" }, { id: "internal" }],
      { id: "internal" },
    )).toEqual([
      { id: "newest" },
      { id: "internal" },
    ]);
  });
});
