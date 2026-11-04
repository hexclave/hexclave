/**
 *
 * Low-level email sending functions that bypass the email outbox queue and send directly via SMTP or email service
 * providers. You probably shouldn't use this and should instead use the functions in emails.tsx.
 */

import { HexclaveAssertionError, captureError } from '@hexclave/shared/dist/utils/errors';
import { omit, pick } from '@hexclave/shared/dist/utils/objects';
import { runAsynchronously, wait } from '@hexclave/shared/dist/utils/promises';
import { Result } from '@hexclave/shared/dist/utils/results';
import { traceSpan } from '@hexclave/shared/dist/utils/telemetry';
import nodemailer from 'nodemailer';
import { checkSmtpEgressPolicy, shouldEnforceSmtpEgressPolicy } from '@/lib/ssrf-protection/smtp';

export function isSecureEmailPort(port: number | string) {
  // "secure" in most SMTP clients means implicit TLS from byte 1 (SMTPS)
  // STARTTLS ports (25/587/2587) should return false.
  let parsedPort = parseInt(port.toString());
  return parsedPort === 465 || parsedPort === 2465;
}

function is4yzSMTPResponseCode(code: number | undefined) {
  if (typeof code !== 'number') {
    return false;
  }
  return code >= 400 && code < 500;
}

/**
 * 5yz SMTP replies are permanent negative completions (RFC 5321 §4.2.1): the server refused this message for good,
 * so retrying won't help. Providers use them for problems in the sender's own setup, e.g. Resend replies 550 with
 * "The <domain> domain is not verified", "API key is invalid", or "Please use our testing email address instead of
 * domains like `example.com`". These are the email server's answer, not a Hexclave bug, so we pass the server's
 * response on to the developer instead of reporting an unknown error.
 */
function getPermanentSMTPRejectionErrorType(responseCode: number | undefined, message: string): 'AUTH_FAILED' | 'REJECTED' | null {
  if (typeof responseCode !== 'number' || responseCode < 500 || responseCode >= 600) {
    return null;
  }
  if (/api key is invalid|invalid api key|authentication (failed|required)/i.test(message)) {
    return 'AUTH_FAILED';
  }
  return 'REJECTED';
}

import.meta.vitest?.test("getPermanentSMTPRejectionErrorType classifies 5yz replies", ({ expect }) => {
  expect(getPermanentSMTPRejectionErrorType(550, "Message failed: 550 Invalid `to` field. Please use our testing email address instead of domains like `example.com`.")).toBe('REJECTED');
  expect(getPermanentSMTPRejectionErrorType(550, "Message failed: 550 The foo.example.org domain is not verified. Please, add and verify your domain on https://resend.com/domains")).toBe('REJECTED');
  expect(getPermanentSMTPRejectionErrorType(550, "Message failed: 550 API key is invalid")).toBe('AUTH_FAILED');
  expect(getPermanentSMTPRejectionErrorType(552, "552 Message size exceeds fixed maximum message size")).toBe('REJECTED');
  expect(getPermanentSMTPRejectionErrorType(451, "451 Temporary local problem")).toBe(null);
  expect(getPermanentSMTPRejectionErrorType(undefined, "Something else")).toBe(null);
});

export type LowLevelEmailConfig = {
  host: string,
  port: number,
  username: string,
  password: string,
  senderEmail: string,
  senderName: string,
  secure: boolean,
  // 'shared': Hexclave's shared email server. 'managed': a custom domain we provision & send through on the user's
  // behalf (Resend under our account). 'standard': the user's own SMTP server or Resend API key. We run the Emailable
  // deliverability check for 'shared' and 'managed' (where bad recipients hurt our own sending reputation), but not
  // for 'standard' (the user owns their own deliverability there).
  type: 'shared' | 'managed' | 'standard',
}

export type LowLevelSendEmailOptions = {
  tenancyId: string,
  emailConfig: LowLevelEmailConfig,
  to: string | string[],
  subject: string,
  html?: string,
  text?: string,
}

