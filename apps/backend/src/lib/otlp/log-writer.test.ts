import { describe, expect, it } from "vitest";
import { buildOtlpIssueInputs, buildOtlpLogInsertPlan, buildOtlpLogRows, getOtlpIssueBatchId, getOtlpLogBillingDebits, getOtlpLogPolicyData, getOtlpLogsDeduplicationToken } from "./log-writer";
import { normalizeOtlpJsonLogsRequest } from "./logs";
import { OTLP_LOG_REQUEST_FIXTURE } from "./logs.test-fixtures";
import { decodeOtlpProtobufRequest, encodeOtlpProtobufRequest } from "./protobuf";
import { evaluateErrorIngestPolicy } from "@/lib/error-ingest";

const EVENT_ID = "0123456789abcdef0123456789abcdef";
const OTHER_EVENT_ID = "fedcba9876543210fedcba9876543210";
const TENANT = { projectId: "project", branchId: "main", userId: null, refreshTokenId: null };

function flatErrorRequest(eventId: string, message = "card declined") {
  return {
    resourceLogs: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
      scopeLogs: [{ logRecords: [{
        timeUnixNano: "1785888000000000001",
        eventName: "$error",
        severityNumber: 17,
        attributes: [
          { key: "hexclave.signal.type", value: { stringValue: "error" } },
          { key: "hexclave.event.id", value: { stringValue: eventId } },
          { key: "hexclave.data", value: { kvlistValue: { values: [
            { key: "event_id", value: { stringValue: eventId } },
            { key: "name", value: { stringValue: "PaymentError" } },
            { key: "message", value: { stringValue: message } },
            { key: "handled", value: { boolValue: false } },
          ] } } },
        ],
      }] }],
    }],
  };
}

