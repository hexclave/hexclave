import "../polyfills";

import { getUser, getUserIfOnGlobalPrismaClientQuery } from "@/app/api/latest/users/crud";
import { checkApiKeySet, checkApiKeySetQuery } from "@/lib/internal-api-keys";
import { getProjectQuery, listManagedProjectIds } from "@/lib/projects";
import { DEFAULT_BRANCH_ID, Tenancy, getSoleTenancyFromProjectBranchQuery } from "@/lib/tenancies";
import { decodeAccessToken } from "@/lib/tokens";
import { authenticateWorkflowRunTokenRequestOrThrow, getWorkflowRunTokenForRequest } from "@/lib/workflows/run-token";
import { globalPrismaClient, rawQueryAll } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared";
import { ProjectsCrud } from "@hexclave/shared/dist/interface/crud/projects";
import { UsersCrud } from "@hexclave/shared/dist/interface/crud/users";
import { HexclaveAdaptSentinel, yupValidate } from "@hexclave/shared/dist/schema-fields";
import { groupBy, typedIncludes } from "@hexclave/shared/dist/utils/arrays";
import { getEnvVariable, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError, StatusError, captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { deindent } from "@hexclave/shared/dist/utils/strings";
import { traceSpan, withTraceSpan } from "@hexclave/shared/dist/utils/telemetry";
import * as yup from "yup";

const allowedMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export type SmartRequestAuth = {
  project: Omit<ProjectsCrud["Admin"]["Read"], "config">,
  branchId: string,
  tenancy: Tenancy,
  user?: UsersCrud["Admin"]["Read"] | undefined,
  /**
   * The internal-project admin who presented `x-stack-admin-access-token`.
   * Distinct from `user`, which is the end-user access-token identity on the
   * target project (usually absent on dashboard admin calls).
   */
  adminUser?: UsersCrud["Admin"]["Read"] | undefined,
  type: "client" | "server" | "admin",
  refreshTokenId?: string,
  /**
   * True when auth was synthesized by programmatic CRUD helpers (adminUpdate,
   * etc.). Absent on real HTTP requests. Used so admin audit logging does not
   * treat internal signup/self-service paths as dashboard actions.
   */
  isProgrammaticInvocation?: boolean,
};

export type DeepPartialSmartRequestWithSentinel<T = SmartRequest> = (T extends object ? {
  [P in keyof T]?: DeepPartialSmartRequestWithSentinel<T[P]>
} : T) | HexclaveAdaptSentinel;

export type SmartRequest = {
  auth: SmartRequestAuth | null,
  url: string,
  method: typeof allowedMethods[number],
  body: unknown,
  bodyBuffer: ArrayBuffer,
  headers: Record<string, string[] | undefined>,
  query: Record<string, string | undefined>,
  params: Record<string, string | undefined>,
  clientVersion: {
    platform: string,
    sdk: string,
    version: string,
  } | undefined,
};

export type MergeSmartRequest<T, MSQ = SmartRequest> =
  HexclaveAdaptSentinel extends T
  ? NonNullable<MSQ> | (MSQ & Exclude<T, HexclaveAdaptSentinel>)
  : (
    T extends (infer U)[]
    ? (
      MSQ extends (infer V)[]
      ? (T & MSQ) & { [K in keyof T & keyof MSQ]: MergeSmartRequest<T[K], MSQ[K]> }
      : (T & MSQ)
    )
    : (
      T extends object
      ? (
        MSQ extends object
        ? { [K in keyof T & keyof MSQ]: MergeSmartRequest<T[K], MSQ[K]> }
        : (T & MSQ)
      )
      : (T & MSQ)
    )
  );

async function validate<T>(obj: SmartRequest, schema: yup.Schema<T>, req: Request | null): Promise<T> {
  try {
    return await yupValidate(schema, obj, {
      abortEarly: false,
      context: {
        noUnknownPathPrefixes: ["body", "query", "params"],
      },
      currentUserId: obj.auth?.user?.id ?? null,
    });
  } catch (error) {
    if (error instanceof yup.ValidationError) {
      if (req === null) {
        // we weren't called by a HTTP request, so it must be a logical error in a manual invocation
        throw new HexclaveAssertionError("Request validation failed", { cause: error });
      } else {
        const inners = error.inner.length ? error.inner : [error];
        const description = schema.describe();

        for (const inner of inners) {
          if (inner.path === "auth" && inner.type === "nullable" && inner.value === null) {
            throw new KnownErrors.AccessTypeRequired;
          }
          if (inner.path === "auth.type" && inner.type === "oneOf") {
            // Project access type not sufficient
            const authTypeField = ((description as yup.SchemaObjectDescription).fields["auth"] as yup.SchemaObjectDescription).fields["type"] as yup.SchemaDescription;
            throw new KnownErrors.InsufficientAccessType(inner.value, authTypeField.oneOf as any[]);
          }
        }

        throw new KnownErrors.SchemaError(
          deindent`
            Request validation failed on ${req.method} ${new URL(req.url).pathname}:
              ${inners.map(e => deindent`
                - ${e.message}
              `).join("\n")}
          `,
        );
      }
    }
    throw error;
  }
}


async function parseBody(req: Request, bodyBuffer: ArrayBuffer): Promise<SmartRequest["body"]> {
  const contentType = req.method === "GET" || req.method === "HEAD" ? undefined : req.headers.get("content-type")?.split(";")[0];

  const getText = () => {
    try {
      return new TextDecoder().decode(bodyBuffer);
    } catch (e) {
      throw new KnownErrors.BodyParsingError("Request body cannot be parsed as UTF-8");
    }
  };

  switch (contentType) {
    case "":
    case undefined: {
      return undefined;
    }
    case "application/json": {
      const text = getText();
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new KnownErrors.BodyParsingError("Invalid JSON in request body");
      }
    }
    case "application/octet-stream": {
      return bodyBuffer;
    }
    case "text/plain": {
      return getText();
    }
    case "application/x-www-form-urlencoded": {
      const text = getText();
      try {
        return Object.fromEntries(new URLSearchParams(text).entries());
      } catch (e) {
        throw new KnownErrors.BodyParsingError("Invalid form data in request body");
      }
    }
    default: {
      throw new KnownErrors.BodyParsingError("Unknown content type in request body: " + contentType);
    }
  }
}

