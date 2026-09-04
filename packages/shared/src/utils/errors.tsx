import { globalVar } from "./globals";
import { Json } from "./json";
import { pick } from "./objects";
import { nicify } from "./strings";


export function throwErr(errorMessage: string, extraData?: any): never;
export function throwErr(error: Error): never;
export function throwErr(...args: StatusErrorConstructorParameters): never;
export function throwErr(...args: any[]): never {
  if (typeof args[0] === "string") {
    throw new HexclaveAssertionError(args[0], args[1]);
  } else if (args[0] instanceof Error) {
    throw args[0];
  } else {
    // @ts-expect-error
    throw new StatusError(...args);
  }
}

function removeStacktraceNameLine(stack: string): string {
  // some browsers (eg. Chrome) prepend the stack with an extra line with the error name
  const addsNameLine = new Error().stack?.startsWith("Error\n");
  return stack.split("\n").slice(addsNameLine ? 1 : 0).join("\n");
}


/**
 * Concatenates the (original) stacktraces of the given errors onto the first.
 *
 * Note: Very often, the concatStacktracesIfRejected function in promises.tsx is an easier way to use this function.
 *
 * Useful when you invoke an async function to receive a promise without awaiting it immediately. Browsers are smart
 * enough to keep track of the call stack in async function calls when you invoke `.then` within the same async tick,
 * but if you don't, the stacktrace will be lost.
 *
 * Here's an example of the unwanted behavior:
 *
 * ```tsx
 * async function log() {
 *   await wait(0);  // put the task on the event loop
 *   console.log(new Error().stack);
 * }
 *
 * async function main() {
 *   await log();  // good; prints both "log" and "main" on the stacktrace
 *   log();  // bad; prints only "log" on the stacktrace
 * }
 * ```
 */
export function concatStacktraces(first: Error, ...errors: Error[]): void {
  // some browsers (eg. Firefox) add an extra empty line at the end
  const addsEmptyLineAtEnd = first.stack?.endsWith("\n");


  // Add a reference to this function itself so that we know that stacktraces were concatenated
  // If you are coming here from a stacktrace, please know that the two parts before and after this line are different
  // stacktraces that were concatenated with concatStacktraces
  const separator = removeStacktraceNameLine(new Error().stack ?? "").split("\n")[0];


  for (const error of errors) {
    const toAppend = removeStacktraceNameLine(error.stack ?? "");
    first.stack += (addsEmptyLineAtEnd ? "" : "\n") + separator + "\n" + toAppend;
  }
}


export class HexclaveAssertionError extends Error {
  constructor(message: string, public readonly extraData?: Record<string, any> & ErrorOptions) {
    const disclaimer = `\n\nThis is likely an error in Hexclave. Please make sure you are running the newest version and report it.`;
    super(`${message}${message.endsWith(disclaimer) ? "" : disclaimer}`, pick(extraData ?? {}, ["cause"]));

    Object.defineProperty(this, "customCaptureExtraArgs", {
      get() {
        return [this.extraData];
      },
      enumerable: false,
    });

    // Use literal dot-form (guarded with `typeof process`) so Next.js / webpack
    // DefinePlugin can inline the value at build time. See getProcessEnv in ./env.
    const hexclaveDebuggerValue = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_HEXCLAVE_DEBUGGER_ON_ASSERTION_ERROR : undefined;
    const stackDebuggerValue = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_STACK_DEBUGGER_ON_ASSERTION_ERROR : undefined;
    if (hexclaveDebuggerValue && stackDebuggerValue && hexclaveDebuggerValue !== stackDebuggerValue) {
      throw new Error("Environment variables NEXT_PUBLIC_HEXCLAVE_DEBUGGER_ON_ASSERTION_ERROR and NEXT_PUBLIC_STACK_DEBUGGER_ON_ASSERTION_ERROR are both set to different values. Remove one of them or set them to the same value.");
    }
    if ((hexclaveDebuggerValue || stackDebuggerValue) === "true") {
      debugger;
    }
  }
}
HexclaveAssertionError.prototype.name = "HexclaveAssertionError";


const hexclaveSetupErrorBrand = "hexclave-setup-error-brand-sentinel";

/**
 * An error caused by an incomplete or incorrect Hexclave setup in the developer's own project — a domain that has not
 * been added to the project's trusted domains, for example.
 *
 * These are neither the end user's fault nor a bug in Hexclave, and they are usually fatal for the flow they occur in (an
 * auth handoff that can never complete, say). Only logging them would leave the developer with a broken flow and no
 * visible explanation, so the SDK also renders them on the page; `title` and `howToFix` end up in that card, so write
 * them as instructions to the developer rather than as internal diagnostics.
 */
export class HexclaveSetupError extends Error {
  public readonly title: string;
  public readonly howToFix: readonly string[];

