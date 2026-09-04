import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { getJwtInfo } from "@hexclave/shared/dist/utils/jwt";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { OAuthUserInfo, parseOAuthAccountCreatedAtMillis, validateUserInfo } from "../utils";
import { OAuthBaseProvider, TokenSet } from "./base";

const USER_INFO_401_RETRY_DELAYS_MS = [1000, 2000];

// `any` because fetch's json() is `any`; the shape is validated by validateUserInfo at the call site
async function fetchRawGithubUserInfo(tokenSet: TokenSet): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const rawUserInfoRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenSet.accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (rawUserInfoRes.ok) {
      return await rawUserInfoRes.json();
    }
    // Retry only 401s: GitHub sometimes rejects freshly-issued tokens for 1-3s until they
    // propagate across its infrastructure (https://github.com/orgs/community/discussions/162975).
    if (rawUserInfoRes.status !== 401 || attempt > USER_INFO_401_RETRY_DELAYS_MS.length) {
      // `attempt` is only in the extras, not the message, so Sentry keeps one grouping per status.
      throw new HexclaveAssertionError(`Error fetching user info from GitHub provider: Status code ${rawUserInfoRes.status}`, {
        rawUserInfoRes,
        rawUserInfoResText: await rawUserInfoRes.text(),
        attempt,
        hasAccessToken: !!tokenSet.accessToken,
        hasRefreshToken: !!tokenSet.refreshToken,
        accessTokenExpiredAt: tokenSet.accessTokenExpiredAt,
        jwtInfo: await getJwtInfo({ jwt: tokenSet.accessToken }),
      });
    }
    // Release the intermediate 401 response's connection instead of holding it until GC
    await rawUserInfoRes.body?.cancel();
    await wait(USER_INFO_401_RETRY_DELAYS_MS[attempt - 1]);
  }
}

export class GithubProvider extends OAuthBaseProvider {
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
    return new GithubProvider(...await OAuthBaseProvider.createConstructorArgs({
      issuer: "https://github.com",
      alternativeIssuers: ["https://github.com/login/oauth"],
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      userinfoEndpoint: "https://api.github.com/user",
      redirectUri,
      baseScope: "user:email",
      // GitHub can return either non-expiring OAuth-App-style access tokens, or
      // expiring user tokens with refresh tokens. If GitHub gives us expires_in,
      // the base provider uses that real value. This fallback is only for older
      // responses without explicit expiry: refresh-token responses should be
      // treated as short-lived. Access-token-only responses are effectively
      // non-expiring OAuth App tokens, so store NULL to mean "the provider did
      // not supply an expiry"; they are still checked against /user before
      // being returned.
      // https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
      // https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation#user-token-expired-due-to-github-app-configuration
      defaultAccessTokenExpiresInMillis: (tokenSet) => tokenSet.refresh_token ? 1000 * 60 * 60 * 8 : null,
      ...rest,
    }));
  }

  async postProcessUserInfo(tokenSet: TokenSet): Promise<OAuthUserInfo> {
    const rawUserInfo = await fetchRawGithubUserInfo(tokenSet);

    const emailsRes = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${tokenSet.accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!emailsRes.ok) {
      // GitHub returns a 403 error when fetching user emails if the permission "Email addresses" is not set
      // https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#choosing-permissions-for-rest-api-access
      if (emailsRes.status === 403) {
        throw new StatusError(StatusError.BadRequest, `GitHub returned a 403 error when fetching user emails. \nDeveloper information: This is likely due to not having the correct permission "Email addresses" in your GitHub app. Please check your GitHub app settings and try again.`);
      }
      throw new HexclaveAssertionError("Error fetching user emails from GitHub: Status code " + emailsRes.status, {
        emailsRes,
        rawUserInfo,
      });
    }
    const emails = await emailsRes.json();
    if (!Array.isArray(emails)) {
      throw new HexclaveAssertionError("Error fetching user emails from GitHub: Invalid response", {
        emails,
        emailsRes,
        rawUserInfo,
      });
    }
    const { email, verified } = emails.find((e: any) => e.primary);

    return validateUserInfo({
      accountId: rawUserInfo.id?.toString(),
      displayName: rawUserInfo.name,
      profileImageUrl: rawUserInfo.avatar_url,
      email: email,
      emailVerified: verified,
      accountCreatedAtMillis: parseOAuthAccountCreatedAtMillis(rawUserInfo.created_at),
    });
  }

  async checkAccessTokenValidity(accessToken: string): Promise<boolean> {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    return res.ok;
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

import.meta.vitest?.describe("fetchRawGithubUserInfo(...)", () => {
  const { vi, test, afterEach } = import.meta.vitest!;

  const testTokenSet: TokenSet = { accessToken: "ghu_test_token", accessTokenExpiredAt: null };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("returns user info on first success without retrying", async ({ expect }) => {
    const fetchMock = vi.fn(async () => Response.json({ id: 123, name: "Test" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchRawGithubUserInfo(testTokenSet);
    expect(result).toEqual({ id: 123, name: "Test" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("retries 401s with 1s then 2s delays and succeeds", async ({ expect }) => {
    vi.useFakeTimers();
    let callCount = 0;
    const fetchMock = vi.fn(async () => ++callCount <= 2
      ? new Response("Bad credentials", { status: 401 })
      : Response.json({ id: 123 }));
    vi.stubGlobal("fetch", fetchMock);
    const promise = fetchRawGithubUserInfo(testTokenSet);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await promise).toEqual({ id: 123 });
  });

  test("throws with the attempt count in extras after 401 retries are exhausted", async ({ expect }) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("Bad credentials", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const promise = fetchRawGithubUserInfo(testTokenSet);
    const rejection = expect(promise).rejects.toMatchObject({
      message: expect.stringContaining("Error fetching user info from GitHub provider: Status code 401"),
      extraData: expect.objectContaining({ attempt: 3 }),
    });
    await vi.advanceTimersByTimeAsync(3000);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("does not retry non-401 statuses", async ({ expect }) => {
    const fetchMock = vi.fn(async () => new Response("Forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchRawGithubUserInfo(testTokenSet)).rejects.toMatchObject({
      message: expect.stringContaining("Error fetching user info from GitHub provider: Status code 403"),
      extraData: expect.objectContaining({ attempt: 1 }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
