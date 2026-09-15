import { cookies } from "@/lib/runtime/headers";
import { refreshTvDisplayCredential, TV_DISPLAY_REFRESH_COOKIE } from "@/lib/tv-mode/displays";
import { clearTvDisplayRefreshCookie, readTvDisplayRefreshCookie, setTvDisplayRefreshCookie } from "@/lib/tv-mode/display-refresh-cookie";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({ auth: yupObject({}).nullable().optional(), url: yupString().defined() }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ accessToken: yupString().defined() }).noUnknown().defined(),
  }),
  handler: async ({ url }) => {
    const cookieStore = await cookies();
    const rawRefreshToken = readTvDisplayRefreshCookie(cookieStore, TV_DISPLAY_REFRESH_COOKIE, url);
    if (rawRefreshToken == null) throw new StatusError(401, "tv_display_refresh_required");
    const result = await refreshTvDisplayCredential(rawRefreshToken);
    if (result == null) {
      clearTvDisplayRefreshCookie(cookieStore, TV_DISPLAY_REFRESH_COOKIE);
      throw new StatusError(401, "tv_display_refresh_invalid");
    }
    setTvDisplayRefreshCookie(cookieStore, TV_DISPLAY_REFRESH_COOKIE, result.refreshToken);
    return { statusCode: 200, bodyType: "json", body: { accessToken: result.accessToken } };
  },
});
