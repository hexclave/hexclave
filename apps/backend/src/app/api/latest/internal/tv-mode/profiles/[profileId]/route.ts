import {
  deleteTvProfile,
  isSavedTvProfileId,
  resolveTvProfile,
  tvProfilePersistenceIsReady,
  TvBuiltInProfileMutationError,
  TvProfileNameConflictError,
  TvProfileAssignedToDisplaysError,
  TvProfileVersionConflictError,
  updateTvProfile,
} from "@/lib/tv-mode/profiles";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import {
  TvProfileConfigurationSchema,
  TvProfileResourceSchema,
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

const authSchema = yupObject({
  type: adminAuthTypeSchema.defined(),
  tenancy: adaptSchema.defined(),
}).defined();
const paramsSchema = yupObject({ profileId: yupString().defined() }).defined();

function mapMutationError(error: unknown): never {
  if (error instanceof TvProfileVersionConflictError) {
    throw new StatusError(StatusError.Conflict, "tv_profile_version_conflict");
  }
  if (error instanceof TvProfileNameConflictError) {
    throw new StatusError(StatusError.Conflict, "tv_profile_name_conflict");
  }
  if (error instanceof TvBuiltInProfileMutationError) {
    throw new StatusError(StatusError.Conflict, "tv_profile_is_builtin");
  }
  if (error instanceof TvProfileAssignedToDisplaysError) {
    throw new StatusError(StatusError.Conflict, `tv_profile_assigned_to_displays:${error.displayCount}`);
  }
  throw error;
}

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({ auth: authSchema, params: paramsSchema }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ profile: TvProfileResourceSchema }).noUnknown().defined(),
  }),
  handler: async ({ auth: { tenancy }, params }) => {
    if (isSavedTvProfileId(params.profileId) && !(await tvProfilePersistenceIsReady(tenancy))) {
      throw new StatusError(StatusError.ServiceUnavailable, "tv_profile_persistence_not_ready");
    }
    const profile = await resolveTvProfile(tenancy, params.profileId);
    if (profile == null) throw new StatusError(StatusError.NotFound, "tv_profile_not_found");
    return { statusCode: 200, bodyType: "json", body: { profile } };
  },
});

export const PATCH = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: authSchema,
    params: paramsSchema,
    body: yupObject({
      expectedVersion: yupNumber().integer().min(1).defined(),
      configuration: TvProfileConfigurationSchema,
    }).noUnknown().defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ profile: TvSavedProfileResourceSchema }).noUnknown().defined(),
  }),
  handler: async ({ auth: { tenancy }, params, body }) => {
    try {
      if (isSavedTvProfileId(params.profileId) && !(await tvProfilePersistenceIsReady(tenancy))) {
        throw new StatusError(StatusError.ServiceUnavailable, "tv_profile_persistence_not_ready");
      }
      const profile = await updateTvProfile(
        tenancy,
        params.profileId,
        body.expectedVersion,
        body.configuration,
      );
      if (profile == null) throw new StatusError(StatusError.NotFound, "tv_profile_not_found");
      return { statusCode: 200, bodyType: "json", body: { profile } };
    } catch (error) {
      return mapMutationError(error);
    }
  },
});

export const DELETE = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: authSchema,
    params: paramsSchema,
    body: yupObject({ expectedVersion: yupNumber().integer().min(1).defined() }).noUnknown().defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ deletedProfileId: yupString().uuid().defined() }).noUnknown().defined(),
  }),
  handler: async ({ auth: { tenancy }, params, body }) => {
    try {
      const deleted = await deleteTvProfile(tenancy, params.profileId, body.expectedVersion);
      if (deleted == null) {
        throw new StatusError(StatusError.ServiceUnavailable, "tv_profile_persistence_not_ready");
      }
      if (!deleted) throw new StatusError(StatusError.NotFound, "tv_profile_not_found");
      return {
        statusCode: 200,
        bodyType: "json",
        body: { deletedProfileId: params.profileId },
      };
    } catch (error) {
      return mapMutationError(error);
    }
  },
});
