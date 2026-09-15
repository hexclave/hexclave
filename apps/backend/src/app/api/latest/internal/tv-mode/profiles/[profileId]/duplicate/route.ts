import {
  createTvProfile,
  duplicateSavedTvProfile,
  isSavedTvProfileId,
  resolveTvProfile,
  tvProfilePersistenceIsReady,
  TvProfileNameConflictError,
  TvProfileVersionConflictError,
} from "@/lib/tv-mode/profiles";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import {
  TvProfileDisplayNameSchema,
  TvSavedProfileResourceSchema,
} from "@hexclave/shared/dist/interface/admin-tv-mode";
import {
  adaptSchema,
  adminAuthTypeSchema,
  yupNumber,
  yupObject,
  yupString,
} from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({ profileId: yupString().defined() }).defined(),
    body: yupObject({
      displayName: TvProfileDisplayNameSchema,
      expectedSourceVersion: yupNumber().integer().min(1).nullable().defined(),
    }).noUnknown().defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ profile: TvSavedProfileResourceSchema }).noUnknown().defined(),
  }),
  handler: async ({ auth: { tenancy }, params, body }) => {
    if (isSavedTvProfileId(params.profileId) && !(await tvProfilePersistenceIsReady(tenancy))) {
      throw new StatusError(StatusError.ServiceUnavailable, "tv_profile_persistence_not_ready");
    }
    const source = await resolveTvProfile(tenancy, params.profileId);
    if (source == null) throw new StatusError(StatusError.NotFound, "tv_profile_not_found");
    if (source.origin === "saved" && body.expectedSourceVersion !== source.version) {
      throw new StatusError(StatusError.Conflict, "tv_profile_version_conflict");
    }
    if (source.origin === "built-in" && body.expectedSourceVersion != null) {
      throw new StatusError(StatusError.BadRequest, "Built-in TV templates do not have a version.");
    }
    try {
      const duplicateConfiguration = {
        ...source.configuration,
        displayName: body.displayName,
      };
      const profile = source.origin === "saved"
        ? await duplicateSavedTvProfile(
          tenancy,
          source.id,
          body.expectedSourceVersion ?? source.version,
          duplicateConfiguration,
        )
        : await createTvProfile(tenancy, duplicateConfiguration);
      if (profile == null) {
        throw new StatusError(
          source.origin === "built-in" ? StatusError.ServiceUnavailable : StatusError.NotFound,
          source.origin === "built-in" ? "tv_profile_persistence_not_ready" : "tv_profile_not_found",
        );
      }
      return { statusCode: 200, bodyType: "json", body: { profile } };
    } catch (error) {
      if (error instanceof TvProfileNameConflictError) {
        throw new StatusError(StatusError.Conflict, "tv_profile_name_conflict");
      }
      if (error instanceof TvProfileVersionConflictError) {
        throw new StatusError(StatusError.Conflict, "tv_profile_version_conflict");
      }
      throw error;
    }
  },
});
