import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { captureError, HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { isJsonSerializable, type Json } from "@hexclave/shared/dist/utils/json";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { traceSpan } from "@hexclave/shared/dist/utils/telemetry";
import createEmailableClient from "emailable";

export const EMAILABLE_NOT_DELIVERABLE_TEST_DOMAIN = "emailable-not-deliverable.example.com";


// ── Types ──────────────────────────────────────────────────────────────

const VERIFY_STATES = ["deliverable", "undeliverable", "risky", "unknown"] as const;
type EmailableVerifyState = (typeof VERIFY_STATES)[number];
type EmailableVerifyResponse = {
  state: EmailableVerifyState,
  disposable: boolean,
  score: number | null,
  [key: string]: Json,
};

export type EmailableCheckResult =
  | { status: "deliverable", emailableScore: number | null }
  | { status: "not-deliverable", emailableResponse: EmailableVerifyResponse, emailableScore: number | null }


// ── Helpers ────────────────────────────────────────────────────────────

const RETRY_BACKOFF_BASE_MS = 4000;

function isReservedExampleDomain(emailDomain: string): boolean {
  return emailDomain === "example.com" || emailDomain.endsWith(".example.com");
}

function isEmailableVerifyState(value: Json): value is EmailableVerifyState {
  return typeof value === "string" && VERIFY_STATES.some((state) => state === value);
}

function validateVerifyResponse(value: unknown) {
  if (!isJsonSerializable(value) || value == null || Array.isArray(value)) {
    throw new HexclaveAssertionError("Emailable returned a non-object response body", { value });
  }
  const response = value;
  const { state, disposable, score } = response;
  if (!isEmailableVerifyState(state)) {
    throw new HexclaveAssertionError("Emailable verify response has invalid or missing state", { response });
  }
  const parsedScore = typeof score === "number" && score >= 0 && score <= 100 ? score : null;
  const parsed: EmailableVerifyResponse = { ...response, state, disposable: disposable === true, score: parsedScore };
  return parsed;
}

async function verifyWithRetries(verifyFn: () => Promise<Json>, maxAttempts: number, delayBaseMs: number): Promise<EmailableVerifyResponse> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await verifyFn();
    if (!isJsonSerializable(res) || res == null || typeof res !== "object" || Array.isArray(res)) {
      throw new HexclaveAssertionError("Emailable returned an unexpected response body", { response: res });
    }
    if (!("state" in res)) {
      const message = res.message;
      if (typeof message === "string" && (message.includes("Your request is taking longer than normal") || message.includes("Your email is still being verified"))) {
        await wait((Math.random() + 0.5) * delayBaseMs * (2 ** i));
        continue;
      }
      throw new HexclaveAssertionError("Emailable returned an unexpected response body", { response: res });
    }
    return validateVerifyResponse(res);
  }
  throw new HexclaveAssertionError("Timed out while verifying email address with Emailable");
}

function buildTestUndeliverableResponse(email: string) {
  const match = email.match(/^([^@]+)@([^@]+)$/);
  if (!match) {
    throw new HexclaveAssertionError("Expected a valid email before creating the Emailable test-mode response", { email });
  }
  return {
    accept_all: false, did_you_mean: null, disposable: false, domain: match[2],
    duration: 0, email, first_name: null, free: false, full_name: null, gender: null,
    last_name: null, mailbox_full: false, mx_record: null, no_reply: false,
    reason: "test_domain_rejection", role: false, score: 0, smtp_provider: null,
    state: "undeliverable" as const, tag: null, user: match[1],
  };
}


// ── Public API ─────────────────────────────────────────────────────────

export async function checkEmailWithEmailable(
  email: string,
  options?: {
    retryExponentialDelayBaseMs?: number,
    /** @internal — used by tests to inject a fake client */
    _clientFactory?: (apiKey: string) => { verify: (email: string) => Promise<Json> },
  },
): Promise<EmailableCheckResult> {
  try {
    const apiKey = getEnvVariable("STACK_EMAILABLE_API_KEY", "") || throwErr("STACK_EMAILABLE_API_KEY must not be empty; set it to 'disable_email_validation' to disable email validation");
    const emailDomain = email.split("@")[1]?.toLowerCase() ?? "";

    if (emailDomain === EMAILABLE_NOT_DELIVERABLE_TEST_DOMAIN) {
      const testResponse = buildTestUndeliverableResponse(email);
      return { status: "not-deliverable", emailableResponse: testResponse, emailableScore: testResponse.score };
    }

    if (apiKey === "disable_email_validation") {
      return { status: "deliverable", emailableScore: null };
    }

    // Avoid spending Emailable requests on reserved example domains without overriding the no-key dev/test behavior.
    if (isReservedExampleDomain(emailDomain)) {
      const testResponse = buildTestUndeliverableResponse(email);
      return { status: "not-deliverable", emailableResponse: testResponse, emailableScore: testResponse.score };
    }

    const clientFactory = options?._clientFactory ?? createEmailableClient;
    const retryDelayBase = options?.retryExponentialDelayBaseMs ?? RETRY_BACKOFF_BASE_MS;

    return await traceSpan("checking email address with Emailable", async () => {
      const client = clientFactory(apiKey);
      const raw = await verifyWithRetries(() => client.verify(email), 4, retryDelayBase);
      console.log("Received emailable response", { email, raw });
      const response = validateVerifyResponse(raw);

      if (response.state === "undeliverable") {
        return { status: "not-deliverable", emailableResponse: response, emailableScore: response.score };
      }
      return { status: "deliverable", emailableScore: response.score };
    });
  } catch (error) {
    captureError("emailable-api-error", new HexclaveAssertionError("Error while checking email address with Emailable", { cause: error, email, options }));
    // If there's an error, let's pretend the email is deliverable, albeit with the score unavailable
    return { status: "deliverable", emailableScore: null };
  }
}


