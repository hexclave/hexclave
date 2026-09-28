import { getDiscordAccountCreatedAtMillis, OAuthUserInfo, validateUserInfo } from "../utils";
import { OAuthBaseProvider, TokenSet } from "./base";

export class DiscordProvider extends OAuthBaseProvider {
  private constructor(
    ...args: ConstructorParameters<typeof OAuthBaseProvider>
  ) {
    super(...args);
  }

  static async create(options: {
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  }) {
    const { redirectUri, ...rest } = options;
    return new DiscordProvider(...await OAuthBaseProvider.createConstructorArgs({
      issuer: "https://discord.com",
      authorizationEndpoint: "https://discord.com/oauth2/authorize",
      tokenEndpoint: "https://discord.com/api/oauth2/token",
      redirectUri,
      baseScope: "identify email",
      ...rest,
    }));
  }

  async postProcessUserInfo(tokenSet: TokenSet): Promise<OAuthUserInfo> {
    const info = await fetch("https://discord.com/api/users/@me", {
      headers: {
        Authorization: `Bearer ${tokenSet.accessToken}`,
      },
    }).then((res) => res.json());

    return validateUserInfo({
      accountId: info.id,
      displayName: info.global_name ?? info.username,
      email: info.email,
      profileImageUrl: info.avatar ? `https://cdn.discordapp.com/avatars/${info.id}/${info.avatar}.${info.avatar.startsWith("a_") ? "gif" : "png"}` : null,
      emailVerified: info.verified,
      accountCreatedAtMillis: getDiscordAccountCreatedAtMillis(info.id),
    });
  }

  async checkAccessTokenValidity(accessToken: string): Promise<boolean> {
    const res = await fetch("https://discord.com/api/users/@me", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    return res.ok;
  }
}