describe("OTLP log storage mapping", () => {
  it("preserves canonical fields, projects the logger UX, and stamps authenticated tenancy", () => {
    const logs = normalizeOtlpJsonLogsRequest(OTLP_LOG_REQUEST_FIXTURE);
    const tenant = { projectId: "authenticated-project", branchId: "main", userId: "user-1", refreshTokenId: "refresh-1" };
    const [row] = buildOtlpLogRows(logs, tenant);

    expect(row).toMatchObject({
      event_type: "$log",
      level: "error",
      data: { attempt: 2 },
      producer: "sdk",
      runtime: "browser",
      project_id: "authenticated-project",
      branch_id: "main",
      user_id: "user-1",
      trace_id: "11111111111111111111111111111111",
      span_id: "2222222222222222",
      service_name: "checkout",
      time_unix_nano: "1785888000000000001",
      observed_time_unix_nano: "1785888000001000002",
      severity_number: 17,
      severity_text: "ERROR",
      otel_event_name: "$log",
      body: "{\"type\":\"string\",\"value\":\"checkout failed\"}",
      dropped_attributes: 3,
      trace_flags: 1,
      resource_dropped_attributes: 1,
      resource_schema_url: "resource-schema",
      scope_name: "hexclave.sdk",
      scope_version: "1.2.3",
      scope_dropped_attributes: 2,
      scope_schema_url: "scope-schema",
    });
    expect(row.attributes).toContain("bytes");
    expect(row.scope_attributes).toContain("scope.mode");
    expect(row.occurrence_id).toMatch(/^[0-9a-f]{32}$/);
    expect(getOtlpLogsDeduplicationToken(logs, tenant)).toBe(getOtlpLogsDeduplicationToken(logs, tenant));
    expect(getOtlpLogsDeduplicationToken(logs, { ...tenant, projectId: "other" })).not.toBe(getOtlpLogsDeduplicationToken(logs, tenant));
    expect(getOtlpLogsDeduplicationToken(logs, {
      ...tenant,
      groupingConfig: { activeConfigId: "hexclave-js:2026-08-01" },
    })).toBe(getOtlpLogsDeduplicationToken(logs, tenant));
  });

  it("uses the server-resolved replay instead of a client-provided replay id", () => {
    const logs = normalizeOtlpJsonLogsRequest(OTLP_LOG_REQUEST_FIXTURE);
    logs[0]?.attributes.set("hexclave.session_replay.id", {
      type: "string",
      value: "11111111-1111-4111-8111-111111111111",
    });

    expect(buildOtlpLogRows(logs, {
      ...TENANT,
      sessionReplayId: "22222222-2222-4222-8222-222222222222",
    })[0]?.session_replay_id).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("derives product events only from the Hexclave event marker", () => {
    const requestForSignalType = (signalType: string) => ({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: "1785888000000000001",
        eventName: "checkout-completed",
        attributes: [
          { key: "hexclave.signal.type", value: { stringValue: signalType } },
          { key: "hexclave.data", value: { kvlistValue: { values: [{ key: "attempt", value: { intValue: "2" } }] } } },
        ],
      }] }] }],
    });
    const canonical = normalizeOtlpJsonLogsRequest(requestForSignalType("event"));
    const tenant = TENANT;

    expect(buildOtlpLogRows(canonical, tenant)).toMatchObject([{
      event_type: "checkout-completed",
      data: { attempt: 2 },
      project_id: "project",
    }]);
    expect(buildOtlpLogRows(normalizeOtlpJsonLogsRequest(requestForSignalType("log")), tenant)).toMatchObject([{
      event_type: "$log",
    }]);
  });

  it("projects system autocapture events ($click) into the events table with their real type", () => {
    const request = {
      resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: "1785888000000000001",
        eventName: "$click",
        attributes: [
          { key: "hexclave.signal.type", value: { stringValue: "event" } },
          { key: "hexclave.data", value: { kvlistValue: { values: [{ key: "selector", value: { stringValue: "#checkout" } }] } } },
        ],
      }] }] }],
    };
    const canonical = normalizeOtlpJsonLogsRequest(request);
    const tenant = { projectId: "project", branchId: "main", userId: "user", refreshTokenId: "rt" };

    expect(buildOtlpLogRows(canonical, tenant)).toMatchObject([{
      event_type: "$click",
      data: { selector: "#checkout" },
    }]);
  });

  it("derives issue grouping from marked OTel error records with a retry-stable UUID batch", () => {
    const request = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: "1785888000000000001",
          eventName: "$error",
          severityNumber: 17,
          body: { stringValue: "card declined" },
          attributes: [
            { key: "hexclave.signal.type", value: { stringValue: "error" } },
            { key: "hexclave.data", value: { kvlistValue: { values: [
              { key: "name", value: { stringValue: "PaymentError" } },
              { key: "message", value: { stringValue: "card declined" } },
              { key: "handled", value: { boolValue: false } },
            ] } } },
          ],
        }] }],
      }],
    };
    const canonical = normalizeOtlpJsonLogsRequest(request);
    const tenant = TENANT;
    const [row] = buildOtlpLogRows(canonical, tenant);
    const [issue] = buildOtlpIssueInputs(canonical, tenant);

    expect(row).toMatchObject({
      event_type: "$error",
      level: "error",
      body: '{"type":"string","value":"card declined"}',
      data: { name: "PaymentError", message: "card declined", handled: false },
      error_type: "PaymentError",
      issue_hash: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(issue).toMatchObject({ type: "PaymentError", value: "card declined", handled: false, serviceName: "checkout" });
    expect(getOtlpIssueBatchId(canonical, tenant)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(getOtlpIssueBatchId(canonical, tenant)).toBe(getOtlpIssueBatchId(canonical, tenant));
  });

  it("uses client event IDs as occurrence identity in mixed OTLP batches", () => {
    const canonical = normalizeOtlpJsonLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [
        ...flatErrorRequest(EVENT_ID).resourceLogs[0].scopeLogs[0].logRecords,
        {
          timeUnixNano: "1785888000000000001",
          eventName: "$log",
          body: { stringValue: "same timestamp, different signal" },
        },
      ] }] }],
    });
    const [errorRow, logRow] = buildOtlpLogRows(canonical, TENANT);

    expect(errorRow.occurrence_id).toBe(EVENT_ID);
    expect(logRow.occurrence_id).not.toBe(EVENT_ID);
    expect(buildOtlpIssueInputs(canonical, TENANT)).toHaveLength(1);
  });

  it("keeps identity and deduplication stable across protobuf round trips and changed retry payloads", () => {
    const encoded = encodeOtlpProtobufRequest("logs", {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: "1785888000000000001",
            eventName: "$error",
            attributes: [
              { key: "hexclave.signal.type", value: { stringValue: "error" } },
              { key: "hexclave.event.id", value: { stringValue: EVENT_ID } },
              { key: "hexclave.data", value: { kvlistValue: { values: [
                { key: "event_id", value: { stringValue: EVENT_ID } },
                { key: "name", value: { stringValue: "PaymentError" } },
                { key: "message", value: { stringValue: "card declined" } },
                { key: "handled", value: { boolValue: false } },
              ] } } },
            ],
          }],
        }],
      }],
    });
    const protobufLogs = normalizeOtlpJsonLogsRequest(decodeOtlpProtobufRequest("logs", encoded));
    const jsonLogs = normalizeOtlpJsonLogsRequest(flatErrorRequest(EVENT_ID));
    const changedRetryLogs = normalizeOtlpJsonLogsRequest(flatErrorRequest(EVENT_ID, "provider timeout"));

    expect(protobufLogs[0].errorEnvelope?.eventId).toBe(EVENT_ID);
    expect(buildOtlpLogRows(protobufLogs, TENANT)[0].occurrence_id).toBe(EVENT_ID);
    expect(getOtlpLogsDeduplicationToken(jsonLogs, TENANT)).toBe(getOtlpLogsDeduplicationToken(changedRetryLogs, TENANT));
    expect(getOtlpIssueBatchId(jsonLogs, TENANT)).toBe(getOtlpIssueBatchId(changedRetryLogs, TENANT));
  });

  it("does not collide identical error payloads when their client event IDs differ", () => {
    const first = normalizeOtlpJsonLogsRequest(flatErrorRequest(EVENT_ID));
    const second = normalizeOtlpJsonLogsRequest(flatErrorRequest(OTHER_EVENT_ID));

    expect(buildOtlpLogRows(first, TENANT)[0].occurrence_id).toBe(EVENT_ID);
    expect(buildOtlpLogRows(second, TENANT)[0].occurrence_id).toBe(OTHER_EVENT_ID);
    expect(getOtlpIssueBatchId(first, TENANT)).not.toBe(getOtlpIssueBatchId(second, TENANT));
    expect(getOtlpLogsDeduplicationToken(first, TENANT)).not.toBe(getOtlpLogsDeduplicationToken(second, TENANT));
  });

  it("keeps derived identities stable across server scrub-policy changes", () => {
    const [plain] = normalizeOtlpJsonLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{
        observedTimeUnixNano: "1785888000000000003",
        severityNumber: 9,
        body: { stringValue: "plain log" },
      }] }] }],
    });
    expect(getOtlpLogsDeduplicationToken([{ ...plain, policyScrubbedData: { value: "first" } }], TENANT))
      .toBe(getOtlpLogsDeduplicationToken([{ ...plain, policyScrubbedData: { value: "second" } }], TENANT));
  });

  it("plans independent destination writes with stable retry tokens and explicit partial destinations", () => {
    const mixed = normalizeOtlpJsonLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [
        ...flatErrorRequest(EVENT_ID).resourceLogs[0].scopeLogs[0].logRecords,
        {
          timeUnixNano: "1785888000000000001",
          eventName: "checkout_completed",
          attributes: [
            { key: "hexclave.signal.type", value: { stringValue: "event" } },
            { key: "hexclave.data", value: { kvlistValue: { values: [] } } },
          ],
        },
      ] }] }],
    });
    const plan = buildOtlpLogInsertPlan(mixed, TENANT);
    const retriedPlan = buildOtlpLogInsertPlan(mixed, TENANT);

    expect(plan.map((destination) => destination.table)).toEqual([
      "analytics_internal.events",
    ]);
    expect(plan.map((destination) => destination.deduplicationToken)).toEqual(
      retriedPlan.map((destination) => destination.deduplicationToken),
    );
    expect(new Set(plan.map((destination) => destination.deduplicationToken)).size).toBe(1);
    expect(buildOtlpLogInsertPlan(mixed.slice(0, 1), TENANT).map((destination) => destination.table)).toEqual(["analytics_internal.events"]);
    expect(buildOtlpLogInsertPlan(mixed.slice(1), TENANT).map((destination) => destination.table)).toEqual([
      "analytics_internal.events",
    ]);
  });

  it("derives retry-stable analytics_events billing debits for every record class", () => {
    const mixed = normalizeOtlpJsonLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [
        ...flatErrorRequest(EVENT_ID).resourceLogs[0].scopeLogs[0].logRecords,
        {
          timeUnixNano: "1785888000000000002",
          eventName: "checkout_completed",
          attributes: [
            { key: "hexclave.signal.type", value: { stringValue: "event" } },
            { key: "hexclave.data", value: { kvlistValue: { values: [] } } },
          ],
        },
        { observedTimeUnixNano: "1785888000000000003", severityNumber: 9, body: { stringValue: "plain log" } },
      ] }] }],
    });

    const debits = getOtlpLogBillingDebits(mixed, TENANT);
    expect(debits).toHaveLength(3);
    expect(debits[0].occurrenceId).toBe(EVENT_ID);
    expect(debits.map((debit) => debit.eventAt.toISOString())).toEqual([
      "2026-08-05T00:00:00.000Z",
      "2026-08-05T00:00:00.000Z",
      "2026-08-05T00:00:00.000Z",
    ]);
    expect(getOtlpLogBillingDebits(mixed, TENANT).map((debit) => debit.occurrenceId))
      .toEqual(debits.map((debit) => debit.occurrenceId));
  });

  it("applies the server policy projection without bypassing the typed writer scrub", () => {
    const canonical = normalizeOtlpJsonLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: "1785888000000000001",
        eventName: "$error",
        attributes: [{
          key: "hexclave.data",
          value: { kvlistValue: { values: [
            { key: "user", value: { kvlistValue: { values: [{ key: "email", value: { stringValue: "foo@example.com" } }] } } },
            { key: "url", value: { stringValue: "https://example.test/orders?token=secret" } },
          ] } },
        }],
      }] }] }],
    });
    const policy = evaluateErrorIngestPolicy({
      config: {
        observability: {
          errorIngest: {
            finalScrub: { dropKeys: { dropEmail: "user.email" }, urlKeys: { pathOnlyUrl: "url" } },
          },
        },
      },
      items: [{ itemId: "log:0", itemType: "log", data: getOtlpLogPolicyData(canonical[0]) }],
    });
    const [row] = buildOtlpLogRows([{
      ...canonical[0],
      policyScrubbedData: policy.scrubbedData.get("log:0"),
    }], TENANT);

    expect(policy.outcomes[0]).toMatchObject({ status: "accepted", scrubbed: true });
    expect(row.data).toEqual({ user: {}, url: "https://example.test/orders" });
    expect(JSON.stringify(row.data)).not.toContain("secret");
  });
});
