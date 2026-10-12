import { afterEach, describe, expect, it, vi } from "vitest";
import { hexclaveApiUrl } from "./env";

function stubUnset() {
  vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_API_URL", "");
  vi.stubEnv("NEXT_PUBLIC_STACK_API_URL", "");
  vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hexclaveApiUrl", () => {
  it("reads the canonical HEXCLAVE_ spelling", () => {
    stubUnset();
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_API_URL", "https://api.example.com");
    expect(hexclaveApiUrl()).toBe("https://api.example.com");
  });

  it("falls back to the legacy STACK_ spelling", () => {
    stubUnset();
    vi.stubEnv("NEXT_PUBLIC_STACK_API_URL", "https://api.dev.stack-auth.com");
    expect(hexclaveApiUrl()).toBe("https://api.dev.stack-auth.com");
  });

  it("accepts both spellings when they agree", () => {
    stubUnset();
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_API_URL", "https://api.example.com");
    vi.stubEnv("NEXT_PUBLIC_STACK_API_URL", "https://api.example.com");
    expect(hexclaveApiUrl()).toBe("https://api.example.com");
  });

  it("throws when the two spellings disagree", () => {
    stubUnset();
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_API_URL", "https://api.hexclave.com");
    vi.stubEnv("NEXT_PUBLIC_STACK_API_URL", "https://api.stack-auth.com");
    expect(() => hexclaveApiUrl()).toThrow(/both set to different values/);
  });

  it("throws outside development instead of guessing a production API URL", () => {
    stubUnset();
    vi.stubEnv("NODE_ENV", "production");
    expect(() => hexclaveApiUrl()).toThrow(/NEXT_PUBLIC_HEXCLAVE_API_URL is not configured/);
  });

  it("treats an unreplaced REPLACE_ME sentinel as unset", () => {
    // The production build bakes in `REPLACE_ME` for startup substitution; if
    // that substitution never ran, the value is missing, not literal.
    stubUnset();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_API_URL", "REPLACE_ME");
    expect(() => hexclaveApiUrl()).toThrow(/NEXT_PUBLIC_HEXCLAVE_API_URL is not configured/);
  });

  it("defaults to the local backend in development, honoring the port prefix", () => {
    stubUnset();
    vi.stubEnv("NODE_ENV", "development");
    expect(hexclaveApiUrl()).toBe("http://localhost:8102");
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX", "92");
    expect(hexclaveApiUrl()).toBe("http://localhost:9202");
  });
});
