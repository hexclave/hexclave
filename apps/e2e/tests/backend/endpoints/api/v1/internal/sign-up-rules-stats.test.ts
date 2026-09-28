import { wait } from "@hexclave/shared/dist/utils/promises";
import { describe } from "vitest";
import { it } from "../../../../../helpers";
import { Auth, Project, backendContext, niceBackendFetch } from "../../../../backend-helpers";

const CLICKHOUSE_EVENT_POLL_TIMEOUT_MS = 60_000;
const CLICKHOUSE_EVENT_POLL_INTERVAL_MS = 500;

// Analytics events reach ClickHouse asynchronously, and full-suite CI runners can take many seconds per request.
async function pollUntil<T>(
  getValue: () => Promise<T>,
  predicate: (value: T) => boolean,
  describeValue: (value: T) => string,
  timeoutDescription: string,
): Promise<T> {
  const deadline = performance.now() + CLICKHOUSE_EVENT_POLL_TIMEOUT_MS;
  let value = await getValue();
  while (!predicate(value)) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Timed out after ${CLICKHOUSE_EVENT_POLL_TIMEOUT_MS / 1000}s waiting for ${timeoutDescription}. Last value: ${describeValue(value)}`,
      );
    }
    await wait(Math.min(CLICKHOUSE_EVENT_POLL_INTERVAL_MS, remainingMs));
    value = await getValue();
  }
  return value;
}


describe("without project access", () => {
  backendContext.set({
    projectKeys: 'no-project'
  });

  it("should not have access to sign-up rules stats", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/internal/sign-up-rules-stats", { accessType: "client" });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "ACCESS_TYPE_WITHOUT_PROJECT_ID",
          "details": { "request_type": "client" },
          "error": deindent\`
            The x-hexclave-access-type header was 'client', but the x-hexclave-project-id header was not provided. (The legacy x-stack-access-type and x-stack-project-id headers are also accepted.)
            
            For more information, see the docs on REST API authentication: https://docs.hexclave.com/api/overview#authentication
          \`,
        },
        "headers": Headers {
          "x-stack-known-error": "ACCESS_TYPE_WITHOUT_PROJECT_ID",
          <some fields may have been hidden>,
        },
      }
    `);
  });
});

describe("with client access", () => {
  it("should not have access to sign-up rules stats", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/internal/sign-up-rules-stats", { accessType: "client" });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 401,
        "body": {
          "code": "INSUFFICIENT_ACCESS_TYPE",
          "details": {
            "actual_access_type": "client",
            "allowed_access_types": ["admin"],
          },
          "error": "The x-hexclave-access-type header must be 'admin', but was 'client'. (The legacy x-stack-access-type header is also accepted.)",
        },
        "headers": Headers {
          "x-stack-known-error": "INSUFFICIENT_ACCESS_TYPE",
          <some fields may have been hidden>,
        },
      }
    `);
  });
});

describe("with server access", () => {
  it("should not have access to sign-up rules stats", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/internal/sign-up-rules-stats", { accessType: "server" });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 401,
        "body": {
          "code": "INSUFFICIENT_ACCESS_TYPE",
          "details": {
            "actual_access_type": "server",
            "allowed_access_types": ["admin"],
          },
          "error": "The x-hexclave-access-type header must be 'admin', but was 'server'. (The legacy x-stack-access-type header is also accepted.)",
        },
        "headers": Headers {
          "x-stack-known-error": "INSUFFICIENT_ACCESS_TYPE",
          <some fields may have been hidden>,
        },
      }
    `);
  });
});

