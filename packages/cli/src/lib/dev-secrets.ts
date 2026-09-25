// `hexclave dev --service-id` pulls `secret()` values from the linked cloud
// project (the one `hexclave deploy` targets), like `railway run` or
// `vercel env pull`: `dev` values first, then `all`. NOT from the development
// environment's own project — that one is a throwaway project the local
// dashboard creates per config file, and nobody sets secrets on it.
//
// Always authenticated as the logged-in user, even when
// HEXCLAVE_SECRET_SERVER_KEY is set: the resolve endpoint is admin-only on
// purpose, so a CI key can never be used to print plaintext secrets.

import { resolveProjectId, resolveSessionAuth, type ProjectAuthWithRefreshToken } from "./auth.js";
import { CliError } from "./errors.js";
import { buildProjectAuthHeadersFactory, projectApiFetch } from "./project-api.js";

export async function resolveDevSecretsFromLinkedProject(options: {
  cloudProjectId: string | undefined,
  keys: string[],
}): Promise<Map<string, string>> {
  if (options.keys.length === 0) return new Map();
  const projectId = resolveProjectId(options.cloudProjectId, [
    `This service's env references ${options.keys.length === 1 ? "a secret" : `${options.keys.length} secrets`} (${options.keys.join(", ")}), which \`hexclave dev\` pulls from your cloud project.`,
    "Pass --cloud-project-id <id> or set the HEXCLAVE_PROJECT_ID environment variable to the project you deploy to.",
  ].join(" "));
  const auth: ProjectAuthWithRefreshToken = { ...resolveSessionAuth(), projectId };
  const authHeaders = await buildProjectAuthHeadersFactory(auth);
  const body = await projectApiFetch(auth, authHeaders, "/project-secrets/resolve", {
    method: "POST",
    jsonBody: { environment: "dev", keys: options.keys },
    failureLabel: `Failed to pull secrets for \`hexclave dev\` from project ${projectId}`,
  });
  const values = body?.values;
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new CliError("The Hexclave API returned an invalid secret-resolve response.");
  }
  const resolved = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string") {
      throw new CliError("The Hexclave API returned an invalid secret-resolve response.");
    }
    resolved.set(key, value);
  }
  return resolved;
}
