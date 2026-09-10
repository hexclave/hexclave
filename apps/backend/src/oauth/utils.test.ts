import { describe, expect, it } from "vitest";
import { getDiscordAccountCreatedAtMillis, isAppleEmailVerified, parseOAuthAccountCreatedAtMillis } from "./utils";

describe("isAppleEmailVerified", () => {
  it("treats the boolean true as verified", () => {
    expect(isAppleEmailVerified(true)).toBe(true);
  });

  it("treats the string \"true\" as verified", () => {
    expect(isAppleEmailVerified("true")).toBe(true);
  });

  it("treats the boolean false as unverified", () => {
    expect(isAppleEmailVerified(false)).toBe(false);
  });

  // Regression: a naive `!!value` coerces the string "false" to `true`, which
  // would let an unverified Apple email pass the account-merge verification gate.
  it("treats the string \"false\" as unverified", () => {
    expect(isAppleEmailVerified("false")).toBe(false);
  });

  it("treats missing/empty/other values as unverified", () => {
    expect(isAppleEmailVerified(undefined)).toBe(false);
    expect(isAppleEmailVerified(null)).toBe(false);
    expect(isAppleEmailVerified("")).toBe(false);
    expect(isAppleEmailVerified("True")).toBe(false);
    expect(isAppleEmailVerified("1")).toBe(false);
    expect(isAppleEmailVerified(1)).toBe(false);
  });
});

describe("OAuth account creation timestamps", () => {
  it("parses provider ISO timestamps and ignores malformed values", () => {
    expect(parseOAuthAccountCreatedAtMillis("2024-01-02T03:04:05.000Z")).toBe(1704164645000);
    expect(parseOAuthAccountCreatedAtMillis(1704164645000)).toBe(1704164645000);
    expect(parseOAuthAccountCreatedAtMillis("not-a-date")).toBeNull();
    expect(parseOAuthAccountCreatedAtMillis(undefined)).toBeNull();
  });

  it("derives Discord account creation time from a snowflake ID", () => {
    // Example snowflake from Discord's reference documentation.
    expect(getDiscordAccountCreatedAtMillis("175928847299117063")).toBe(1462015105796);
    expect(getDiscordAccountCreatedAtMillis("not-a-snowflake")).toBeNull();
  });
});
