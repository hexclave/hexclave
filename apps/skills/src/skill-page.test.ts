import { describe, expect, it } from "vitest";

import { GET as deploymentsGet } from "./app/deployments/route";
import { GET as workflowsGet } from "./app/workflows/route";
import { GET as skillGet } from "./app/route";
import { createSkillPageRoute } from "./skill-page";

const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

function htmlRequest(url: string) {
  return new Request(url, { headers: { accept: HTML_ACCEPT } });
}

function markdownRequest(url: string) {
  return new Request(url, { headers: { accept: "*/*" } });
}

describe("skill page shell", () => {
  it("renders the page's own setup prompt in the copy box", async () => {
    const { GET } = createSkillPageRoute({
      tabTitle: "Tab",
      heading: "Heading",
      description: "Description",
      ledeHtml: "Lede",
      setupPrompt: { blurb: "Blurb goes here.", text: "Do the thing at https://example.com" },
      skillMarkdown: "# Skill",
    });

    const html = await GET(htmlRequest("https://skill.hexclave.com/")).text();

    expect(html).toContain("Blurb goes here.");
    expect(html).toContain(`data-copy="Do the thing at https://example.com"`);
  });

  it("escapes setup prompts so they cannot break out of the copy box", async () => {
    const { GET } = createSkillPageRoute({
      tabTitle: "Tab",
      heading: "Heading",
      description: "Description",
      ledeHtml: "Lede",
      setupPrompt: { blurb: `Blurb & "quotes"`, text: `<script>alert(1)</script>` },
      skillMarkdown: "# Skill",
    });

    const html = await GET(htmlRequest("https://skill.hexclave.com/")).text();

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(`Blurb &amp; &quot;quotes&quot;`);
  });
});

describe("skill site pages", () => {
  it("starts the root HTML page with agent fetch instructions, then human content", async () => {
    const html = await skillGet(htmlRequest("https://skill.hexclave.com/")).text();

    const agentHeadingIndex = html.indexOf("If you are an AI agent");
    const curlIndex = html.indexOf("curl -sSL https://skill.hexclave.com");
    const humanHeadingIndex = html.indexOf("If you are a human");
    const pageHeadingIndex = html.indexOf("The Hexclave Agent Skill");

    expect(agentHeadingIndex).toBeGreaterThan(-1);
    expect(curlIndex).toBeGreaterThan(agentHeadingIndex);
    expect(humanHeadingIndex).toBeGreaterThan(curlIndex);
    expect(pageHeadingIndex).toBeGreaterThan(humanHeadingIndex);
  });

  it("serves the general setup docs URL on the root skill page", async () => {
    const html = await skillGet(htmlRequest("https://skill.hexclave.com/")).text();

    expect(html).toContain("https://docs.hexclave.com/guides/getting-started/setup");
  });

  it("serves a Deploy-specific setup prompt on /deployments", async () => {
    const html = await deploymentsGet(htmlRequest("https://skill.hexclave.com/deployments")).text();

    // The generic getting-started URL is what this page used to inherit from the
    // shared shell; it must not be what the copy button hands to the agent.
    expect(html).not.toContain(`data-copy="https://docs.hexclave.com/guides/getting-started/setup"`);
    expect(html).toContain(`data-copy="Read https://skill.hexclave.com/deployments and use it to set up Hexclave in this folder"`);
  });

  it("still serves the Deploy skill markdown to non-browser clients", async () => {
    const response = deploymentsGet(markdownRequest("https://skill.hexclave.com/deployments"));

    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    await expect(response.text()).resolves.toContain("# Hexclave Deploy");
  });

  it("serves a Workflows-specific setup prompt on /workflows", async () => {
    const html = await workflowsGet(htmlRequest("https://skill.hexclave.com/workflows")).text();

    expect(html).not.toContain(`data-copy="https://docs.hexclave.com/guides/getting-started/setup"`);
    expect(html).toContain(`data-copy="Read https://skill.hexclave.com/workflows and use it to write a Hexclave workflow for this project"`);
  });

  it("still serves the Workflows skill markdown to non-browser clients", async () => {
    const response = workflowsGet(markdownRequest("https://skill.hexclave.com/workflows"));

    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    const markdown = await response.text();
    expect(markdown).toContain("# Hexclave Workflows");
    // The one thing an agent most needs from this page: there is no config
    // section and no CLI command, so it must hand the source to the user.
    expect(markdown).toContain("cannot live in `hexclave.config.ts` yet");
  });
});
