import { initSentry } from "./lib/sentry.js";
initSentry();

import * as Sentry from "@sentry/node";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { Command } from "commander";
import { cliVersion } from "./lib/own-package.js";
import { AuthError, CliError } from "./lib/errors.js";
import { registerLoginCommand } from "./commands/login.js";
import { registerLogoutCommand } from "./commands/logout.js";
import { registerDeployCommand } from "./commands/deploy.js";
import { registerExecCommand } from "./commands/exec.js";
import { registerConfigCommand } from "./commands/config-file.js";
import { registerInitCommand } from "./commands/init.js";
import { registerProjectCommand } from "./commands/project.js";
import { registerDevCommand } from "./commands/dev.js";
import { registerFixCommand } from "./commands/fix.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerWhoamiCommand } from "./commands/whoami.js";
import { registerTeamCommand } from "./commands/team.js";
import { registerSourceMapsCommand } from "./commands/source-maps.js";

const program = new Command();

program
  .name("hexclave")
  .description("Hexclave CLI. For more information, go to https://docs.hexclave.com. If you're an AI agent, go to https://skill.hexclave.com.")
  .version(cliVersion() ?? "0.0.0")
  .option("--json", "Output in JSON format");

registerLoginCommand(program);
registerLogoutCommand(program);
registerExecCommand(program);
registerDeployCommand(program);
registerSourceMapsCommand(program);
registerConfigCommand(program);
registerInitCommand(program);
registerProjectCommand(program);
registerDevCommand(program);
registerWhoamiCommand(program);
registerTeamCommand(program);
registerFixCommand(program);
registerDoctorCommand(program);

async function main() {
  try {
    const argv = process.argv[2] === "--"
      ? [process.argv[0], process.argv[1], ...process.argv.slice(3)]
      : process.argv;
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof AuthError) {
      console.error(`Auth error: ${err.message}`);
      process.exit(1);
    }
    if (err instanceof CliError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    // Report the failure before flushing telemetry; the flush can consume its
    // full timeout, and users should not stare at a silent CLI after it failed.
    console.error(err);
    captureError("stack-cli-fatal", err);
    await Sentry.flush(2000);
    process.exit(1);
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
