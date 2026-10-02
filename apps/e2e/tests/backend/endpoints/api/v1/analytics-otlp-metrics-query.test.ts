import { it } from "../../../../helpers";
import { Project, niceBackendFetch } from "../../../backend-helpers";

function currentUnixNano(): string {
  return String(BigInt(Date.now()) * 1_000_000n);
}

it("returns the typed native metrics read model for an admin dashboard request", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });
  const timeUnixNano = currentUnixNano();

  const ingest = await niceBackendFetch("/api/v1/analytics/otlp/v1/metrics", {
    method: "POST",
    accessType: "server",
    body: {
      resourceMetrics: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
        scopeMetrics: [{
          scope: { name: "checkout.metrics", version: "1.0.0" },
          metrics: [{
            name: "checkout.requests",
            unit: "{request}",
            sum: {
              aggregationTemporality: 2,
              isMonotonic: true,
              dataPoints: [{
                startTimeUnixNano: timeUnixNano,
                timeUnixNano,
                asInt: "1",
              }],
            },
          }],
        }],
      }],
    },
  });
  expect(ingest.status).toBe(200);

  const response = await niceBackendFetch("/api/v1/internal/analytics/metrics", {
    method: "POST",
    accessType: "admin",
    body: { hours: 24, metric_name: "checkout.requests" },
  });

  expect(response.status).toBe(200);
  expect(response.body.selected_metric_name).toBe("checkout.requests");
  expect(response.body.selected_metric_type).toBe("sum");
  expect(response.body.catalog).toEqual(expect.arrayContaining([
    expect.objectContaining({ metric_name: "checkout.requests", metric_type: "sum", supports_numeric_aggregation: true }),
  ]));
  expect(response.body.series.length).toBeGreaterThan(0);
});

it("does not expose the internal metrics read model to server-only auth", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });

  const response = await niceBackendFetch("/api/v1/internal/analytics/metrics", {
    method: "POST",
    accessType: "server",
    body: { hours: 24 },
  });

  expect(response.status).toBe(401);
});

it("rejects an unallowlisted metrics query range", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });

  const response = await niceBackendFetch("/api/v1/internal/analytics/metrics", {
    method: "POST",
    accessType: "admin",
    body: { hours: 2 },
  });

  expect(response.status).toBe(400);
});