async function _lowLevelSendEmailWithoutRetries(options: LowLevelSendEmailOptions): Promise<Result<undefined, {
  rawError: any,
  errorType: string,
  canRetry: boolean,
  message?: string,
}>> {
  let finished = false;
  const strippedEmailConfig = options.emailConfig.type === 'shared' ? "shared" : pick(options.emailConfig, ['host', 'port', 'username', 'senderEmail', 'senderName']);
  runAsynchronously(async () => {
    await wait(15_000);
    if (!finished) {
      captureError("email-send-timeout", new HexclaveAssertionError("Email send took longer than 15s; maybe the email service is too slow?", {
        config: strippedEmailConfig,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      }));
    }
  });
  try {
    const toArray = typeof options.to === 'string' ? [options.to] : options.to;

    if (toArray.length === 0) {
      // no valid emails, so we can just return ok
      // (we skip silently because this is not an error)
      return Result.ok(undefined);
    }

    return await traceSpan('sending email to ' + JSON.stringify(toArray), async () => {
      try {
        // Only tenant-provided ("standard") SMTP configs are attacker-controlled, so the egress policy
        // only applies to those. "shared" (operator/Hexclave server) and "managed" (Resend) are trusted
        // — enforcing the policy on them would needlessly break e.g. local dev (Inbucket on 127.0.0.1).
        let connectHost = options.emailConfig.host;
        let connectServername: string | undefined = undefined;
        if (options.emailConfig.type === 'standard' && shouldEnforceSmtpEgressPolicy()) {
          const smtpEgressPolicyResult = await checkSmtpEgressPolicy({
            host: options.emailConfig.host,
            port: options.emailConfig.port,
          });
          if (smtpEgressPolicyResult.status === "error") {
            captureError("smtp-egress-policy-rejected", new HexclaveAssertionError("SMTP config was rejected by the egress policy", {
              violation: smtpEgressPolicyResult.violation,
              config: strippedEmailConfig,
            }));
            return Result.error({
              rawError: smtpEgressPolicyResult.violation,
              errorType: 'EGRESS_POLICY_REJECTED',
              canRetry: false,
              message: 'The email server host or port is not allowed. Please use a public SMTP server on a standard SMTP port.',
            } as const);
          }
          // Pin the connection to a validated address so nodemailer can't re-resolve the hostname to an
          // internal IP after our check (DNS rebinding); keep the hostname as the TLS SNI/cert name.
          connectHost = smtpEgressPolicyResult.connectHost;
          connectServername = smtpEgressPolicyResult.servername ?? undefined;
        }

        const transporter = nodemailer.createTransport({
          host: connectHost,
          port: options.emailConfig.port,
          secure: options.emailConfig.secure,
          ...(connectServername != null ? { servername: connectServername } : {}),
          disableFileAccess: true,
          disableUrlAccess: true,
          connectionTimeout: 15000,
          greetingTimeout: 10000,
          socketTimeout: 20000,
          dnsTimeout: 7000,
          auth: {
            user: options.emailConfig.username,
            pass: options.emailConfig.password,
          },
        });

        try {
          await transporter.sendMail({
            from: `"${options.emailConfig.senderName}" <${options.emailConfig.senderEmail}>`,
            ...options,
            to: toArray,
          });
        } finally {
          transporter.close();
        }

        return Result.ok(undefined);
      } catch (error) {
        if (error instanceof Error) {
          const code = (error as any).code as string | undefined;
          const responseCode = (error as any).responseCode as number | undefined;
          const errorNumber = (error as any).errno as number | undefined;

          const getServerResponse = (error: any) => {
            if (error?.response) {
              return `\nResponse from the email server:\n${error.response}`;
            }
            return '';
          };

          if (errorNumber === -3008 || code === 'EDNS') {
            return Result.error({
              rawError: error,
              errorType: 'HOST_NOT_FOUND',
              canRetry: false,
              message: 'Failed to connect to the email host. Please make sure the email host configuration is correct.'
            } as const);
          }

          // nodemailer surfaces a refused connection as code 'ESOCKET' with 'ECONNREFUSED' in the message.
          // Safe to retry: the connection was refused before any SMTP exchange, so the message was never
          // handed off — there's no duplicate-delivery risk, and a transient refusal (server restarting /
          // overloaded) can recover. A persistent misconfig still fails after MAX_SEND_ATTEMPTS.
          if (code === 'ECONNREFUSED' || error.message.includes('ECONNREFUSED')) {
            return Result.error({
              rawError: error,
              errorType: 'CONNECTION_REFUSED',
              canRetry: true,
              message: 'The email server refused the connection. Please make sure the email host and port configuration are correct.',
            } as const);
          }

          if (responseCode === 535 || code === 'EAUTH') {
            return Result.error({
              rawError: error,
              errorType: 'AUTH_FAILED',
              canRetry: false,
              message: 'Failed to authenticate with the email server. Please check your email credentials configuration.',
            } as const);
          }

          if (responseCode === 450) {
            return Result.error({
              rawError: error,
              errorType: 'TEMPORARY',
              canRetry: true,
              message: 'The email server returned a temporary error. This could be due to a temporary network issue or a temporary block on the email server. Please try again later.\n\nError: ' + getServerResponse(error),
            } as const);
          }

          if (responseCode === 553) {
            return Result.error({
              rawError: error,
              errorType: 'INVALID_EMAIL_ADDRESS',
              canRetry: false,
              message: 'The email address provided is invalid. Please verify both the recipient and sender email addresses configuration are correct.\n\nError:' + getServerResponse(error),
            } as const);
          }

          if (responseCode === 554 || code === 'EENVELOPE') {
            return Result.error({
              rawError: error,
              errorType: 'REJECTED',
              canRetry: false,
              message: 'The email server rejected the email. Please check your email configuration and try again later.\n\nError:' + getServerResponse(error),
            } as const);
          }

          if (code === 'ETIMEDOUT') {
            return Result.error({
              rawError: error,
              errorType: 'TIMEOUT',
              canRetry: true,
              message: 'The email server timed out while sending the email. This could be due to a temporary network issue or a temporary block on the email server. Please try again later.',
            } as const);
          }

          if (error.message.includes('Unexpected socket close')) {
            return Result.error({
              rawError: error,
              errorType: 'SOCKET_CLOSED',
              canRetry: false,
              message: 'Connection to email server was lost unexpectedly. This could be due to incorrect email server port configuration or a temporary network issue. Please verify your configuration and try again.',
            } as const);
          }
          // Any other 5yz reply is a permanent rejection by the email server (e.g. Resend's 550 for an unverified
          // sender domain, an invalid API key, or a test-domain recipient), so don't retry and don't report it as unknown
          const permanentRejectionErrorType = getPermanentSMTPRejectionErrorType(responseCode, error.message);
          if (permanentRejectionErrorType === 'AUTH_FAILED') {
            return Result.error({
              rawError: error,
              errorType: 'AUTH_FAILED',
              canRetry: false,
              message: 'Failed to authenticate with the email server. Please check your email credentials configuration.' + getServerResponse(error),
            } as const);
          }
          if (permanentRejectionErrorType === 'REJECTED') {
            return Result.error({
              rawError: error,
              errorType: 'REJECTED',
              canRetry: false,
              message: 'The email server permanently rejected the email. Please check your email server configuration (such as a verified sender domain and valid credentials) and the recipient address.' + getServerResponse(error),
            } as const);
          }

          // 4yz error codes are considered temporary errors in SMTP, so they should be retried anyway
          // This is fallback logic for a code we don't explicitly capture but should still be retryable and we have the code
          if (is4yzSMTPResponseCode(responseCode)) {
            return Result.error({
              rawError: error,
              errorType: 'TRANSIENT_NEGATIVE_COMPLETION_REPLY',
              canRetry: true,
              message: 'The email server returned a temporary error. Please try again later.' + getServerResponse(error),
            } as const);
          }
        }

        // ============ temporary error ============
        const temporaryErrorIndicators = [
          "450 ",
          "Client network socket disconnected before secure TLS connection was established",
          "Too many requests",
          ...options.emailConfig.host.includes("resend") ? [
            // Resend is a bit unreliable, so we'll retry even in some cases where it may send duplicate emails
            "ECONNRESET",
          ] : [],
        ];
        if (temporaryErrorIndicators.some(indicator => error instanceof Error && error.message.includes(indicator))) {
          // this can happen occasionally (especially with certain unreliable email providers)
          // so let's retry
          return Result.error({
            rawError: error,
            errorType: 'UNKNOWN',
            canRetry: true,
            message: 'Failed to send email, but error is possibly transient due to the internet connection. Please check your email configuration and try again later.',
          } as const);
        }

        // ============ unknown error ============
        captureError("unknown-email-send-error", new HexclaveAssertionError("Unknown error while sending email. We should add a better error description for the user.", { strippedEmailConfig, cause: error }));
        return Result.error({
          rawError: error,
          errorType: 'UNKNOWN',
          canRetry: false,
          message: 'An unknown error occurred while sending the email.',
        } as const);
      }
    });
  } finally {
    finished = true;
  }
}

export async function lowLevelSendEmailDirectWithoutRetries(options: LowLevelSendEmailOptions): Promise<Result<undefined, {
  rawError: any,
  errorType: string,
  canRetry: boolean,
  message?: string,
}>> {
  if (!options.to) {
    throw new HexclaveAssertionError("No recipient email address provided to sendEmail", omit(options, ['emailConfig']));
  }

  const result = await _lowLevelSendEmailWithoutRetries(options);

  if (result.status === 'error') {
    console.warn("Failed to send email.", {
      host: options.emailConfig.host,
      from: options.emailConfig.senderEmail,
      to: options.to,
      subject: options.subject,
      error: result.error,
    }, result.error.rawError);
  }

  return result;
}
