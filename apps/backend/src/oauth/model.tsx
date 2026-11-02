import { createMfaRequiredError } from "@/app/api/latest/auth/mfa/sign-in/verification-code-handler";
import { usersCrudHandlers } from "@/app/api/latest/users/crud";
import { Prisma } from "@/generated/prisma/client";
import { withExternalDbSyncUpdate } from "@/lib/external-db-sync";
import { checkApiKeySet } from "@/lib/internal-api-keys";
import { PendingOAuthAction, applyPendingOAuthAction } from "@/lib/oauth-pending-actions";
import { getOAuthRedirectUrisForTenancy, isAcceptedNativeAppUrl, validateRedirectUrl } from "@/lib/redirect-urls";
import { getSoleTenancyFromProjectBranch, getTenancy } from "@/lib/tenancies";
import { createRefreshTokenObj, decodeAccessToken, generateAccessTokenFromRefreshTokenIfValid, isRefreshTokenValid } from "@/lib/tokens";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { AuthorizationCode, AuthorizationCodeModel, Client, Falsey, RefreshToken, Token, User } from "@node-oauth/oauth2-server";
import { KnownErrors } from "@hexclave/shared";
import { HexclaveAssertionError, StatusError, captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { getProjectBranchFromClientId } from ".";
const PrismaClientKnownRequestError = Prisma.PrismaClientKnownRequestError;

declare module "@node-oauth/oauth2-server" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Client {}

  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface User {
    email?: string | null;
    oauthProvider?: string;
    pendingOAuthAction?: PendingOAuthAction;
  }
}

const enabledScopes = ["legacy"];

function assertScopeIsValid(scope: string[]) {
  for (const s of scope) {
    if (!checkScope(s)) {
      throw new KnownErrors.InvalidScope(s);
    }
  }
}

function checkScope(scope: string | string[] | undefined) {
  if (typeof scope === "string") {
    return enabledScopes.includes(scope);
  } else if (Array.isArray(scope)){
    return scope.every((s) => enabledScopes.includes(s));
  } else {
    return false;
  }
}

export class OAuthModel implements AuthorizationCodeModel {
  // Host-derived API URL — threaded into `generateAccessToken` so the access
  // token's `iss` claim follows the host the customer's SDK targeted (see
  // `request-api-url.ts`). The OAuthServer that wraps this model is built
  // per-request in `createOAuthServer()` so each request flows through its own
  // model instance with its own apiUrl.
  constructor(private readonly apiUrl: string) {}

  async getClient(clientId: string, clientSecret: string): Promise<Client | Falsey> {
    const tenancy = await getSoleTenancyFromProjectBranch(...getProjectBranchFromClientId(clientId), true);
    if (!tenancy) {
      return false;
    }

    // If client_secret is provided, validate it
    // Note: The specific error handling (sentinel vs invalid key) is done in the route handlers
    // that call this method, as they have more context about the request
    if (clientSecret) {
      const keySet = await checkApiKeySet(tenancy.project.id, { publishableClientKey: clientSecret });
      if (keySet.status === "error") {
        return false;
      }
    }

    let redirectUris: string[] = [];
    try {
      // This may include wildcard domains and the implicit hosted handler domain;
      // model.validateRedirectUri(...) performs the authoritative trust check.
      redirectUris = getOAuthRedirectUrisForTenancy(tenancy);
    } catch (e) {
      captureError("get-oauth-redirect-urls", {
        error: e,
        projectId: tenancy.project.id,
        domains: tenancy.config.domains,
      });
      throw e;
    }

    if (redirectUris.length === 0 && tenancy.config.domains.allowLocalhost) {
      redirectUris.push("http://localhost");
    }

    return {
      id: tenancy.project.id,
      grants: ["authorization_code", "refresh_token"],
      redirectUris: redirectUris,
    };
  }

