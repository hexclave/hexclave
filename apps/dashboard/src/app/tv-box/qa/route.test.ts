import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let createTvBoxQaResponse: typeof import("./response").createTvBoxQaResponse;

beforeAll(async () => {
  ({ createTvBoxQaResponse } = await import("./response"));
});

describe("TV Box QA fixture route", () => {
  it("is disabled unless the explicit development opt-in is exactly true", () => {
    expect(createTvBoxQaResponse({
      enabled: undefined,
      fixture: "celebration-takeover",
      nodeEnvironment: "development",
    }).status).toBe(404);
    expect(createTvBoxQaResponse({
      enabled: "TRUE",
      fixture: "celebration-takeover",
      nodeEnvironment: "development",
    }).status).toBe(404);
  });

  it("is always unavailable in production", () => {
    expect(createTvBoxQaResponse({
      enabled: "true",
      fixture: "celebration-takeover",
      nodeEnvironment: "production",
    }).status).toBe(404);
  });

  it("serves only known snapshot-backed fixtures without live API configuration", async () => {
    const response = createTvBoxQaResponse({
      enabled: "true",
      fixture: "celebration-takeover",
      nodeEnvironment: "development",
    });
    const document = await response.text();

    expect(response.status).toBe(200);
    expect(document).toContain('"mode":"fixture-preview"');
    expect(document).toContain('"variant":"celebration"');
    expect(document).not.toContain('"api"');
    expect(document).not.toContain("accessToken");
    expect(document).not.toContain("pairingCode");
  });

  it("does not expose unknown or non-snapshot loading scenarios", () => {
    expect(createTvBoxQaResponse({
      enabled: "true",
      fixture: "unknown-fixture",
      nodeEnvironment: "development",
    }).status).toBe(404);
    expect(createTvBoxQaResponse({
      enabled: "true",
      fixture: "loading",
      nodeEnvironment: "development",
    }).status).toBe(404);
  });
});
