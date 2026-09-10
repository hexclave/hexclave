import { yupBoolean, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { describe, expect, it } from "vitest";
import { parseWebhookOpenAPI } from "./openapi";

describe("parseWebhookOpenAPI", () => {
  it("emits machine-readable OpenAPI 3.1 types for nullable webhook fields", () => {
    const result = parseWebhookOpenAPI({
      webhooks: [{
        type: "user.created",
        schema: yupObject({
          display_name: yupString().nullable().defined(),
          status: yupString().oneOf(["active"]).nullable().defined(),
          reason: yupString().max(500).nullable().optional(),
          restricted_reason: yupObject({
            type: yupString().defined(),
          }).nullable().defined(),
          is_restricted: yupBoolean().defined(),
        }).defined(),
        metadata: {
          summary: "User Created",
          description: "A user was created.",
        },
      }],
    });

    expect(result).toMatchObject({
      openapi: "3.1.0",
      webhooks: {
        "user.created": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    properties: {
                      data: {
                        properties: {
                          display_name: {
                            type: ["string", "null"],
                          },
                          status: {
                            enum: ["active", null],
                            type: ["string", "null"],
                          },
                          reason: {
                            type: ["string", "null"],
                          },
                          restricted_reason: {
                            type: ["object", "null"],
                          },
                          is_restricted: {
                            type: "boolean",
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });
});
