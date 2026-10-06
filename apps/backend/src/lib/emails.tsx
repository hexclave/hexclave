import { globalPrismaClient } from '@/prisma-client';
import { runAsynchronouslyAndWaitUntil } from '@/utils/background-tasks';
import { EmailOutboxCreatedWith, type Prisma } from '@/generated/prisma/client';
import { DEFAULT_EMAIL_THEMES, DEFAULT_TEMPLATE_IDS } from '@hexclave/shared/dist/helpers/emails';
import { UsersCrud } from '@hexclave/shared/dist/interface/crud/users';
import { getEnvBoolean, getEnvVariable } from '@hexclave/shared/dist/utils/env';
import { HexclaveAssertionError } from '@hexclave/shared/dist/utils/errors';
import { Json } from '@hexclave/shared/dist/utils/json';
import { runEmailQueueStep, serializeRecipient } from './email-queue-step';
import { LowLevelEmailConfig, isSecureEmailPort } from './emails-low-level';
import { Tenancy } from './tenancies';
import { createHash } from 'node:crypto';


/**
 * Describes where an email should be delivered. Each outbox entry targets exactly one recipient entity.
 *
 * user-primary-email: the email is being sent to the primary email address of a user (determined at the time of sending, NOT the time of creation/rendering). if the user unsubscribes, they will not receive the email.
 * user-custom-emails: the email is being sent to a list of custom emails, but if the user unsubscribes, they will no longer receive the email.
 * custom-emails: the email is being sent to a list of custom emails. there is no associated user object and the recipient cannot unsubscribe. cannot be used to send non-transactional emails.
 */
export type EmailOutboxRecipient =
  | { type: "user-primary-email", userId: string }
  | { type: "user-custom-emails", userId: string, emails: string[] }
  | { type: "custom-emails", emails: string[] };

function getDefaultEmailTemplate(tenancy: Tenancy, type: keyof typeof DEFAULT_TEMPLATE_IDS) {
  const templateList = new Map(Object.entries(tenancy.config.emails.templates));
  const defaultTemplateIdsMap = new Map(Object.entries(DEFAULT_TEMPLATE_IDS));
  const defaultTemplateId = defaultTemplateIdsMap.get(type);
  if (defaultTemplateId) {
    const template = templateList.get(defaultTemplateId);
    if (!template) {
      throw new HexclaveAssertionError(`Default email template not found: ${type}`);
    }
    return template;
  }
  throw new HexclaveAssertionError(`Unknown email template type: ${type}`);
}

export async function sendEmailToMany(options: {
  tenancy: Tenancy,
  recipients: EmailOutboxRecipient[],
  tsxSource: string,
  extraVariables: Record<string, Json>,
  themeId: string | null,
  isHighPriority: boolean,
  shouldSkipDeliverabilityCheck: boolean,
  scheduledAt: Date,
  createdWith: { type: "draft", draftId: string } | { type: "programmatic-call", templateId: string | null },
  overrideSubject?: string,
  overrideNotificationCategoryId?: string,
  idempotencyKey?: string,
}) {
  if (options.idempotencyKey !== undefined && (options.idempotencyKey.length === 0 || options.idempotencyKey.length > 256)) {
    throw new HexclaveAssertionError("Email idempotency keys must contain 1-256 characters");
  }
  await globalPrismaClient.emailOutbox.createMany({
    data: options.recipients.map((recipient) => {
      const serializedRecipient = serializeRecipient(recipient)!;
      const row: Prisma.EmailOutboxCreateManyInput = {
        tenancyId: options.tenancy.id,
        tsxSource: options.tsxSource,
        themeId: options.themeId,
        isHighPriority: options.isHighPriority,
        createdWith: options.createdWith.type === "draft" ? EmailOutboxCreatedWith.DRAFT : EmailOutboxCreatedWith.PROGRAMMATIC_CALL,
        emailDraftId: options.createdWith.type === "draft" ? options.createdWith.draftId : undefined,
        emailProgrammaticCallTemplateId: options.createdWith.type === "programmatic-call" ? options.createdWith.templateId : undefined,
        to: serializedRecipient,
        extraRenderVariables: options.extraVariables,
        scheduledAt: options.scheduledAt,
        shouldSkipDeliverabilityCheck: options.shouldSkipDeliverabilityCheck,
        overrideSubject: options.overrideSubject,
        overrideNotificationCategoryId: options.overrideNotificationCategoryId,
      };
      if (options.idempotencyKey !== undefined) {
        row.id = emailOutboxIdForIdempotencyKey(options.tenancy.id, options.idempotencyKey, JSON.stringify(serializedRecipient));
      }
      return row;
    }),
    skipDuplicates: options.idempotencyKey !== undefined,
  });

  if (!getEnvBoolean("STACK_EMAIL_BRANCHING_DISABLE_QUEUE_AUTO_TRIGGER")) {
    // The cron job should run runEmailQueueStep() to process the emails, but we call it here again for those self-hosters
    // who didn't set up the cron job correctly, and also just in case something happens to the cron job.
    runAsynchronouslyAndWaitUntil(runEmailQueueStep());
  }
}

