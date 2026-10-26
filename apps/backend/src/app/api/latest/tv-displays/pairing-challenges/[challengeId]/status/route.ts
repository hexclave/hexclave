import { cookies } from "@/lib/runtime/headers";
import { getTvDisplayResource, pollTvDisplayPairing, TV_DISPLAY_REFRESH_COOKIE } from "@/lib/tv-mode/displays";
import { setTvDisplayRefreshCookie } from "@/lib/tv-mode/display-refresh-cookie";
import { getTenancy } from "@/lib/tenancies";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { TvDisplayPairingStatusSchema } from "@hexclave/shared/dist/interface/admin-tv-mode";
import { yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({}).nullable().optional(),
    params: yupObject({ challengeId: yupString().uuid().defined() }).defined(),
    body: yupObject({ deviceSecret: yupString().min(32).max(256).defined() }).noUnknown().defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: TvDisplayPairingStatusSchema,
  }),
  handler: async ({ params, body }) => {
    const result = await pollTvDisplayPairing({ challengeId: params.challengeId, deviceSecret: body.deviceSecret });
    if (result.status !== "paired") return { statusCode: 200, bodyType: "json", body: result };
    const tenancy = await getTenancy(result.display.tenancyId);
    if (tenancy == null) {
      throw new HexclaveAssertionError("A paired TV display references a missing tenancy.");
    }
    const cookieStore = await cookies();
    setTvDisplayRefreshCookie(cookieStore, TV_DISPLAY_REFRESH_COOKIE, result.refreshToken);
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        status: result.status,
        accessToken: result.accessToken,
        display: await getTvDisplayResource(tenancy, result.display),
      },
    };
  },
});
