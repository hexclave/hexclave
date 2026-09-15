import { getAuthorizedTvDisplay } from "@/lib/tv-mode/displays";
import { readTvDisplayBearerToken } from "@/lib/tv-mode/read-bearer-token";
import { resolveTvProfile } from "@/lib/tv-mode/profiles";
import { buildLiveTvSnapshot } from "@/lib/tv-mode/snapshot";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { TvSnapshotSchema } from "@hexclave/shared/dist/interface/admin-tv-mode";
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
    body: TvSnapshotSchema,
  }),
  handler: async ({ headers }) => {
    const accessToken = readTvDisplayBearerToken(headers.authorization?.[0]);
    const authorized = await getAuthorizedTvDisplay(accessToken);
    if (authorized == null) throw new StatusError(401, "tv_display_access_invalid");
    const profile = await resolveTvProfile(authorized.tenancy, authorized.display.profileId);
    if (profile == null) throw new StatusError(409, "tv_display_profile_unavailable");
    const acknowledgedAt = authorized.display.financialVisibilityAcknowledgedAt;
    const exactFinancialsAcknowledged = profile.configuration.financialVisibility !== "exact"
      || (acknowledgedAt != null && (profile.updatedAt == null || acknowledgedAt >= new Date(profile.updatedAt)));
    let snapshot = await buildLiveTvSnapshot({
      tenancy: authorized.tenancy,
      profileId: authorized.display.profileId,
      resolvedProfile: profile,
      includeScreenDurations: true,
      forceFinancialRedaction: !exactFinancialsAcknowledged,
    });
    if (snapshot == null) throw new StatusError(409, "tv_display_profile_unavailable");
    const currentAuthorized = await getAuthorizedTvDisplay(accessToken);
    if (currentAuthorized == null) throw new StatusError(401, "tv_display_access_invalid");
    const currentProfile = await resolveTvProfile(currentAuthorized.tenancy, currentAuthorized.display.profileId);
    if (currentProfile == null) throw new StatusError(409, "tv_display_profile_unavailable");
    const assignmentChangedDuringSnapshot = currentAuthorized.display.profileId !== authorized.display.profileId
      || currentAuthorized.display.financialVisibilityAcknowledgedAt?.getTime() !== acknowledgedAt?.getTime()
      || currentProfile.id !== profile.id
      || currentProfile.version !== profile.version
      || currentProfile.updatedAt !== profile.updatedAt;
    if (assignmentChangedDuringSnapshot) {
      // Snapshot aggregation can outlive a profile edit. Rebuild from the
      // authoritative assignment and fail closed on exact values; a subsequent
      // poll can restore exact data after the administrator acknowledges it.
      snapshot = await buildLiveTvSnapshot({
        tenancy: currentAuthorized.tenancy,
        profileId: currentAuthorized.display.profileId,
        resolvedProfile: currentProfile,
        includeScreenDurations: true,
        forceFinancialRedaction: true,
      });
      if (snapshot == null) throw new StatusError(409, "tv_display_profile_unavailable");
    }
    return { statusCode: 200, bodyType: "json", body: snapshot };
  },
});