const parseAuth = withTraceSpan('smart request parseAuth', async (req: Request): Promise<SmartRequestAuth | null> => {
  const projectId = req.headers.get("x-stack-project-id");
  const branchId = req.headers.get("x-stack-branch-id") ?? DEFAULT_BRANCH_ID;
  let requestType = req.headers.get("x-stack-access-type");
  const publishableClientKey = req.headers.get("x-stack-publishable-client-key");
  const secretServerKey = req.headers.get("x-stack-secret-server-key");
  const superSecretAdminKey = req.headers.get("x-stack-super-secret-admin-key");
  const adminAccessToken = req.headers.get("x-stack-admin-access-token");
  const accessToken = req.headers.get("x-stack-access-token");
  const developmentKeyOverride = req.headers.get("x-stack-development-override-key");  // in development, the internal project's API key can optionally be used to access any project
  const allowAnonymousUser = req.headers.get("x-stack-allow-anonymous-user") === "true";
  const allowRestrictedUser = allowAnonymousUser || req.headers.get("x-stack-allow-restricted-user") === "true";

  // Ensure header combinations are valid
  const eitherKeyOrToken = !!(publishableClientKey || secretServerKey || superSecretAdminKey || adminAccessToken);
  if (!requestType && eitherKeyOrToken) {
    throw new KnownErrors.ProjectKeyWithoutAccessType();
  }
  if (!requestType) return null;
  if (!typedIncludes(["client", "server", "admin"] as const, requestType)) throw new KnownErrors.InvalidAccessType(requestType);
  if (!projectId) throw new KnownErrors.AccessTypeWithoutProjectId(requestType);

  // Workflow sandboxes authenticate with a signed, run-scoped token that rides
  // in the ordinary secret-server-key header. It is a server credential, so
  // this is null on admin-type requests; the full design (and why one shared
  // predicate decides this) lives in lib/workflows/run-token.tsx.
  const workflowRunToken = getWorkflowRunTokenForRequest({ requestType, secretServerKey });

  const extractUserIdAndRefreshTokenIdFromAccessToken = async (options: { token: string, projectId: string, allowAnonymous: boolean, allowRestricted: boolean }) => {
    const result = await decodeAccessToken(options.token, { allowAnonymous: /* always true as we check for anonymous users later */ true, allowRestricted: /* always true as we check for restricted users later */ true });
    if (result.status === "error") {
      throw result.error;
    }

    if (result.data.projectId !== options.projectId) {
      throw new KnownErrors.InvalidProjectForAccessToken(options.projectId, result.data.projectId);
    }

    // Check if anonymous user is allowed
    if (result.data.isAnonymous && !options.allowAnonymous) {
      throw new KnownErrors.AnonymousAuthenticationNotAllowed();
    }

    // Check if restricted user is allowed
    if (result.data.restrictedReason && !options.allowRestricted) {
      throw new KnownErrors.RestrictedUserNotAllowed(result.data.restrictedReason);
    }

    return {
      userId: result.data.userId,
      refreshTokenId: result.data.refreshTokenId,
    };
  };

  const extractUserFromAdminAccessToken = async (options: { token: string, projectId: string, allowAnonymous: boolean }) => {
    const result = await decodeAccessToken(options.token, {
      allowAnonymous: options.allowAnonymous,
      // Anonymous dev-environment tokens may be restricted; non-anonymous restricted tokens are rejected below after decoding.
      allowRestricted: options.allowAnonymous,
    });
    if (result.status === "error") {
      if (KnownErrors.AccessTokenExpired.isInstance(result.error)) {
        throw new KnownErrors.AdminAccessTokenExpired(result.error.constructorArgs[0]);
      } else {
        throw new KnownErrors.UnparsableAdminAccessToken();
      }
    }

    if (result.data.projectId !== "internal") {
      throw new KnownErrors.AdminAccessTokenIsNotAdmin();
    }
    if (result.data.restrictedReason != null && !result.data.isAnonymous) {
      throw new KnownErrors.AdminAccessTokenIsNotAdmin();
    }
    if (result.data.isAnonymous && !options.allowAnonymous) {
      throw new KnownErrors.AdminAccessTokenIsNotAdmin();
    }

    const user = await getUser({ projectId: 'internal', branchId: DEFAULT_BRANCH_ID, userId: result.data.userId });
    if (!user) {
      // this is the case when access token is still valid, but the user is deleted from the database
      // this should be very rare, let's log it on Sentry when it happens
      captureError("admin-access-token-expiration", new HexclaveAssertionError("User not found for admin access token. This may not be a bug, but it's worth investigating"));
      throw new StatusError(401, "The user associated with the admin access token is no longer valid. Please refresh the admin access token and try again.");
    }

    const allProjects = await listManagedProjectIds(user);
    if (!allProjects.includes(options.projectId)) {
      throw new KnownErrors.AdminAccessTokenIsNotAdmin();
    }

    return user;
  };

  const { userId, refreshTokenId } = projectId && accessToken ? await extractUserIdAndRefreshTokenIdFromAccessToken({ token: accessToken, projectId, allowAnonymous: allowAnonymousUser, allowRestricted: allowRestrictedUser }) : { userId: null, refreshTokenId: null };

  // Prisma does a query for every function call by default, even if we batch them with transactions
  // Because smart route handlers are always called, we instead send over a single raw query that fetches all the
  // data at the same time, saving us a lot of requests
  //
  // The user usually requires knowledge of the source-of-truth database, which would mean it would require us two
  // roundtrips (one to the global database to fetch the project/tenancy, and one to the source-of-truth database to
  // fetch the user). However, more often than not, the user is on the global database, so we optimistically fetch
  // the user from the global database and only fall back to the source-of-truth database if we later determine that
  // the user is not on the global database.
  const bundledQueries = {
    userIfOnGlobalPrismaClient: userId ? getUserIfOnGlobalPrismaClientQuery(projectId, branchId, userId) : undefined,
    isClientKeyValid: publishableClientKey && requestType === "client" ? checkApiKeySetQuery(projectId, { publishableClientKey }) : undefined,
    // A workflow run token occupies the same header as a secret server key but
    // is authenticated below, not by an ApiKeySet lookup; a `wrt_` value can
    // never match a key row, so skip the lookup when — and only when — the
    // run-token branch below will actually run. Both conditions read the same
    // predicate so they cannot drift apart into a dereference of a query that
    // was never built. The admin header gets no such treatment: a run token
    // there is not an admin credential, and letting the ordinary lookup fail
    // is exactly right.
    isServerKeyValid: secretServerKey && requestType === "server" && workflowRunToken == null ? checkApiKeySetQuery(projectId, { secretServerKey }) : undefined,
    isAdminKeyValid: superSecretAdminKey && requestType === "admin" ? checkApiKeySetQuery(projectId, { superSecretAdminKey }) : undefined,
    project: getProjectQuery(projectId),
    tenancy: getSoleTenancyFromProjectBranchQuery(projectId, branchId, true),
  };
  const queriesResults = await rawQueryAll(globalPrismaClient, bundledQueries);
  const project = await queriesResults.project;
  if (project === null) throw new KnownErrors.CurrentProjectNotFound(projectId);  // this does allow one to probe whether a project exists or not, but that's fine (it's worth the better error messages)
  const tenancy = await queriesResults.tenancy;
  const isClientKeyValid = await queriesResults.isClientKeyValid;
  const isServerKeyValid = await queriesResults.isServerKeyValid;
  const isAdminKeyValid = await queriesResults.isAdminKeyValid;
  const requiresPublishableClientKey = tenancy?.config.project.requirePublishableClientKey ?? true;

  let adminUser: UsersCrud["Admin"]["Read"] | undefined;
  if (developmentKeyOverride) {
    if (!["development", "test"].includes(getNodeEnvironment()) && getEnvVariable("STACK_ALLOW_DEVELOPMENT_KEY_OVERRIDE_DESPITE_PRODUCTION", "") !== "this-is-dangerous") {  // it's not actually that dangerous, but it changes the security model
      throw new StatusError(401, "Development key override is only allowed in development or test environments");
    }
    const result = await checkApiKeySet("internal", { superSecretAdminKey: developmentKeyOverride });
    if (result.status === "error") throw new StatusError(401, "Invalid development key override");
  } else if (workflowRunToken != null) {
    // Server-scoped: the predicate that produced this token already excluded
    // admin-type requests, which take the admin-access-token branch below or
    // the switch's admin case instead. On rejection this throws the same
    // KnownError an invalid real secret server key would — the
    // failure/logging policy lives with the token implementation.
    await authenticateWorkflowRunTokenRequestOrThrow({
      token: workflowRunToken,
      projectId,
      branchId,
      tenancyId: tenancy?.id ?? null,
    });
  } else if (adminAccessToken) {
    // TODO put this into the bundled queries above (not so important because this path is quite rare)
    // Capture the return value: audit logging needs the internal-project actor,
    // and we previously discarded it after only validating the token.
    adminUser = await extractUserFromAdminAccessToken({
      token: adminAccessToken,
      projectId,
      allowAnonymous: project.is_development_environment,
    });
  } else {
    switch (requestType) {
      case "client": {
        if (!publishableClientKey) {
          if (requiresPublishableClientKey) {
            throw new KnownErrors.PublishableClientKeyRequiredForProject(projectId);
          }
          break;
        }
        if (isClientKeyValid.status === "error") {
          if (isClientKeyValid.error === "publishable-key-required") {
            throw new KnownErrors.PublishableClientKeyRequiredForProject(projectId);
          }
          throw new KnownErrors.InvalidPublishableClientKey(projectId);
        }
        break;
      }
      case "server": {
        if (!secretServerKey) throw new KnownErrors.ServerAuthenticationRequired();
        if (isServerKeyValid.status === "error") throw new KnownErrors.InvalidSecretServerKey(projectId);
        break;
      }
      case "admin": {
        if (!superSecretAdminKey) throw new KnownErrors.AdminAuthenticationRequired();
        if (isAdminKeyValid.status === "error") throw new KnownErrors.InvalidSuperSecretAdminKey(projectId);
        break;
      }
      default: {
        throw new HexclaveAssertionError(`Unexpected request type: ${requestType}. This should never happen because we should've filtered this earlier`);
      }
    }
  }

  if (!tenancy) {
    // note that we only check branch existence here so you can't probe branches unless you have the project keys
    throw new KnownErrors.BranchDoesNotExist(branchId);
  }

  const user = await queriesResults.userIfOnGlobalPrismaClient;

  return {
    project,
    branchId,
    refreshTokenId: refreshTokenId ?? undefined,
    tenancy,
    user: user ?? undefined,
    adminUser,
    type: requestType,
  };
});

