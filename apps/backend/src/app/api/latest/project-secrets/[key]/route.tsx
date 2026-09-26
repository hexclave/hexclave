import { MAX_PROJECT_SECRET_KEY_LENGTH, PROJECT_SECRET_ENVIRONMENTS, PROJECT_SECRET_KEY_REGEX } from "@/lib/project-secrets";
import { globalPrismaClient } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const DELETE = createSmartRouteHandler({
  metadata: {
    summary: "Delete project secret",
    description: "Deletes the stored value of a project secret for one environment, or — when `environment` is omitted — every environment's value of the key. Deploys of services whose env vars reference the secret will fail afterwards unless another environment (or `all`) still satisfies the resolve.",
    tags: ["Secrets"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      key: yupString().defined().max(MAX_PROJECT_SECRET_KEY_LENGTH, "Secret keys may be at most ${max} characters long").matches(PROJECT_SECRET_KEY_REGEX, "Secret keys must contain only letters, numbers, underscores, and hyphens"),
    }).defined(),
    query: yupObject({
      // Omitted = the whole key, which is what a key-only DELETE meant before
      // per-environment values existed. Defaulting to `all` instead would 404
      // an older client deleting a key it listed as, say, prod-only.
      environment: yupString().oneOf([...PROJECT_SECRET_ENVIRONMENTS]).optional(),
    }).defined(),
    method: yupString().oneOf(["DELETE"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      success: yupBoolean().oneOf([true]).defined(),
    }).defined(),
  }),
  handler: async ({ auth, params, query }) => {
    const deleted = await globalPrismaClient.projectSecret.deleteMany({
      where: {
        projectId: auth.tenancy.project.id,
        key: params.key,
        ...(query.environment === undefined ? {} : { environment: query.environment }),
      },
    });
    if (deleted.count === 0) {
      throw new StatusError(404, query.environment === undefined
        ? `No secret with key ${JSON.stringify(params.key)} exists in this project.`
        : `No secret with key ${JSON.stringify(params.key)} exists in this project for environment ${JSON.stringify(query.environment)}.`);
    }
    return {
      statusCode: 200,
      bodyType: "json",
      body: { success: true },
    };
  },
});
