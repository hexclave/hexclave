import { getAuthorizedTvDisplay, getTvDisplayResource } from "@/lib/tv-mode/displays";
import { readTvDisplayBearerToken } from "@/lib/tv-mode/read-bearer-token";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { TvDisplayResourceSchema } from "@hexclave/shared/dist/interface/admin-tv-mode";
import { yupNumber, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    headers: yupObject({ authorization: yupTuple([yupString().defined()]).optional() }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ display: TvDisplayResourceSchema }).noUnknown().defined(),
  }),
  handler: async ({ headers }) => {
    const authorized = await getAuthorizedTvDisplay(readTvDisplayBearerToken(headers.authorization?.[0]));
    if (authorized == null) throw new StatusError(401, "tv_display_access_invalid");
    return {
      statusCode: 200,
      bodyType: "json",
      body: { display: await getTvDisplayResource(authorized.tenancy, authorized.display) },
    };
  },
});
