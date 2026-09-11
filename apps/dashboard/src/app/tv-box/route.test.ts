import { beforeEach, describe, expect, it, vi } from "vitest";

const connection = vi.fn(async () => {});

vi.mock("@/lib/env", () => ({
  getPublicEnvVar: () => "http://localhost:8102",
}));

vi.mock("next/server", () => ({ connection }));

describe("TV Box route", () => {
  beforeEach(() => {
    connection.mockClear();
  });

  it("keeps the document request dynamic", async () => {
    const { GET } = await import("./route");
    const response = await GET();

    expect(connection).toHaveBeenCalledOnce();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});
