import { SpanKind, SpanStatusCode, type Attributes, type BatchObservableCallback, type Counter, type Gauge, type Histogram, type HrTime, type Meter, type MetricOptions, type Observable, type ObservableCallback, type ObservableCounter, type ObservableGauge, type ObservableUpDownCounter, type UpDownCounter } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { createHexclaveHttpMetricSpanProcessor, type HttpClientMetricSpan } from "./otel-http-metrics";

class FakeCounter implements Pick<Counter, "add"> {
  constructor(
    private readonly name: string,
    private readonly values: Map<string, { value: number, attributes: Attributes }[]>,
  ) {}

  add(value: number, attributes: Attributes = {}): void {
    const entries = this.values.get(this.name) ?? [];
    entries.push({ value, attributes });
    this.values.set(this.name, entries);
  }
}

class FakeHistogram implements Pick<Histogram, "record"> {
  constructor(
    private readonly name: string,
    private readonly values: Map<string, { value: number, attributes: Attributes }[]>,
  ) {}

  record(value: number, attributes: Attributes = {}): void {
    const entries = this.values.get(this.name) ?? [];
    entries.push({ value, attributes });
    this.values.set(this.name, entries);
  }
}

class FakeObservable implements Observable {
  addCallback(_callback: ObservableCallback): void {}
  removeCallback(_callback: ObservableCallback): void {}
}

class FakeMeter implements Meter {
  readonly values = new Map<string, { value: number, attributes: Attributes }[]>();

  createCounter(name: string, _options?: MetricOptions): Counter {
    return new FakeCounter(name, this.values);
  }

  createHistogram(name: string, _options?: MetricOptions): Histogram {
    return new FakeHistogram(name, this.values);
  }

  createGauge(name: string, _options?: MetricOptions): Gauge {
    return new FakeHistogram(name, this.values);
  }

  createUpDownCounter(name: string, _options?: MetricOptions): UpDownCounter {
    return new FakeCounter(name, this.values);
  }

  createObservableGauge(_name: string, _options?: MetricOptions): ObservableGauge {
    return new FakeObservable();
  }

  createObservableCounter(_name: string, _options?: MetricOptions): ObservableCounter {
    return new FakeObservable();
  }

  createObservableUpDownCounter(_name: string, _options?: MetricOptions): ObservableUpDownCounter {
    return new FakeObservable();
  }

  addBatchObservableCallback(_callback: BatchObservableCallback, _observables: Observable[]): void {}

  removeBatchObservableCallback(_callback: BatchObservableCallback, _observables: Observable[]): void {}
}

function span(overrides: {
  kind?: SpanKind,
  attributes?: Attributes,
  duration?: HrTime,
  statusCode?: SpanStatusCode,
}): HttpClientMetricSpan {
  return {
    kind: overrides.kind ?? SpanKind.CLIENT,
    attributes: overrides.attributes ?? {},
    duration: overrides.duration ?? [0, 50_000_000],
    status: { code: overrides.statusCode ?? SpanStatusCode.UNSET },
  };
}

describe("createHexclaveHttpMetricSpanProcessor", () => {
  it("records count and duration from a recorded HTTP client span", () => {
    const meter = new FakeMeter();
    const processor = createHexclaveHttpMetricSpanProcessor(meter);

    processor.record(span({
      attributes: {
        "http.request.method": "post",
        "http.response.status_code": 201,
      },
      duration: [1, 500_000_000],
    }));

    expect(meter.values.get("hexclave.http.client.request.count")).toEqual([{
      value: 1,
      attributes: {
        "http.request.method": "POST",
        "http.response.status_code": 201,
      },
    }]);
    expect(meter.values.get("hexclave.http.client.request.duration")).toEqual([{
      value: 1.5,
      attributes: {
        "http.request.method": "POST",
        "http.response.status_code": 201,
      },
    }]);
  });

  it("ignores non-HTTP and non-client spans", () => {
    const meter = new FakeMeter();
    const processor = createHexclaveHttpMetricSpanProcessor(meter);

    processor.record(span({ kind: SpanKind.SERVER, attributes: { "http.request.method": "GET" } }));
    processor.record(span({ attributes: { "hexclave.signal.type": "custom_span" } }));

    expect(meter.values.size).toBe(0);
  });

  it("accepts legacy HTTP semconv and span error status", () => {
    const meter = new FakeMeter();
    const processor = createHexclaveHttpMetricSpanProcessor(meter);

    processor.record(span({
      attributes: {
        "http.method": "GET",
        "http.status_code": 500,
      },
      statusCode: SpanStatusCode.ERROR,
    }));

    expect(meter.values.get("hexclave.http.client.request.count")).toEqual([{
      value: 1,
      attributes: {
        "http.request.method": "GET",
        "http.response.status_code": 500,
        "error.type": "error",
      },
    }]);
  });
});