  constructor(options: {
    title: string,
    message: string,
    howToFix: readonly string[],
    // like HexclaveAssertionError's extraData: freeform diagnostics that only ever reach the error sinks
    extraData?: Record<string, unknown> & ErrorOptions,
  }) {
    super(options.message, pick(options.extraData ?? {}, ["cause"]));
    this.title = options.title;
    this.howToFix = options.howToFix;

    Object.defineProperty(this, hexclaveSetupErrorBrand, { value: true, enumerable: false });
    Object.defineProperty(this, "customCaptureExtraArgs", {
      get() {
        return [{ ...options.extraData, howToFix: options.howToFix }];
      },
      enumerable: false,
    });
  }

  /**
   * Like `instanceof`, but also true for setup errors thrown by another copy of this package — an app can easily end up
   * with two of them, and a setup error from either must still show up as one.
   */
  public static isSetupError(error: unknown): error is HexclaveSetupError {
    if (typeof error !== "object" || error === null) return false;
    // an own property with the sentinel value, not just the name somewhere on the prototype chain; the brand decides
    // whether an error is shown to the developer verbatim, so a coincidental key must not be enough
    if (!Object.prototype.hasOwnProperty.call(error, hexclaveSetupErrorBrand)) return false;
    if (error[hexclaveSetupErrorBrand] !== true) return false;
    return typeof error["title"] === "string" && Array.isArray(error["howToFix"]);
  }
}
HexclaveSetupError.prototype.name = "HexclaveSetupError";


export function errorToNiceString(error: unknown): string {
  if (!(error instanceof Error)) return `${typeof error}<${nicify(error)}>`;
  return nicify(error, { maxDepth: 8 });
}


export type CaptureLevel = "error" | "warning";

type ErrorSink = (location: string, error: unknown, level: CaptureLevel, ...extraArgs: unknown[]) => void;

const errorSinks = new Set<ErrorSink>();
export function registerErrorSink(sink: ErrorSink): void {
  if (errorSinks.has(sink)) {
    return;
  }
  errorSinks.add(sink);
}
registerErrorSink((location, error, level, ...extraArgs) => {
  const logger = level === "warning" ? console.warn : console.error;
  const colorCode = level === "warning" ? "\x1b[43m" : "\x1b[41m";
  const label = level === "warning" ? "warning" : "error";
  logger(
    `${colorCode}Captured ${label} in ${location}:`,
    // HACK: Log a nicified version of the error to get around buggy Next.js pretty-printing
    // https://www.reddit.com/r/nextjs/comments/1gkxdqe/comment/m19kxgn/?utm_source=share&utm_medium=web3x&utm_name=web3xcss&utm_term=1&utm_content=share_button
    errorToNiceString(error),
    ...extraArgs,
    "\x1b[0m",
  );
});
registerErrorSink((location, error, level, ...extraArgs) => {
  globalVar.hexclaveCapturedErrors = globalVar.hexclaveCapturedErrors ?? [];
  globalVar.hexclaveCapturedErrors.push({ location, error, level, extraArgs });
});

function dispatchToSinks(location: string, error: unknown, level: CaptureLevel): void {
  for (const sink of errorSinks) {
    sink(
      location,
      error,
      level,
      ...error && (typeof error === 'object' || typeof error === 'function') && "customCaptureExtraArgs" in error && Array.isArray(error.customCaptureExtraArgs) ? (error.customCaptureExtraArgs as any[]) : [],
    );
  }
}

/**
 * Captures an error and sends it to the error sinks (most notably, Sentry). Errors caught with captureError are
 * supposed to be seen by an engineer, so they should be actionable and important.
 *
 * The location string is a machine-readable ID, and should hence not contain spaces or anything like that. Good
 * examples are: "api-route-handler", "renderPart()", etc.
 *
 * Errors that bubble up to the top of runAsynchronously or a route handler are already captured with captureError.
 */
export function captureError(location: string, error: unknown): void {
  dispatchToSinks(location, error, "error");
}

/**
 * Like captureError, but logs at warning level. Use for issues that an engineer should know about but that aren't
 * severe enough to be treated as an error (e.g. recoverable failures in background tasks).
 */
export function captureWarning(location: string, error: unknown): void {
  dispatchToSinks(location, error, "warning");
}


type Status = {
  statusCode: number,
  message: string,
};

type StatusErrorConstructorParameters =
| [
  status: Status,
  message?: string
]
| [
  statusCode: number | Status,
  message: string,
];

export class StatusError extends Error {
  private readonly __stackStatusErrorBrand = "stack-status-error-brand-sentinel" as const;
  public name = "StatusError";
  public readonly statusCode: number;

