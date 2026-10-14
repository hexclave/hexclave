import type { PrismaClientTransaction } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared/dist/known-errors";
import { describe, expect, it, vi } from "vitest";
import { getAuthContactChannelWithEmailNormalization } from "@/lib/contact-channel";
import { handleOAuthEmailMergeStrategy } from "./oauth";
import type { Tenancy } from "@/lib/tenancies";

vi.mock("@/lib/contact-channel", () => ({
  getAuthContactChannelWithEmailNormalization: vi.fn(),
}));
vi.mock("@/lib/users", () => ({
  createOrUpgradeAnonymousUserWithRules: vi.fn(),
}));

const linkMethodTenancy = { config: { auth: { oauth: { accountMergeStrategy: "link_method" } } } } as unknown as Tenancy;
const prisma = {} as PrismaClientTransaction;

describe("handleOAuthEmailMergeStrategy with link_method", () => {
  it("does not link and returns the sign-in-with-existing-method error when the provider email is unverified", async () => {
    vi.mocked(getAuthContactChannelWithEmailNormalization).mockResolvedValueOnce({
      usedForAuth: true,
      isVerified: true,
      projectUserId: "existing-user",
    } as any);

    const promise = handleOAuthEmailMergeStrategy(prisma, linkMethodTenancy, "person@example.com", false);
    const error = await promise.then(() => null, (e: unknown) => e);
    expect(KnownErrors.ContactChannelAlreadyUsedForAuthBySomeoneElse.isInstance(error as any)).toBe(true);
    expect((error as any).constructorArgs).toEqual(["email", "person@example.com", true]);
  });

  it("links to the existing user when the provider email is verified", async () => {
    vi.mocked(getAuthContactChannelWithEmailNormalization).mockResolvedValueOnce({
      usedForAuth: true,
      isVerified: true,
      projectUserId: "existing-user",
    } as any);

    await expect(handleOAuthEmailMergeStrategy(prisma, linkMethodTenancy, "person@example.com", true))
      .resolves.toEqual({ linkedUserId: "existing-user", primaryEmailAuthEnabled: true });
  });
});
