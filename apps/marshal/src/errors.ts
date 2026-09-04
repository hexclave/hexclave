// Errors that map to HTTP responses. Anything else thrown from a route is a 500 with a
// generic message (never GCP/R2 error bodies — they can contain project/resource identifiers the
// backend shouldn't relay to end users).
export class MarshalError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MarshalError";
  }
}

export function badRequest(message: string): MarshalError {
  return new MarshalError(400, "bad_request", message);
}

export function notFound(message: string): MarshalError {
  return new MarshalError(404, "not_found", message);
}

export function conflict(message: string): MarshalError {
  return new MarshalError(409, "conflict", message);
}