  async validateScope(user: User | null, client: Client | null, scope?: string[]): Promise<string[] | Falsey> {
    if (!user) {
      return false;
    }

    if (!client) {
      return false;
    }

    return checkScope(scope) ? scope : false;
  }

  async generateAccessToken(client: Client, user: User, scope: string[]): Promise<string> {
    assertScopeIsValid(scope);
    const tenancy = await getSoleTenancyFromProjectBranch(...getProjectBranchFromClientId(client.id));

    const refreshTokenObj = await this._getOrCreateRefreshTokenObj(client, user, scope);

    const accessToken = await generateAccessTokenFromRefreshTokenIfValid({
      tenancy,
      refreshTokenObj,
      apiUrl: this.apiUrl,
    });
    if (!accessToken) {
      // Either the refresh token became invalid between _getOrCreateRefreshTokenObj and now
      // (e.g. a concurrent sign-out deleted the row), or the user was deleted mid-flight.
      throw new KnownErrors.RefreshTokenNotFoundOrExpired();
    }
    return accessToken;
  }

  async _getOrCreateRefreshTokenObj(client: Client, user: User, scope: string[]) {
    const tenancy = await getSoleTenancyFromProjectBranch(...getProjectBranchFromClientId(client.id));

    // if refresh token already exists and is valid, return it
    if (user.refreshTokenId) {
      const refreshTokenObj = await globalPrismaClient.projectUserRefreshToken.findUnique({
        where: {
          tenancyId_id: {
            tenancyId: tenancy.id,
            id: user.refreshTokenId,
          },
        },
      });
      if (refreshTokenObj && refreshTokenObj.projectUserId !== user.id) {
        throw new StatusError(401, "Cross-domain handoff refresh token does not belong to the authenticated user.");
      }
      if (refreshTokenObj && await isRefreshTokenValid({ tenancy, refreshTokenObj })) {
        return refreshTokenObj;
      }
    }

    // otherwise, create a new refresh token and set its ID on the user
    const refreshTokenObj = await createRefreshTokenObj({
      tenancy,
      projectUserId: user.id,
    });
    user.refreshTokenId = refreshTokenObj.id;
    return refreshTokenObj;
  }

  async generateRefreshToken(client: Client, user: User, scope: string[]): Promise<string> {
    assertScopeIsValid(scope);

    const tokenObj = await this._getOrCreateRefreshTokenObj(client, user, scope);
    return tokenObj.refreshToken;
  }

  async saveToken(token: Token, client: Client, user: User): Promise<Token | Falsey> {
    const afterCallbackRedirectUrl = user.afterCallbackRedirectUrl ?? null;

    if (token.refreshToken) {
      const tenancy = await getSoleTenancyFromProjectBranch(...getProjectBranchFromClientId(client.id));
      const prisma = await getPrismaClientForTenancy(tenancy);
      const projectUser = await prisma.projectUser.findUniqueOrThrow({
        where: {
          tenancyId_projectUserId: {
            tenancyId: tenancy.id,
            projectUserId: user.id,
          },
        },
      });
      if (projectUser.requiresTotpMfa) {
        // A link flow returns a User without oauthProvider/email; mirror the callback's
        // link guard so an MFA re-challenge cannot be recorded as a sign-in success.
        const isComplianceSignIn = user.oauthProvider != null;
        throw await createMfaRequiredError({
          project: tenancy.project,
          branchId: tenancy.branchId,
          userId: projectUser.projectUserId,
          isNewUser: false,
          ...(isComplianceSignIn ? {
            method: "oauth" as const,
            email: user.email ?? undefined,
            oauthProvider: user.oauthProvider,
          } : {}),
        });
      }


      await globalPrismaClient.projectUserRefreshToken.upsert({
        where: {
          tenancyId_id: {
            tenancyId: tenancy.id,
            id: user.refreshTokenId,
          },
        },
        update: withExternalDbSyncUpdate({
          refreshToken: token.refreshToken,
          expiresAt: token.refreshTokenExpiresAt,
        }),
        create: {
          refreshToken: token.refreshToken,
          tenancyId: tenancy.id,
          projectUserId: user.id,
        },
      });
    }

    token.client = client;
    token.user = user;
    return {
      accessToken: token.accessToken,
      accessTokenExpiresAt: token.accessTokenExpiresAt,
      refreshToken: token.refreshToken,
      refreshTokenExpiresAt: token.refreshTokenExpiresAt,
      scope: token.scope,
      client: token.client,
      user: token.user,

      // TODO remove deprecated camelCase properties
      newUser: user.newUser,
      is_new_user: user.newUser,
      afterCallbackRedirectUrl: afterCallbackRedirectUrl,
      after_callback_redirect_url: afterCallbackRedirectUrl,
    };
  }

