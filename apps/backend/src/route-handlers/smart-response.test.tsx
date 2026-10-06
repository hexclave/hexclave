import { describe, expect, it } from "vitest";
import { createResponse } from "./smart-response";

describe("createResponse", () => {
  it.each([204, 205, 304])("creates a valid empty response for status %s", async (statusCode) => {
    const response = await createResponse(null, "request-id", {
      statusCode,
      bodyType: "empty",
    });

    expect(response.status).toBe(statusCode);
    expect(await response.text()).toBe("");
  });
});
