import { describe, expect, it } from "vitest";
import { KnownError, KnownErrors } from "@hexclave/shared";
import { errors as joseErrors } from "jose";
import { getExternalAuthTokenErrorReason, validateAuthorizedParty } from "./external-auth";

describe("Clerk authorized parties", () => {
  it("allows verification to proceed when the optional allowlist is blank", () => {
    expect(() => validateAuthorizedParty({ azp: undefined }, undefined)).not.toThrow();
  });

  // A token without `azp` must fail too: otherwise omitting the claim would bypass the allowlist.
  it.each([
    { azp: "https://unexpected.example.com" },
    { azp: undefined },
  ])("rejects a token whose azp does not match a configured allowlist: %j", (payload) => {
    expect(() => validateAuthorizedParty(payload, ["http://localhost:8115"])).toThrowError(
      expect.objectContaining({
        constructorArgs: ["authorized_party_mismatch"],
      }),
    );
  });
});

describe("external authentication diagnostics", () => {
  it.each([
    "malformed_token",
    "signature_mismatch",
    "expired",
    "issuer_mismatch",
    "audience_mismatch",
    "authorized_party_mismatch",
    "client_id_mismatch",
    "missing_claim",
    "unknown",
  ] as const)("preserves invalid-token reason %s", (reason) => {
    const error = new KnownErrors.InvalidExternalAuthToken(reason);
    expect(error.details).toMatchObject({ reason });
    expect(error.message).toContain(`(${reason})`);
  });

  it.each([
    "provider_disabled",
    "required_setting_missing",
    "invalid_authorized_party",
    "unknown",
  ] as const)("preserves provider-configuration reason %s", (reason) => {
    const error = new KnownErrors.ExternalAuthProviderNotConfigured(reason);
    expect(error.details).toMatchObject({ reason });
    expect(error.message).toContain(`(${reason})`);
  });

  it.each([
    new KnownErrors.InvalidExternalAuthToken("issuer_mismatch"),
    new KnownErrors.ExternalAuthProviderNotConfigured("required_setting_missing"),
  ] as const)("round-trips %s through the wire format", (error) => {
    const parsed = KnownError.fromJson({
      code: error.errorCode,
      message: error.humanReadableMessage,
      details: error.details,
    });
    expect(parsed).toMatchObject({
      errorCode: error.errorCode,
      details: error.details,
    });
  });

  it("falls back to unknown for an unrecognised wire reason", () => {
    const parsed = KnownError.fromJson({
      code: "INVALID_EXTERNAL_AUTH_TOKEN",
      message: "The external authentication token could not be verified.",
      details: { reason: "future_reason" },
    });
    expect(parsed).toMatchObject({
      details: { reason: "unknown" },
    });
  });

  it.each([
    [new joseErrors.JWTExpired("expired", {}, "exp"), "expired"],
    [new joseErrors.JWTClaimValidationFailed("invalid claim", {}, "iss"), "issuer_mismatch"],
    [new joseErrors.JWTClaimValidationFailed("invalid claim", {}, "aud"), "audience_mismatch"],
    [new joseErrors.JWTClaimValidationFailed("invalid claim", {}, "future"), "unknown"],
    [new joseErrors.JWTInvalid(), "malformed_token"],
    [new joseErrors.JWSInvalid(), "malformed_token"],
    [new joseErrors.JOSENotSupported(), "unknown"],
  ] as const)("maps %s to the %s reason", (error, reason) => {
    expect(getExternalAuthTokenErrorReason(error)).toBe(reason);
  });
});
