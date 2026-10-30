import { ContactChannelsCrud } from "@hexclave/shared/dist/interface/crud/contact-channels";


export type ContactChannel = {
  id: string,
  value: string,
  // Phone contact channels can be created through the REST API (and by SMS sign-in), so they can show up here even
  // though the SDK doesn't have dedicated methods for them yet
  type: 'email' | 'phone',
  isPrimary: boolean,
  isVerified: boolean,
  usedForAuth: boolean,

  /**
   * Sends a verification email. Only available for email contact channels; throws for phone contact channels, which
   * are verified with a code sent via SMS instead.
   */
  sendVerificationEmail(options?: { callbackUrl?: string }): Promise<void>,
  update(data: ContactChannelUpdateOptions): Promise<void>,
  delete(): Promise<void>,
}

/**
 * The email verification endpoint only looks up email contact channels, so calling it for a phone channel would fail
 * with a misleading "contact channel not found" error. Fail early with a clear message instead.
 */
export function assertCanSendVerificationEmail(type: ContactChannel["type"]): void {
  if (type !== "email") {
    throw new Error(`sendVerificationEmail() can only be called on email contact channels, but this contact channel has type "${type}". Phone numbers are verified with a code sent via SMS.`);
  }
}

export type ContactChannelCreateOptions = {
  // For phone numbers, the value must be in E.164 format (eg. "+15555550100")
  value: string,
  type: 'email' | 'phone',
  usedForAuth: boolean,
  isPrimary?: boolean,
}

export function contactChannelCreateOptionsToCrud(userId: string, options: ContactChannelCreateOptions): ContactChannelsCrud["Client"]["Create"] {
  return {
    value: options.value,
    type: options.type,
    used_for_auth: options.usedForAuth,
    is_primary: options.isPrimary,
    user_id: userId,
  };
}

export type ContactChannelUpdateOptions = {
  usedForAuth?: boolean,
  value?: string,
  isPrimary?: boolean,
}

export function contactChannelUpdateOptionsToCrud(options: ContactChannelUpdateOptions): ContactChannelsCrud["Client"]["Update"] {
  return {
    value: options.value,
    used_for_auth: options.usedForAuth,
    is_primary: options.isPrimary,
  };
}

export type ServerContactChannel = ContactChannel & {
  update(data: ServerContactChannelUpdateOptions): Promise<void>,
}
export type ServerContactChannelUpdateOptions = ContactChannelUpdateOptions & {
  isVerified?: boolean,
}

export function serverContactChannelUpdateOptionsToCrud(options: ServerContactChannelUpdateOptions): ContactChannelsCrud["Server"]["Update"] {
  return {
    value: options.value,
    is_verified: options.isVerified,
    used_for_auth: options.usedForAuth,
    is_primary: options.isPrimary,
  };
}

export type ServerContactChannelCreateOptions = ContactChannelCreateOptions & {
  isVerified?: boolean,
}
export function serverContactChannelCreateOptionsToCrud(userId: string, options: ServerContactChannelCreateOptions): ContactChannelsCrud["Server"]["Create"] {
  return {
    type: options.type,
    value: options.value,
    is_verified: options.isVerified,
    user_id: userId,
    used_for_auth: options.usedForAuth,
    is_primary: options.isPrimary,
  };
}

import.meta.vitest?.test("assertCanSendVerificationEmail only allows email contact channels", ({ expect }) => {
  expect(() => assertCanSendVerificationEmail("email")).not.toThrow();
  expect(() => assertCanSendVerificationEmail("phone")).toThrowErrorMatchingInlineSnapshot(`[Error: sendVerificationEmail() can only be called on email contact channels, but this contact channel has type "phone". Phone numbers are verified with a code sent via SMS.]`);
});
