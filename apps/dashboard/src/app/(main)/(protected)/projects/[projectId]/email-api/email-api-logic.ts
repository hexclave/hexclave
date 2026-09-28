import type { AdminEmailOutbox, AdminEmailOutboxStatus } from "@hexclave/next";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";

export type EmailApiSource = {
  id: string,
  displayName: string,
  count: number,
  lastSentAt: Date | null,
  statuses: Map<AdminEmailOutboxStatus, number>,
};

export function isEmailApiEmail(email: Pick<AdminEmailOutbox, "createdWith">): boolean {
  return email.createdWith === "programmatic-call";
}

export function countEmailsSince(
  emails: Pick<AdminEmailOutbox, "createdAt">[],
  now: Date,
  durationMillis: number,
): number {
  const start = now.getTime() - durationMillis;
  return emails.filter((email) => {
    const createdAt = email.createdAt.getTime();
    return createdAt >= start;
  }).length;
}

export function groupEmailsBySource(
  emails: Pick<AdminEmailOutbox, "createdAt" | "status" | "emailProgrammaticCallTemplateId">[],
  templateNames: ReadonlyMap<string, string>,
): EmailApiSource[] {
  const groups = new Map<string, EmailApiSource>();
  for (const email of emails) {
    const id = email.emailProgrammaticCallTemplateId ?? "html";
    const existing = groups.get(id);
    const source = existing ?? {
      id,
      displayName: id === "html"
        ? "Raw HTML"
        : templateNames.get(id) ?? `Template (${id.slice(0, 8)}...)`,
      count: 0,
      lastSentAt: null,
      statuses: new Map(),
    };
    source.count++;
    source.lastSentAt = source.lastSentAt == null || email.createdAt > source.lastSentAt
      ? email.createdAt
      : source.lastSentAt;
    source.statuses.set(email.status, (source.statuses.get(email.status) ?? 0) + 1);
    groups.set(id, source);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || stringCompare(a.displayName, b.displayName));
}

type DeliveryOutcome = "success" | "failure" | "excluded";

function assertNever(value: never): never {
  return throwErr(`Unhandled email delivery value: ${value}`);
}

function classifyDeliveryStatus(status: AdminEmailOutboxStatus): DeliveryOutcome {
  switch (status) {
    case "sent": {
      return "success";
    }
    case "opened": {
      return "success";
    }
    case "clicked": {
      return "success";
    }
    case "marked-as-spam": {
      // Spam complaints still represent delivered messages; skipped and delayed rows do not.
      return "success";
    }
    case "bounced": {
      return "failure";
    }
    case "render-error": {
      return "failure";
    }
    case "server-error": {
      return "failure";
    }
    case "paused": {
      return "excluded";
    }
    case "preparing": {
      return "excluded";
    }
    case "rendering": {
      return "excluded";
    }
    case "scheduled": {
      return "excluded";
    }
    case "queued": {
      return "excluded";
    }
    case "sending": {
      return "excluded";
    }
    case "delivery-delayed": {
      return "excluded";
    }
    case "skipped": {
      // Delayed rows are still in flight, while skipped rows were never attempted.
      return "excluded";
    }
    default: {
      return assertNever(status);
    }
  }
}

export function getDeliverySuccessRate(emails: Pick<AdminEmailOutbox, "status">[]): number | null {
  let successes = 0;
  let failures = 0;
  for (const email of emails) {
    const outcome = classifyDeliveryStatus(email.status);
    switch (outcome) {
      case "success": {
        successes++;
        break;
      }
      case "failure": {
        failures++;
        break;
      }
      case "excluded": {
        break;
      }
      default: {
        return assertNever(outcome);
      }
    }
  }
  const terminalCount = successes + failures;
  return terminalCount === 0 ? null : successes / terminalCount;
}