export async function createSmartRequest(req: Request, bodyBuffer: ArrayBuffer, options?: { params: Promise<Record<string, string>> }): Promise<SmartRequest> {
  return await traceSpan("creating smart request", async () => {
    const urlObject = new URL(req.url);
    const clientVersionMatch = req.headers.get("x-stack-client-version")?.match(/^(\w+)\s+(@[\w\/]+)@([\d.]+)$/);

    return {
      url: req.url,
      method: typedIncludes(allowedMethods, req.method) ? req.method : throwErr(new StatusError(405, "Method not allowed")),
      body: await parseBody(req, bodyBuffer),
      bodyBuffer,
      headers: Object.fromEntries(
        [...groupBy(req.headers.entries(), ([key, _]) => key.toLowerCase())]
          .map(([key, values]) => [key, values.map(([_, value]) => value)]),
      ),
      query: Object.fromEntries(urlObject.searchParams.entries()),
      params: await options?.params ?? {},
      auth: await parseAuth(req),
      clientVersion: clientVersionMatch ? {
        platform: clientVersionMatch[1],
        sdk: clientVersionMatch[2],
        version: clientVersionMatch[3],
      } : undefined,
    } satisfies SmartRequest;
  });
}

export async function validateSmartRequest<T extends DeepPartialSmartRequestWithSentinel>(nextReq: Request | null, smartReq: SmartRequest, schema: yup.Schema<T>): Promise<T> {
  return await validate(smartReq, schema, nextReq);
}
