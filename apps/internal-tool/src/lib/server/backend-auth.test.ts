import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireBackendAssertion } from "./backend-auth";

// The module under test imports the `server-only` marker package, which throws
// when loaded outside a React Server Components bundler context.
vi.mock("server-only", () => ({}));

// Capture the scope each rejection reports. These assertions are the point of
// the diagnostics: every rejection returns the same opaque message to the
// caller, so the log scope is the only thing that distinguishes them.
const { capturedScopes } = vi.hoisted(() => ({ capturedScopes: [] as string[] }));
vi.mock("@hexclave/shared/dist/utils/errors", async (importOriginal) => ({
  ...await importOriginal<typeof import("@hexclave/shared/dist/utils/errors")>(),
  captureError: (scope: string) => { capturedScopes.push(scope); },
}));

function request(authorization?: string): Request {
  return new Request("https://tool.example.com/api/backend/log-ai-query", {
    method: "POST",
    headers: authorization == null ? {} : { authorization },
  });
}

beforeEach(() => {
  capturedScopes.length = 0;
  vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_API_URL", "https://api.dev.stack-auth.com");
  vi.stubEnv("NEXT_PUBLIC_STACK_API_URL", "");
  vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_PROJECT_ID", "2b308f3a-739c-424b-a869-32a7ef7e3ce6");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireBackendAssertion", () => {
  it("rejects a request with no Authorization header without logging", async () => {
    const err = await requireBackendAssertion(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StatusError);
    expect((err as StatusError).statusCode).toBe(401);
    // A missing header is an ordinary unauthenticated request, not a
    // misconfiguration; logging it would drown the signal we actually want.
    expect(capturedScopes).toEqual([]);
  });

  it("rejects a non-Bearer Authorization header", async () => {
    const err = await requireBackendAssertion(request("Basic abc")).catch((e: unknown) => e);
    expect((err as StatusError).statusCode).toBe(401);
    expect(capturedScopes).toEqual([]);
  });

  it("logs the verify scope when the token can't be verified, but stays opaque to the caller", async () => {
    // A malformed token fails inside jose before any JWKS fetch is attempted,
    // so this exercises the catch path without touching the network.
    const err = await requireBackendAssertion(request("Bearer not-a-jwt")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StatusError);
    expect((err as StatusError).statusCode).toBe(401);
    expect((err as StatusError).message).toMatchInlineSnapshot(`"Invalid backend assertion."`);
    expect(capturedScopes).toEqual(["backend-assertion-verify"]);
  });
});
