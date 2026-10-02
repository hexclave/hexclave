import { OAuthUserInfo, validateUserInfo } from "../utils";
import { OAuthBaseProvider, TokenSet } from "./base";

export class CustomOidcProvider extends OAuthBaseProvider {
  private constructor(
    ...args: ConstructorParameters<typeof OAuthBaseProvider>
  ) {
    super(...args);
  }

  static async create(options: {
    clientId: string,
    clientSecret: string,
    redirectUri: string,
    issuerUrl: string,
    scope?: string,
  }) {
    const { redirectUri, issuerUrl, scope, ...rest } = options;
    return new CustomOidcProvider(...await OAuthBaseProvider.createConstructorArgs({
      discoverFromUrl: issuerUrl,
      redirectUri,
      baseScope: scope || "openid email profile",
      openid: true,
      // Spec-compliant IdPs (Okta, Auth0, Keycloak, Entra via generic OIDC, ...) honor
      // prompt=consent by ignoring existing grants and re-showing the consent screen on
      // every sign-in, which for enterprise tenants often turns into an admin-approval
      // wall. Same reasoning as MicrosoftProvider. Refresh tokens are still issued
      // whenever the configured scope includes offline_access.
      noConsentPrompt: true,
      ...rest,
    }));
  }

  async postProcessUserInfo(tokenSet: TokenSet): Promise<OAuthUserInfo> {
    const rawUserInfo = await this.oauthClient.userinfo(tokenSet.accessToken);
    return validateUserInfo({
      accountId: rawUserInfo.sub,
      displayName: rawUserInfo.name ?? rawUserInfo.preferred_username ?? null,
      email: rawUserInfo.email ?? null,
      profileImageUrl: rawUserInfo.picture ?? null,
      emailVerified: !!rawUserInfo.email_verified,
    });
  }

  async checkAccessTokenValidity(accessToken: string): Promise<boolean> {
    try {
      const response = await this.oauthClient.userinfo(accessToken);
      return !!response.sub;
    } catch (error: any) {
      // Only treat definitive auth failures (401/403) as "invalid token".
      // Rethrow network/transient errors so callers don't persist false-negative validity.
      if (error?.status === 401 || error?.status === 403 || error?.code === "invalid_token") {
        return false;
      }
      throw error;
    }
  }
}