  async getAccessToken(accessToken: string): Promise<Token | Falsey> {
    const result = await decodeAccessToken(accessToken, { allowAnonymous: true, allowRestricted: true });
    if (result.status === "error") {
      captureError("getAccessToken", result.error);
      return false;
    }
    const decoded = result.data;

    return {
      accessToken,
      accessTokenExpiresAt: new Date(decoded.exp * 1000),
      user: {
        id: decoded.userId,
      },
      client: {
        id: decoded.projectId,
        grants: ["authorization_code", "refresh_token"],
      },
      scope: enabledScopes,
    };
  }

  async getRefreshToken(refreshToken: string): Promise<RefreshToken | Falsey> {
    const token = await globalPrismaClient.projectUserRefreshToken.findUnique({
      where: {
        refreshToken,
      },
    });

    if (!token) {
      return false;
    }

    const tenancy = await getTenancy(token.tenancyId);

    if (!tenancy) {
      // this may trigger when the tenancy was deleted after the token was created
      return false;
    }

    if (!(await isRefreshTokenValid({ tenancy, refreshTokenObj: token }))) {
      return false;
    }

    return {
      refreshToken,
      refreshTokenExpiresAt: token.expiresAt === null ? undefined : token.expiresAt,
      user: {
        id: token.projectUserId,
        refreshTokenId: token.id,
      },
      client: {
        id: tenancy.project.id,
        grants: ["authorization_code", "refresh_token"],
      },
      scope: enabledScopes,
    };
  }

  async revokeToken(token: RefreshToken): Promise<boolean> {
    // No refreshToken rotation for now (see Git history for old code)
    return true;
  }

  async verifyScope(token: Token, scope: string[]): Promise<boolean> {
    return checkScope(scope);
  }

  async saveAuthorizationCode(
    code: Pick<AuthorizationCode, 'authorizationCode' | 'expiresAt' | 'redirectUri' | 'scope' | 'codeChallenge' | 'codeChallengeMethod'>,
    client: Client,
    user: User
  ): Promise<AuthorizationCode | Falsey> {
    if (!code.scope) {
      throw new KnownErrors.InvalidScope("<empty string>");
    }
    assertScopeIsValid(code.scope);
    const tenancy = await getSoleTenancyFromProjectBranch(...getProjectBranchFromClientId(client.id));

    if (!validateRedirectUrl(code.redirectUri, tenancy) && !isAcceptedNativeAppUrl(code.redirectUri)) {
      throw new KnownErrors.RedirectUrlNotWhitelisted(code.redirectUri);
    }

    if (!code.codeChallenge || code.codeChallengeMethod !== "S256") {
      throw new HexclaveAssertionError("Refusing to persist an OAuth authorization code without a valid S256 PKCE challenge; this should have been rejected at the authorize endpoint.", { hasChallenge: !!code.codeChallenge, codeChallengeMethod: code.codeChallengeMethod });
    }

    await globalPrismaClient.projectUserAuthorizationCode.create({
      data: {
        authorizationCode: code.authorizationCode,
        codeChallenge: code.codeChallenge,
        codeChallengeMethod: code.codeChallengeMethod,
        redirectUri: code.redirectUri,
        expiresAt: code.expiresAt,
        projectUserId: user.id,
        newUser: user.newUser,
        afterCallbackRedirectUrl: user.afterCallbackRedirectUrl,
        grantedRefreshTokenId: user.refreshTokenId,
        pendingOAuthAction: user.pendingOAuthAction,
        tenancyId: tenancy.id,
      },
    });

    return {
      authorizationCode: code.authorizationCode,
      expiresAt: code.expiresAt,
      redirectUri: code.redirectUri,
      scope: enabledScopes,
      client: {
        id: client.id,
        grants: ["authorization_code", "refresh_token"],
      },
      user,
    };
  }

