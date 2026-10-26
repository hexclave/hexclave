import { getExactEndUserIp } from "@/lib/end-users";
import {
  approveTvDisplayPairing,
  consumeTvDisplayPairingRateLimit,
  listTvDisplays,
  refundTvDisplayPairingRateLimit,
  requireTvDisplayAdminUserId,
  TvDisplayOperationError,
} from "@/lib/tv-mode/displays";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { TvDisplayResourceSchema } from "@hexclave/shared/dist/interface/admin-tv-mode";
import { adaptSchema, adminAuthTypeSchema, yupArray, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { captureError, HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";

const adminAuthSchema = yupObject({
  type: adminAuthTypeSchema,
  tenancy: adaptSchema.defined(),
  adminUserId: yupString().uuid().optional(),
}).defined();

async function refundApprovalRateLimits(options: {
  adminUserId: string,
  ip: string,
  now: Date,
  refundAdmin: boolean,
  refundIp: boolean,
}): Promise<void> {
  const refundResults = await Promise.allSettled([
    options.refundAdmin
      ? refundTvDisplayPairingRateLimit({ identity: options.adminUserId, operation: "approval-admin", windowMs: 10 * 60_000, now: options.now })
      : Promise.resolve(),
    options.refundIp
      ? refundTvDisplayPairingRateLimit({ identity: options.ip, operation: "approval-ip", windowMs: 10 * 60_000, now: options.now })
      : Promise.resolve(),
  ]);
  for (const result of refundResults) {
    if (result.status === "rejected") {
      captureError("tv-display-rate-limit-refund-failed", new HexclaveAssertionError(
        "A TV display approval could not refund its rate-limit bucket.",
        { cause: result.reason },
      ));
    }
  }
}

export async function consumeTvDisplayApprovalRateLimits(options: {
  adminUserId: string,
  ip: string,
  now: Date,
}): Promise<[boolean, boolean]> {
  const consumeResults = await Promise.allSettled([
    consumeTvDisplayPairingRateLimit({
      identity: options.adminUserId,
      operation: "approval-admin",
      windowMs: 10 * 60_000,
      limit: 10,
      now: options.now,
    }),
    consumeTvDisplayPairingRateLimit({
      identity: options.ip,
      operation: "approval-ip",
      windowMs: 10 * 60_000,
      limit: 20,
      now: options.now,
    }),
  ]);
  if (consumeResults.some((result) => result.status === "rejected")) {
    await refundApprovalRateLimits({
      adminUserId: options.adminUserId,
      ip: options.ip,
      now: options.now,
      refundAdmin: consumeResults[0].status === "fulfilled",
      refundIp: consumeResults[1].status === "fulfilled",
    });
  }
  const rejectedResult = consumeResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejectedResult != null) throw rejectedResult.reason;
  const adminResult = consumeResults[0];
  const ipResult = consumeResults[1];
  if (adminResult.status !== "fulfilled" || ipResult.status !== "fulfilled") {
    throw new HexclaveAssertionError("TV display pairing rate-limit consumption did not settle.");
  }
  return [adminResult.value, ipResult.value];
}

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({ auth: adminAuthSchema }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ displays: yupArray(TvDisplayResourceSchema).defined() }).noUnknown().defined(),
  }),
  handler: async ({ auth: { tenancy } }) => ({
    statusCode: 200,
    bodyType: "json",
    body: { displays: await listTvDisplays(tenancy) },
  }),
});

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: adminAuthSchema,
    body: yupObject({
      pairingCode: yupString().min(1).defined(),
      profileId: yupString().min(1).defined(),
      displayName: yupString().trim().min(1).max(80).defined(),
      acknowledgeExactFinancials: yupBoolean().defined(),
    }).noUnknown().defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      success: yupBoolean().oneOf([true]).defined(),
      approvedAt: yupString().defined(),
      expiresAt: yupString().defined(),
    }).noUnknown().defined(),
  }),
  handler: async ({ auth, body }) => {
    const adminUserId = requireTvDisplayAdminUserId(auth.adminUserId);
    const ip = await getExactEndUserIp() ?? "unknown-untrusted-ip";
    const rateLimitNow = new Date();
    const [adminAllowed, ipAllowed] = await consumeTvDisplayApprovalRateLimits({ adminUserId, ip, now: rateLimitNow });
    if (!adminAllowed || !ipAllowed) {
      await refundApprovalRateLimits({
        adminUserId,
        ip,
        now: rateLimitNow,
        refundAdmin: adminAllowed,
        refundIp: ipAllowed,
      });
      throw new StatusError(429, "tv_display_pairing_rate_limited");
    }
    try {
      const approval = await approveTvDisplayPairing({
        tenancy: auth.tenancy,
        pairingCode: body.pairingCode,
        profileId: body.profileId,
        displayName: body.displayName,
        adminUserId,
        acknowledgeExactFinancials: body.acknowledgeExactFinancials,
      });
      return {
        statusCode: 200,
        bodyType: "json",
        body: {
          success: true,
          approvedAt: approval.approvedAt.toISOString(),
          expiresAt: approval.expiresAt.toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof TvDisplayOperationError) {
        if (
          error.code === "tv_display_profile_not_found"
          || error.code === "tv_display_exact_financials_acknowledgement_required"
        ) {
          await refundApprovalRateLimits({
            adminUserId,
            ip,
            now: rateLimitNow,
            refundAdmin: true,
            refundIp: true,
          });
        }
        const status = error.code === "tv_display_profile_not_found"
          ? 404
          : error.code === "tv_display_exact_financials_acknowledgement_required"
            ? 428
            : 400;
        throw new StatusError(status, error.code);
      }
      throw error;
    }
  },
});
