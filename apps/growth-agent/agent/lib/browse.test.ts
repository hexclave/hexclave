import { describe, expect, it, vi } from "vitest";
import { extractCurlFallbackPage, fetchPageWithCurl } from "./browse.ts";

describe("curl browser fallback", () => {
  it("extracts readable static content without scripts or styles", () => {
    const result = extractCurlFallbackPage(`<!doctype html>
      <html><head><title>Acme &amp; Co</title><style>.hidden{display:none}</style></head>
      <body><main><h1>Ship faster</h1><script>steal()</script><p>Public product copy.</p></main></body></html>`,
    "https://example.com/", "https://www.example.com/");

    expect(result).toEqual({
      finalUrl: "https://www.example.com/",
      title: "Acme & Co",
      snapshotText: "[curl fallback: Chromium was unavailable; this is static HTML from https://example.com/ and may omit client-rendered content.]\nShip faster\nPublic product copy.",
    });
  });

  it("leaves invalid numeric HTML entities unchanged", () => {
    const result = extractCurlFallbackPage("<p>Value: &#999999999;</p>", "https://example.com/", "https://example.com/");

    expect(result.snapshotText).toContain("&#999999999;");
  });

  it("passes the URL through the sandbox environment and removes the temporary response", async () => {
    const sandbox = {
      async run() {
        return { exitCode: 0, stdout: "https://example.com/final", stderr: "" };
      },
      async readBinaryFile() {
        return new TextEncoder().encode("<title>Example</title><p>Hello</p>");
      },
      async removePath() {
        return undefined;
      },
    };
    const runSpy = vi.spyOn(sandbox, "run");
    const removeSpy = vi.spyOn(sandbox, "removePath");

    const result = await fetchPageWithCurl({
      url: "https://example.com/search?q=$(unsafe)",
      requestId: "call/example",
      sandbox,
    });

    expect(result.finalUrl).toBe("https://example.com/final");
    expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        HEXCLAVE_BROWSE_OUTPUT_PATH: "/workspace/browse-page-call_example.untracked.html",
        HEXCLAVE_BROWSE_URL: "https://example.com/search?q=$(unsafe)",
      },
    }));
    expect(removeSpy).toHaveBeenCalledWith({
      path: "/workspace/browse-page-call_example.untracked.html",
      force: true,
      recursive: false,
    });
  });
});
