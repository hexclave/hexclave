import { captureError } from "./errors";
import { mapWithConcurrency } from "./promises";
import { Result } from "./results";

/** Structurally the SDK's `TeamList<T>`: one page of teams plus the cursor for the next one. */
export type TeamList<T> = T[] & { nextCursor: string | null };

/** Matches the backend's per-request cap for `/teams`. */
export const teamsPageSize = 200;

/**
 * Options for reading the first (unfiltered) page of a user's teams. Internal callers must always pass a limit: without
 * one, the backend returns every team unpaginated and rejects the request once more than 500 teams match. All
 * first-page reads use these same options so they share one SDK cache entry (eg. `useTeams` and the ID lookups that
 * fall back to it).
 */
export const firstTeamsPageOptions = { limit: teamsPageSize };

/** The subset of the SDK's `ListTeamsOptions` used here: a cursor is only valid together with a limit. */
export type TeamPageRequest =
  | { query?: string, limit: number, cursor?: undefined }
  | { query?: string, limit: number, cursor: string };

export type TeamPageLister<T> = {
  listTeams: (options: TeamPageRequest) => Promise<TeamList<T>>,
};

/**
 * Fetches every team after `firstPage`, one capped page at a time, and returns them all including `firstPage`.
 * Only for checks that genuinely need every team (e.g. which teams have products); pickers should page lazily
 * with `useTeamPages` instead. Called as a method on `source`, so an SDK user can be passed directly.
 */
export async function listAllTeams<T>(source: TeamPageLister<T>, firstPage: TeamList<T>): Promise<T[]> {
  const teams = [...firstPage];
  let cursor = firstPage.nextCursor;
  while (cursor != null) {
    const page = await source.listTeams({ limit: teamsPageSize, cursor });
    teams.push(...page);
    cursor = page.nextCursor;
  }
  return teams;
}

// Each team costs a permission request plus, for admins, a products request; with thousands of teams an unbounded
// fan-out would queue thousands of requests at once just to decide whether to show the Payments tab.
const teamProductChecksConcurrency = 10;

type ProductsListable = { listProducts: (options: { limit: number }) => Promise<{ customerType: string }[]> };

/**
 * The teams the user can manage billing for, i.e. teams where they are `team_admin` and that have team products.
 * Used by the account settings pages (SDK, dashboard and hosted copies) to fill and show the Payments tab.
 *
 * Teams past the first page are fetched with `listAllTeams`. That lookup is secondary: if it fails, the error is
 * reported and only the first page is checked, rather than failing the whole check and hiding the Payments tab
 * even for teams we already know about.
 */
export async function findTeamsWithProducts<TTeam extends ProductsListable>(
  user: TeamPageLister<TTeam> & { hasPermission: (team: TTeam, permissionId: string) => Promise<boolean> },
  firstPage: TeamList<TTeam>,
): Promise<TTeam[]> {
  const allTeamsResult = await Result.fromThrowingAsync(async () => await listAllTeams(user, firstPage));
  if (allTeamsResult.status === "error") {
    captureError("findTeamsWithProducts: listing teams past the first page", allTeamsResult.error);
  }
  const teams = allTeamsResult.status === "ok" ? allTeamsResult.data : [...firstPage];

  const checked = await mapWithConcurrency(teams, teamProductChecksConcurrency, async (team) => {
    if (!await user.hasPermission(team, "team_admin")) {
      return null;
    }
    const products = await team.listProducts({ limit: 1 });
    return products.some(product => product.customerType === "team") ? team : null;
  });
  return checked.filter((team): team is TTeam => team !== null);
}
