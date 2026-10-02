export type ExecuteResult =
  | { status: "ok", data: unknown }
  | { status: "error", error: { message: string, stack?: string, cause?: unknown } };
