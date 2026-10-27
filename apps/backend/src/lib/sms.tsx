import { VerificationCodeType } from "@/generated/prisma/client";
import { getSharedEmailConfig } from "@/lib/emails";
import { lowLevelSendEmailDirectWithoutRetries } from "@/lib/emails-low-level";
import { postToSmsWebhook } from "@/lib/ssrf-protection/sms-webhook";
import { Tenancy } from "@/lib/tenancies";
import { PrismaTransaction } from "@/lib/types";
import { globalPrismaClient, retryTransaction } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared";
import { phoneNumberRegex } from "@hexclave/shared/dist/schema-fields";
import { getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { parseJson } from "@hexclave/shared/dist/utils/json";
import { isObjectLike } from "@hexclave/shared/dist/utils/objects";
import { HexclaveAssertionError, StatusError, captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";
import { createHmac } from "node:crypto";

/**
 * The domain that the `test` SMS provider delivers messages to. See `sendSmsWithTestProvider`.
 */
export const TEST_SMS_PROVIDER_EMAIL_DOMAIN = "sms.hexclave.test";

type SmsServerConfig = Tenancy["config"]["sms"]["server"];

export function isSmsProviderConfigured(tenancy: Tenancy): boolean {
  return tenancy.config.sms.server.provider !== undefined;
}

export type SmsPurpose = "sign_in_code" | "phone_number_verification";

export type SendSmsOptions = {
  to: string,
  body: string,
  // Passed on to webhooks, so the receiver can eg. pick a different sender or template per purpose
  purpose: SmsPurpose,
};

/**
 * Sends a text message to the given phone number (in E.164 format) using the SMS provider configured for the tenancy.
 *
 * Unlike emails, SMS are sent synchronously (without an outbox/retry queue), since they are currently only used for
 * short-lived one-time codes, where a delayed delivery is not useful and the user can simply request a new code.
 */
export async function sendSms(tenancy: Tenancy, options: SendSmsOptions): Promise<void> {
  if (!phoneNumberRegex.test(options.to)) {
    throw new HexclaveAssertionError("sendSms was called with a phone number that is not in E.164 format; it should have been validated by the caller", { to: options.to });
  }

  const server = tenancy.config.sms.server;
  switch (server.provider) {
    case undefined: {
      throw new StatusError(StatusError.BadRequest, "No SMS provider is configured for this project. Configure one in the project settings to send SMS.");
    }
    case "twilio": {
      await sendSmsWithTwilio(server, options);
      return;
    }
    case "webhook": {
      await sendSmsWithWebhook(tenancy, server, options);
      return;
    }
    case "test": {
      await sendSmsWithTestProvider(tenancy, options);
      return;
    }
  }
}

// Every SMS costs the project money, so we limit how many codes can be sent to the same phone number. This mostly
// protects against SMS pumping (toll fraud), where attackers trigger many messages to premium-rate numbers they own.
const SMS_CODE_RATE_LIMIT_WINDOW_MS = 1000 * 60 * 60;
const SMS_CODE_RATE_LIMIT_MAX_CODES_PER_WINDOW = 5;

/** Creates a code while holding the quota lock; the callback must only perform transactional database work. */
export async function createRateLimitedSmsCode<T>(
  tenancy: Tenancy,
  type: VerificationCodeType,
  phoneNumber: string,
  createCode: (transaction: PrismaTransaction) => Promise<T>,
): Promise<T> {
  return await retryTransaction(globalPrismaClient, async (tx) => {
    // The lock covers both counting and insertion, including across backend processes. Hash
    // collisions only serialize unrelated recipients; they do not combine their quotas.
    const lockKey = JSON.stringify([tenancy.project.id, tenancy.branchId, type, phoneNumber]);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('sms-code-quota'), hashtext(${lockKey}))`;
    const rows = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS "count"
      FROM "VerificationCode"
      WHERE "projectId" = ${tenancy.project.id}
        AND "branchId" = ${tenancy.branchId}
        AND "type" = ${type}::"VerificationCodeType"
        AND "data" @> ${JSON.stringify({ phone_number: phoneNumber })}::jsonb
        AND "createdAt" > ${new Date(Date.now() - SMS_CODE_RATE_LIMIT_WINDOW_MS)}
    `;
    const count = (rows.length === 1 ? rows[0] : throwErr("COUNT query should always return exactly one row", { rows })).count;
    if (count >= SMS_CODE_RATE_LIMIT_MAX_CODES_PER_WINDOW) {
      throw new StatusError(StatusError.TooManyRequests, "Too many codes were requested for this phone number. Please try again later.");
    }
    return await createCode(tx);
  });
}

// How long we wait for an SMS provider (Twilio or the project's webhook) to accept a message. Also documented to webhook
// receivers in the dashboard ("respond with a 2xx status within 10 seconds").
const SMS_PROVIDER_TIMEOUT_MS = 10_000;

// Twilio error codes that are caused by the recipient phone number rather than the project's configuration. See
// https://www.twilio.com/docs/api/errors
//
// 21408 ("Permission to send an SMS has not been enabled for the region indicated by the 'To' number") is deliberately
// not in this list: it is caused by the geo permissions of the project's Twilio account, not by the recipient, so it
// must surface as a delivery failure rather than telling the user that their phone number is wrong.
const TWILIO_INVALID_RECIPIENT_ERROR_CODES = new Set([
  21211, // Invalid 'To' phone number
  21610, // Attempt to send to unsubscribed recipient
  21612, // The 'To' phone number is not currently reachable via SMS
  21614, // 'To' number is not a valid mobile number
]);

async function sendSmsWithTwilio(server: SmsServerConfig, options: SendSmsOptions): Promise<void> {
  if (server.twilioAccountSid === undefined || server.twilioAuthToken === undefined || server.senderType === undefined || server.senderValue === undefined) {
    throw new HexclaveAssertionError("Twilio SMS config is incomplete despite provider being twilio; the config schema should have rejected this");
  }

  let response;
  try {
    response = await fetch(urlString`https://api.twilio.com/2010-04-01/Accounts/${server.twilioAccountSid}/Messages.json`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${Buffer.from(`${server.twilioAccountSid}:${server.twilioAuthToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: options.to,
        Body: options.body,
        // Phone numbers, short codes and alphanumeric sender IDs all go into `From`; a messaging service instead picks
        // a sender from its pool for each message (eg. the right short code for the destination country)
        ...server.senderType === "messaging_service"
          ? { MessagingServiceSid: server.senderValue }
          : { From: server.senderValue },
      }),
      // SMS are sent synchronously within the user's request, so a stalled connection to Twilio must not hold the
      // request open indefinitely
      signal: AbortSignal.timeout(SMS_PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    // Timeouts, connection errors, DNS failures, ... are transient delivery problems that the user can retry, just
    // like they are for the webhook provider
    captureError("sms-twilio-request-failed", error);
    throw new KnownErrors.SmsDeliveryFailed();
  }

  if (response.ok) {
    return;
  }

  // We never forward Twilio's error message to the caller, as it may contain details about the project's Twilio
  // account; instead, we only distinguish between errors caused by the recipient and everything else. The latter are
  // almost always a misconfiguration of the project's Twilio account, which the project can see in their Twilio
  // console, so we report it to the end user as a generic delivery failure rather than an internal error.
  const parsedResponse = parseJson(await response.text());
  const twilioErrorCode = parsedResponse.status === "ok" && isObjectLike(parsedResponse.data) && !Array.isArray(parsedResponse.data)
    ? parsedResponse.data.code
    : undefined;
  if (typeof twilioErrorCode === "number" && TWILIO_INVALID_RECIPIENT_ERROR_CODES.has(twilioErrorCode)) {
    throw new StatusError(StatusError.BadRequest, "This phone number cannot receive SMS messages. Please check that the phone number is correct.");
  }
  throw new KnownErrors.SmsDeliveryFailed();
}

/**
 * Signs an SMS webhook request body. The signature covers the timestamp too, so receivers can reject replayed
 * requests by checking that the timestamp is recent. Format of the header value: `t=<unix seconds>,v1=<hex HMAC>`,
 * where the HMAC is HMAC-SHA256(secret, `${t}.${body}`).
 */
export function getSmsWebhookSignatureHeader(secret: string, body: string, timestampSeconds: number): string {
  const signature = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

/**
 * The `webhook` provider lets projects use any SMS provider (or other channel): we POST each message to the project's
 * endpoint as JSON, signed with the project's webhook secret, and the endpoint delivers it however it wants.
 *
 * This deliberately doesn't use the Svix-based webhooks: those are asynchronous and retried for hours, but a one-time
 * code that arrives late is useless, and the user needs to know immediately whether sending worked.
 */
async function sendSmsWithWebhook(tenancy: Tenancy, server: SmsServerConfig, options: SendSmsOptions): Promise<void> {
  if (server.webhookUrl === undefined || server.webhookSecret === undefined) {
    throw new HexclaveAssertionError("SMS webhook config is incomplete despite provider being webhook; the config schema should have rejected this");
  }

  const body = JSON.stringify({
    type: "sms.send",
    id: generateUuid(),
    created_at_millis: Date.now(),
    project_id: tenancy.project.id,
    branch_id: tenancy.branchId,
    purpose: options.purpose,
    to: options.to,
    body: options.body,
  });
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Hexclave-Signature": getSmsWebhookSignatureHeader(server.webhookSecret, body, Math.floor(Date.now() / 1000)),
  });

  let response;
  try {
    response = await postToSmsWebhook(server.webhookUrl, { headers, body, signal: AbortSignal.timeout(SMS_PROVIDER_TIMEOUT_MS) });
  } catch (error) {
    // SSRF violations are reported as 400s, so the project can see what's wrong with their URL
    if (error instanceof StatusError) throw error;
    // Anything else (timeouts, connection errors, DNS failures, ...) is a problem with the project's endpoint
    throw new KnownErrors.SmsDeliveryFailed();
  }
  if (response.status < 200 || response.status >= 300) {
    // We never forward the endpoint's response, as it may contain details the end user shouldn't see
    throw new KnownErrors.SmsDeliveryFailed();
  }
}

/**
 * The `test` provider is used for local development and the E2E tests, where we can't send real SMS. Instead of
 * building a separate inbox for SMS, it delivers each message as an email to `<digits of phone number>@sms.hexclave.test`
 * on the shared email server, which in development is Inbucket. That way, developers can read the messages in the
 * Inbucket UI, and the E2E tests can reuse their existing mailbox helpers.
 *
 * It is never available in production, as it would send messages through the shared email server.
 */
async function sendSmsWithTestProvider(tenancy: Tenancy, options: SendSmsOptions): Promise<void> {
  const nodeEnvironment = getNodeEnvironment();
  if (nodeEnvironment !== "development" && nodeEnvironment !== "test") {
    throw new StatusError(StatusError.BadRequest, "The test SMS provider is only available in development and test environments.");
  }

  const result = await lowLevelSendEmailDirectWithoutRetries({
    tenancyId: tenancy.id,
    emailConfig: await getSharedEmailConfig(tenancy.project.display_name),
    to: `${options.to.slice(1)}@${TEST_SMS_PROVIDER_EMAIL_DOMAIN}`,
    subject: `SMS to ${options.to}`,
    text: options.body,
  });
  if (result.status === "error") {
    throw new HexclaveAssertionError("Failed to deliver SMS via the test provider", { error: result.error });
  }
}
