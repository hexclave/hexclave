import { emailSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import * as yup from 'yup';

const DISCORD_EPOCH_MILLIS = 1_420_070_400_000n;

export type OAuthUserInfo = yup.InferType<typeof OAuthUserInfoSchema>;

const OAuthUserInfoSchema = yupObject({
  accountId: yupString().min(1).defined(),
  displayName: yupString().nullable().default(null),
  email: emailSchema.nullable().default(null),
  profileImageUrl: yupString().nullable().default(null),
  emailVerified: yupBoolean().default(false),
  accountCreatedAtMillis: yupNumber().integer().min(0).nullable().default(null),
});

export function validateUserInfo(
  userInfo: Partial<yup.InferType<typeof OAuthUserInfoSchema>>,
): OAuthUserInfo {
  return OAuthUserInfoSchema.validateSync(userInfo);
}

export function parseOAuthAccountCreatedAtMillis(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

export function getDiscordAccountCreatedAtMillis(accountId: unknown): number | null {
  if (typeof accountId !== "string" || !/^\d+$/.test(accountId)) {
    return null;
  }
  const timestamp = Number((BigInt(accountId) >> 22n) + DISCORD_EPOCH_MILLIS);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

/**
 * Parses an OIDC `email_verified` claim. The spec says it's a boolean, but some
 * IdPs emit its string representation ("true"/"false") instead — Apple does, and
 * so do some providers configured as custom OIDC (eg. AWS Cognito's userinfo
 * endpoint). A naive `!!value` coerces the string "false" into `true`, which
 * would let an UNVERIFIED email satisfy the account-merge verification gate in
 * `handleOAuthEmailMergeStrategy` and silently link into an existing account
 * (account takeover). Treat only a real `true` or the exact string "true" as
 * verified; anything else (including "false") is unverified.
 *
 * Use this for every provider that reads a raw `email_verified` claim (Apple web,
 * Apple native, custom OIDC) so they can never drift apart again.
 */
export function parseEmailVerifiedClaim(value: unknown): boolean {
  return value === true || value === "true";
}
