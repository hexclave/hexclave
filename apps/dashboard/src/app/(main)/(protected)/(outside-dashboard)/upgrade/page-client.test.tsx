// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PageClient from "./page-client";

type MockTeam = {
  id: string,
  displayName: string,
  useProducts: () => Array<{ id: string | null, type?: string }>,
  createCheckoutUrl: (options: { productId: string, returnUrl: string }) => Promise<string>,
};

const createCheckoutUrlMock = vi.fn<[options: { productId: string, returnUrl: string }], Promise<string>>();

function createTeam(id: string, displayName: string, productIds: string[]): MockTeam {
  return {
    id,
    displayName,
    useProducts: () => productIds.map((productId) => ({ id: productId, type: "subscription" })),
    createCheckoutUrl: createCheckoutUrlMock,
  };
}

let teams: MockTeam[] = [];
let selectedTeam: MockTeam | null = null;

vi.mock("@/lib/dashboard-user", () => ({
  useDashboardInternalUser: () => ({
    useTeams: () => teams,
    selectedTeam,
  }),
}));

// The dashboard's Link needs a mounted Next app router; a plain anchor is enough here.
vi.mock("@/components/link", () => ({
  Link: ({ href, children }: { href: string, children: ReactNode }) => <a href={href}>{children}</a>,
}));

// The real picker searches teams server-side; a plain select is enough here.
vi.mock("@/components/user-team-picker", () => ({
  UserTeamPicker: (props: { value: MockTeam | null, onChange: (team: MockTeam) => void }) => (
    <select
      aria-label="Team to upgrade"
      value={props.value?.id ?? ""}
      onChange={(event) => {
        const team = teams.find((t) => t.id === event.target.value) ?? null;
        if (team == null) throw new Error(`Unknown team ${event.target.value}`);
        props.onChange(team);
      }}
    >
      {teams.map((team) => <option key={team.id} value={team.id}>{team.displayName}</option>)}
    </select>
  ),
}));

function setPlanParam(plan: string | null) {
  window.history.replaceState(null, "", plan == null ? "/upgrade" : `/upgrade?plan=${encodeURIComponent(plan)}`);
}

describe("Upgrade page", () => {
  beforeEach(() => {
    teams = [];
    selectedTeam = null;
    setPlanParam(null);
    createCheckoutUrlMock.mockReturnValue(new Promise(() => {}));
  });

  afterEach(() => {
    cleanup();
    createCheckoutUrlMock.mockReset();
  });

  it("starts the Team checkout for a developer's only team", async () => {
    teams = [createTeam("team-1", "Acme", [])];
    setPlanParam("team");

    render(<PageClient />);

    expect(screen.getByText("Upgrade to Team")).toBeTruthy();
    expect(screen.queryByLabelText("Team to upgrade")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to Team — $49/mo" }));

    await waitFor(() => {
      expect(createCheckoutUrlMock).toHaveBeenCalledWith({
        productId: "team",
        returnUrl: `${window.location.origin}/projects`,
      });
    });
  });

  it("defaults to Team when the plan parameter is missing or unknown", async () => {
    teams = [createTeam("team-1", "Acme", [])];
    setPlanParam("enterprise");

    render(<PageClient />);

    expect(await screen.findByRole("button", { name: "Upgrade to Team — $49/mo" })).toBeTruthy();
  });

  it("starts the Growth checkout when asked for Growth", async () => {
    teams = [createTeam("team-1", "Acme", ["team"])];
    setPlanParam("growth");

    render(<PageClient />);

    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to Growth — $299/mo" }));

    await waitFor(() => {
      expect(createCheckoutUrlMock).toHaveBeenCalledWith({
        productId: "growth",
        returnUrl: `${window.location.origin}/projects`,
      });
    });
  });

  it("says so instead of selling a plan the team already has", async () => {
    teams = [createTeam("team-1", "Acme", ["growth"])];
    setPlanParam("team");

    render(<PageClient />);

    expect(await screen.findByText("Acme is already on the Growth plan.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Upgrade to/ })).toBeNull();
    expect(createCheckoutUrlMock).not.toHaveBeenCalled();
  });

  it("starts with the selected team and lets the developer pick another", async () => {
    const paid = createTeam("team-1", "Paid Co", ["team"]);
    const free = createTeam("team-2", "Side Project", []);
    teams = [paid, free];
    selectedTeam = paid;
    setPlanParam("team");

    render(<PageClient />);

    expect(await screen.findByText("Paid Co is already on the Team plan.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Team to upgrade"), { target: { value: "team-2" } });
    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to Team — $49/mo" }));

    await waitFor(() => {
      expect(createCheckoutUrlMock).toHaveBeenCalledTimes(1);
    });
  });

  it("sends developers without a team to create a project first", () => {
    teams = [];

    render(<PageClient />);

    const link = screen.getByRole("link", { name: "Create a project" });
    expect(link.getAttribute("href")).toBe("/new-project");
    expect(createCheckoutUrlMock).not.toHaveBeenCalled();
  });
});
