import { OAuthUserInfo, validateUserInfo } from "../utils";
import { OAuthBaseProvider, TokenSet } from "./base";

export class GitlabProvider extends OAuthBaseProvider {
  private constructor(
    ...args: ConstructorParameters<typeof OAuthBaseProvider>
  ) {
    super(...args);
  }

  static async create(options: { clientId: string, clientSecret: string, redirectUri: string }) {
    const { redirectUri, ...rest } = options;
    return new GitlabProvider(
      ...(await OAuthBaseProvider.createConstructorArgs({
        issuer: "https://gitlab.com",
        authorizationEndpoint: "https://gitlab.com/oauth/authorize",
        tokenEndpoint: "https://gitlab.com/oauth/token",
        userinfoEndpoint: "https://gitlab.com/api/v4/user",
        redirectUri,
        baseScope: "read_user",
        ...rest,
      }))
    );
  }

  async postProcessUserInfo(tokenSet: TokenSet): Promise<OAuthUserInfo> {
    const headers = { Authorization: `Bearer ${tokenSet.accessToken}` };
    const [userInfo, emails] = await Promise.all([
      fetch("https://gitlab.com/api/v4/user", { headers }).then(res => res.json()),
      fetch("https://gitlab.com/api/v4/user/emails", { headers }).then(res => res.json())
    ]);

    const { confirmed_at } = emails.find((e: any) => e.email === userInfo.email);

    return validateUserInfo({
      accountId: userInfo.id?.toString(),
      displayName: userInfo.name,
      profileImageUrl: userInfo.avatar_url,
      email: userInfo.email,
      emailVerified: !!confirmed_at,
    });
  }

  async checkAccessTokenValidity(accessToken: string): Promise<boolean> {
    const res = await fetch("https://gitlab.com/api/v4/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    return res.ok;
  }
}
