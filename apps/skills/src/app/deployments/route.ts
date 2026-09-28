import { deploymentsSkillSitePrompt } from "../../../../../packages/shared/src/ai/unified-prompts/skill-site-prompt";
import { createSkillPageRoute } from "../../skill-page";

// This static segment must resolve before the dynamic `/[toolName]` MCP-tool
// proxy: Next.js matches literal segments ahead of dynamic ones, so `/deployments`
// serves the skill page rather than being treated as an MCP tool name.
export const { GET, HEAD } = createSkillPageRoute({
  tabTitle: "Hexclave Deploy Skill",
  heading: "The Hexclave Deploy Skill",
  description: "The full Hexclave agent skill plus everything specific to the Deploy app — services, env vars, deploying, and custom domains.",
  ledeHtml: `This endpoint serves the full Hexclave <span translate="no">SKILL.md</span> followed by the deeper Deploy material — configuring services, env vars, deploying with <span translate="no">hexclave deploy</span>, and custom domains.`,
  // Deploy has no getting-started docs page of its own, so the prompt points
  // the agent back at this URL (which serves the markdown below) instead of at the
  // general setup docs — pasting those would set up the SDK and never deploy anything.
  setupPrompt: {
    blurb: "Copy this prompt into your coding agent. It points the agent at this page, which carries the full Hexclave skill plus everything needed to configure and ship a deployment.",
    text: "Read https://skill.hexclave.com/deployments and use it to set up Hexclave in this folder",
  },
  skillMarkdown: deploymentsSkillSitePrompt,
});
