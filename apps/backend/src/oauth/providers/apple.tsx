import { HexclaveAssertionError, StatusError, captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { decodeJwt, exportPKCS8, generateKeyPair, importPKCS8, SignJWT } from 'jose';
import { OAuthUserInfo, parseEmailVerifiedClaim, validateUserInfo } from "../utils";
import { OAuthBaseProvider, TokenSet } from "./base";

export class AppleProvider extends OAuthBaseProvider {
  private constructor(
    ...args: ConstructorParameters<typeof OAuthBaseProvider>
  ) {
    super(...args);
  }

  static async create(options: {
    clientId: string,
    clientSecret?: string,
    teamId?: string,
    keyId?: string,
    privateKey?: string,
    redirectUri: string,
  }) {
    const { redirectUri, clientSecret, teamId, keyId, privateKey, ...rest } = options;
    let resolvedClientSecret = clientSecret;
    if (teamId != null && keyId != null && privateKey != null) {
      // Key credentials take precedence so rotation takes effect even when an old
      // static secret is still stored in the dashboard.
      const signingKey = await (async () => {
        try {
          return await importPKCS8(privateKey, "ES256");
        } catch (error) {
          captureError("apple-oauth-client-secret-minting-failed", error);
          throw new StatusError(StatusError.BadRequest, "The Apple private key is invalid. Please provide the original .p8 key contents.");
        }
      })();
      const now = Math.floor(Date.now() / 1000);
      // getProvider() constructs AppleProvider for each request, so a five-minute
      // secret is sufficient and avoids storing a long-lived JWT in config.
      try {
        resolvedClientSecret = await new SignJWT({})
          .setProtectedHeader({ alg: "ES256", kid: keyId })
          .setIssuer(teamId)
          .setSubject(options.clientId)
          .setAudience("https://appleid.apple.com")
          .setIssuedAt(now)
          .setExpirationTime(now + 5 * 60)
          .sign(signingKey);
      } catch (error) {
        throw new HexclaveAssertionError("Failed to mint Apple OAuth client secret", { cause: error });
      }
    } else if (resolvedClientSecret == null || resolvedClientSecret === "") {
      throw new StatusError(StatusError.BadRequest, "Apple OAuth requires a client secret or Team ID, Key ID, and private key.");
    }
    return new AppleProvider(
      ...(await OAuthBaseProvider.createConstructorArgs({
        issuer: "https://appleid.apple.com",
        authorizationEndpoint: "https://appleid.apple.com/auth/authorize",
        tokenEndpoint: "https://appleid.apple.com/auth/token",
        redirectUri,
        jwksUri: "https://appleid.apple.com/auth/keys",
        baseScope: "name email",
        authorizationExtraParams: { "response_mode": "form_post" },
        tokenEndpointAuthMethod: "client_secret_post",
        openid: true,
        clientSecret: resolvedClientSecret,
        ...rest,
      }))
    );
  }

  async postProcessUserInfo(tokenSet: TokenSet): Promise<OAuthUserInfo> {
    const idToken = tokenSet.idToken ?? throwErr("No id token received for Apple OAuth", { tokenSet });

    let payload;
    try {
      payload = decodeJwt(idToken);
    } catch (error) {
      throw new HexclaveAssertionError("Error decoding Apple ID token", { cause: error });
    }

    return validateUserInfo({
      accountId: payload.sub,
      email: payload.email,
      emailVerified: parseEmailVerifiedClaim(payload.email_verified),
    });
  }

  async checkAccessTokenValidity(accessToken: string): Promise<boolean> {
    const res = await fetch("https://appleid.apple.com/auth/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    return res.ok;
  }
}

import.meta.vitest?.test("AppleProvider mints short-lived ES256 client secrets", async ({ expect }) => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const provider = await AppleProvider.create({
    clientId: "com.example.web",
    clientSecret: "old-static-secret",
    teamId: "TEAM123",
    keyId: "KEY123",
    privateKey: privateKeyPem,
    redirectUri: "https://example.com/callback",
  });
  const clientSecret = provider.oauthClient.metadata.client_secret
    ?? throwErr("AppleProvider must set a client secret");
  const header = JSON.parse(Buffer.from(clientSecret.split(".")[0], "base64url").toString());
  const claims = decodeJwt(clientSecret);
  expect(header).toMatchObject({ alg: "ES256", kid: "KEY123" });
  expect(claims).toMatchObject({
    iss: "TEAM123",
    sub: "com.example.web",
    aud: "https://appleid.apple.com",
  });
  expect(claims.exp! - claims.iat!).toBe(300);
});

import.meta.vitest?.test("AppleProvider works with key credentials only, without a static client secret", async ({ expect }) => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const provider = await AppleProvider.create({
    clientId: "com.example.web",
    teamId: "TEAM123",
    keyId: "KEY123",
    privateKey: await exportPKCS8(privateKey),
    redirectUri: "https://example.com/callback",
  });
  const claims = decodeJwt(provider.oauthClient.metadata.client_secret ?? throwErr("AppleProvider must set a client secret"));
  expect(claims).toMatchObject({ iss: "TEAM123", sub: "com.example.web" });
});
