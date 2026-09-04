import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { createFeatureFlagsBootstrap } from "@hexclave/shared/dist/feature-flags/canonical";
import { parseFeatureFlagsConfig } from "@hexclave/shared/dist/feature-flags/schema";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupArray, yupMixed, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { withActiveExperimentRuns } from "@/lib/feature-flags/active-experiments";

function normalizeEtag(value: string): string {
  const withoutWeakPrefix = value.startsWith("W/") ? value.slice(2).trim() : value;
  return withoutWeakPrefix.startsWith('"') && withoutWeakPrefix.endsWith('"')
    ? withoutWeakPrefix.slice(1, -1)
    : withoutWeakPrefix;
}

function ifNoneMatchContains(values: readonly string[], version: string): boolean {
  return values.flatMap((value) => value.split(",")).map((value) => normalizeEtag(value.trim())).some((value) => value === "*" || value === version);
}

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Bootstrap feature flag definitions",
    description: "Returns versioned feature flag definitions to server and admin SDKs for local evaluation.",
    tags: ["Feature Flags"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    method: yupString().oneOf(["GET"]).defined(),
    headers: yupObject({
      "if-none-match": yupArray(yupString().defined()).optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupMixed<number>().oneOf([200, 304]).defined(),
    bodyType: yupString().oneOf(["response"]).defined(),
    body: yupMixed<Response>().defined(),
  }),
  handler: async ({ auth, headers }) => {
    if (auth.tenancy.config.apps.installed["feature-flags"]?.enabled !== true) {
      throw new StatusError(StatusError.BadRequest, "Feature flags are not enabled for this project.");
    }
    const config = await withActiveExperimentRuns(
      auth.tenancy,
      parseFeatureFlagsConfig(auth.tenancy.config.featureFlags),
    );
    const bootstrap = createFeatureFlagsBootstrap(config);
    const etag = `"${bootstrap.configVersion}"`;
    // no-transform keeps the validator header: in-process gzip otherwise
    // strips ETag because it would describe the uncompressed bytes.
    const cacheControl = "no-store, max-age=0, no-transform";
    if (ifNoneMatchContains(headers["if-none-match"] ?? [], bootstrap.configVersion)) {
      return {
        statusCode: 304,
        bodyType: "response",
        body: new Response(null, { status: 304, headers: { etag, "cache-control": cacheControl } }),
      };
    }
    return {
      statusCode: 200,
      bodyType: "response",
      body: Response.json({
        config: bootstrap.config,
        flag_ids_by_key: bootstrap.flagIdsByKey,
        config_version: bootstrap.configVersion,
      }, { status: 200, headers: { etag, "cache-control": cacheControl } }),
    };
  },
});
