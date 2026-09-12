import { getExactEndUserIp } from "@/lib/end-users";
import { consumeTvDisplayPairingRateLimit, createTvDisplayPairingChallenge, TV_DISPLAY_POLLING_INTERVAL_SECONDS } from "@/lib/tv-mode/displays";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { TvDisplayPairingChallengeSchema } from "@hexclave/shared/dist/interface/admin-tv-mode";
import { yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({ auth: yupObject({}).nullable().optional() }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: TvDisplayPairingChallengeSchema,
  }),
  handler: async () => {
    const ip = await getExactEndUserIp() ?? "unknown-untrusted-ip";
    const minuteAllowed = await consumeTvDisplayPairingRateLimit({
      identity: ip,
      operation: "challenge-create-minute",
      windowMs: 60_000,
      limit: 5,
    });
    if (!minuteAllowed) throw new StatusError(429, "tv_display_pairing_rate_limited");
    const hourAllowed = await consumeTvDisplayPairingRateLimit({
      identity: ip,
      operation: "challenge-create-hour",
      windowMs: 60 * 60_000,
      limit: 30,
    });
    if (!hourAllowed) throw new StatusError(429, "tv_display_pairing_rate_limited");
    const challenge = await createTvDisplayPairingChallenge();
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        challengeId: challenge.challengeId,
        pairingCode: challenge.pairingCode,
        deviceSecret: challenge.deviceSecret,
        expiresAt: challenge.expiresAt.toISOString(),
        pollingIntervalSeconds: TV_DISPLAY_POLLING_INTERVAL_SECONDS,
      },
    };
  },
});
