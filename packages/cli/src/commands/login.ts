import { StackClientApp } from "@hexclave/js";
import { Command } from "commander";
import { DEFAULT_PUBLISHABLE_CLIENT_KEY, resolveLoginConfig } from "../lib/auth.js";
import { readConfigValue, removeConfigValue, writeConfigValue } from "../lib/config.js";
import { CliError } from "../lib/errors.js";

export function registerLoginCommand(program: Command) {
  program
    .command("login")
    .description(
      "Log in to Hexclave via browser. To attach this login to an existing anonymous session, set STACK_CLI_ANON_REFRESH_TOKEN (env var) or the same key in the CLI credentials file before running; login does not write that value.",
    )
    .action(async () => {
      const config = resolveLoginConfig();

      const app = new StackClientApp({
        projectId: "internal",
        publishableClientKey: DEFAULT_PUBLISHABLE_CLIENT_KEY,
        baseUrl: config.apiUrl,
        tokenStore: "memory",
        noAutomaticPrefetch: true,
        analytics: { enabled: false },
        observability: { enabled: false },
      });

      const anonRefreshToken =
        process.env.STACK_CLI_ANON_REFRESH_TOKEN ?? readConfigValue("STACK_CLI_ANON_REFRESH_TOKEN");

      console.log("Waiting for browser authentication...");

      const result = await app.promptCliLogin({
        appUrl: config.dashboardUrl,
        anonRefreshToken,
        promptLink: (url) => {
          console.log(`\nPlease visit the following URL to authenticate:\n${url}`);
        },
      });

      if (result.status === "error") {
        throw new CliError(`Login failed: ${result.error.message}`);
      }

      writeConfigValue("STACK_CLI_REFRESH_TOKEN", result.data);
      if (anonRefreshToken) {
        removeConfigValue("STACK_CLI_ANON_REFRESH_TOKEN");
      }
      console.log("Login successful!");
    });
}
