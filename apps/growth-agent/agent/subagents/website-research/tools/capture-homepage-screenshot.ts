import { defineTool } from "eve/tools";
import { z } from "zod";
import { isBrowserRuntimeUnavailableError } from "#lib/browser-session.ts";
import { browsePage } from "#lib/browse.ts";
import { saveArtifact } from "#lib/hexclave-client.ts";

/**
 * Captures a screenshot of the product's homepage and stores it as a `brand_screenshot` artifact.
 * Useful on its own for dashboard/human review, and it is the visual reference ad creative
 * generation reads once that lands. Capturing it once during research — rather than only ever live,
 * on demand, at generation time — means a screenshot still exists even for a project whose site
 * becomes unreachable later.
 *
 * The returned tool result carries no image bytes — only metadata. The bytes go straight from the
 * browser sandbox into the artifact write and are never echoed into the model's context.
 */
export default defineTool({
  description: "Capture a screenshot of the product's homepage (or another key marketing page) and save it as a brand_screenshot artifact for future ad-creative reference. Call this at most once or twice per run. If Chromium is unavailable, the tool returns a non-fatal skipped result so website analysis can continue. You will not see the image itself; that is expected.",
  inputSchema: z.object({
    project_id: z.string().min(1),
    branch_id: z.string().min(1),
    run_id: z.string().min(1).optional(),
    url: z.string().url().describe("Absolute http(s) URL of the page to screenshot — usually the homepage."),
  }),
  async execute(input, ctx) {
    let page: Awaited<ReturnType<typeof browsePage>>;
    try {
      page = await browsePage({ context: ctx, url: input.url, screenshot: true });
    } catch (error) {
      if (!isBrowserRuntimeUnavailableError(error)) throw error;
      return {
        skipped: true,
        reason: "Chromium is unavailable in the website-research sandbox; continue the website analysis using browse-page's automatic curl fallback.",
      };
    }
    if (page.screenshotBase64 == null) {
      throw new Error("Browser sandbox did not return a screenshot.");
    }
    const result = await saveArtifact({
      project_id: input.project_id,
      branch_id: input.branch_id,
      ...input.run_id === undefined ? {} : { run_id: input.run_id },
      kind: "brand_screenshot",
      title: `Homepage screenshot: ${page.title || page.finalUrl}`,
      content: page.screenshotBase64,
      metadata: {
        source_url: input.url,
        final_url: page.finalUrl,
        page_title: page.title,
        mime_type: "image/png",
        byte_length_base64: page.screenshotBase64.length,
      },
    });
    return {
      artifact: result,
      final_url: page.finalUrl,
      page_title: page.title,
    };
  },
});