export function emailOutboxIdForIdempotencyKey(tenancyId: string, idempotencyKey: string, recipientKey: string): string {
  const digest = createHash("sha256")
    .update(tenancyId)
    .update("\0")
    .update(idempotencyKey)
    .update("\0")
    .update(recipientKey)
    .digest();
  // RFC 4122 variant + v5 bits make the deterministic digest a valid UUID for
  // the existing EmailOutbox primary key. SHA-256 retains substantially more
  // collision resistance than the 122 UUID payload bits can represent.
  digest[6] = digest[6] & 0x0f | 0x50;
  digest[8] = digest[8] & 0x3f | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function sendEmailFromDefaultTemplate(options: {
  tenancy: Tenancy,
  user: UsersCrud["Admin"]["Read"] | null,
  email: string,
  templateType: keyof typeof DEFAULT_TEMPLATE_IDS,
  extraVariables: Record<string, Json>,
  shouldSkipDeliverabilityCheck: boolean,
}) {
  const template = getDefaultEmailTemplate(options.tenancy, options.templateType);

  await sendEmailToMany({
    tenancy: options.tenancy,
    recipients: [options.user ? { type: "user-custom-emails", userId: options.user.id, emails: [options.email] } : { type: "custom-emails", emails: [options.email] }],
    tsxSource: template.tsxSource,
    extraVariables: options.extraVariables,
    themeId: template.themeId === false ? null : (template.themeId ?? options.tenancy.config.emails.selectedThemeId),
    createdWith: { type: "programmatic-call", templateId: DEFAULT_TEMPLATE_IDS[options.templateType] },
    isHighPriority: true,  // always make emails sent via default template high priority
    shouldSkipDeliverabilityCheck: options.shouldSkipDeliverabilityCheck,
    scheduledAt: new Date(),
  });
}

const DEFAULT_TEMPLATE_ID_SET: ReadonlySet<string> = new Set(Object.values(DEFAULT_TEMPLATE_IDS));
const DEFAULT_EMAIL_THEME_ID_SET: ReadonlySet<string> = new Set(Object.keys(DEFAULT_EMAIL_THEMES));

/** Whether an email was rendered with a project-defined custom (non-default) theme. */
function isCustomEmailTheme(themeId: string | null | undefined): boolean {
  return themeId !== null && themeId !== undefined && !DEFAULT_EMAIL_THEME_ID_SET.has(themeId);
}

/** Whether an outbox email is project-defined custom content that should get the shared-server dev wrapper. */
export function isCustomEmailForSharedServer(recipient: EmailOutboxRecipient, createdWith: EmailOutboxCreatedWith, programmaticCallTemplateId: string | null, themeId: string | null | undefined): boolean {
  // A custom (non-default) theme makes even a default/system email (verification, password reset, ...) look
  // like the project's own production email, so it should carry the dev notice regardless of recipient or
  // template. Hexclave's own internal notifications always send with themeId === null, so they stay exempt.
  if (isCustomEmailTheme(themeId)) {
    return true;
  }
  // Hexclave's own system notifications (credential-scanning alerts, internal feedback) send raw HTML to bare
  // "custom-emails" addresses and must go out verbatim; the send-email API always targets the project's users.
  if (recipient.type === "custom-emails") {
    return false;
  }
  if (createdWith === EmailOutboxCreatedWith.DRAFT) {
    return true;
  }
  return programmaticCallTemplateId === null || !DEFAULT_TEMPLATE_ID_SET.has(programmaticCallTemplateId);
}

export function wrapSharedDevEmail(content: { subject: string, html?: string, text?: string }): { subject: string, html?: string, text?: string } {
  const wrappedSubject = `[Hexclave dev email] ${content.subject}`;

  const noticeHtml = `<div style="margin:0 0 16px 0;padding:12px 16px;border:1px solid #f0c000;border-radius:8px;background:#fff8e1;color:#5b4a00;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;">`
    + `<strong>This is a development email from an app built on Hexclave.</strong><br />`
    + `The app hasn't configured its own email server yet, so it was sent through Hexclave's shared development email server. If this is your app, set up a custom email server in your Hexclave dashboard to send emails from your own domain. If you don't recognize this app, you can ignore this email.`
    + `</div>`;

  const noticeText = `[Development email from an app built on Hexclave]\n`
    + `The app hasn't configured its own email server yet, so it was sent through Hexclave's shared development email server. If this is your app, set up a custom email server in your Hexclave dashboard to send emails from your own domain. If you don't recognize this app, you can ignore this email.\n\n`;

  return {
    subject: wrappedSubject,
    html: content.html === undefined ? undefined : injectDevNoticeIntoHtml(content.html, noticeHtml),
    text: content.text === undefined ? undefined : noticeText + content.text,
  };
}

// Insert the notice just inside <body> so it stays valid markup for full HTML documents; fall back to prepending for fragments.
function injectDevNoticeIntoHtml(html: string, noticeHtml: string): string {
  const bodyOpenTag = /<body[^>]*>/i;
  if (bodyOpenTag.test(html)) {
    return html.replace(bodyOpenTag, (match) => match + noticeHtml);
  }
  return noticeHtml + html;
}

export async function getEmailConfig(tenancy: Tenancy): Promise<LowLevelEmailConfig> {
  const projectEmailConfig = tenancy.config.emails.server;

  if (projectEmailConfig.isShared) {
    return await getSharedEmailConfig(tenancy.project.display_name);
  } else {
    if (projectEmailConfig.provider === "managed") {
      if (!projectEmailConfig.password || !projectEmailConfig.managedSubdomain || !projectEmailConfig.managedSenderLocalPart) {
        throw new HexclaveAssertionError("Managed email config is incomplete despite provider being managed", {
          projectId: tenancy.id,
          emailConfig: projectEmailConfig,
        });
      }
      return {
        host: "smtp.resend.com",
        port: 465,
        username: "resend",
        password: projectEmailConfig.password,
        senderEmail: `${projectEmailConfig.managedSenderLocalPart}@${projectEmailConfig.managedSubdomain}`,
        senderName: tenancy.project.display_name,
        secure: true,
        type: "managed",
      };
    }

    if (!projectEmailConfig.host || !projectEmailConfig.port || !projectEmailConfig.username || !projectEmailConfig.password || !projectEmailConfig.senderEmail || !projectEmailConfig.senderName) {
      throw new HexclaveAssertionError("Email config is not complete despite not being shared. This should never happen?", { projectId: tenancy.id, emailConfig: projectEmailConfig });
    }
    return {
      host: projectEmailConfig.host,
      port: projectEmailConfig.port,
      username: projectEmailConfig.username,
      password: projectEmailConfig.password,
      senderEmail: projectEmailConfig.senderEmail,
      senderName: projectEmailConfig.senderName,
      secure: isSecureEmailPort(projectEmailConfig.port),
      type: 'standard',
    };
  }
}


export async function getSharedEmailConfig(displayName: string): Promise<LowLevelEmailConfig> {
  return {
    host: getEnvVariable('STACK_EMAIL_HOST'),
    port: parseInt(getEnvVariable('STACK_EMAIL_PORT')),
    username: getEnvVariable('STACK_EMAIL_USERNAME'),
    password: getEnvVariable('STACK_EMAIL_PASSWORD'),
    senderEmail: getEnvVariable('STACK_EMAIL_SENDER'),
    senderName: displayName,
    secure: isSecureEmailPort(getEnvVariable('STACK_EMAIL_PORT')),
    type: 'shared',
  };
}

export function normalizeEmail(email: string): string {
  if (typeof email !== 'string') {
    throw new TypeError('normalize-email expects a string');
  }


  const emailLower = email.trim().toLowerCase();
  const emailParts = emailLower.split(/@/);

  if (emailParts.length !== 2) {
    throw new HexclaveAssertionError('Invalid email address', { email });
  }

  let [username, domain] = emailParts;

  return `${username}@${domain}`;
}

import.meta.vitest?.test('normalizeEmail(...)', async ({ expect }) => {
  expect(normalizeEmail('Example.Test@gmail.com')).toBe('example.test@gmail.com');
  expect(normalizeEmail('Example.Test+123@gmail.com')).toBe('example.test+123@gmail.com');
  expect(normalizeEmail('exampletest@gmail.com')).toBe('exampletest@gmail.com');
  expect(normalizeEmail('EXAMPLETEST@gmail.com')).toBe('exampletest@gmail.com');

  expect(normalizeEmail('user@example.com')).toBe('user@example.com');
  expect(normalizeEmail('user.name+tag@example.com')).toBe('user.name+tag@example.com');

  expect(() => normalizeEmail('test@multiple@domains.com')).toThrow();
  expect(() => normalizeEmail('invalid.email')).toThrow();
});
