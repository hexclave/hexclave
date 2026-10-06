import { wait } from "@hexclave/shared/dist/utils/promises";
import { it } from "../../../../helpers";
import { Auth, Project, backendContext, niceBackendFetch } from "../../../backend-helpers";

it("accepts a standard empty OTLP/HTTP JSON trace export with server auth", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });

  const response = await niceBackendFetch("/api/v1/analytics/otlp/v1/traces", {
    method: "POST",
    accessType: "server",
    body: { resourceSpans: [] },
  });

  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {},
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("accepts OTLP/HTTP protobuf and returns an empty protobuf success message", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });

  const response = await niceBackendFetch("/api/v1/analytics/otlp/v1/traces", {
    method: "POST",
    accessType: "server",
    rawBody: new Uint8Array(),
    rawContentType: "application/x-protobuf",
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/x-protobuf");
  expect(response.body).toEqual(new ArrayBuffer(0));
});

it("accepts browser OTLP with an authenticated client session", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });
  await Auth.Otp.signIn();

  const response = await niceBackendFetch("/api/v1/analytics/otlp/v1/traces", {
    method: "POST",
    accessType: "client",
    body: { resourceSpans: [] },
  });

  expect(response.status).toBe(200);
});

it("normalizes AI spans from both OTel gen_ai and legacy Vercel AI SDK telemetry into queryable columns", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });

  const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
  const startNano = `${Date.now() - 1000}000000`;
  const endNano = `${Date.now()}000000`;
  const ingestResponse = await niceBackendFetch("/api/v1/analytics/otlp/v1/traces", {
    method: "POST",
    accessType: "server",
    body: {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "agent-worker" } }] },
        scopeSpans: [{
          spans: [
            {
              traceId,
              spanId: "aaaaaaaaaaaaaaa1",
              name: "chat gpt-4.1",
              startTimeUnixNano: startNano,
              endTimeUnixNano: endNano,
              attributes: [
                { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
                { key: "gen_ai.provider.name", value: { stringValue: "openai" } },
                { key: "gen_ai.request.model", value: { stringValue: "gpt-4.1" } },
                { key: "gen_ai.usage.input_tokens", value: { intValue: 811 } },
                { key: "gen_ai.usage.output_tokens", value: { intValue: 92 } },
              ],
            },
            {
              traceId,
              spanId: "aaaaaaaaaaaaaaa2",
              parentSpanId: "aaaaaaaaaaaaaaa1",
              name: "ai.toolCall",
              startTimeUnixNano: startNano,
              endTimeUnixNano: endNano,
              attributes: [
                { key: "ai.operationId", value: { stringValue: "ai.toolCall" } },
                { key: "ai.toolCall.name", value: { stringValue: "get_weather" } },
              ],
            },
          ],
        }],
      }],
    },
  });
  expect(ingestResponse.status).toBe(200);

  // Retry query because async inserts may have a flush delay
  let queryResponse;
  for (let attempt = 0; attempt < 15; attempt++) {
    await wait(500);
    queryResponse = await niceBackendFetch("/api/v1/analytics/query", {
      method: "POST",
      accessType: "server",
      body: {
        query: `
          SELECT span_type, gen_ai_operation_name, gen_ai_provider_name, gen_ai_request_model,
                 toString(gen_ai_input_tokens) AS gen_ai_input_tokens,
                 toString(gen_ai_output_tokens) AS gen_ai_output_tokens,
                 gen_ai_tool_name
          FROM spans
          WHERE trace_id = {traceId:String} AND gen_ai_operation_name IS NOT NULL
          ORDER BY span_id
        `,
        params: { traceId },
      },
    });
    if (queryResponse.status === 200 && queryResponse.body?.result?.length === 2) {
      break;
    }
  }

  expect(queryResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "query_id": "<stripped UUID>:main:<stripped UUID>",
        "result": [
          {
            "gen_ai_input_tokens": "811",
            "gen_ai_operation_name": "chat",
            "gen_ai_output_tokens": "92",
            "gen_ai_provider_name": "openai",
            "gen_ai_request_model": "gpt-4.1",
            "gen_ai_tool_name": null,
            "span_type": "chat gpt-4.1",
          },
          {
            "gen_ai_input_tokens": null,
            "gen_ai_operation_name": "execute_tool",
            "gen_ai_output_tokens": null,
            "gen_ai_provider_name": null,
            "gen_ai_request_model": null,
            "gen_ai_tool_name": "get_weather",
            "span_type": "ai.toolCall",
          },
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("requires a user session for browser OTLP", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });
  backendContext.set({ userAuth: null });

  const response = await niceBackendFetch("/api/v1/analytics/otlp/v1/traces", {
    method: "POST",
    accessType: "client",
    body: { resourceSpans: [] },
  });

  expect(response.status).toBe(401);
});
