import { issueCreatedWebhookEvent, issueIgnoredWebhookEvent, issueMergedWebhookEvent, issueRegressedWebhookEvent, issueResolvedWebhookEvent } from "@hexclave/shared/dist/interface/crud/issues";
import { projectPermissionCreatedWebhookEvent, projectPermissionDeletedWebhookEvent } from "@hexclave/shared/dist/interface/crud/project-permissions";
import { teamMembershipCreatedWebhookEvent, teamMembershipDeletedWebhookEvent } from "@hexclave/shared/dist/interface/crud/team-memberships";
import { teamPermissionCreatedWebhookEvent, teamPermissionDeletedWebhookEvent } from "@hexclave/shared/dist/interface/crud/team-permissions";
import { teamCreatedWebhookEvent, teamDeletedWebhookEvent, teamUpdatedWebhookEvent } from "@hexclave/shared/dist/interface/crud/teams";
import { userCreatedWebhookEvent, userDeletedWebhookEvent, userUpdatedWebhookEvent } from "@hexclave/shared/dist/interface/crud/users";
import { WebhookEvent } from "@hexclave/shared/dist/interface/webhooks";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError, captureError } from "@hexclave/shared/dist/utils/errors";
import { Result } from "@hexclave/shared/dist/utils/results";
import { Svix } from "svix";
import * as yup from "yup";
import { isPreviewModeEnabled } from "@/lib/preview-mode";
import type { Tenancy } from "@/lib/tenancies";

export function getSvixClient() {
  return new Svix(
    getEnvVariable("STACK_SVIX_API_KEY"),
    { serverUrl: getEnvVariable("STACK_SVIX_SERVER_URL", "") || undefined }
  );
}

export function isWebhooksAppEnabled(tenancy: Tenancy): boolean {
  return tenancy.config.apps.installed["webhooks"]?.enabled ?? false;
}

async function sendWebhooks(options: {
  type: string,
  projectId: string,
  data: any,
  eventId?: string,
}) {
  if (isPreviewModeEnabled()) {
    return;
  }

  const svix = getSvixClient();

  try {
    await svix.application.getOrCreate({ uid: options.projectId, name: options.projectId });
  } catch (e: any) {
    if (e.message.includes("409")) {
      // This is a Svix bug; they are working on fixing it. We can ignore it for now (it means the app already exists).
      // TODO: remove this once it no longer appears on Sentry or during the E2E tests
      captureError("svix-409-hack", "Svix bug: 409 error when creating application. Remove this warning once Svix fixes this.");
    } else {
      throw e;
    }
  }
  await svix.message.create(options.projectId, {
    eventType: options.type,
    ...options.eventId === undefined ? {} : { eventId: options.eventId },
    payload: {
      type: options.type,
      data: options.data,
    },
  });
}

function createWebhookSender<T extends yup.Schema>(event: WebhookEvent<T>) {
  return async (options: { projectId: string, data: yup.InferType<typeof event.schema>, eventId?: string }) => {
    await Result.retry(async () => {
      try {
        return Result.ok(await sendWebhooks({
          type: event.type,
          projectId: options.projectId,
          data: options.data,
          eventId: options.eventId,
        }));
      } catch (e) {
        if (typeof e === "object" && e !== null && "code" in e && e.code === "429") {
          // Rate limit. Let's retry later
          return Result.error(e);
        }
        throw new HexclaveAssertionError("Error sending Svix webhook!", { event: event.type, data: options.data, cause: e });
      }
    }, 5);
  };
}

export const sendUserCreatedWebhook = createWebhookSender(userCreatedWebhookEvent);
export const sendUserUpdatedWebhook = createWebhookSender(userUpdatedWebhookEvent);
export const sendUserDeletedWebhook = createWebhookSender(userDeletedWebhookEvent);
export const sendTeamCreatedWebhook = createWebhookSender(teamCreatedWebhookEvent);
export const sendTeamUpdatedWebhook = createWebhookSender(teamUpdatedWebhookEvent);
export const sendTeamDeletedWebhook = createWebhookSender(teamDeletedWebhookEvent);
export const sendTeamMembershipCreatedWebhook = createWebhookSender(teamMembershipCreatedWebhookEvent);
export const sendTeamMembershipDeletedWebhook = createWebhookSender(teamMembershipDeletedWebhookEvent);
export const sendTeamPermissionCreatedWebhook = createWebhookSender(teamPermissionCreatedWebhookEvent);
export const sendTeamPermissionDeletedWebhook = createWebhookSender(teamPermissionDeletedWebhookEvent);
export const sendProjectPermissionCreatedWebhook = createWebhookSender(projectPermissionCreatedWebhookEvent);
export const sendProjectPermissionDeletedWebhook = createWebhookSender(projectPermissionDeletedWebhookEvent);

function createIdempotentWebhookSender<T extends yup.Schema>(event: WebhookEvent<T>) {
  const send = createWebhookSender(event);
  return async (options: { projectId: string, data: yup.InferType<typeof event.schema>, eventId: string }) => {
    await send(options);
  };
}

export const sendIssueCreatedWebhook = createIdempotentWebhookSender(issueCreatedWebhookEvent);
export const sendIssueRegressedWebhook = createIdempotentWebhookSender(issueRegressedWebhookEvent);
export const sendIssueResolvedWebhook = createIdempotentWebhookSender(issueResolvedWebhookEvent);
export const sendIssueIgnoredWebhook = createIdempotentWebhookSender(issueIgnoredWebhookEvent);
export const sendIssueMergedWebhook = createIdempotentWebhookSender(issueMergedWebhookEvent);
