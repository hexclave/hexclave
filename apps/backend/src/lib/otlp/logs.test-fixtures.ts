export const OTLP_LOG_REQUEST_FIXTURE = {
  resourceLogs: [{
    schemaUrl: "resource-schema",
    resource: {
      attributes: [{ key: "service.name", value: { stringValue: "checkout" } }],
      droppedAttributesCount: 1,
    },
    scopeLogs: [{
      schemaUrl: "scope-schema",
      scope: {
        name: "hexclave.sdk",
        version: "1.2.3",
        attributes: [{ key: "scope.mode", value: { stringValue: "browser" } }],
        droppedAttributesCount: 2,
      },
      logRecords: [{
        timeUnixNano: "1785888000000000001",
        observedTimeUnixNano: "1785888000001000002",
        severityNumber: 17,
        severityText: "ERROR",
        eventName: "$log",
        body: { stringValue: "checkout failed" },
        attributes: [
          { key: "hexclave.data", value: { kvlistValue: { values: [{ key: "attempt", value: { intValue: "2" } }] } } },
          { key: "bytes", value: { bytesValue: "AAE=" } },
        ],
        droppedAttributesCount: 3,
        flags: 1,
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
      }],
    }],
  }],
};
