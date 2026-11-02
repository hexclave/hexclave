import { deindent } from "../../../utils/strings";

// Hand-written summary of the commands in packages/cli/src/commands. Keep it in
// sync when commands are added or renamed. It intentionally leaves out the
// full flag list and points at `help` for that, so a stale flag here can't
// mislead an agent for long.
export const cliHelpPrompt = deindent`
  The CLI is how an agent operates the user's Hexclave project. When the user asks you to read or change something in Hexclave, use the CLI yourself rather than sending them to the dashboard.

  Run \`npx @hexclave/cli help\` or \`npx @hexclave/cli <command> --help\` for the exact flags of the installed version.

  ### Targets: development environment vs. cloud

  Most project-level commands act on one of two targets:
  - **Development environment**: pass \`--config-file <path-to-hexclave.config.ts>\`. No login needed, but the development environment must already be running for that config file (start it with \`npx @hexclave/cli dev --config-file <path> -- <command>\`, usually via the project's \`dev\` script).
  - **Cloud project**: pass \`--cloud-project-id <id>\` (some commands also read \`HEXCLAVE_PROJECT_ID\`). \`exec\` and \`config pull\` require \`npx @hexclave/cli login\` first; \`deploy\` and \`config push\` also accept a \`HEXCLAVE_SECRET_SERVER_KEY\` environment variable instead (useful in CI). Use \`npx @hexclave/cli project list\` to find project IDs.

  ### \`exec\`: read and write project data

  \`npx @hexclave/cli exec [--config-file <path> | --cloud-project-id <id>] "<javascript>"\` is the main tool for anything that touches project data: users, teams, permissions, payments, emails, analytics, session replays, and anything else the server SDK exposes. The code runs as the body of an async function with a pre-configured HexclaveServerApp in scope as \`hexclaveServerApp\`, so you can \`await\` directly. Whatever the code \`return\`s is printed as JSON; nothing is printed if it returns nothing.

  \`\`\`sh
  npx @hexclave/cli exec --config-file ./hexclave.config.ts "
    const users = await hexclaveServerApp.listUsers({ limit: 10, orderBy: 'signedUpAt', desc: true });
    return users.map(u => ({ id: u.id, email: u.primaryEmail, signedUpAt: u.signedUpAt }));
  "
  \`\`\`

  - Look up a method's exact signature before calling it. The SDK interfaces are in the \`src/lib/hexclave-app\` folder of the installed SDK package, and the API reference is at https://docs.hexclave.com/sdk/overview.
  - For analytics questions, use \`hexclaveServerApp.queryAnalytics({ query: "<clickhouse-sql>" })\`. Start with \`SHOW TABLES\` and \`DESCRIBE TABLE\`.
  - Read before you write, and confirm with the user before destructive or production-affecting changes (deleting users or teams, changing a cloud project).
  - Use exec for data only. Change configuration through the config file and \`config push\`, not through exec.

  ### Other commands

  | Command | What it does |
  |---|---|
  | \`init\` | Set up Hexclave in the current project. \`--mode create \\| create-cloud \\| link-config \\| link-cloud\` skips the mode prompt only. Pass \`--apps\` (create), \`--config-file\` (link-config), or \`--select-project-id\` (link-cloud) to also skip the app, path, or project selection prompt. It can still ask to overwrite an existing config file or append keys to an existing \`.env\`. |
  | \`dev --config-file <path> -- <command>\` | Run your app's dev command with the development environment's credentials injected as environment variables, and sync the config file. |
  | \`config pull\` / \`config push\` | Pull a cloud project's config into a local \`hexclave.config.ts\`, or push a local config file to it (\`config push --cloud-project-id <id> --config-file <path>\`). Before pushing, pull into a separate file (\`config pull --cloud-project-id <id> --config-file <other-path>.ts\`) and compare it with your local file, so you don't overwrite changes made elsewhere. |
  | \`deploy\` | Deploy the services defined in \`hexclave.deploy.ts\`, in dependency order (\`--service-id\` deploys one service). |
  | \`doctor\` | Check that Hexclave is wired up correctly in the project. |
  | \`fix --error "<message>"\` | Have an AI agent fix a Hexclave error in the project. |
  | \`project list\` / \`project create\` | List development-environment and cloud projects, or create a cloud project. |
  | \`team ...\` | Manage the teams of the logged-in Hexclave account (\`list\`, \`create\`, \`invite\`, \`update\`, \`leave\`, \`delete\`, plus \`members\` and \`invitations\` subcommands). These are the user's Hexclave dashboard teams, not the teams inside their project; use exec for those. |
  | \`login\` / \`logout\` / \`whoami\` | Sign the CLI in or out of Hexclave, and show who is signed in. |
`;
