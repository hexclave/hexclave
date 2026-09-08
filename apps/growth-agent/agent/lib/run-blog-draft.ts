import type { ChannelFrom } from "eve/channels";
import { buildGrowthSessionAuth } from "#lib/run-context.ts";
import { followSessionEvents } from "#lib/session-stream.ts";
import { PLAIN_LANGUAGE_RULE } from "#lib/writing-style.ts";

export type BlogDraftRequest = {
  readonly project_id: string,
  readonly branch_id: string,
  readonly action_item_id: string,
  readonly action_title: string,
  readonly action_description: string,
  readonly blog_idea: {
    readonly title: string,
    readonly target_intent: string | null,
    readonly aeo_angle: string | null,
    readonly outline_summary: string | null,
  },
  readonly product: {
    readonly website_url: string | null,
    readonly company_summary: string | null,
    readonly additional_notes: string | null,
  },
};

export type BlogDraftResult = {
  readonly draft_markdown: string,
};

const MAX_BLOG_DRAFT_MS = 3 * 60 * 1000;

function buildBlogDraftPrompt(input: BlogDraftRequest): string {
  const idea = input.blog_idea;
  return [
    `Write one complete, publishable blog post for the product at ${input.product.website_url ?? "(website not recorded)"}.`,
    "",
    input.product.company_summary != null ? `What the product does: ${input.product.company_summary}` : "The product summary was not recorded; infer what you can from the idea below and stay generic where you cannot.",
    input.product.additional_notes != null ? `Additional context from the team: ${input.product.additional_notes}` : "",
    "",
    "The growth analysis proposed this piece:",
    `- Working title: ${idea.title}`,
    idea.target_intent != null ? `- Target search intent / keyword cluster: ${idea.target_intent}` : "- Target search intent: not specified",
    idea.aeo_angle != null ? `- AEO angle (the direct question an assistant should be able to cite this post for): ${idea.aeo_angle}` : "- AEO angle: not specified",
    idea.outline_summary != null ? `- What it must cover: ${idea.outline_summary}` : "- Coverage notes: not specified",
    `- Why the team picked it: ${input.action_description}`,
    "",
    "Rules:",
    "- Output ONLY the post, as markdown, starting with a single `# ` title. No preamble, no commentary, no code fences around the whole document.",
    "- Open by answering the target question directly in the first two sentences — that is what makes the post citable by answer engines.",
    "- Be specific to THIS product. Never invent statistics, customer quotes, funding, awards, or named customers; if you need a number you were not given, write around it instead.",
    "- Write the complete post with no placeholder sections, no 'TODO', and no bracketed instructions to the author.",
    // Only the plain-language half of the house style applies here: a blog post is meant to be
    // long-form, so the brevity targets in WRITING_STYLE_RULES would fight the purpose of the piece.
    `- ${PLAIN_LANGUAGE_RULE}`,
    "- Length follows the topic, not a word count. Every paragraph must add something; cut any section that only restates another one.",
    "- Do not call any tools. Produce the post in your reply.",
  ].join("\n");
}

export async function executeBlogDraft(input: BlogDraftRequest, helpers: { readonly from: ChannelFrom }): Promise<BlogDraftResult> {
  const session = await helpers.from(`blog-draft:${input.action_item_id}`).send(buildBlogDraftPrompt(input), {
    auth: buildGrowthSessionAuth({
      project_id: input.project_id,
      branch_id: input.branch_id,
      finding_source: "report",
    }),
    mode: "task",
    title: `Growth blog draft (${input.blog_idea.title})`,
    // Retries must queue behind an in-flight run instead of steering it away.
    turnPolicy: "queue",
  });

  const chunks: string[] = [];
  collect: for await (const event of followSessionEvents({ session, label: "Blog draft", maxSessionMs: MAX_BLOG_DRAFT_MS })) {
    switch (event.type) {
      case "message.completed": {
        if (event.data.message != null && event.data.message.length > 0 && !chunks.includes(event.data.message)) {
          chunks.push(event.data.message);
        }
        break;
      }
      case "session.completed": {
        break collect;
      }
      case "session.failed": {
        throw new Error(`Blog draft session failed: session=${session.id} code=${event.data.code} message=${event.data.message}`);
      }
      case "session.waiting": {
        throw new Error(`Blog draft session parked waiting for input in task mode: session=${session.id}`);
      }
      default: {
        break;
      }
    }
  }

  const draftMarkdown = chunks.join("\n\n").trim();
  if (draftMarkdown.length === 0) {
    throw new Error(`Blog draft generation produced no content: session=${session.id}`);
  }
  return { draft_markdown: draftMarkdown };
}