  async getAuthorizationCode(authorizationCode: string): Promise<AuthorizationCode | Falsey> {
    const code = await globalPrismaClient.projectUserAuthorizationCode.findUnique({
      where: {
        authorizationCode,
      },
    });

    if (!code) {
      return false;
    }

    const tenancy = await getTenancy(code.tenancyId);

    if (!tenancy) {
      // this may trigger when the tenancy was deleted after the code was created
      return false;
    }

    try {
      await usersCrudHandlers.adminRead({
        tenancy,
        user_id: code.projectUserId,
        allowedErrorTypes: [KnownErrors.UserNotFound],
      });
    } catch (error) {
      if (error instanceof KnownErrors.UserNotFound) {
        // this may trigger when the user was deleted after the code was created
        return false;
      }
      throw error;
    }

    return {
      authorizationCode: code.authorizationCode,
      expiresAt: code.expiresAt,
      redirectUri: code.redirectUri,
      scope: enabledScopes,
      codeChallenge: code.codeChallenge,
      codeChallengeMethod: code.codeChallengeMethod,
      client: {
        // TODO once we support branches, the branch ID should be included here
        id: tenancy.project.id,
        grants: ["authorization_code", "refresh_token"],
      },
      user: {
        id: code.projectUserId,
        newUser: code.newUser,
        afterCallbackRedirectUrl: code.afterCallbackRedirectUrl ?? undefined,
        refreshTokenId: code.grantedRefreshTokenId ?? undefined,
      },
    };
  }

  async revokeAuthorizationCode(code: AuthorizationCode): Promise<boolean> {
    let deletedCode;
    try {
      deletedCode = await globalPrismaClient.projectUserAuthorizationCode.delete({
        where: {
          authorizationCode: code.authorizationCode,
        },
      });
    } catch (error) {
      if (!(error instanceof PrismaClientKnownRequestError)) {
        throw error;
      }
      return false;
    }

    // The OAuth library calls this right after verifying the PKCE code_verifier and before minting any tokens,
    // which makes it the earliest point where we know the redeemer is the party that started the flow. The
    // delete above is the atomic single-use claim, so the action runs at most once. It also has to run before
    // tokens are minted, as the access token's claims (e.g. is_anonymous) must reflect the applied action.
    if (deletedCode.pendingOAuthAction != null) {
      const tenancy = await getTenancy(deletedCode.tenancyId)
        ?? throwErr("Tenancy of authorization code not found, but getAuthorizationCode just checked that it exists", { tenancyId: deletedCode.tenancyId });
      await applyPendingOAuthAction({
        tenancy,
        projectUserId: deletedCode.projectUserId,
        rawAction: deletedCode.pendingOAuthAction,
      });
    }

    return true;
  }

  async validateRedirectUri(redirect_uri: string, client: Client): Promise<boolean> {
    // Accept native app OAuth URLs without trusted domain configuration
    if (isAcceptedNativeAppUrl(redirect_uri)) {
      return true;
    }

    const tenancy = await getSoleTenancyFromProjectBranch(...getProjectBranchFromClientId(client.id));

    return validateRedirectUrl(redirect_uri, tenancy);
  }
}
