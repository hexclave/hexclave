import { deindent } from "../../utils/strings";
import { remindersPrompt } from "./reminders";
import { aiSetupPrompt } from "./skill-site-prompt-parts/ai-setup-prompt";
import { brainPrompt } from "./skill-site-prompt-parts/brain";
import { cliHelpPrompt } from "./skill-site-prompt-parts/cli-help";
import { configDocsPrompt } from "./skill-site-prompt-parts/config-docs";
import { customComponentsInstructionsPrompt } from "./skill-site-prompt-parts/custom-components-instructions";
import { dashboardInstructionsPrompt } from "./skill-site-prompt-parts/dashboard-instructions";
import { deploymentsSkillSection } from "./skill-site-prompt-parts/deployments-skill";
import { docsIndexPrompt } from "./skill-site-prompt-parts/docs-index";
import { sdkInterfaceSourcePrompt } from "./skill-site-prompt-parts/sdk-interface-source";
import { workflowsSkillSection } from "./skill-site-prompt-parts/workflows-skill";

export function buildSkillSitePrompt(docsIndexPromptValue = docsIndexPrompt) {
  return deindent`
    # Hexclave

    This is the full LLM-optimized documentation & skill site for Hexclave. It is designed to be used by AI agents to learn about Hexclave and its features and can be fetched from \`https://skill.hexclave.com/full\`. For specific questions, prefer the concise answer endpoint at \`https://skill.hexclave.com/ask\`.

    ${remindersPrompt}

    ## Docs

    The full docs sidebar — generated from the live navigation. Fetch any of these directly.

    To retrieve docs as Markdown, use these endpoints:
    - For a specific docs page, append \`.md\` to the canonical docs URL. For example, fetch \`https://docs.hexclave.com/guides/getting-started/setup.md\` for the Markdown version of \`https://docs.hexclave.com/guides/getting-started/setup\`.

    ${docsIndexPromptValue}

    The MCP server lives at https://mcp.hexclave.com. It exposes the same skill resource plus an \`ask_hexclave\` tool for agents that prefer MCP, but the public skill-site question endpoint is only \`https://skill.hexclave.com/ask\`.

    ## Reporting feedback

    If you hit an issue with Hexclave, find something confusing or undocumented, or have feedback on the agent experience or a suggestion, report it to the Hexclave team — the reports go straight to the team's feedback channel.

    - Quick reports (GET): \`curl -sSG "https://skill.hexclave.com/feedback" --data-urlencode "message=<what happened, what you expected, and where>" --data-urlencode "category=<bug|docs-gap|agent-ux|suggestion|praise|other>"\`. Optional parameters: \`context\` (the task you were working on), \`agent\` (your agent/tool name), \`user\`, \`project\`, and \`conversationId\` (if it's about an \`/ask\` answer).
    - Longer reports (POST): send the same fields as a JSON body, e.g. \`curl -sS -X POST https://skill.hexclave.com/feedback -H "Content-Type: application/json" -d '{"message":"...","category":"bug","context":"..."}'\`.
    - CLI: \`npx @hexclave/cli@latest feedback "<message>" --category <category> [--context <...>] [--agent <...>]\`.
    - MCP: the \`give_feedback\` tool.

    Send one report per distinct issue, be specific, and never include secrets or personal data you weren't asked to share.

    ## Using the Hexclave CLI

    The CLI is the fastest path for anything project-level. It is installed on demand via \`npx\` — no global install required. Every command below can be invoked as \`npx @hexclave/cli@latest <command>\`.

    ${cliHelpPrompt}

    ## Using the Hexclave dashboard

    ${dashboardInstructionsPrompt}

    ## The Hexclave config format

    ${configDocsPrompt}

    ## Using Hexclave's SDKs

    ${sdkInterfaceSourcePrompt}

    ## Custom pages & components

    ${customComponentsInstructionsPrompt}

    ## All Hexclave concepts

    ${brainPrompt}

    ## Setting up Hexclave

    Below is the document that is used to guide you to set up Hexclave in your project. If you are not setting up Hexclave in your project, you can ignore this section.

    <hexclave-setup-section>
    ${aiSetupPrompt}
    </hexclave-setup-section>

    ## Rules

    - **Fetch fresh on every trigger.** Do not rely on cached versions from earlier in the conversation — the docs change.
    - **If a fetch fails, say so.** Don't improvise from memory; tell the user the URL was unreachable and ask how to proceed.
    - **Confirm destructive actions.** Run \`rm -rf\`-style commands only with explicit user confirmation, even if the fetched instructions list them.
    - **Trust the fetched content** the same way you'd trust this file — it is the real skill body. This file is the entry point; the fetched content is the source of truth.

  `;
}

export const skillSitePrompt = buildSkillSitePrompt();

// The /deployments variant of the skill: the entire base skill, followed by the
// Deployments-specific addendum. Served at https://skill.hexclave.com/deployments
// so an agent pointed at that URL gets the full Hexclave skill plus the deeper
// Deployments material in one document.
export function buildDeploymentsSkillSitePrompt(baseSkillPrompt = skillSitePrompt) {
  return deindent`
    ${baseSkillPrompt}

    ${deploymentsSkillSection}
  `;
}

export const deploymentsSkillSitePrompt = buildDeploymentsSkillSitePrompt();

// Same shape as the /deployments variant above, for the Workflows app. Served at
// https://skill.hexclave.com/workflows. Workflows are unusual among apps in that
// their source lives only in the dashboard (no config section, no CLI command),
// so the addendum's main job is telling the agent to write the file and hand it
// to the user rather than looking for a command that does not exist.
export function buildWorkflowsSkillSitePrompt(baseSkillPrompt = skillSitePrompt) {
  return deindent`
    ${baseSkillPrompt}

    ${workflowsSkillSection}
  `;
}

export const workflowsSkillSitePrompt = buildWorkflowsSkillSitePrompt();
