import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The module under test imports the `server-only` marker package, which throws
// when loaded outside a React Server Components bundler context.
vi.mock("server-only", () => ({}));

const getUser = vi.fn();
vi.mock("../../hexclave-server", () => ({
  getHexclaveServerApp: () => ({ getUser }),
}));

const { requireInternalAiChatReviewer } = await import("./internal-auth");

const req = new Request("https://internal.example.com/api/spacetimedb-token", { method: "POST" });

function fakeUser(clientReadOnlyMetadata: unknown) {
  return {
    id: "user-123",
    displayName: "Ada Lovelace",
    primaryEmail: "ada@example.com",
    clientReadOnlyMetadata,
  };
}

async function expectStatus(promise: Promise<unknown>, statusCode: number) {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(StatusError);
  expect(err instanceof StatusError ? err.statusCode : null).toBe(statusCode);
}

beforeEach(() => {
  getUser.mockReset();
});

describe("requireInternalAiChatReviewer", () => {
  it("rejects signed-out requests with 401", async () => {
    getUser.mockResolvedValue(null);
    await expectStatus(requireInternalAiChatReviewer(req), 401);
  });

  it.each([null, {}, { isAiChatReviewer: false }, { isAiChatReviewer: "true" }])(
    "rejects signed-in users that are not approved reviewers with 403 (metadata %j)",
    async (metadata) => {
      getUser.mockResolvedValue(fakeUser(metadata));
      await expectStatus(requireInternalAiChatReviewer(req), 403);
    },
  );

  it("returns the user and reviewer name for approved reviewers", async () => {
    getUser.mockResolvedValue(fakeUser({ isAiChatReviewer: true }));
    const result = await requireInternalAiChatReviewer(req);
    expect(result.user.id).toBe("user-123");
    expect(result.reviewerName).toBe("Ada Lovelace");
    expect(getUser).toHaveBeenCalledWith({ tokenStore: req });
  });
});