  public static BadRequest = { statusCode: 400, message: "Bad Request" };
  public static Unauthorized = { statusCode: 401, message: "Unauthorized" };
  public static PaymentRequired = { statusCode: 402, message: "Payment Required" };
  public static Forbidden = { statusCode: 403, message: "Forbidden" };
  public static NotFound = { statusCode: 404, message: "Not Found" };
  public static MethodNotAllowed = { statusCode: 405, message: "Method Not Allowed" };
  public static NotAcceptable = { statusCode: 406, message: "Not Acceptable" };
  public static ProxyAuthenticationRequired = { statusCode: 407, message: "Proxy Authentication Required" };
  public static RequestTimeout = { statusCode: 408, message: "Request Timeout" };
  public static Conflict = { statusCode: 409, message: "Conflict" };
  public static Gone = { statusCode: 410, message: "Gone" };
  public static LengthRequired = { statusCode: 411, message: "Length Required" };
  public static PreconditionFailed = { statusCode: 412, message: "Precondition Failed" };
  public static PayloadTooLarge = { statusCode: 413, message: "Payload Too Large" };
  public static URITooLong = { statusCode: 414, message: "URI Too Long" };
  public static UnsupportedMediaType = { statusCode: 415, message: "Unsupported Media Type" };
  public static RangeNotSatisfiable = { statusCode: 416, message: "Range Not Satisfiable" };
  public static ExpectationFailed = { statusCode: 417, message: "Expectation Failed" };
  public static ImATeapot = { statusCode: 418, message: "I'm a teapot" };
  public static MisdirectedRequest = { statusCode: 421, message: "Misdirected Request" };
  public static UnprocessableEntity = { statusCode: 422, message: "Unprocessable Entity" };
  public static Locked = { statusCode: 423, message: "Locked" };
  public static FailedDependency = { statusCode: 424, message: "Failed Dependency" };
  public static TooEarly = { statusCode: 425, message: "Too Early" };
  public static UpgradeRequired = { statusCode: 426, message: "Upgrade Required" };
  public static PreconditionRequired = { statusCode: 428, message: "Precondition Required" };
  public static TooManyRequests = { statusCode: 429, message: "Too Many Requests" };
  public static RequestHeaderFieldsTooLarge = { statusCode: 431, message: "Request Header Fields Too Large" };
  public static UnavailableForLegalReasons = { statusCode: 451, message: "Unavailable For Legal Reasons" };

  public static InternalServerError = { statusCode: 500, message: "Internal Server Error" };
  public static NotImplemented = { statusCode: 501, message: "Not Implemented" };
  public static BadGateway = { statusCode: 502, message: "Bad Gateway" };
  public static ServiceUnavailable = { statusCode: 503, message: "Service Unavailable" };
  public static GatewayTimeout = { statusCode: 504, message: "Gateway Timeout" };
  public static HTTPVersionNotSupported = { statusCode: 505, message: "HTTP Version Not Supported" };
  public static VariantAlsoNegotiates = { statusCode: 506, message: "Variant Also Negotiates" };
  public static InsufficientStorage = { statusCode: 507, message: "Insufficient Storage" };
  public static LoopDetected = { statusCode: 508, message: "Loop Detected" };
  public static NotExtended = { statusCode: 510, message: "Not Extended" };
  public static NetworkAuthenticationRequired = { statusCode: 511, message: "Network Authentication Required" };


  constructor(...args: StatusErrorConstructorParameters);
  constructor(
    status: number | Status,
    message?: string,
  ) {
    if (typeof status === "object") {
      message ??= status.message;
      status = status.statusCode;
    }
    super(message);
    this.statusCode = status;
    if (!message) {
      throw new HexclaveAssertionError("StatusError always requires a message unless a Status object is passed", { cause: this });
    }
  }

  public static isStatusError(error: unknown): error is StatusError {
    // like instanceof, but also works for errors thrown in other realms or by different versions of the same package
    return typeof error === "object" && error !== null && "__stackStatusErrorBrand" in error && error.__stackStatusErrorBrand === "stack-status-error-brand-sentinel";
  }

  public isClientError() {
    return this.statusCode >= 400 && this.statusCode < 500;
  }

  public isServerError() {
    return !this.isClientError();
  }

  public getStatusCode(): number {
    return this.statusCode;
  }

  public getBody(): Uint8Array {
    return new TextEncoder().encode(this.message);
  }

  public getHeaders(): Record<string, string[]> {
    return {
      "Content-Type": ["text/plain; charset=utf-8"],
    };
  }

  public toDescriptiveJson(): Json {
    return {
      status_code: this.getStatusCode(),
      message: this.message,
      headers: this.getHeaders(),
    };
  }

  /**
   * @deprecated this is not a good way to make status errors human-readable, use toDescriptiveJson instead
   */
  public toHttpJson(): Json {
    return {
      status_code: this.statusCode,
      body: this.message,
      headers: this.getHeaders(),
    };
  }
}
StatusError.prototype.name = "StatusError";
