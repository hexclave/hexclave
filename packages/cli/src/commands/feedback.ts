import { AGENT_FEEDBACK_CATEGORIES, isAgentFeedbackCategory, sendAgentFeedback, type AgentFeedbackDiagnostic } from "@hexclave/shared/dist/ai/agent-feedback";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { Command } from "commander";
import { resolveLoginConfig } from "../lib/auth.js";
import { CliError } from "../lib/errors.js";
import { withProgress } from "../lib/progress.js";

type FeedbackOptions = {
  category?: string,
  context?: string,
  agent?: string,
  user?: string,
  project?: string,
};

function logFeedbackDiagnostic(diagnostic: AgentFeedbackDiagnostic): void {
  if (diagnostic.event === "upstream-error" && diagnostic.status >= 400 && diagnostic.status < 500) {
    return;
  }
  captureError("cli-feedback", new HexclaveAssertionError("Failed to submit agent feedback from the CLI", { diagnostic }));
}

export function registerFeedbackCommand(program: Command) {
  program
    .command("feedback")
    .description("Send feedback to the Hexclave team: issues you ran into, docs gaps, agent UX problems, or suggestions. AI agents are encouraged to use this.")
    .argument("<message...>", "The feedback. Be specific: what you expected, what happened, and the page/endpoint/SDK symbol involved. Don't include secrets.")
    .option("--category <category>", `One of: ${AGENT_FEEDBACK_CATEGORIES.join(", ")}`, "other")
    .option("--context <context>", "The higher-level task you or the user were trying to accomplish")
    .option("--agent <agent>", "The AI agent or tool submitting the feedback (e.g. Claude Code, Cursor)")
    .option("--user <user>", "Who is sending this feedback (optional)")
    .option("--project <project>", "A short description of the project (framework, language, purpose)")
    .action(async (messageParts: string[], opts: FeedbackOptions) => {
      const flags = program.opts();
      const message = messageParts.join(" ").trim();
      if (message === "") {
        throw new CliError("Feedback message must not be empty.");
      }
      const category = opts.category ?? "other";
      if (!isAgentFeedbackCategory(category)) {
        throw new CliError(`Invalid --category "${category}". Must be one of: ${AGENT_FEEDBACK_CATEGORIES.join(", ")}.`);
      }

      const { apiUrl } = resolveLoginConfig();
      const result = await withProgress("Sending feedback", async () => await sendAgentFeedback({
        backendApiBaseUrl: apiUrl,
        body: {
          message,
          category,
          context: opts.context ?? null,
          agent: opts.agent ?? null,
          user: opts.user ?? null,
          project: opts.project ?? null,
          source: "cli",
        },
        onDiagnostic: logFeedbackDiagnostic,
      }));

      if (result.status === "error") {
        throw new CliError(result.message);
      }

      if (flags.json) {
        console.log(JSON.stringify({ success: true }, null, 2));
        return;
      }
      console.log("Thanks! Your feedback was sent to the Hexclave team.");
    });
}
