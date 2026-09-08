import { listGrowthActions } from "@/lib/growth/growth-api";
import type { GrowthActionItem } from "@/lib/growth/growth-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAllActiveGrowthExperiments } from "./experiments-data";

vi.mock("@/lib/growth/growth-api", () => ({
  listGrowthActions: vi.fn(),
}));

function experiment(id: string): GrowthActionItem {
  return {
    id,
    typeId: "custom",
    category: "conversion",
    tags: [],
    title: `Experiment ${id}`,
    description: "A test experiment.",
    status: "active",
    payload: null,
    watchedMetrics: [],
    reportId: null,
    briefId: null,
    workflow: null,
    createdAtMillis: 1,
    activatedAtMillis: 2,
    completedAtMillis: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listAllActiveGrowthExperiments", () => {
  it("requests only active actions and follows every cursor", async () => {
    vi.mocked(listGrowthActions)
      .mockResolvedValueOnce({ items: [experiment("one")], nextCursor: "cursor-one" })
      .mockResolvedValueOnce({ items: [experiment("two")], nextCursor: null });

    await expect(listAllActiveGrowthExperiments({})).resolves.toEqual([experiment("one"), experiment("two")]);
    expect(vi.mocked(listGrowthActions).mock.calls).toMatchInlineSnapshot(`
      [
        [
          {},
          {
            "cursor": undefined,
            "status": "active",
          },
        ],
        [
          {},
          {
            "cursor": "cursor-one",
            "status": "active",
          },
        ],
      ]
    `);
  });

  it("fails instead of looping when the endpoint repeats a cursor", async () => {
    vi.mocked(listGrowthActions)
      .mockResolvedValueOnce({ items: [experiment("one")], nextCursor: "repeated" })
      .mockResolvedValueOnce({ items: [experiment("two")], nextCursor: "repeated" });

    await expect(listAllActiveGrowthExperiments({})).rejects.toThrow('repeated cursor "repeated"');
    expect(listGrowthActions).toHaveBeenCalledTimes(2);
  });
});
