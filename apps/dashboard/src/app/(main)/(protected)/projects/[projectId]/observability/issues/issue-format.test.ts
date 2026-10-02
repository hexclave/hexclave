import { describe, expect, it } from "vitest";
import {
  formatIssueCount,
  issueCulprit,
  issueShortIdLabel,
  issueSubtitle,
  issueTitle,
  parseIssueRouteId,
} from "./issue-format";
import type { IssueFrame } from "./issues-data";

function frame(overrides: Partial<IssueFrame> = {}): IssueFrame {
  return {
    filename: null,
    function: null,
    module: null,
    abs_path: null,
    lineno: null,
    colno: null,
    in_app: false,
    symbolication: {
      status: "not_attempted",
      source_file: null,
      original_line: null,
      original_column: null,
      name: null,
      context: null,
      diagnostics: [],
    },
    ...overrides,
  };
}

describe("issueTitle / issueSubtitle", () => {
  it("titles a real exception on its type, with the message beside it", () => {
    const issue = { type: "TypeError", value: "Cannot read properties of undefined", synthetic: false };
    expect(issueTitle(issue)).toBe("TypeError");
    expect(issueSubtitle(issue)).toBe("Cannot read properties of undefined");
  });

  it("titles a synthetic error on its MESSAGE, because its type is always \"Error\"", () => {
    const first = { type: "Error", value: "Non-Error thrown: \"nope\"", synthetic: true };
    const second = { type: "Error", value: "Non-Error thrown: {\"code\":42}", synthetic: true };
    expect(issueTitle(first)).toBe("Non-Error thrown: \"nope\"");
    expect(issueTitle(second)).toBe("Non-Error thrown: {\"code\":42}");
    expect(issueTitle(first)).not.toBe(issueTitle(second));
  });

  it("does not repeat the message as its own subtitle", () => {
    const issue = { type: "Error", value: "boom", synthetic: true };
    expect(issueTitle(issue)).toBe("boom");
    expect(issueSubtitle(issue)).toBe("");
  });

  it("uses only the first line of a multi-line message", () => {
    const issue = { type: "", value: "first line\nsecond line", synthetic: false };
    expect(issueTitle(issue)).toBe("first line");
  });

  it("never renders an empty title", () => {
    expect(issueTitle({ type: "", value: "", synthetic: false })).toBe("Unknown error");
    expect(issueTitle({ type: "   ", value: "  \n ", synthetic: true })).toBe("Unknown error");
  });
});

describe("issueCulprit", () => {
  it("prefers the server-computed culprit", () => {
    expect(issueCulprit({ culprit: "app/checkout.ts in submit" })).toBe("app/checkout.ts in submit");
  });

  it("falls back to the top IN-APP frame, not merely the top frame", () => {
    const frames = [
      frame({ module: "app/page.tsx", function: "render", in_app: true }),
      frame({ filename: "react-dom.js", function: "commit", in_app: false }),
    ];
    expect(issueCulprit({ culprit: "", frames })).toBe("app/page.tsx in render");
  });

  it("falls back to the top frame when nothing is in-app", () => {
    const frames = [
      frame({ filename: "vendor.js", function: "a" }),
      frame({ filename: "react-dom.js", function: "commit" }),
    ];
    expect(issueCulprit({ culprit: null, frames })).toBe("react-dom.js in commit");
  });

  it("falls back to data.url, then data.path, then mechanism_type", () => {
    expect(issueCulprit({ culprit: "", data: { url: "https://app.test/checkout" } }))
      .toBe("https://app.test/checkout");
    expect(issueCulprit({ culprit: "", data: { path: "/api/orders" } })).toBe("/api/orders");
    expect(issueCulprit({ culprit: "", data: { mechanism_type: "unhandledrejection" } }))
      .toBe("unhandledrejection");
  });

  it("treats the backend's degraded-grouping sentinel as missing", () => {
    expect(issueCulprit({ culprit: "<unknown>", data: { url: "https://app.test/checkout" } }))
      .toBe("https://app.test/checkout");
    expect(issueCulprit({ culprit: "<unknown>" })).toBe("unknown");
  });

  it("NEVER returns an empty string", () => {
    const degenerate = [
      { culprit: null },
      { culprit: "" },
      { culprit: "   " },
      { culprit: "", frames: [] },
      { culprit: "", frames: [frame()] },
      { culprit: "", data: {} },
      { culprit: "", data: { url: "   " } },
      { culprit: "", frames: [frame()], data: null },
    ];
    for (const input of degenerate) {
      expect(issueCulprit(input)).not.toBe("");
      expect(issueCulprit(input).trim().length).toBeGreaterThan(0);
    }
  });
});

describe("formatIssueCount", () => {
  it("keeps small counts exact and compacts large ones", () => {
    expect(formatIssueCount(0)).toBe("0");
    expect(formatIssueCount("1203")).toBe("1,203");
    expect(formatIssueCount("9999")).toBe("9,999");
    expect(formatIssueCount("10000")).toBe("10.0k");
    expect(formatIssueCount("125000")).toBe("125k");
    expect(formatIssueCount("999500")).toBe("1.0M");
    expect(formatIssueCount("1500000")).toBe("1.5M");
  });

  it("handles decimal strings beyond Number.MAX_SAFE_INTEGER", () => {
    expect(formatIssueCount("90071992547409910")).toBe("90071992547M");
  });

  it("rejects a value that isn't a decimal count", () => {
    expect(() => formatIssueCount("12a")).toThrow();
    expect(() => formatIssueCount("-4")).toThrow();
    expect(() => formatIssueCount(-4)).toThrow();
  });
});

describe("parseIssueRouteId", () => {
  it("accepts a v4 uuid and an all-digits short id", () => {
    expect(parseIssueRouteId("3F2504E0-4F89-41D3-9A0C-0305E82C3301")).toEqual({
      kind: "uuid",
      value: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
    expect(parseIssueRouteId("42")).toEqual({ kind: "short-id", value: "42" });
  });

  it("rejects anything else, including a zero-padded short id", () => {
    expect(parseIssueRouteId("0042")).toBeNull();
    expect(parseIssueRouteId("")).toBeNull();
    expect(parseIssueRouteId("not-an-id")).toBeNull();
    expect(parseIssueRouteId("../secrets")).toBeNull();
  });

  it("rejects uuid-shaped-but-not-v4 ids, matching the backend's isUuid contract", () => {
    expect(parseIssueRouteId("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBeNull();
    expect(parseIssueRouteId("3f2504e0-4f89-41d3-7a0c-0305e82c3301")).toBeNull();
  });
});

describe("issueShortIdLabel", () => {
  it("renders the hash form", () => {
    expect(issueShortIdLabel("42")).toBe("#42");
  });
});
