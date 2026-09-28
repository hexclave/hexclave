import { MAX_PROJECT_SECRET_KEY_LENGTH, PROJECT_SECRET_KEY_REGEX } from "@/lib/project-secrets";
import { globalPrismaClient } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const DELETE = createSmartRouteHandler({
  metadata: {
    summary: "Delete project secret",
    description: "Deletes a stored project secret value. Deploys of services whose env vars reference the secret will fail afterwards unless the deploy supplies a default value for it.",
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
    method: yupString().oneOf(["DELETE"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      success: yupBoolean().oneOf([true]).defined(),
    }).defined(),
  }),
  handler: async ({ auth, params }) => {
    const deleted = await globalPrismaClient.projectSecret.deleteMany({
      where: {
        projectId: auth.tenancy.project.id,
        key: params.key,
      },
    });
    if (deleted.count === 0) {
      throw new StatusError(404, `No secret with key ${JSON.stringify(params.key)} exists in this project.`);
    }
    return {
      statusCode: 200,
      bodyType: "json",
      body: { success: true },
    };
  },
});
