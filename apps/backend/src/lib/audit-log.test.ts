import { describe, expect, it } from "vitest";
import { isAuditLogPathSensitive, sanitizeAuditMetadata } from "./audit-log";

describe("isAuditLogPathSensitive", () => {
  it("keeps config namespaces whose leaf is not a secret", () => {
    expect(isAuditLogPathSensitive("auth.password.allowSignIn")).toBe(false);
    expect(isAuditLogPathSensitive("has_secret_server_key")).toBe(false);
    expect(isAuditLogPathSensitive("refresh_token_id")).toBe(false);
    expect(isAuditLogPathSensitive("api_key_id")).toBe(false);
  });

  it("redacts exact and substring secret leaves", () => {
    expect(isAuditLogPathSensitive("password")).toBe(true);
    expect(isAuditLogPathSensitive("password_hash")).toBe(true);
    expect(isAuditLogPathSensitive("totp_secret_base64")).toBe(true);
    expect(isAuditLogPathSensitive("emails.server.password")).toBe(true);
    expect(isAuditLogPathSensitive("client_metadata.my_api_key")).toBe(true);
    expect(isAuditLogPathSensitive("client_secret")).toBe(true);
  });
});

describe("sanitizeAuditMetadata", () => {
  it("drops secret values but keeps changed_paths names", () => {
    const sanitized = sanitizeAuditMetadata({
      source: "users.create",
      changed_paths: ["password", "display_name", "client_metadata.my_api_key"],
      changes: {
        display_name: { before: null, after: "Ada" },
        password: { before: null, after: "hunter2" },
        "client_metadata.my_api_key": { before: null, after: "sk_live" },
      },
      totp_secret_base64: "ZXhhbXBsZQ==",
    });
    expect(sanitized).toEqual({
      source: "users.create",
      changed_paths: ["password", "display_name", "client_metadata.my_api_key"],
      changes: {
        display_name: { before: null, after: "Ada" },
      },
    });
  });
});
