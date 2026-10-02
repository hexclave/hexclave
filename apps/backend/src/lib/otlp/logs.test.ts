import { describe, expect, it } from "vitest";
import { getHexclaveOtlpLogContractError, normalizeOtlpJsonLogsRequest } from "./logs";
import { OTLP_LOG_REQUEST_FIXTURE } from "./logs.test-fixtures";

describe("OTLP JSON logs normalization", () => {
  it("preserves resources, scopes, body AnyValue, severity, flags, and trace correlation", () => {
    const [log] = normalizeOtlpJsonLogsRequest(OTLP_LOG_REQUEST_FIXTURE);
    expect(log).toMatchObject({
      timeUnixNano: "1785888000000000001",
      observedTimeUnixNano: "1785888000001000002",
      severityNumber: 17,
      severityText: "ERROR",
      eventName: "$log",
      body: { type: "string", value: "checkout failed" },
      droppedAttributesCount: 3,
      flags: 1,
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      resource: { droppedAttributesCount: 1, schemaUrl: "resource-schema" },
      scope: { name: "hexclave.sdk", version: "1.2.3", droppedAttributesCount: 2, schemaUrl: "scope-schema" },
    });
    expect(log.attributes.get("bytes")).toEqual({ type: "bytes", value: "AAE=" });
  });

  it("rejects half-present trace correlation and invalid severity", () => {
    const log = OTLP_LOG_REQUEST_FIXTURE.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(() => normalizeOtlpJsonLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ ...log, spanId: "" }] }] }],
    })).toThrow(/traceId and spanId/);
    expect(() => normalizeOtlpJsonLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ ...log, severityNumber: 25 }] }] }],
    })).toThrow(/SeverityNumber/);
  });

  it("validates Hexclave marker contracts without constraining vanilla OTel logs", () => {
    const [vanilla] = normalizeOtlpJsonLogsRequest(OTLP_LOG_REQUEST_FIXTURE);
    expect(getHexclaveOtlpLogContractError(vanilla, "client")).toBeNull();
    const [invalidError] = normalizeOtlpJsonLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: "1",
        eventName: "$error",
        attributes: [
          { key: "hexclave.signal.type", value: { stringValue: "error" } },
          { key: "hexclave.data", value: { kvlistValue: { values: [] } } },
        ],
      }] }] }],
    });
    expect(getHexclaveOtlpLogContractError(invalidError, "client")).toMatch(/name\/message/);
  });

  it("adapts the flat error payload and preserves one event ID across both compatibility fields", () => {
    const eventId = "0123456789abcdef0123456789abcdef";
    const [log] = normalizeOtlpJsonLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: "1",
        eventName: "$error",
        attributes: [
          { key: "hexclave.signal.type", value: { stringValue: "error" } },
          { key: "hexclave.event.id", value: { stringValue: eventId } },
          { key: "hexclave.data", value: { kvlistValue: { values: [
            { key: "event_id", value: { stringValue: eventId } },
            { key: "name", value: { stringValue: "PaymentError" } },
            { key: "message", value: { stringValue: "card declined" } },
            { key: "handled", value: { boolValue: false } },
          ] } } },
        ],
      }] }] }],
    });

    expect(log.errorEnvelope).toMatchObject({ eventId, identityError: null });
    expect(getHexclaveOtlpLogContractError(log, "client")).toBeNull();
  });

  it("rejects malformed or conflicting flat error identities as a per-record contract error", () => {
    const errorRecord = (attributeEventId: string, dataEventId: string) => normalizeOtlpJsonLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: "1",
        eventName: "$error",
        attributes: [
          { key: "hexclave.signal.type", value: { stringValue: "error" } },
          { key: "hexclave.event.id", value: { stringValue: attributeEventId } },
          { key: "hexclave.data", value: { kvlistValue: { values: [
            { key: "event_id", value: { stringValue: dataEventId } },
            { key: "name", value: { stringValue: "PaymentError" } },
            { key: "message", value: { stringValue: "card declined" } },
            { key: "handled", value: { boolValue: true } },
          ] } } },
        ],
      }] }] }],
    })[0];

    expect(getHexclaveOtlpLogContractError(errorRecord("not-an-event-id", "not-an-event-id"), "client")).toMatch(/32-character hexadecimal/);
    expect(getHexclaveOtlpLogContractError(errorRecord("0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"), "client")).toMatch(/must match/);
  });

  it("canonicalizes zero-padded timestamps so the required-timestamp check cannot be bypassed", () => {
    const log = OTLP_LOG_REQUEST_FIXTURE.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(() => normalizeOtlpJsonLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ ...log, timeUnixNano: "00", observedTimeUnixNano: "0" }] }] }],
    })).toThrow(/timeUnixNano or observedTimeUnixNano/);
    const [normalized] = normalizeOtlpJsonLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ ...log, timeUnixNano: "00", observedTimeUnixNano: "1785888000001000002" }] }] }],
    });
    expect(normalized.timeUnixNano).toBe("0");
  });

  it("treats an empty body object as an unset AnyValue", () => {
    const [log] = normalizeOtlpJsonLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: "1",
        eventName: "$click",
        body: {},
        attributes: [
          { key: "hexclave.signal.type", value: { stringValue: "event" } },
          { key: "hexclave.data", value: { kvlistValue: { values: [{ key: "href", value: {} }] } } },
        ],
      }] }] }],
    });
    expect(log.body).toBeNull();
    const data = log.attributes.get("hexclave.data");
    if (data?.type !== "kvlist") throw new Error("Expected hexclave.data to normalize as a kvlist");
    expect(data.value.get("href")).toEqual({ type: "null", value: null });
  });

  it("admits system autocapture event names from the client origin only", () => {
    const eventRecord = (eventName: string) => normalizeOtlpJsonLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: "1",
        eventName,
        attributes: [
          { key: "hexclave.signal.type", value: { stringValue: "event" } },
          { key: "hexclave.data", value: { kvlistValue: { values: [] } } },
        ],
      }] }] }],
    })[0];

    expect(getHexclaveOtlpLogContractError(eventRecord("$click"), "client")).toBeNull();
    expect(getHexclaveOtlpLogContractError(eventRecord("checkout_completed"), "client")).toBeNull();
    expect(getHexclaveOtlpLogContractError(eventRecord("checkout_completed"), "server")).toBeNull();
    expect(getHexclaveOtlpLogContractError(eventRecord("$click"), "server")).toMatch(/cannot be written from the server origin/);
    expect(getHexclaveOtlpLogContractError(eventRecord("$error"), "client")).toMatch(/known system event type or a valid custom eventName/);
    expect(getHexclaveOtlpLogContractError(eventRecord("$not-a-system-event"), "client")).toMatch(/known system event type or a valid custom eventName/);
  });
});
