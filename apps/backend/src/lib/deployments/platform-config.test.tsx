import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { describe, expect, it, vi } from "vitest";
import { globalPrismaClient } from "@/prisma-client";
import { assertDeploymentsEnabled, getDeploymentsPlatformConfig } from "./platform-config";

// Only the singleton read is exercised here, so the mock is that one delegate.
// The point of these tests is the DEFAULTING and the guard's direction — the
// two things a wrong answer would silently turn every customer's deploys off.
vi.mock("@/prisma-client", () => ({
  globalPrismaClient: {
    deploymentsPlatformConfig: {
      findFirst: vi.fn(),
    },
  },
}));

const mockFindFirst = vi.mocked(globalPrismaClient.deploymentsPlatformConfig.findFirst);

describe("getDeploymentsPlatformConfig", () => {
  it("reads a missing row as everything enabled", async () => {
    // The normal state of an instance where nobody has ever flipped a switch:
    // the migration writes no row, so this must not read as "off".
    mockFindFirst.mockResolvedValue(null as never);
    await expect(getDeploymentsPlatformConfig()).resolves.toEqual({ deploymentsEnabled: true });
  });

  it("reads the stored row when one exists", async () => {
    mockFindFirst.mockResolvedValue({ deploymentsEnabled: false } as never);
    await expect(getDeploymentsPlatformConfig()).resolves.toEqual({ deploymentsEnabled: false });
  });
});

describe("assertDeploymentsEnabled", () => {
  it("allows deploys while the fusebox is on", async () => {
    mockFindFirst.mockResolvedValue({ deploymentsEnabled: true } as never);
    await expect(assertDeploymentsEnabled()).resolves.toBeUndefined();
  });

  it("allows deploys when no row has ever been written", async () => {
    mockFindFirst.mockResolvedValue(null as never);
    await expect(assertDeploymentsEnabled()).resolves.toBeUndefined();
  });

  it("refuses with a 503 while the fusebox is off", async () => {
    mockFindFirst.mockResolvedValue({ deploymentsEnabled: false } as never);
    const error = await assertDeploymentsEnabled().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StatusError);
    // 503, not 403: the caller did nothing wrong and the state is temporary,
    // which is what tells a CLI user to wait rather than edit their deploy file.
    expect((error as StatusError).statusCode).toBe(503);
    expect((error as StatusError).message).toContain("temporarily disabled");
  });
});
