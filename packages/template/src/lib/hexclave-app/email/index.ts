import type { Json } from "@hexclave/shared/dist/utils/json";
import { XOR } from "@hexclave/shared/dist/utils/types";

export type AdminSentEmail = {
  id: string,
  to: string[],
  subject: string,
  recipient: string, // We'll derive this from to[0] for display
  sentAt: Date, // We'll derive this from sent_at_millis for display
  error?: unknown,
}

export type AdminEmailOutboxRecipient =
  | { type: "user-primary-email", userId: string }
  | { type: "user-custom-emails", userId: string, emails: string[] }
  | { type: "custom-emails", emails: string[] };

export type AdminEmailOutboxStatus =
  | "paused"
  | "preparing"
  | "rendering"
  | "render-error"
  | "scheduled"
  | "queued"
  | "sending"
  | "server-error"
  | "skipped"
  | "bounced"
  | "delivery-delayed"
  | "sent"
  | "opened"
  | "clicked"
  | "marked-as-spam";

export type AdminEmailOutboxSimpleStatus =
  | "in-progress"
  | "ok"
  | "error";

export type AdminEmailOutboxCreatedWith = "draft" | "programmatic-call";

// Error entry from a failed send attempt
export type AdminSendAttemptError = {
  attemptNumber: number,
  timestamp: string,
  externalMessage: string,
  externalDetails: Record<string, Json>,
  internalMessage: string,
  internalDetails: Record<string, Json>,
};

// =============================== BASE TYPES ===============================

// Base fields present on all emails
type AdminEmailOutboxBase = {
  id: string,
  createdAt: Date,
  updatedAt: Date,
  tsxSource: string,
  themeId: string | null,
  to: AdminEmailOutboxRecipient,
  scheduledAt: Date,
  // Source tracking for grouping emails by template/draft
  createdWith: AdminEmailOutboxCreatedWith,
  emailDraftId: string | null,
  emailProgrammaticCallTemplateId: string | null,
  variables: Record<string, Json>,
  isPaused: false,
  hasRendered: false,
  hasDelivered: false,
  // Retry tracking fields
  sendRetries: number,
  nextSendRetryAt: Date | null,
  sendAttemptErrors: AdminSendAttemptError[] | null,
};

// Fields available after rendering completes successfully
// Use Omit to properly override hasRendered from base
type AdminEmailOutboxRenderedFields = Omit<AdminEmailOutboxBase, "hasRendered"> & {
  hasRendered: true,
  startedRenderingAt: Date,
  renderedAt: Date,
  subject: string,
  html: string | null,
  text: string | null,
  isTransactional: boolean,
  isHighPriority: boolean,
  notificationCategoryId: string | null,
};

// Fields available after sending starts
type AdminEmailOutboxStartedSendingFields = AdminEmailOutboxRenderedFields & {
  startedSendingAt: Date,
};

// Fields available after delivery completes
// Use Omit to properly override hasDelivered from base (inherited through chain)
type AdminEmailOutboxFinishedDeliveringFields = Omit<AdminEmailOutboxStartedSendingFields, "hasDelivered"> & {
  hasDelivered: true,
  deliveredAt: Date,
};

// =============================== STATUS-SPECIFIC TYPES ===============================

// Use Omit to properly override isPaused from base
export type AdminEmailOutboxPaused = Omit<AdminEmailOutboxBase, "isPaused"> & {
  status: "paused",
  simpleStatus: "in-progress",
  isPaused: true,
};

export type AdminEmailOutboxPreparing = AdminEmailOutboxBase & {
  status: "preparing",
  simpleStatus: "in-progress",
};

export type AdminEmailOutboxRendering = AdminEmailOutboxBase & {
  status: "rendering",
  simpleStatus: "in-progress",
  startedRenderingAt: Date,
};

export type AdminEmailOutboxRenderError = AdminEmailOutboxBase & {
  status: "render-error",
  simpleStatus: "error",
  startedRenderingAt: Date,
  renderedAt: Date,
  renderError: string,
};

export type AdminEmailOutboxScheduled = AdminEmailOutboxRenderedFields & {
  status: "scheduled",
  simpleStatus: "in-progress",
};

export type AdminEmailOutboxQueued = AdminEmailOutboxRenderedFields & {
  status: "queued",
  simpleStatus: "in-progress",
};

export type AdminEmailOutboxSending = AdminEmailOutboxStartedSendingFields & {
  status: "sending",
  simpleStatus: "in-progress",
};

