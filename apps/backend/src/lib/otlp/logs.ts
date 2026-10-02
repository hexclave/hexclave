import { CUSTOM_TELEMETRY_NAME_RE, canWriteTelemetrySignal, isAnalyticsSystemEvent, isW3cSpanId, isW3cTraceId, type TelemetryWriterOrigin } from "@hexclave/shared/dist/utils/analytics-wire";
import type { ErrorIngestScrubbedRecord } from "@/lib/error-ingest/error-ingest-scrubber";
import { OtlpJsonRequestError, otlpAnyValue, otlpArray, otlpAttributes, otlpCanonicalUint64String, otlpRecord, otlpString, otlpUint, otlpUint32, type OtlpAttributes, type OtlpAttributeValue } from "./json";

export type CanonicalOtlpLogRecord = {
  timeUnixNano: string,
  observedTimeUnixNano: string,
  severityNumber: number,
  severityText: string,
  body: OtlpAttributeValue | null,
  attributes: OtlpAttributes,
  droppedAttributesCount: number,
  flags: number,
  traceId: string | null,
  spanId: string | null,
  eventName: string,
  resource: {
    attributes: OtlpAttributes,
    droppedAttributesCount: number,
    schemaUrl: string,
  },
  scope: {
    name: string,
    version: string,
    attributes: OtlpAttributes,
    droppedAttributesCount: number,
    schemaUrl: string,
  },
  errorEnvelope: OtlpErrorEnvelope | null,
  policyScrubbedData?: Readonly<ErrorIngestScrubbedRecord>,
};

export const HEXCLAVE_ERROR_EVENT_ID_RE = /^[0-9a-f]{32}$/;

export type OtlpErrorEnvelope = {
  fields: OtlpAttributes,
  eventId: string | null,
  identityError: string | null,
};

function readFlatErrorEventId(fields: OtlpAttributes, key: string): { value: string | null, error: string | null } {
  const attribute = fields.get(key);
  if (attribute === undefined) return { value: null, error: null };
  if (attribute.type === "null") return { value: null, error: null };
  if (attribute.type !== "string" || !HEXCLAVE_ERROR_EVENT_ID_RE.test(attribute.value)) {
    return { value: null, error: "Hexclave error event_id must be a 32-character hexadecimal string" };
  }
  return { value: attribute.value, error: null };
}

export function getOtlpErrorEnvelope(log: Pick<CanonicalOtlpLogRecord, "eventName" | "attributes">): OtlpErrorEnvelope | null {
  if (log.eventName !== "$error" || log.attributes.get("hexclave.signal.type")?.type !== "string" || log.attributes.get("hexclave.signal.type")?.value !== "error") return null;
  const flatData = log.attributes.get("hexclave.data");
  if (flatData?.type !== "kvlist") return null;
  const fields = flatData.value;

  const attributeEventId = readFlatErrorEventId(log.attributes, "hexclave.event.id");
  const dataEventId = readFlatErrorEventId(fields, "event_id");
  let identityError = attributeEventId.error ?? dataEventId.error;
  if (identityError === null && attributeEventId.value !== null && dataEventId.value !== null && attributeEventId.value !== dataEventId.value) {
    identityError = "Hexclave error event_id must match between hexclave.event.id and error payload event_id";
  }
  return {
    fields,
    eventId: identityError === null ? attributeEventId.value ?? dataEventId.value : null,
    identityError,
  };
}

function nullToAbsent(value: OtlpAttributeValue): OtlpAttributeValue | null {
  return value.type === "null" ? null : value;
}

function unixNanoOrZero(value: unknown, path: string): string {
  if (value === undefined) return "0";
  return otlpCanonicalUint64String(value, path);
}

