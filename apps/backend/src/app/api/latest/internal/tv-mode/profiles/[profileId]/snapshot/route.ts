import { buildLiveTvSnapshot } from "@/lib/tv-mode/snapshot";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { TvSnapshotSchema } from "@hexclave/shared/dist/interface/admin-tv-mode";
import {
  adaptSchema,
  adminAuthTypeSchema,
  yupNumber,
  yupObject,
  yupString,
} from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      profileId: yupString().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: TvSnapshotSchema,
  }),
  handler: async ({ auth: { tenancy }, params: { profileId } }, fullRequest) => {
    const snapshotContract = fullRequest.headers["x-hexclave-tv-snapshot-contract"]?.at(0)
      ?? fullRequest.headers["x-stack-tv-snapshot-contract"]?.at(0);
    const snapshot = await buildLiveTvSnapshot({
      tenancy,
      profileId,
      includeScreenDurations: snapshotContract === "2",
    });
    if (snapshot == null) {
      throw new StatusError(StatusError.NotFound, "No TV presentation profile found with the given ID.");
    }
    return {
      statusCode: 200,
      bodyType: "json",
      body: snapshot,
    };
  },
});
