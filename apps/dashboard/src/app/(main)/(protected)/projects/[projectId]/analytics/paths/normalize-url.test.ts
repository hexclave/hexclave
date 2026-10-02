import { describe, expect, it } from "vitest";
import { normalizeUrlPath } from "./normalize-url";

describe("normalizeUrlPath", () => {
  it("groups dynamic routes while preserving their stable path structure", () => {
    expect(normalizeUrlPath("/users/550e8400-e29b-41d4-a716-446655440000/settings?tab=security#password"))
      .toBe("/users/:id/settings");
    expect(normalizeUrlPath("/orders/12345/items/67890")).toBe("/orders/:id/items/:id");
  });

  it("keeps one placeholder per dynamic segment so comparison patterns match the original depth", () => {
    expect(normalizeUrlPath("/orgs/12345/67890/settings")).toBe("/orgs/:id/:id/settings");
  });

  it("does not group ordinary static route segments", () => {
    expect(normalizeUrlPath("/projects/internal/analytics/paths")).toBe("/projects/internal/analytics/paths");
  });

  it("normalizes the shortest URL-safe base64 token accepted by the contract", () => {
    expect(normalizeUrlPath("/api/Abcdefghijklmnop1/details")).toBe("/api/:id/details");
    expect(normalizeUrlPath("/api/auth/details")).toBe("/api/auth/details");
  });

  it("keeps a static 16-character word literal when it has no digits", () => {
    expect(normalizeUrlPath("/docs/abcdefghijklmnop/details")).toBe("/docs/abcdefghijklmnop/details");
  });
});
