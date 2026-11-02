// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsEventLimitBanner, SessionReplayLimitBanner } from "./shared";

const { captureErrorMock } = vi.hoisted(() => ({ captureErrorMock: vi.fn() }));

const useItemMock = vi.fn();
let usePlanUsageImplementation: () => { arePlanLimitsEnforced: boolean };

vi.mock("@hexclave/shared/dist/utils/errors", async (importOriginal) => ({
  ...await importOriginal<typeof import("@hexclave/shared/dist/utils/errors")>(),
  captureError: captureErrorMock,
}));

// The real Link needs a mounted Next.js app router, which jsdom doesn't have. Without this stub it throws, and the
// banner's error boundary would swallow that as if it were a billing read failure.
vi.mock("@/components/link", () => ({
  Link: (props: { href: string, children: ReactNode }) => <a href={props.href}>{props.children}</a>,
}));

vi.mock("../use-admin-app", () => ({
  useAdminApp: () => ({
    useProject: () => ({ id: "project-1", ownerTeamId: "team-1" }),
    usePlanUsage: () => usePlanUsageImplementation(),
  }),
}));

vi.mock("@/lib/dashboard-user", () => ({
  useDashboardInternalUser: () => ({
    useTeam: () => ({
      useItem: useItemMock,
      useProducts: () => [],
      createCheckoutUrl: vi.fn(),
    }),
  }),
}));

const banners = [
  {
    name: "AnalyticsEventLimitBanner",
    Banner: AnalyticsEventLimitBanner,
    itemId: "analytics_events",
    exhaustedText: /reached your monthly analytics event limit/,
    approachingText: /approaching your monthly analytics event limit/,
    freeLimit: 100_000,
  },
  {
    name: "SessionReplayLimitBanner",
    Banner: SessionReplayLimitBanner,
    itemId: "session_replays",
    exhaustedText: /reached your monthly session replay limit/,
    approachingText: /approaching your monthly session replay limit/,
    freeLimit: 2_500,
  },
];

describe.each(banners)("$name", ({ Banner, itemId, exhaustedText, approachingText, freeLimit }) => {
  beforeEach(() => {
    usePlanUsageImplementation = () => ({ arePlanLimitsEnforced: true });
    useItemMock.mockReturnValue({ quantity: freeLimit });
  });

  afterEach(() => {
    cleanup();
    useItemMock.mockReset();
    captureErrorMock.mockReset();
    vi.restoreAllMocks();
  });

  it("renders nothing and skips the quota read when plan limits are not enforced", () => {
    usePlanUsageImplementation = () => ({ arePlanLimitsEnforced: false });
    useItemMock.mockReturnValue({ quantity: 0 });

    render(<Banner />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(useItemMock).not.toHaveBeenCalled();
  });

  it("shows the limit-reached alert at quantity 0 when plan limits are enforced", () => {
    useItemMock.mockReturnValue({ quantity: 0 });

    render(<Banner />);

    expect(useItemMock).toHaveBeenCalledWith(itemId);
    expect(captureErrorMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(exhaustedText);
  });

  it("shows the approaching-limit alert at 80% usage when plan limits are enforced", () => {
    useItemMock.mockReturnValue({ quantity: freeLimit * 0.2 });

    render(<Banner />);

    expect(captureErrorMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(approachingText);
  });

  it("renders nothing below 80% usage when plan limits are enforced", () => {
    useItemMock.mockReturnValue({ quantity: freeLimit * 0.21 });

    render(<Banner />);

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders nothing while the flag is loading, and nothing after it resolves to not enforced", async () => {
    useItemMock.mockReturnValue({ quantity: 0 });
    let resolveFlag: () => void = () => {
      throw new Error("Expected the suspended promise executor to have run");
    };
    const pendingFlag = new Promise<void>((resolve) => {
      resolveFlag = resolve;
    });
    let isFlagLoaded = false;
    usePlanUsageImplementation = () => {
      if (!isFlagLoaded) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- this is how a hook suspends a React component
        throw pendingFlag;
      }
      return { arePlanLimitsEnforced: false };
    };

    render(<Banner />);
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      isFlagLoaded = true;
      resolveFlag();
      await pendingFlag;
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(useItemMock).not.toHaveBeenCalled();
  });

  it("reports the error and renders nothing when reading the flag fails", () => {
    const readError = new Error("plan usage read failed");
    usePlanUsageImplementation = () => {
      throw readError;
    };
    // React logs errors caught by boundaries; keep that expected noise out of the test output.
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<div data-testid="page-content"><Banner /></div>);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("page-content")).toBeTruthy();
    expect(captureErrorMock).toHaveBeenCalledWith(expect.stringContaining("billing-read-failed"), readError);
  });
});
