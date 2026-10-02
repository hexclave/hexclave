import { it } from "../../../../helpers";
import { Auth, Project, backendContext, niceBackendFetch } from "../../../backend-helpers";

it("accepts a standard empty OTLP/HTTP JSON logs export with server auth", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });

  const response = await niceBackendFetch("/api/v1/analytics/otlp/v1/logs", {
    method: "POST",
    accessType: "server",
    body: { resourceLogs: [] },
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

  const response = await niceBackendFetch("/api/v1/analytics/otlp/v1/logs", {
    method: "POST",
    accessType: "server",
    rawBody: new Uint8Array(),
    rawContentType: "application/x-protobuf",
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/x-protobuf");
  expect(response.body).toEqual(new ArrayBuffer(0));
});

it("returns OTLP partialSuccess when only the Hexclave product marker contract rejects a LogRecord", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });

  const response = await niceBackendFetch("/api/v1/analytics/otlp/v1/logs", {
    method: "POST",
    accessType: "server",
    body: {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: "1720000000000000000",
            eventName: "invalid event name",
            attributes: [
              { key: "hexclave.signal.type", value: { stringValue: "event" } },
              { key: "hexclave.data", value: { kvlistValue: { values: [] } } },
            ],
          }],
        }],
      }],
    },
  });

  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    partialSuccess: {
      rejectedLogRecords: "1",
      errorMessage: "Hexclave product event LogRecords require a known system event type or a valid custom eventName",
    },
  });
});

it("accepts browser OTLP logs with an authenticated client session", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });
  await Auth.Otp.signIn();
  const response = await niceBackendFetch("/api/v1/analytics/otlp/v1/logs", {
    method: "POST",
    accessType: "client",
    body: { resourceLogs: [] },
  });
  expect(response.status).toBe(200);
});

it("requires a user session for browser OTLP logs", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });
  backendContext.set({ userAuth: null });
  const response = await niceBackendFetch("/api/v1/analytics/otlp/v1/logs", {
    method: "POST",
    accessType: "client",
    body: { resourceLogs: [] },
  });
  expect(response.status).toBe(401);
});
