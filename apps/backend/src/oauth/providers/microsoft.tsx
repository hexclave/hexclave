import { OAuthUserInfo, validateUserInfo } from "../utils";
import { OAuthBaseProvider, TokenSet } from "./base";

export class MicrosoftProvider extends OAuthBaseProvider {
  private constructor(
    ...args: ConstructorParameters<typeof OAuthBaseProvider>
  ) {
    super(...args);
  }

  static async create(options: {
    clientId: string,
    clientSecret: string,
    microsoftTenantId?: string,
    redirectUri: string,
  }) {
    const tenantId = encodeURIComponent(options.microsoftTenantId || "consumers");
    const { redirectUri, ...rest } = options;
    return new MicrosoftProvider(...await OAuthBaseProvider.createConstructorArgs({
      // Note that it is intentional to have tenantid instead of tenantId, also intentional to not be a template literal. This will be replaced by the openid-client library.
      // The library only supports azure tenancy with the discovery endpoint but not the manual setup, so we patch it to enable the tenantid replacement.
      issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
      authorizationEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
      tokenEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      redirectUri,
      baseScope: "User.Read openid",
      openid: true,
      jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
      // Microsoft treats the token-request scope as a resource selector during
      // authorization-code redemption. Plain sign-in can work without restating
      // it, but connected-account flows with extra provider_scope values have
      // returned AADSTS70011 unless we include the originally requested scopes.
      includeScopeInCallbackTokenExchange: true,
      // Entra re-prompts for (admin) consent on every sign-in when prompt=consent
      // is sent, even if the tenant already granted consent; incremental consent
      // still happens automatically when new scopes are requested.
      noConsentPrompt: true,
      ...rest,
    }));
  }

  async postProcessUserInfo(tokenSet: TokenSet): Promise<OAuthUserInfo> {
    const rawUserInfo = await fetch(
      'https://graph.microsoft.com/v1.0/me',
      {
        headers: {
          Authorization: `Bearer ${tokenSet.accessToken}`,
        },
      }
    ).then(res => res.json());

    return validateUserInfo({
      accountId: rawUserInfo.id,
      displayName: rawUserInfo.displayName,
      email: rawUserInfo.mail || rawUserInfo.userPrincipalName,
      profileImageUrl: undefined, // Microsoft Graph API does not return profile image URL
      // Microsoft does not make sure that the email is verified, so we cannot trust it
      // https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation#validate-the-subject
      emailVerified: false,
    });
  }

  async checkAccessTokenValidity(accessToken: string): Promise<boolean> {
    const res = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok;
  }
}
