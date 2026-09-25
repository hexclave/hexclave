import { globalVar } from "@hexclave/shared/dist/utils/globals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleFeedbackRoute } from "./feedback-route";

describe("skill-site feedback route", () => {
  beforeEach(() => {
    globalVar.hexclaveCapturedErrors = [];
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_API_URL", "https://api.hexclave.test");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockBackend(response: Response = Response.json({ success: true, message: "ok" })) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function getForwardedBody(fetchMock: ReturnType<typeof mockBackend>): unknown {
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.hexclave.test/api/latest/internal/agent-feedback");
    return JSON.parse(String(init?.body));
  }

  it("forwards GET query parameters to the backend", async () => {
    const fetchMock = mockBackend();
    const response = await handleFeedbackRoute(new Request(
      "https://skill.hexclave.com/feedback?message=Docs%20are%20wrong&category=docs-gap&context=OAuth%20setup&agent=Cursor",
      { headers: { "user-agent": "curl/8.0", "x-forwarded-for": "203.0.113.1" } },
    ));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Thanks!");
    expect(getForwardedBody(fetchMock)).toMatchInlineSnapshot(`
      {
        "agent": "Cursor",
        "category": "docs-gap",
        "context": "OAuth setup",
        "conversation_id": null,
        "message": "Docs are wrong",
        "project": null,
        "request_host": "skill.hexclave.com",
        "request_ip": "203.0.113.1",
        "source": "skill-get",
        "user": null,
        "user_agent": "curl/8.0",
      }
    `);
  });

  it("forwards JSON POST bodies", async () => {
    const fetchMock = mockBackend();
    const response = await handleFeedbackRoute(new Request("https://skill.hexclave.com/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Long report", category: "agent-ux", project: "Next.js app" }),
    }));

    expect(response.status).toBe(200);
    expect(getForwardedBody(fetchMock)).toMatchObject({
      message: "Long report",
      category: "agent-ux",
      project: "Next.js app",
      source: "skill-post",
    });
  });

  it("treats plain-text POST bodies as the message", async () => {
    const fetchMock = mockBackend();
    const response = await handleFeedbackRoute(new Request("https://skill.hexclave.com/feedback?category=bug", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "The CLI crashed when running init",
    }));

    expect(response.status).toBe(200);
    expect(getForwardedBody(fetchMock)).toMatchObject({ message: "The CLI crashed when running init", category: "bug" });
  });

  it("does not parse explicit plain-text bodies starting with a brace as JSON", async () => {
    const fetchMock = mockBackend();
    const response = await handleFeedbackRoute(new Request("https://skill.hexclave.com/feedback", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{oauth failed} while signing in",
    }));

    expect(response.status).toBe(200);
    expect(getForwardedBody(fetchMock)).toMatchObject({ message: "{oauth failed} while signing in" });
  });

  it("returns usage instructions when the message is missing", async () => {
    const fetchMock = mockBackend();
    const response = await handleFeedbackRoute(new Request("https://skill.hexclave.com/feedback"));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Usage: GET https://skill.hexclave.com/feedback?message=");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unknown categories", async () => {
    const fetchMock = mockBackend();
    const response = await handleFeedbackRoute(new Request("https://skill.hexclave.com/feedback?message=hi&category=nope"));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid `category`");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a generic error and reports to Sentry when the backend fails", async () => {
    mockBackend(new Response("internal details", { status: 500 }));
    const response = await handleFeedbackRoute(new Request("https://skill.hexclave.com/feedback?message=hi"));

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain("internal details");
    expect(globalVar.hexclaveCapturedErrors?.at(-1)).toMatchObject({ location: "skill-site-feedback-upstream-error" });
  });
});
