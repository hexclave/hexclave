import { phoneNumberRegex } from "../schema-fields";

/**
 * The kinds of sender IDs that SMS providers accept as the "from" of a message. Which ones work depends on the
 * destination country (eg. alphanumeric sender IDs are not supported in the US and Canada, and short codes only work
 * in the country they were provisioned for), which is why providers also offer messaging services/sender pools that
 * pick a suitable sender per message.
 */
export const smsSenderTypes = ["phone_number", "short_code", "alphanumeric", "messaging_service"] as const;
export type SmsSenderType = typeof smsSenderTypes[number];

const smsSenderValueRules = new Map<SmsSenderType, { regex: RegExp, message: string }>([
  ["phone_number", { regex: phoneNumberRegex, message: "Sender phone number must be in E.164 format, eg. +15555550100" }],
  ["short_code", { regex: /^\d{3,8}$/, message: "Short code must be 3 to 8 digits" }],
  // Carriers require at least one letter, as an all-digit sender would be indistinguishable from a phone number
  ["alphanumeric", { regex: /^(?=.*[A-Za-z])[A-Za-z0-9 ]{1,11}$/, message: "Alphanumeric sender ID must be 1 to 11 letters, digits or spaces, with at least one letter" }],
  // Provider-specific ID of a messaging service/sender pool, eg. "MG..." for Twilio
  ["messaging_service", { regex: /^[A-Za-z0-9_-]{1,64}$/, message: "Messaging service ID must be 1 to 64 letters, digits, dashes or underscores" }],
]);

/**
 * Returns an error message if the value is not a valid sender of the given type, or null if it is.
 */
export function getSmsSenderValueError(type: SmsSenderType, value: string): string | null {
  const rule = smsSenderValueRules.get(type);
  if (rule === undefined) {
    throw new Error(`Unknown SMS sender type: ${type}`);
  }
  return rule.regex.test(value) ? null : rule.message;
}

import.meta.vitest?.test("getSmsSenderValueError", ({ expect }) => {
  expect(getSmsSenderValueError("phone_number", "+15555550100")).toBe(null);
  expect(getSmsSenderValueError("phone_number", "5555550100")).not.toBe(null);
  expect(getSmsSenderValueError("short_code", "55123")).toBe(null);
  expect(getSmsSenderValueError("short_code", "12")).not.toBe(null);
  expect(getSmsSenderValueError("short_code", "123456789")).not.toBe(null);
  expect(getSmsSenderValueError("short_code", "+55123")).not.toBe(null);
  expect(getSmsSenderValueError("alphanumeric", "Acme")).toBe(null);
  expect(getSmsSenderValueError("alphanumeric", "Acme Inc 24")).toBe(null);
  expect(getSmsSenderValueError("alphanumeric", "Acme Inc 245")).not.toBe(null);
  expect(getSmsSenderValueError("alphanumeric", "12345")).not.toBe(null);
  expect(getSmsSenderValueError("alphanumeric", "Acme!")).not.toBe(null);
  expect(getSmsSenderValueError("messaging_service", "MG0123456789abcdef0123456789abcdef")).toBe(null);
  expect(getSmsSenderValueError("messaging_service", "")).not.toBe(null);
  expect(getSmsSenderValueError("messaging_service", "has spaces")).not.toBe(null);
});