// ── Tests ──────────────────────────────────────────────────────────────

import.meta.vitest?.describe("checkEmailWithEmailable(...)", () => {
  const { vi, test, beforeEach, expect } = import.meta.vitest!;

  const fakeClient = (verifyFn: (email: string) => Promise<Json>) => (_apiKey: string) => ({ verify: verifyFn });
  const stubEmailableApiKey = (value: string) => {
    vi.stubEnv("HEXCLAVE_EMAILABLE_API_KEY", value);
    vi.stubEnv("STACK_EMAILABLE_API_KEY", value);
  };

  const deliverableClient = fakeClient(async () => ({
    state: "deliverable", disposable: false, score: 95, domain: "gmail.com", email: "test@gmail.com", user: "test",
  }));

  const errorClient = fakeClient(async () => {
    throw new Error("network error");
  });

  beforeEach(() => {
    stubEmailableApiKey("test_api_key");
    return () => vi.unstubAllEnvs();
  });

  test("returns test-domain rejection regardless of API key", async ({ expect }) => {
    await expect(checkEmailWithEmailable(`user@${EMAILABLE_NOT_DELIVERABLE_TEST_DOMAIN}`))
      .resolves.toMatchObject({ status: "not-deliverable", emailableResponse: { state: "undeliverable", reason: "test_domain_rejection" } });
  });

  test("falls back to deliverable when API key is unset", async ({ expect }) => {
    stubEmailableApiKey("");
    await expect(checkEmailWithEmailable(`user@${EMAILABLE_NOT_DELIVERABLE_TEST_DOMAIN}`))
      .resolves.toEqual({ status: "deliverable", emailableScore: null });
  });

  test.each([
    "user@example.com",
    "user@stack-generated.example.com",
  ])("falls back to deliverable for reserved example address %s when the API key is unset", async (email) => {
    stubEmailableApiKey("");
    vi.stubEnv("NODE_ENV", "test");
    const result = await checkEmailWithEmailable(email);
    expect(result).toEqual({ status: "deliverable", emailableScore: null });
  });

  test.each([
    "user@example.com",
    "user@status-monitor.example.com",
  ])("bypasses reserved example address %s when validation is disabled", async (email) => {
    stubEmailableApiKey("disable_email_validation");
    const verify = vi.fn();
    const result = await checkEmailWithEmailable(email, { _clientFactory: () => ({ verify }) });
    expect(result).toEqual({ status: "deliverable", emailableScore: null });
    expect(verify).not.toHaveBeenCalled();
  });

  test("returns ok for deliverable email", async ({ expect }) => {
    stubEmailableApiKey("test_api_key");
    const result = await checkEmailWithEmailable("test@gmail.com", { _clientFactory: deliverableClient });
    expect(result).toMatchObject({ status: "deliverable", emailableScore: 95 });
  });

  test("successfully retries and verifies deliverable email if Emailable asks for a retry the first time", async ({ expect }) => {
    stubEmailableApiKey("test_api_key");
    let retryCount = 0;
    const retryClient = fakeClient(async () => retryCount++ === 0 ? {
      message: "Your request is taking longer than normal. Please send your request again."
    } : {
      state: "deliverable", disposable: false, score: 95, domain: "gmail.com", email: "test@gmail.com", user: "test",
    });
    const result = await checkEmailWithEmailable("test@gmail.com", { _clientFactory: retryClient });
    expect(retryCount).toBe(2);
    expect(result).toMatchObject({ status: "deliverable", emailableScore: 95 });
  });

  test("returns deliverable on API error", async ({ expect }) => {
    const result = await checkEmailWithEmailable("test@gmail.com", { _clientFactory: errorClient });
    expect(result).toMatchObject({ status: "deliverable", emailableScore: null });
  });

  test("returns deliverable on malformed Emailable response bodies", async ({ expect }) => {
    const malformedClient = fakeClient(async () => "definitely not an object");
    const result = await checkEmailWithEmailable("test@gmail.com", { _clientFactory: malformedClient });
    expect(result).toMatchObject({ status: "deliverable", emailableScore: null });
  });
});
