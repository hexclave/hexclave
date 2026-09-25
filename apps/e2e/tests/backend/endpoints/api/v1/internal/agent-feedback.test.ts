import { describe } from "vitest";
import { it } from "../../../../../helpers";
import { niceBackendFetch } from "../../../../backend-helpers";

describe("/api/v1/internal/agent-feedback", () => {
  it("accepts feedback via GET without authentication", async ({ expect }) => {
    const response = await niceBackendFetch(`/api/v1/internal/agent-feedback?${new URLSearchParams({
      message: "The setup docs are missing a step.",
      category: "docs-gap",
      agent: "e2e-test",
    })}`);
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "message": "Thanks! Your feedback was sent to the Hexclave team. Don't send the same feedback again.",
          "success": true,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("accepts feedback via POST without authentication", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/internal/agent-feedback", {
      method: "POST",
      body: {
        message: "A longer report about the agent experience.",
        category: "agent-ux",
        context: "Adding teams to a Next.js app",
        source: "cli",
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it("rejects feedback without a message", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/internal/agent-feedback?category=bug");
    expect(response.status).toBe(400);
  });

  it("rejects unknown categories", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/internal/agent-feedback", {
      method: "POST",
      body: { message: "hi", category: "not-a-category" },
    });
    expect(response.status).toBe(400);
  });
});
