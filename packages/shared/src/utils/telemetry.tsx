import { Attributes, AttributeValue, Span, trace } from "@opentelemetry/api";
import { getEnvVariable } from "./env";
import { HexclaveAssertionError } from "./errors";

const tracer = trace.getTracer('stack-tracer');


export function withTraceSpan<P extends any[], T>(optionsOrDescription: string | { description: string, attributes?: Record<string, AttributeValue> }, fn: (...args: P) => Promise<T>): (...args: P) => Promise<T> {
  return async (...args: P) => {
    return await traceSpan(optionsOrDescription, (span) => fn(...args));
  };
}

export async function traceSpan<T>(optionsOrDescription: string | { description: string, attributes?: Record<string, AttributeValue> }, fn: (span: Span) => Promise<T>): Promise<T> {
  let options = typeof optionsOrDescription === 'string' ? { description: optionsOrDescription } : optionsOrDescription;
  return await tracer.startActiveSpan(`STACK: ${options.description}`, async (span) => {
    if (options.attributes) {
      for (const [key, value] of Object.entries(options.attributes)) {
        span.setAttribute(key, value);
      }
    }
    try {
      return await fn(span);
    } finally {
      span.end();
    }
  });
}

export function log(message: string, attributes: Attributes) {
  const span = trace.getActiveSpan();
  if (span) {
    span.addEvent(message, attributes);
    // Telemetry is not initialized while seeding, so we don't want to throw an error
  } else if (getEnvVariable('STACK_SEED_MODE', 'false') !== 'true') {
    throw new HexclaveAssertionError('No active span found');
  }
}
