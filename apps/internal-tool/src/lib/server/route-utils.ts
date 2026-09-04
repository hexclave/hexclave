import "server-only";

import { StatusError, captureError } from "@hexclave/shared/dist/utils/errors";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { z } from "zod";

export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new StatusError(StatusError.BadRequest, "Request body must be valid JSON.");
  }
}

export function handleApiError(scope: string, err: unknown): Response {
  if (err instanceof z.ZodError) {
    return Response.json({
      error: "Invalid request body.",
      issues: err.issues.map(issue => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    }, { status: 400 });
  }

  if (StatusError.isStatusError(err)) {
    if (err.isClientError()) {
      return new Response(err.message, {
        status: err.statusCode,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    captureError(scope, err);
    return new Response("Upstream service failed.", {
      status: err.statusCode,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  captureError(scope, err);
  return new Response("Internal server error.", {
    status: 500,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function successResponse(extra?: Record<string, Json>): Response {
  return Response.json({ success: true, ...extra });
}

export const zJsonArrayString = z.string().superRefine((value, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be a valid JSON string." });
    return;
  }
  if (!Array.isArray(parsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be a JSON array." });
  }
});
