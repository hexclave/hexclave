import { cookies } from "@/lib/runtime/headers";
import { deleteTvDisplay, getAuthorizedTvDisplay, TV_DISPLAY_REFRESH_COOKIE } from "@/lib/tv-mode/displays";
import { clearTvDisplayRefreshCookie } from "@/lib/tv-mode/display-refresh-cookie";
import { readTvDisplayBearerToken } from "@/lib/tv-mode/read-bearer-token";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupBoolean, yupNumber, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    headers: yupObject({ authorization: yupTuple([yupString().defined()]).optional() }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ success: yupBoolean().oneOf([true]).defined() }).noUnknown().defined(),
  }),
  handler: async ({ headers }) => {
    const authorized = await getAuthorizedTvDisplay(readTvDisplayBearerToken(headers.authorization?.[0]));
    if (authorized == null) throw new StatusError(401, "tv_display_access_invalid");
    const cookieStore = await cookies();
    const deleted = await deleteTvDisplay(authorized.tenancy, authorized.display.id);
    clearTvDisplayRefreshCookie(cookieStore, TV_DISPLAY_REFRESH_COOKIE);
    if (!deleted) throw new StatusError(401, "tv_display_access_invalid");
    return { statusCode: 200, bodyType: "json", body: { success: true } };
  },
});
