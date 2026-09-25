import { MAX_PROJECT_SECRET_KEY_LENGTH, MAX_SECRETS_PER_PROJECT, PROJECT_SECRET_KEY_REGEX, readProjectSecretValues } from "@/lib/project-secrets";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupArray, yupNumber, yupObject, yupRecord, yupString } from "@hexclave/shared/dist/schema-fields";
// Admin-only resolve that `hexclave dev` calls directly with the developer's
// login. Returns decrypted values for the requested keys for the `dev`
// environment (else `all`). Not used by the dashboard list, and not available
// to secret-server-key-only CI — that would dump plaintext secrets into CI logs.

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Resolve project secrets for local development",
    description: "Decrypts the requested secret keys for the `dev` environment (falling back to `all`). Keys with neither are omitted from `values`. Admin session only — not secret-server-key. Used by `hexclave dev`; the dashboard never displays these values.",
    tags: ["Secrets"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    body: yupObject({
      environment: yupString().oneOf(["dev"]).defined(),
      // A project can't hold more distinct keys than this, so a longer list can
      // only be a mistake (or an attempt to make the request expensive).
      keys: yupArray(yupString().defined().max(MAX_PROJECT_SECRET_KEY_LENGTH).matches(PROJECT_SECRET_KEY_REGEX)).max(MAX_SECRETS_PER_PROJECT).defined(),
    }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      values: yupRecord(yupString().defined(), yupString().defined()).defined(),
    }).defined(),
  }),
  handler: async ({ auth, body }) => {
    // Keys without a `dev` or `all` value are left out rather than failing the
    // request: the caller (`hexclave dev`) owns the user-facing "missing
    // secrets" error, which can say which env vars need them and how to fix it.
    const values = await readProjectSecretValues(auth.tenancy.project.id, body.keys, "dev");
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        values: Object.fromEntries(values),
      },
    };
  },
});