export function normalizeOtlpJsonLogsRequest(value: unknown): CanonicalOtlpLogRecord[] {
  const request = otlpRecord(value, "body");
  const result: CanonicalOtlpLogRecord[] = [];
  for (const [resourceIndex, rawResourceLogs] of otlpArray(request.resourceLogs ?? [], "body.resourceLogs").entries()) {
    const resourcePath = `body.resourceLogs[${resourceIndex}]`;
    const resourceLogs = otlpRecord(rawResourceLogs, resourcePath);
    const rawResource = otlpRecord(resourceLogs.resource ?? {}, `${resourcePath}.resource`);
    const resource = {
      attributes: otlpAttributes(rawResource.attributes ?? [], `${resourcePath}.resource.attributes`),
      droppedAttributesCount: otlpUint(rawResource.droppedAttributesCount, `${resourcePath}.resource.droppedAttributesCount`),
      schemaUrl: otlpString(resourceLogs.schemaUrl, `${resourcePath}.schemaUrl`, ""),
    };
    for (const [scopeIndex, rawScopeLogs] of otlpArray(resourceLogs.scopeLogs ?? [], `${resourcePath}.scopeLogs`).entries()) {
      const scopePath = `${resourcePath}.scopeLogs[${scopeIndex}]`;
      const scopeLogs = otlpRecord(rawScopeLogs, scopePath);
      const rawScope = otlpRecord(scopeLogs.scope ?? {}, `${scopePath}.scope`);
      const scope = {
        name: otlpString(rawScope.name, `${scopePath}.scope.name`, ""),
        version: otlpString(rawScope.version, `${scopePath}.scope.version`, ""),
        attributes: otlpAttributes(rawScope.attributes ?? [], `${scopePath}.scope.attributes`),
        droppedAttributesCount: otlpUint(rawScope.droppedAttributesCount, `${scopePath}.scope.droppedAttributesCount`),
        schemaUrl: otlpString(scopeLogs.schemaUrl, `${scopePath}.schemaUrl`, ""),
      };
      for (const [logIndex, rawLog] of otlpArray(scopeLogs.logRecords ?? [], `${scopePath}.logRecords`).entries()) {
        const logPath = `${scopePath}.logRecords[${logIndex}]`;
        const log = otlpRecord(rawLog, logPath);
        const traceId = otlpString(log.traceId, `${logPath}.traceId`, "");
        const spanId = otlpString(log.spanId, `${logPath}.spanId`, "");
        if ((traceId === "") !== (spanId === "")) throw new OtlpJsonRequestError(`${logPath}.traceId and spanId must either both be empty or both be present`);
        if (traceId !== "" && !isW3cTraceId(traceId)) throw new OtlpJsonRequestError(`${logPath}.traceId must be a valid W3C trace id`);
        if (spanId !== "" && !isW3cSpanId(spanId)) throw new OtlpJsonRequestError(`${logPath}.spanId must be a valid W3C span id`);
        const timeUnixNano = unixNanoOrZero(log.timeUnixNano, `${logPath}.timeUnixNano`);
        const observedTimeUnixNano = unixNanoOrZero(log.observedTimeUnixNano, `${logPath}.observedTimeUnixNano`);
        if (timeUnixNano === "0" && observedTimeUnixNano === "0") throw new OtlpJsonRequestError(`${logPath} must contain timeUnixNano or observedTimeUnixNano`);
        const severityNumber = otlpUint(log.severityNumber, `${logPath}.severityNumber`);
        if (severityNumber > 24) throw new OtlpJsonRequestError(`${logPath}.severityNumber must be an OTLP SeverityNumber`);
        const normalized: CanonicalOtlpLogRecord = {
          timeUnixNano,
          observedTimeUnixNano,
          severityNumber,
          severityText: otlpString(log.severityText, `${logPath}.severityText`, ""),
          body: log.body === undefined ? null : nullToAbsent(otlpAnyValue(log.body, `${logPath}.body`)),
          attributes: otlpAttributes(log.attributes ?? [], `${logPath}.attributes`),
          droppedAttributesCount: otlpUint(log.droppedAttributesCount, `${logPath}.droppedAttributesCount`),
          flags: otlpUint32(log.flags, `${logPath}.flags`),
          traceId: traceId === "" ? null : traceId,
          spanId: spanId === "" ? null : spanId,
          eventName: otlpString(log.eventName, `${logPath}.eventName`, ""),
          resource,
          scope,
          errorEnvelope: null,
        };
        normalized.errorEnvelope = getOtlpErrorEnvelope(normalized);
        result.push(normalized);
      }
    }
  }
  return result;
}

export function getHexclaveOtlpLogContractError(log: CanonicalOtlpLogRecord, origin: TelemetryWriterOrigin): string | null {
  const signalType = log.attributes.get("hexclave.signal.type");
  if (signalType === undefined) return null;
  if (signalType.type !== "string") return "hexclave.signal.type must be a string";
  if (signalType.value === "event") {
    if (!isAnalyticsSystemEvent(log.eventName) && !CUSTOM_TELEMETRY_NAME_RE.test(log.eventName)) {
      return "Hexclave product event LogRecords require a known system event type or a valid custom eventName";
    }
    // Origin gate (also mirrored from events/batch): autocapture system events
    // are browser-mintable only — a server key must not fabricate e.g. $click.
    if (!canWriteTelemetrySignal(log.eventName, "event", origin)) {
      return `Hexclave product event LogRecords of type ${JSON.stringify(log.eventName)} cannot be written from the ${origin} origin`;
    }
    if (log.attributes.get("hexclave.data")?.type !== "kvlist") return "Hexclave product event LogRecords require a hexclave.data kvlist attribute";
    return null;
  }
  if (signalType.value === "error") {
    if (log.eventName !== "$error") return "Hexclave error LogRecords require eventName $error";
    const errorEnvelope = getOtlpErrorEnvelope(log);
    if (errorEnvelope === null) return "Hexclave error LogRecords require a hexclave.data kvlist attribute";
    if (errorEnvelope.identityError != null) return errorEnvelope.identityError;
    if (errorEnvelope.fields.get("name")?.type !== "string" || errorEnvelope.fields.get("message")?.type !== "string" || errorEnvelope.fields.get("handled")?.type !== "boolean") {
      return "Hexclave error LogRecords require string name/message and boolean handled fields";
    }
    return null;
  }
  if (signalType.value === "log") return null;
  return `Unknown Hexclave signal type ${JSON.stringify(signalType.value)}`;
}
