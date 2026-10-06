import { it } from "../../../../helpers";
import { Auth, Project, backendContext, niceBackendFetch } from "../../../backend-helpers";

const metricRequest = {
  resourceMetrics: [{
    resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
    scopeMetrics: [{
      scope: { name: "checkout.metrics", version: "1.0.0" },
      metrics: [{
        name: "checkout.requests",
        description: "Requests accepted by checkout",
        unit: "{request}",
        sum: {
          aggregationTemporality: 2,
          isMonotonic: true,
          dataPoints: [{
            startTimeUnixNano: "1720000000000000000",
            timeUnixNano: "1720000000001000000",
            asInt: "1",
          }],
        },
      }],
    }],
  }],
};

it("accepts a standard empty OTLP/HTTP JSON metrics export with server auth", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });

  const response = await niceBackendFetch("/api/v1/analytics/otlp/v1/metrics", {
    method: "POST",
    accessType: "server",
    body: { resourceMetrics: [] },
  });

  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {},
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("persists a standard metric export and returns OTLP success", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });

  const response = await niceBackendFetch("/api/v1/analytics/otlp/v1/metrics", {
    method: "POST",
    accessType: "server",
    body: metricRequest,
  });

  expect(response.status).toBe(200);
  expect(response.body).toEqual({});
});

it("accepts OTLP/HTTP protobuf and returns an empty protobuf success message", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });

  const response = await niceBackendFetch("/api/v1/analytics/otlp/v1/metrics", {
    method: "POST",
    accessType: "server",
    rawBody: new Uint8Array(),
    rawContentType: "application/x-protobuf",
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/x-protobuf");
  expect(response.body).toEqual(new ArrayBuffer(0));
});

it("accepts browser OTLP metrics with an authenticated client session", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });
  await Auth.Otp.signIn();
  const response = await niceBackendFetch("/api/v1/analytics/otlp/v1/metrics", {
    method: "POST",
    accessType: "client",
    body: { resourceMetrics: [] },
  });
  expect(response.status).toBe(200);
});

it("requires a user session for browser OTLP metrics", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });
  backendContext.set({ userAuth: null });
  const response = await niceBackendFetch("/api/v1/analytics/otlp/v1/metrics", {
    method: "POST",
    accessType: "client",
    body: { resourceMetrics: [] },
  });
  expect(response.status).toBe(401);
});
