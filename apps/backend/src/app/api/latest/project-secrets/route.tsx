import { MAX_PROJECT_SECRET_KEY_LENGTH, MAX_SECRETS_PER_PROJECT, MAX_SECRET_VALUE_LENGTH, PROJECT_SECRET_ENVIRONMENTS, PROJECT_SECRET_KEY_REGEX, countDistinctProjectSecretKeys, listProjectSecrets, projectSecretEnvironmentFromPrisma, projectSecretEnvironmentToPrisma } from "@/lib/project-secrets";
import { globalPrismaClient, retryTransaction } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { encryptWithKms } from "@hexclave/shared/dist/helpers/vault/server-side";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupArray, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

// The project's secret store. WRITE-ONLY on list/GET: values can be set,
// overwritten, and deleted, but never read back through those paths. The
// admin-only resolve route (used by `hexclave dev`, under /internal so it can't
// shadow a secret named "resolve" in /project-secrets/[key]) is the exception.
// Keyed by (project, key, environment).

const environmentSchema = yupString().oneOf([...PROJECT_SECRET_ENVIRONMENTS]).defined();

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "List project secrets",
    description: "Lists the keys and environments of the project's stored secrets (never their values — secrets are write-only on this path). Used by the dashboard's secrets page and by `hexclave deploy`'s pre-flight check for missing secrets.",
    tags: ["Secrets"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      items: yupArray(yupObject({
        key: yupString().defined(),
        environment: environmentSchema,
        created_at_millis: yupNumber().defined(),
        updated_at_millis: yupNumber().defined(),
      }).defined()).defined(),
    }).defined(),
  }),
  handler: async ({ auth }) => {
    const secrets = await listProjectSecrets(auth.tenancy.project.id);
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        items: secrets.map((secret) => ({
          key: secret.key,
          environment: secret.environment,
          created_at_millis: secret.createdAt.getTime(),
          updated_at_millis: secret.updatedAt.getTime(),
        })),
      },
    };
  },
});

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Set project secret",
    description: "Sets (or overwrites) the value of a project secret for one environment (`environment`) or for several at once (`environments`, written atomically). The value is envelope-encrypted with KMS before it is stored and can never be read back on list/GET — it is only decrypted server-side by a deploy or the admin resolve endpoint.",
    tags: ["Secrets"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    body: yupObject({
      key: yupString().defined().max(MAX_PROJECT_SECRET_KEY_LENGTH, "Secret keys may be at most ${max} characters long").matches(PROJECT_SECRET_KEY_REGEX, "Secret keys must contain only letters, numbers, underscores, and hyphens"),
      value: yupString().defined(),
      // `environment` writes one cell; `environments` writes several in one
      // transaction, so the dashboard's multi-environment Add can't leave
      // only some of them saved. Clients from before `environments` send (at
      // most) `environment`, hence both.
      environment: yupString().oneOf([...PROJECT_SECRET_ENVIRONMENTS]).optional(),
      environments: yupArray(environmentSchema).optional(),
    }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      key: yupString().defined(),
      items: yupArray(yupObject({
        environment: environmentSchema,
        created: yupBoolean().defined(),
      }).defined()).defined(),
    }).defined(),
  }),
  handler: async ({ auth, body }) => {
    if (body.value.length === 0) {
      throw new StatusError(400, "Secret values must not be empty. To remove a secret, delete it instead.");
    }
    if (body.value.length > MAX_SECRET_VALUE_LENGTH) {
      throw new StatusError(400, `Secret values must be at most ${MAX_SECRET_VALUE_LENGTH} characters.`);
    }
    if (body.environment !== undefined && body.environments !== undefined) {
      throw new StatusError(400, "Pass either `environment` or `environments`, not both.");
    }
    // Clients from before per-environment values send no environment; their
    // secrets were always "applies everywhere", which is exactly `default`.
    const environments = body.environments ?? [body.environment ?? "default"];
    if (environments.length === 0) {
      throw new StatusError(400, "`environments` must name at least one environment.");
    }
    if (new Set(environments).size !== environments.length) {
      throw new StatusError(400, "`environments` must not name an environment twice.");
    }
    const projectId = auth.tenancy.project.id;
    const existingRows = await globalPrismaClient.projectSecret.findMany({
      where: { projectId, key: body.key },
      select: { environment: true },
    });
    const existingEnvironments = new Set(existingRows.map((row) => projectSecretEnvironmentFromPrisma(row.environment)));
    // Soft cap on distinct KEYS, checked only when this would add a new key
    // (overwrites, and new environments of an existing key, are always
    // allowed). Not atomic with the write, so a burst of concurrent creates can
    // slightly overshoot — fine for a work bound, it is not an exact quota.
    // (Same for `created` below: two concurrent first-time sets may both report
    // created: true, which is response-cosmetic.)
    if (existingRows.length === 0) {
      const count = await countDistinctProjectSecretKeys(projectId);
      if (count >= MAX_SECRETS_PER_PROJECT) {
        throw new StatusError(400, `This project already has ${MAX_SECRETS_PER_PROJECT} secrets (the maximum). Delete unused secrets first.`);
      }
    }
    // Encrypted before the transaction: each KMS call is a network round trip,
    // which shouldn't hold the transaction open.
    const writes = await Promise.all(environments.map(async (environment) => ({
      environment,
      encrypted: await encryptWithKms(body.value),
    })));
    await retryTransaction(globalPrismaClient, async (tx) => {
      for (const { environment, encrypted } of writes) {
        const prismaEnvironment = projectSecretEnvironmentToPrisma(environment);
        await tx.projectSecret.upsert({
          where: {
            projectId_key_environment: {
              projectId,
              key: body.key,
              environment: prismaEnvironment,
            },
          },
          update: {
            encrypted,
          },
          create: {
            projectId,
            key: body.key,
            environment: prismaEnvironment,
            encrypted,
          },
        });
      }
    });
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        key: body.key,
        items: environments.map((environment) => ({
          environment,
          created: !existingEnvironments.has(environment),
        })),
      },
    };
  },
});
