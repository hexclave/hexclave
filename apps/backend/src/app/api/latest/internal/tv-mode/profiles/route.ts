import { createTvProfile, listTvProfiles, TvProfileNameConflictError } from "@/lib/tv-mode/profiles";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import {
  TvBuiltInProfileResourceSchema,
  TvProfileConfigurationSchema,
  TvSavedProfileResourceSchema,
} from "@hexclave/shared/dist/interface/admin-tv-mode";
import {
  adaptSchema,
  adminAuthTypeSchema,
  yupArray,
  yupBoolean,
  yupNumber,
  yupObject,
  yupString,
} from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

const authSchema = yupObject({
  type: adminAuthTypeSchema.defined(),
  tenancy: adaptSchema.defined(),
}).defined();

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({ auth: authSchema }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      persistenceReady: yupBoolean().defined(),
      effectiveDefaultProfileId: yupString().oneOf(["company-pulse"]).defined(),
      savedProfiles: yupArray(TvSavedProfileResourceSchema).defined(),
      templates: yupArray(TvBuiltInProfileResourceSchema).defined(),
    }).noUnknown().defined(),
  }),
  handler: async ({ auth: { tenancy } }) => {
    const profiles = await listTvProfiles(tenancy);
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        ...profiles,
        effectiveDefaultProfileId: "company-pulse",
      },
    };
  },
});

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: authSchema,
    body: yupObject({ configuration: TvProfileConfigurationSchema }).noUnknown().defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ profile: TvSavedProfileResourceSchema }).noUnknown().defined(),
  }),
  handler: async ({ auth: { tenancy }, body }) => {
    try {
      const profile = await createTvProfile(tenancy, body.configuration);
      if (profile == null) {
        throw new StatusError(StatusError.ServiceUnavailable, "tv_profile_persistence_not_ready");
      }
      return { statusCode: 200, bodyType: "json", body: { profile } };
    } catch (error) {
      if (error instanceof TvProfileNameConflictError) {
        throw new StatusError(StatusError.Conflict, "tv_profile_name_conflict");
      }
      throw error;
    }
  },
});
