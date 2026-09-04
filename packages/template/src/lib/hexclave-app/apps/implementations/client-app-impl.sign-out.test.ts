import { AsyncStore } from "@hexclave/shared/dist/utils/stores";
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

class Deferred {
  readonly promise: Promise<void>;
  private _resolve: () => void = () => {
    throw new Error("Deferred promise was resolved before initialization");
  };

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this._resolve = resolve;
    });
  }

  resolve(): void {
    this._resolve();
  }
}

describe("StackClientApp sign-out", () => {
  it("delays current-user reads until redirect dispatch without blocking unrelated stores", async () => {
    const clientApp = new StackClientApp({
      baseUrl: "http://localhost:12345",
      projectId: "00000000-0000-4000-8000-000000000000",
      publishableClientKey: "stack-pk-test",
      tokenStore: "memory",
      redirectMethod: "none",
      noAutomaticPrefetch: true,
      devTool: false,
    });
    const clientInterface = clientApp["_interface"];
    Reflect.set(clientInterface, "getClientUserByToken", async () => ({
      id: "user-id",
      is_anonymous: false,
      is_restricted: false,
    }));

    const signInToAccountWithTokens = clientApp["_signInToAccountWithTokens"];
    await signInToAccountWithTokens.call(clientApp, {
      accessToken: createAccessTokenString("refresh-token-id"),
      refreshToken: "refresh-token",
    });

    const createCookieHelper = clientApp["_createCookieHelper"];
    const getOrCreateTokenStore = clientApp["_getOrCreateTokenStore"];
    const getSessionFromTokenStore = clientApp["_getSessionFromTokenStore"];
    const tokenStore = getOrCreateTokenStore.call(clientApp, await createCookieHelper.call(clientApp));
    const session = getSessionFromTokenStore.call(clientApp, tokenStore);

    Reflect.set(clientInterface, "signOut", async () => {
      session.markInvalid();
    });

    const redirectStarted = new Deferred();
    const redirectFinished = new Deferred();
    Reflect.set(clientApp, "_redirectToDefaultAfterSignOut", async () => {
      redirectStarted.resolve();
      await redirectFinished.promise;
    });

    const unrelatedStore = new AsyncStore<void>();
    expect(unrelatedStore.setAsync(new Promise<void>(() => {}))).toBeInstanceOf(Promise);

    const signOut = clientApp["_signOut"];
    const signOutPromise = signOut.call(clientApp, session);
    await redirectStarted.promise;

    const getUserDuringSignOut = clientApp.getUser();
    const stateBeforeRedirectFinished = await Promise.race([
      getUserDuringSignOut.then(() => "resolved"),
      Promise.resolve("pending"),
    ]);
    expect(stateBeforeRedirectFinished).toBe("pending");

    redirectFinished.resolve();
    await signOutPromise;

    await expect(getUserDuringSignOut).resolves.toBeNull();
  });
});