export type AdminEmailOutboxServerError = AdminEmailOutboxStartedSendingFields & {
  status: "server-error",
  simpleStatus: "error",
  errorAt: Date,
  serverError: string,
};

// SKIPPED can happen at any time, so rendering/sending fields are optional
// Use Omit to properly override hasRendered from base (can be true or false when skipped)
export type AdminEmailOutboxSkipped = Omit<AdminEmailOutboxBase, "hasRendered"> & {
  status: "skipped",
  simpleStatus: "ok",
  hasRendered: boolean,
  skippedAt: Date,
  skippedReason: string,
  skippedDetails: Record<string, Json>,
  // Optional fields depending on when skipped
  startedRenderingAt?: Date,
  renderedAt?: Date,
  subject?: string,
  html?: string | null,
  text?: string | null,
  isTransactional?: boolean,
  isHighPriority?: boolean,
  notificationCategoryId?: string | null,
  startedSendingAt?: Date,
};

export type AdminEmailOutboxBounced = AdminEmailOutboxStartedSendingFields & {
  status: "bounced",
  simpleStatus: "error",
  bouncedAt: Date,
};

export type AdminEmailOutboxDeliveryDelayed = AdminEmailOutboxStartedSendingFields & {
  status: "delivery-delayed",
  simpleStatus: "ok",
  deliveryDelayedAt: Date,
};

export type AdminEmailOutboxSent = AdminEmailOutboxFinishedDeliveringFields & {
  status: "sent",
  simpleStatus: "ok",
  canHaveDeliveryInfo: boolean,
};

export type AdminEmailOutboxOpened = AdminEmailOutboxFinishedDeliveringFields & {
  status: "opened",
  simpleStatus: "ok",
  openedAt: Date,
  canHaveDeliveryInfo: true,
};

export type AdminEmailOutboxClicked = AdminEmailOutboxFinishedDeliveringFields & {
  status: "clicked",
  simpleStatus: "ok",
  clickedAt: Date,
  canHaveDeliveryInfo: true,
};

export type AdminEmailOutboxMarkedAsSpam = AdminEmailOutboxFinishedDeliveringFields & {
  status: "marked-as-spam",
  simpleStatus: "ok",
  markedAsSpamAt: Date,
  canHaveDeliveryInfo: true,
};

// =============================== DISCRIMINATED UNION ===============================

export type AdminEmailOutbox =
  | AdminEmailOutboxPaused
  | AdminEmailOutboxPreparing
  | AdminEmailOutboxRendering
  | AdminEmailOutboxRenderError
  | AdminEmailOutboxScheduled
  | AdminEmailOutboxQueued
  | AdminEmailOutboxSending
  | AdminEmailOutboxServerError
  | AdminEmailOutboxSkipped
  | AdminEmailOutboxBounced
  | AdminEmailOutboxDeliveryDelayed
  | AdminEmailOutboxSent
  | AdminEmailOutboxOpened
  | AdminEmailOutboxClicked
  | AdminEmailOutboxMarkedAsSpam;

type SendEmailOptionsBase = {
  themeId?: string | null | false,
  subject?: string,
  notificationCategoryName?: string,
  scheduledAt?: Date,
  variables?: Record<string, unknown>,
}


export type SendEmailOptions = SendEmailOptionsBase
  & XOR<[
    { userIds: string[] },
    { allUsers: true },
    // Send to arbitrary email addresses that don't have to belong to a user. These recipients have no associated user
    // object and cannot unsubscribe, so this should only be used for transactional emails.
    { emails: string[] }
  ]>
  & XOR<[
    { html: string },
    { templateId: string },
    { draftId: string }
  ]>

export type EmailDeliveryWindowStats = {
  sent: number,
  bounced: number,
  marked_as_spam: number,
};

export type EmailDeliveryStats = {
  hour: EmailDeliveryWindowStats,
  day: EmailDeliveryWindowStats,
  week: EmailDeliveryWindowStats,
  month: EmailDeliveryWindowStats,
};

export type EmailDeliveryCapacity = {
  rate_per_second: number,
  boost_multiplier: number,
  penalty_factor: number,
  is_boost_active: boolean,
  boost_expires_at: string | null,
};

export type EmailDeliveryInfo = {
  stats: EmailDeliveryStats,
  capacity: EmailDeliveryCapacity,
};
