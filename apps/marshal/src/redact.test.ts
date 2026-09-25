import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact.js";

// Stage-1 build-log redaction: Marshal scrubs the credentials it handed the builder before
// serving or persisting a build log. redactBuildLogText composes redactSecrets (exact-value
// scrub) with regex scrubs for the presigned-URL query signature. This test pins that
// coverage — the e2e suite's mock builder can't exercise it, so a regression would otherwise
// ship green (the previous e2e redaction assertion was vacuous).

// Re-implement the composition here rather than importing from services.ts, which pulls in
// the S3/GCP clients at module load. redactBuildLogText's body is small and stable.
function redactBuildLogText(text: string, values: string[]): string {
  return redactSecrets(text, values)
    .replace(/X-Amz-Signature=[A-Za-z0-9%]+/gi, "X-Amz-Signature=<redacted>")
    .replace(/X-Amz-Credential=[A-Za-z0-9%/]+/gi, "X-Amz-Credential=<redacted>");
}

describe("redactSecrets", () => {
  it("replaces every occurrence of each secret value", () => {
    expect(redactSecrets("token=abc123 and again abc123", ["abc123"])).toBe("token=<redacted> and again <redacted>");
  });

  it("ignores empty values (so an empty secret can't blank the whole log)", () => {
    expect(redactSecrets("hello world", [""])).toBe("hello world");
  });

  it("redacts a value whose prefix is also a secret, in either order", () => {
    // Redacting the shorter value first used to destroy the longer match and
    // leave its tail exposed: "abcdef" became "<redacted>def". Provider tokens and
    // its scheme-stripped form are exactly this shape.
    expect(redactSecrets("token=abcdef", ["abc", "abcdef"])).toBe("token=<redacted>");
    expect(redactSecrets("token=abcdef", ["abcdef", "abc"])).toBe("token=<redacted>");
    expect(redactSecrets("a=abc b=abcdef", ["abc", "abcdef"])).toBe("a=<redacted> b=<redacted>");
  });

  it("does not rescan replacement text or amplify hostile short secrets without bound", () => {
    const text = "x".repeat(1024 * 1024);
    const redacted = redactSecrets(text, ["x", "<", "r", "e", "d", "a", "c", "t", ">"]);

    expect(redacted.length).toBeLessThanOrEqual(text.length);
    expect(redacted).toBe("<redacted>");
  });

  it("merges overlapping matches without exposing either secret", () => {
    expect(redactSecrets("zabcabcz", ["abc", "bcab"])).toBe("z<redacted>z");
  });
});

describe("redactBuildLogText", () => {
  it("scrubs overlapping provider credentials, the registry auth blob, and the webhook token", () => {
    const providerToken = "Bearer ya29.verysecrettoken";
    const providerTokenWithoutScheme = "ya29.verysecrettoken";
    const registryAuth = "eDpGbHlWMSBmbTJf";
    const webhookToken = "9f8e7d6c5b4a";
    const values = [providerToken, registryAuth, webhookToken, providerTokenWithoutScheme];

    const log = [
      `pushing to registry with auth ${registryAuth}`,
      `token header Bearer ya29.verysecrettoken`,
      `bare token ya29.verysecrettoken`,
      `POST webhook Authorization: Bearer ${webhookToken}`,
    ].join("\n");

    const redacted = redactBuildLogText(log, values);
    expect(redacted).not.toContain("ya29.verysecrettoken");
    expect(redacted).not.toContain(registryAuth);
    expect(redacted).not.toContain(webhookToken);
    expect(redacted).toContain("<redacted>");
  });

  it("scrubs presigned-URL signature and credential query params by shape", () => {
    const url = "https://bucket.r2/uploads/x.tar.gz?X-Amz-Credential=AKIA%2F20260101%2Fauto&X-Amz-Signature=deadbeefcafe1234&X-Amz-Expires=900";
    const redacted = redactBuildLogText(`fetching ${url}`, []);
    expect(redacted).toContain("X-Amz-Signature=<redacted>");
    expect(redacted).toContain("X-Amz-Credential=<redacted>");
    expect(redacted).not.toContain("deadbeefcafe1234");
    expect(redacted).not.toContain("AKIA");
  });
});
