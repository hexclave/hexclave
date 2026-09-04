import { describe, expect, it } from "vitest";
import { StackClientApp } from "../interfaces/client-app";

function createAccessTokenString(refreshTokenId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const nowSeconds = Math.floor(Date.now() / 1000);
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({ sub: "user-id", exp: nowSeconds + 60, iat: nowSeconds, refresh_token_id: refreshTokenId }),
    "",
  ].join(".");
}

function createTestSetup(getUser: () => Promise<unknown>) {
  const clientApp = new StackClientApp({
    baseUrl: "http://localhost:12345",
    projectId: "00000000-0000-4000-8000-000000000000",
    publishableClientKey: "stack-pk-test",
    tokenStore: "memory",
    redirectMethod: "none",
    noAutomaticPrefetch: true,
  });
  Reflect.set(clientApp["_interface"], "getClientUserByToken", getUser);
  const privateMethod = (name: string) => (...args: unknown[]) => clientApp[name].apply(clientApp, args);
  return {
    currentUserCache: clientApp["_currentUserCache"],
    signIn: (refreshToken: string) => privateMethod("_signInToAccountWithTokens")({
      accessToken: createAccessTokenString(`${refreshToken}-id`),
      refreshToken,
    }),
    getSessionFromTokenStore: privateMethod("_getSessionFromTokenStore"),
    getTokenStore: async () => privateMethod("_getOrCreateTokenStore")(await privateMethod("_createCookieHelper")()),
  };
}

describe("StackClientApp sign-in cache warm-up", () => {
  it("has the new session's user cached by the time the token store change is published", async () => {
    let getUserCalls = 0;
    const setup = createTestSetup(async () => {
      getUserCalls += 1;
      return { id: "user-id", is_anonymous: false, is_restricted: false };
    });

    // `useUser()` hooks re-read the cache when the session changes, so if the cache were still cold here, they'd
    // suspend and flash their Suspense fallback over the UI that's already on the screen.
    const cacheStatusesOnTokenStoreChange: string[] = [];
    const tokenStore = await setup.getTokenStore();
    tokenStore.onChange(() => {
      const session = setup.getSessionFromTokenStore(tokenStore);
      cacheStatusesOnTokenStoreChange.push(setup.currentUserCache.getIfCached([session]).status);
    });

    await setup.signIn("refresh-token");

    expect(cacheStatusesOnTokenStoreChange).toEqual(["ok"]);
    const cachedUser = setup.currentUserCache.getIfCached([setup.getSessionFromTokenStore(tokenStore)]);
    expect(cachedUser.data.data).toMatchObject({ id: "user-id" });
    expect(getUserCalls).toBe(1);
  });

  it("doesn't let a slow sign-in publish its tokens on top of a sign-in that started later", async () => {
    let onFirstFetchStarted!: () => void;
    let releaseFirstFetch!: () => void;
    const firstFetchStarted = new Promise<void>((resolve) => {
      onFirstFetchStarted = resolve;
    });
    const firstFetchReleased = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });

    let getUserCalls = 0;
    const setup = createTestSetup(async () => {
      // Only the first sign-in's fetch blocks, so the second one deterministically gets to publish while it waits.
      if (++getUserCalls === 1) {
        onFirstFetchStarted();
        await firstFetchReleased;
      }
      return { id: "user-id", is_anonymous: false, is_restricted: false };
    });

    const slowSignIn = setup.signIn("old-refresh-token");
    await firstFetchStarted;
    await setup.signIn("new-refresh-token");
    releaseFirstFetch();
    await slowSignIn;

    expect(getUserCalls).toBe(2);
    expect((await setup.getTokenStore()).get().refreshToken).toBe("new-refresh-token");
  });
});