describe("with admin access", () => {
  it("should return empty stats when no rules have been triggered", async ({ expect }) => {
    await Project.createAndSwitch({ config: {} });
    const response = await niceBackendFetch("/api/v1/internal/sign-up-rules-stats", { accessType: "admin" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      rule_triggers: [],
      total_triggers: 0,
      triggers_by_action: {
        allow: 0,
        reject: 0,
        restrict: 0,
        log: 0,
      },
    });
  });

  it("should return stats structure with proper fields", async ({ expect }) => {
    await Project.createAndSwitch({ config: {} });
    const response = await niceBackendFetch("/api/v1/internal/sign-up-rules-stats", { accessType: "admin" });
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('rule_triggers');
    expect(response.body).toHaveProperty('analytics_hours');
    expect(response.body).toHaveProperty('total_triggers');
    expect(response.body).toHaveProperty('triggers_by_action');
    expect(response.body.triggers_by_action).toHaveProperty('allow');
    expect(response.body.triggers_by_action).toHaveProperty('reject');
    expect(response.body.triggers_by_action).toHaveProperty('restrict');
    expect(response.body.triggers_by_action).toHaveProperty('log');
  });

  it("should track rule triggers after a rule matches", async ({ expect }) => {
    // Create a project with a sign-up rule that will match
    await Project.createAndSwitch();
    await Project.updateConfig({
      'auth.signUpRules.test-rule': {
        enabled: true,
        displayName: 'Test Rule',
        priority: 1,
        condition: 'true', // Always matches
        action: {
          type: 'log',
        },
      },
    });

    // If we're in the last 10 seconds of the hour, wait until the next hour so our tests aren't flakey
    const now = new Date();
    const lastSecondOfHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 59, 50);
    if (now.getTime() > lastSecondOfHour.getTime()) {
      await wait(1_000 + 10_000 - (now.getTime() - lastSecondOfHour.getTime()));
    }

    // ClickHouse receives the rule-trigger event asynchronously, so wait for it before querying stats.
    const { userId } = await Auth.Password.signUpWithEmail();

    const getStats = () => niceBackendFetch("/api/v1/internal/sign-up-rules-stats", { accessType: "admin" });
    const response = await pollUntil(
      getStats,
      (value) => value.status === 200
        && value.body.rule_triggers.some((rule: { rule_id: string; total_count: number }) => rule.rule_id === "test-rule" && rule.total_count > 0),
      (value) => `stats response status=${value.status}, body=${JSON.stringify(value.body)}`,
      "test-rule trigger in sign-up rule stats",
    );

    expect(response.status, "Timed out waiting for sign-up rule stats").toBe(200);
    const testRule = response.body.rule_triggers.find((rule: { rule_id: string }) => rule.rule_id === "test-rule");
    expect(testRule?.total_count, "Timed out waiting for test-rule event in ClickHouse").toBeGreaterThan(0);
    expect(Array.isArray(response.body.rule_triggers)).toBe(true);
    expect(typeof response.body.total_triggers).toBe('number');
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "analytics_hours": 48,
          "rule_triggers": [
            {
              "all_time_count": 1,
              "hourly_counts": <stripped field 'hourly_counts'>,
              "rule_id": "test-rule",
              "total_count": 1,
            },
          ],
          "total_triggers": 1,
          "triggers_by_action": {
            "allow": 0,
            "log": 1,
            "reject": 0,
            "restrict": 0,
          },
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    const hourlyCounts = response.body.rule_triggers[0].hourly_counts;
    expect(hourlyCounts.length).toBe(48);
    for (let i = 0; i < hourlyCounts.length - 1; i++) {
      expect(hourlyCounts[i].hour).toEqual(new Date(new Date().getTime() - (hourlyCounts.length - 1 - i) * 60 * 60 * 1000).toISOString().slice(0, 13) + ':00:00.000Z');
      expect(hourlyCounts[i].count).toBe(0);
    }
    const lastHourlyCount = hourlyCounts[hourlyCounts.length - 1];
    expect(lastHourlyCount.hour).toEqual(new Date().toISOString().slice(0, 13) + ':00:00.000Z');
    expect(lastHourlyCount.count).toBe(1);
  });

  it("should read rule_id from ClickHouse events with COALESCE for both camelCase and snake_case data", async ({ expect }) => {
    // Regression test: a ClickHouse migration converts ruleId -> rule_id (snake_case).
    // The stats query must handle both field name formats via COALESCE.
    // This test verifies the COALESCE query reads the correct rule_id from the event.
    await Project.createAndSwitch();
    await Project.updateConfig({
      'auth.signUpRules.coalesce-rule': {
        enabled: true,
        displayName: 'COALESCE Test Rule',
        priority: 1,
        condition: 'true',
        action: { type: 'log' },
      },
    });

    await Auth.Password.signUpWithEmail();

    // Wait for the ClickHouse event to appear and verify via a raw COALESCE query
    const chResult = await pollUntil(
      () => niceBackendFetch("/api/v1/analytics/query", {
        method: "POST",
        accessType: "server",
        body: {
          query: `
            SELECT
              COALESCE(
                NULLIF(CAST(data.rule_id, 'Nullable(String)'), ''),
                NULLIF(CAST(data.ruleId, 'Nullable(String)'), '')
              ) as rule_id
            FROM events
            WHERE event_type = '$sign-up-rule-trigger'
            LIMIT 1
          `,
          params: {},
        },
      }),
      (value) => value.status === 200 && value.body?.result?.length > 0,
      (value) => `ClickHouse query response status=${value.status}, body=${JSON.stringify(value.body)}`,
      "sign-up-rule-trigger event in ClickHouse",
    );

    expect(chResult.status).toBe(200);
    expect(chResult.body.result.length).toBeGreaterThan(0);
    expect(chResult.body.result[0].rule_id).toBe('coalesce-rule');

    // Verify the stats endpoint returns correct data with the COALESCE-based query
    const response = await niceBackendFetch("/api/v1/internal/sign-up-rules-stats", { accessType: "admin" });
    expect(response.status).toBe(200);
    expect(response.body.rule_triggers.length).toBeGreaterThan(0);
    const trigger = response.body.rule_triggers.find((t: any) => t.rule_id === 'coalesce-rule');
    expect(trigger).toBeTruthy();
    expect(trigger.total_count).toBeGreaterThanOrEqual(1);
  });
});
