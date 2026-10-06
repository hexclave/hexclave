import { describe, expect, it } from "vitest";
import { parameterizeMessage } from "./parameterize";

describe("parameterizeMessage", () => {
  it("replaces every supported pattern, and only those", () => {
    const cases = [
      "User 8f14e45f-ceea-467a-9e33-1c2b3d4e5f60 not found",
      "Checksum mismatch: expected deadbeefcafe1234",
      "Flag 0xff is set and code abc1 failed",
      "Request 918273 timed out after 30 attempts",
      "Budget exceeded by 12.75 units",
      "No account for jane.doe+test@example.co.uk",
      "Failed to fetch https://api.example.com/v2/users/1234?trace=abc#frag",
      "Connection refused from 192.168.10.42",
      "Connection refused from 2001:0db8:85a3:0000:0000:8a2e:0370:7334",
      "Connection refused from 2001:db8::1",
      "Loopback ::1 and unspecified :: are unavailable",
      "Snapshot 2026-08-01 is stale",
      "Token expired at 2026-08-01T12:34:56.789Z",
      "Job ran at 12:00:00 and failed",
      "user a3bb189e-8bf9-3888-9912-ace4e6543002 at 10.0.0.1 hit https://x.io/a/1 with 42 retries (2026-01-02T03:04:05Z), avg 1.5s, admin@x.io",
    ];
    expect(cases.map((message) => parameterizeMessage(message))).toMatchInlineSnapshot(`
      [
        "User <uuid> not found",
        "Checksum mismatch: expected <hex>",
        "Flag <hex> is set and code abc1 failed",
        "Request <int> timed out after <int> attempts",
        "Budget exceeded by <float> units",
        "No account for <email>",
        "Failed to fetch <url>",
        "Connection refused from <ip>",
        "Connection refused from <ip>",
        "Connection refused from <ip>",
        "Loopback <ip> and unspecified <ip> are unavailable",
        "Snapshot <date> is stale",
        "Token expired at <date>",
        "Job ran at <int>:<int>:<int> and failed",
        "user <uuid> at <ip> hit <url> with <int> retries (<date>), avg <float>s, <email>",
      ]
    `);
  });

  it("is stable across occurrences of the same message shape", () => {
    const first = parameterizeMessage("User 8f14e45f-ceea-467a-9e33-1c2b3d4e5f60 not found after 3 tries");
    const second = parameterizeMessage("User 11111111-2222-3333-4444-555555555555 not found after 9 tries");
    expect(first).toBe(second);
    expect(first).toMatchInlineSnapshot(`"User <uuid> not found after <int> tries"`);
  });

  it("keeps genuinely different messages different", () => {
    expect(parameterizeMessage("User 1 not found")).not.toBe(parameterizeMessage("Team 1 not found"));
  });

  it("keeps a number attached to a unit suffix from splitting the issue", () => {
    expect([
      parameterizeMessage("Request took 30s"),
      parameterizeMessage("Request took 45s"),
      parameterizeMessage("Request took 1.5s"),
      parameterizeMessage("Encoding utf8 failed for chunk abc1"),
    ]).toMatchInlineSnapshot(`
      [
        "Request took <int>s",
        "Request took <int>s",
        "Request took <float>s",
        "Encoding utf8 failed for chunk abc1",
      ]
    `);
  });

  it("caps the input at 8 KB", () => {
    const long = `${"z".repeat(10_000)} 12345`;
    const result = parameterizeMessage(long);
    expect(result.length).toBe(8 * 1024);
    expect(result.includes("<int>")).toBe(false);
  });

  it("caps the input in UTF-8 bytes, matching the stored message representation", () => {
    const result = parameterizeMessage("é".repeat(10_000));
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(8 * 1024);
  });

  it("leaves a message with nothing variable untouched", () => {
    expect(parameterizeMessage("Cannot read properties of undefined")).toMatchInlineSnapshot(`"Cannot read properties of undefined"`);
  });

  it("is not stateful across calls despite the global regex", () => {
    const message = "id 1 and id 2";
    expect(parameterizeMessage(message)).toBe(parameterizeMessage(message));
  });
});
