import { getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

const SAFE_CLICKHOUSE_ERROR_CODES = [
  62, // SYNTAX_ERROR
  159, // TIMEOUT_EXCEEDED
  164, // READONLY
  158, // TOO_MANY_ROWS
  396, // TOO_MANY_ROWS_OR_BYTES
  636, // CANNOT_EXTRACT_TABLE_STRUCTURE
  // User/AI SQL omitted a JOIN subquery alias. Message only echoes their query text.
  206, // ALIAS_REQUIRED
];

const UNSAFE_CLICKHOUSE_ERROR_CODES = [
  36, // BAD_ARGUMENTS
  43, // ILLEGAL_TYPE_OF_ARGUMENT
  47, // UNKNOWN_IDENTIFIER
  60, // UNKNOWN_TABLE
  386, // NO_COMMON_TYPE
  497, // ACCESS_DENIED
];

const DEFAULT_CLICKHOUSE_ERROR_MESSAGE = "Error during execution of this query.";

export function getSafeClickhouseErrorMessage(error: unknown, query: string) {
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string" || isNaN(Number(error.code)) || !("message" in error) || typeof error.message !== "string") {
    captureError("unknown-clickhouse-error-for-query-not-clickhouse-error", new HexclaveAssertionError("Unknown error from Clickhouse is not a Clickhouse error", { cause: error, query: query }));
    return DEFAULT_CLICKHOUSE_ERROR_MESSAGE;
  }

  const errorCode = Number(error.code);
  const message = error.message;
  if (SAFE_CLICKHOUSE_ERROR_CODES.includes(errorCode)) {
    return message;
  }
  const isKnown = UNSAFE_CLICKHOUSE_ERROR_CODES.includes(errorCode);
  if (!isKnown) {
    captureError("unknown-clickhouse-error-for-query", new HexclaveAssertionError(`Unknown Clickhouse error: code ${errorCode} not in safe or unsafe codes`, { cause: error, query: query }));
  }

  if (getNodeEnvironment() === "development" || getNodeEnvironment() === "test") {
    return `${DEFAULT_CLICKHOUSE_ERROR_MESSAGE}${!isKnown ? "\n\nThis error is not known and you should probably add it to the safe or unsafe codes in clickhouse-errors.ts." : ""}\n\nAs you are in development mode, you can see the full error: ${errorCode} ${message}`;
  }
  return DEFAULT_CLICKHOUSE_ERROR_MESSAGE;
}
