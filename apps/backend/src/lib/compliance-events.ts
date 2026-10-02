import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import { getBillingTeamId } from "@/lib/plan-entitlements";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { recordSystemTelemetry, getEndUserIpInfoForEvent, SystemEventTypes } from "./events";
import { Tenancy } from "./tenancies";

type SignInAttemptOptions = {
  outcome: "success" | "failed",
  method: "password" | "otp" | "passkey" | "oauth",
  failureReason?: string | null,
  email?: string | null,
  oauthProvider?: string | null,
  userId?: string | null,
};

type PermissionDeniedOptions = {
  permissionId: string,
  teamId?: string | null,
  scope: "team" | "project",
  userId?: string | null,
};

type UserRestrictedOptions = {
  userId: string,
  restrictedReason: string,
};

async function logComplianceEvent(label: string, message: string, callback: () => Promise<void>): Promise<void> {
  try {
    await callback();
  } catch (error) {
    captureError(label, new HexclaveAssertionError(message, { cause: error }));
  }
}

function logComplianceEventRegistrationError(label: string, message: string, error: unknown): void {
  captureError(label, new HexclaveAssertionError(message, { cause: error }));
}

async function logSignInAttempt(tenancy: Tenancy, options: SignInAttemptOptions): Promise<void> {
  await logComplianceEvent(
    "compliance-sign-in-attempt-log-error",
    "Failed to log sign-in attempt compliance event",
    async () => {
      const ipInfo = await getEndUserIpInfoForEvent();
      await recordSystemTelemetry([SystemEventTypes.SignInAttempt], {
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
        userId: options.userId ?? null,
        outcome: options.outcome,
        method: options.method,
        failureReason: options.failureReason ?? null,
        email: options.email ?? null,
        oauthProvider: options.oauthProvider ?? null,
        ipInfo,
      }, {
        // Meter public failed sign-ins to bound compliance-event write amplification.
        billingTeamId: getBillingTeamId(tenancy.project),
      });
    },
  );
}

async function logPermissionDenied(tenancy: Tenancy, options: PermissionDeniedOptions): Promise<void> {
  await logComplianceEvent(
    "compliance-permission-denied-log-error",
    "Failed to log permission denial compliance event",
    async () => {
      const ipInfo = await getEndUserIpInfoForEvent();
      await recordSystemTelemetry([SystemEventTypes.PermissionCheck], {
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
        userId: options.userId ?? null,
        outcome: "denied",
        permissionId: options.permissionId,
        teamId: options.teamId ?? null,
        scope: options.scope,
        ipInfo,
      }, {
        // Meter permission denials to bound compliance-event write amplification.
        billingTeamId: getBillingTeamId(tenancy.project),
      });
    },
  );
}

async function logUserRestricted(tenancy: Tenancy, options: UserRestrictedOptions): Promise<void> {
  await logComplianceEvent(
    "compliance-user-restricted-log-error",
    "Failed to log restricted-user compliance event",
    async () => {
      const ipInfo = await getEndUserIpInfoForEvent();
      await recordSystemTelemetry([SystemEventTypes.UserRestricted], {
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
        userId: options.userId,
        restrictedReason: options.restrictedReason,
        ipInfo,
      }, {
        // Meter restricted-user events to bound compliance-event write amplification.
        billingTeamId: getBillingTeamId(tenancy.project),
      });
    },
  );
}

export function logSignInAttemptInBackground(tenancy: Tenancy, options: SignInAttemptOptions): void {
  try {
    runAsynchronouslyAndWaitUntil(logSignInAttempt(tenancy, options));
  } catch (error) {
    logComplianceEventRegistrationError(
      "compliance-sign-in-attempt-registration-error",
      "Failed to register sign-in attempt compliance event",
      error,
    );
  }
}

export function logPermissionDeniedInBackground(tenancy: Tenancy, options: PermissionDeniedOptions): void {
  try {
    runAsynchronouslyAndWaitUntil(logPermissionDenied(tenancy, options));
  } catch (error) {
    logComplianceEventRegistrationError(
      "compliance-permission-denied-registration-error",
      "Failed to register permission denial compliance event",
      error,
    );
  }
}

export function logUserRestrictedInBackground(tenancy: Tenancy, options: UserRestrictedOptions): void {
  try {
    runAsynchronouslyAndWaitUntil(logUserRestricted(tenancy, options));
  } catch (error) {
    logComplianceEventRegistrationError(
      "compliance-user-restricted-registration-error",
      "Failed to register restricted-user compliance event",
      error,
    );
  }
}
