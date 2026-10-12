import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { generateImpersonateSnippet } from "./browser-action-snippets";

describe("impersonation snippet navigation", () => {
  it("reloads the current app route without leaving its deployment base path", () => {
    const location = {
      href: "https://example.com/workspace/home?view=recent#activity",
      protocol: "https:",
      reload() {
        destinations.push(this.href);
      },
      replace(url: string) {
        this.href = new URL(url, this.href).href;
        destinations.push(this.href);
      },
    };
    const destinations: string[] = [];
    const cookies: string[] = [];

    runInNewContext(generateImpersonateSnippet("project", "test-token", new Date("2030-01-01")), {
      location,
      window: { location },
      document: { set cookie(value: string) { cookies.push(value); } },
    });

    expect(destinations).toMatchInlineSnapshot(`
      [
        "https://example.com/workspace/home?view=recent#activity",
      ]
    `);
    expect(cookies.some(value => value.startsWith("__Host-hexclave-refresh-project--default="))).toBe(true);
  });
});
