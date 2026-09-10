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
 * Apple emits the `email_verified` claim as either a boolean or its string
 * representation ("true"/"false"). A naive `!!value` coerces the string "false"
 * into `true`, which would let an UNVERIFIED Apple email satisfy the account-merge
 * verification gate in `handleOAuthEmailMergeStrategy` and silently link into an
 * existing account (account takeover). Treat only a real `true` or the exact
 * string "true" as verified; anything else (including "false") is unverified.
 *
 * Shared between the web provider (`providers/apple.tsx`) and the native sign-in
 * route so the two can never drift apart again.
 */
export function isAppleEmailVerified(value: unknown): boolean {
  return value === true || value === "true";
}
