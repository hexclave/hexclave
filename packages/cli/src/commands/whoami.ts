import { Command } from "commander";
import { getInternalUser } from "../lib/app.js";
import { resolveSessionAuth } from "../lib/auth.js";
import { withProgress } from "../lib/progress.js";
import { listAllTeams } from "../lib/resolve-team.js";

export function registerWhoamiCommand(program: Command) {
  program
    .command("whoami")
    .description("Show the currently logged-in Hexclave CLI user")
    .action(async () => {
      const flags = program.opts();
      const auth = resolveSessionAuth();
      const { user, teams } = await withProgress("Loading account", async () => {
        const user = await getInternalUser(auth);
        const teams = await listAllTeams(user);
        return { user, teams };
      });

      const result = {
        id: user.id,
        displayName: user.displayName,
        primaryEmail: user.primaryEmail,
        primaryEmailVerified: user.primaryEmailVerified,
        isAnonymous: user.isAnonymous,
        isRestricted: user.isRestricted,
        teams: teams.map((team) => ({
          id: team.id,
          displayName: team.displayName,
        })),
        apiUrl: auth.apiUrl,
        dashboardUrl: auth.dashboardUrl,
      };

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`User ID: ${result.id}`);
      console.log(`Display name: ${result.displayName ?? "(none)"}`);
      console.log(`Primary email: ${result.primaryEmail ?? "(none)"}${result.primaryEmailVerified ? " (verified)" : ""}`);
      console.log(`Anonymous: ${result.isAnonymous ? "yes" : "no"}`);
      console.log(`Restricted: ${result.isRestricted ? "yes" : "no"}`);
      console.log(`Teams: ${result.teams.length}`);
      console.log(`API URL: ${result.apiUrl}`);
      console.log(`Dashboard URL: ${result.dashboardUrl}`);
    });
}
