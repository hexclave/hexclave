import { describe, expect, it } from "vitest";
import { copyForReason, negotiate, renderHtml, renderJson, renderText, responseFor } from "./server.mjs";

describe("negotiate", () => {
  it("serves HTML only when the client asked for it", () => {
    expect(negotiate("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe("html");
    expect(negotiate("TEXT/HTML")).toBe("html");
  });

  it("serves JSON to clients that asked for JSON", () => {
    expect(negotiate("application/json")).toBe("json");
    expect(negotiate("application/vnd.api+json")).toBe("json");
  });

  it("falls back to plain text for wildcard and missing Accept", () => {
    // curl's default, and most API clients: a person or a log, not a browser.
    expect(negotiate("*/*")).toBe("text");
    expect(negotiate(undefined)).toBe("text");
    expect(negotiate("")).toBe("text");
  });
});

describe("copyForReason", () => {
  it("names the 24-hour limit and the plan that lifts it", () => {
    const copy = copyForReason("free_plan_24h");
    expect(copy.body).toContain("24 hours");
    expect(copy.body).toContain("Team plan");
  });

  it("falls back rather than rendering nothing for a reason it does not know", () => {
    // An image older than a newly added park reason must still render a page.
    expect(copyForReason("something_added_later").body.length).toBeGreaterThan(0);
  });
});

describe("responseFor", () => {
  it("answers 503 with no-store and noindex", () => {
    const response = responseFor({ accept: "text/html", reason: "free_plan_24h" });
    expect(response.status).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex");
    expect(response.headers["x-hexclave-deployment-stopped"]).toBe("free_plan_24h");
  });

  it("does not send Retry-After, which would promise a return that never comes", () => {
    expect(responseFor({ accept: "*/*", reason: "free_plan_24h" }).headers).not.toHaveProperty("retry-after");
  });

  it("gives HEAD the headers without the body", () => {
    const head = responseFor({ method: "HEAD", accept: "text/html", reason: "free_plan_24h" });
    const get = responseFor({ method: "GET", accept: "text/html", reason: "free_plan_24h" });
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
  });

  it("answers every method, since it stands in for a whole application", () => {
    for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      expect(responseFor({ method, accept: "*/*", reason: "free_plan_24h" }).status).toBe(503);
    }
  });

  it("counts content-length in bytes, not characters", () => {
    // The visitor heading carries a typographic apostrophe, which is three bytes.
    const response = responseFor({ accept: "text/plain", reason: "free_plan_24h" });
    expect(Number(response.headers["content-length"])).toBe(Buffer.byteLength(response.body));
    expect(Number(response.headers["content-length"])).toBeGreaterThan(response.body.length);
  });
});

describe("rendered pages", () => {
  it("keeps the visitor text free of plan and deployment vocabulary", () => {
    // The visitor is not the owner: telling them the site is on a Free plan
    // discloses the owner's billing tier to their own users.
    const visitorText = renderText("free_plan_24h").split("Are you the owner")[0];
    expect(visitorText).not.toMatch(/free|plan|deploy/i);
  });

  it("links to the project selector rather than naming a project", () => {
    for (const rendered of [renderHtml("free_plan_24h"), renderJson("free_plan_24h"), renderText("free_plan_24h")]) {
      expect(rendered).toContain("https://app.hexclave.com/projects/-selector-/deployments");
    }
  });

  it("tells robots not to index it in the markup as well as the header", () => {
    expect(renderHtml("free_plan_24h")).toContain('<meta name="robots" content="noindex">');
  });

  it("needs no network to render: no external stylesheet, script or image", () => {
    const html = renderHtml("free_plan_24h");
    expect(html).not.toMatch(/<script|<img|<link/i);
  });

  it("escapes the reason copy it interpolates", () => {
    expect(renderHtml('"><script>alert(1)</script>')).not.toContain("<script>alert(1)</script>");
  });

  it("reports the reason machine-readably in JSON", () => {
    expect(JSON.parse(renderJson("free_plan_24h"))).toMatchObject({ error: "site_unavailable", reason: "free_plan_24h" });
  });
});
