import { KnownErrors } from "@hexclave/shared";
import type { ExternalAuthProviderId } from "@hexclave/shared/dist/interface/external-auth";
import { AccessToken, InternalSession } from "@hexclave/shared/dist/sessions";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { Store } from "@hexclave/shared/dist/utils/stores";
import type { ExternalTokenStore } from "../../common";
import { createEmptyTokenStore, type TokenObject } from "./common";

type ExternalTokenStoreState = {
  generation: number,
  providerSessionId: string | null | undefined,
};

type SessionOptions = {
  refreshToken: string | null,
  accessToken?: string | null,
  sessionKey?: string,
  refreshAccessTokenWithoutRefreshTokenCallback?: () => Promise<AccessToken | null>,
};

export function isExternalTokenStore(value: object): value is ExternalTokenStore {
  return "type" in value && value.type === "external";
}

export class ExternalTokenStoreSessionAdapter {
  private readonly storesByExternalTokenStore = new WeakMap<ExternalTokenStore, Store<TokenObject>>();
  private readonly externalTokenStoresByStore = new WeakMap<Store<TokenObject>, ExternalTokenStore>();
  private readonly externalTokenStoresBySession = new WeakMap<InternalSession, ExternalTokenStore>();
  private readonly states = new WeakMap<ExternalTokenStore, ExternalTokenStoreState>();

  constructor(
    private readonly createSession: (options: SessionOptions) => InternalSession,
    private readonly exchangeToken: (providerId: ExternalAuthProviderId, token: string) => Promise<string>,
  ) {}

  getOrCreateTokenStore(
    externalTokenStore: ExternalTokenStore,
    onProviderChange: (store: Store<TokenObject>, previousSessionKey: string) => void,
  ): Store<TokenObject> {
    const existing = this.storesByExternalTokenStore.get(externalTokenStore);
    if (existing != null) {
      return existing;
    }

    const store = createEmptyTokenStore();
    this.storesByExternalTokenStore.set(externalTokenStore, store);
    this.externalTokenStoresByStore.set(store, externalTokenStore);
    this.states.set(externalTokenStore, {
      generation: 0,
      providerSessionId: externalTokenStore.getSessionId?.(),
    });
    externalTokenStore.subscribe?.(() => {
      const state = this.states.get(externalTokenStore) ?? throwErr("External token store state was not initialized");
      // Derive the previous session's key from the recorded state, not from a live getSessionId()
      // read: by the time this notification fires, the provider has already switched sessions, so a
      // live read would compute the *new* key and the expiry hint would target the wrong session.
      const previousSessionKey = this.buildSessionKey(externalTokenStore, state);
      const providerSessionId = externalTokenStore.getSessionId?.();
      if (externalTokenStore.getSessionId == null || providerSessionId !== state.providerSessionId) {
        state.generation += 1;
        state.providerSessionId = providerSessionId;
      }
      onProviderChange(store, previousSessionKey);
      store.set({ accessToken: null, refreshToken: null });
    });
    return store;
  }

  getSessionKey(tokenStore: Store<TokenObject>, tokenObject: TokenObject): string {
    const externalTokenStore = this.externalTokenStoresByStore.get(tokenStore);
    if (externalTokenStore == null) {
      return InternalSession.calculateSessionKey(tokenObject);
    }

    const state = this.states.get(externalTokenStore) ?? throwErr("External token store state was not initialized");
    // Read the provider session id live (instead of from state) so a session switch is reflected
    // immediately, even before the store's subscribe notification has fired.
    return this.buildSessionKey(externalTokenStore, {
      generation: state.generation,
      providerSessionId: externalTokenStore.getSessionId?.(),
    });
  }

  private buildSessionKey(externalTokenStore: ExternalTokenStore, state: ExternalTokenStoreState): string {
    if (externalTokenStore.getSessionId == null) {
      return `external-${externalTokenStore.providerId}-${state.generation}`;
    }
    return state.providerSessionId == null
      ? "not-logged-in"
      : `external-${externalTokenStore.providerId}-${state.providerSessionId}`;
  }

  createSessionForTokenStore(
    tokenStore: Store<TokenObject>,
    tokenObject: TokenObject,
    sessionKey: string,
  ): InternalSession {
    const externalTokenStore = this.externalTokenStoresByStore.get(tokenStore);
    let session: InternalSession;
    if (externalTokenStore == null) {
      session = this.createSession({
        refreshToken: tokenObject.refreshToken,
        accessToken: tokenObject.accessToken,
      });
    } else if (sessionKey === "not-logged-in") {
      // A provider can clear its session before its token store notification arrives; never let
      // that transiently expose the previous provider session's cached Hexclave token.
      session = this.createSession({
        refreshToken: null,
        accessToken: null,
        sessionKey,
      });
    } else {
      session = this.createSession({
        refreshToken: null,
        accessToken: tokenObject.accessToken,
        sessionKey,
        refreshAccessTokenWithoutRefreshTokenCallback: async () => {
          const state = this.states.get(externalTokenStore) ?? throwErr("External token store state was not initialized");
          const expectedGeneration = state.generation;
          const assertSessionIdentityUnchanged = () => {
            const liveSessionKey = this.buildSessionKey(externalTokenStore, {
              generation: state.generation,
              providerSessionId: externalTokenStore.getSessionId?.(),
            });
            if (state.generation !== expectedGeneration || liveSessionKey !== sessionKey) {
              throw new Error("The external provider session changed while exchanging a token; retrying with the current provider session.");
            }
          };
          // Returning null from this callback permanently invalidates the cached InternalSession, so
          // we must only do it when the provider session is definitively gone — for transient states
          // we throw instead, which surfaces the failure to the current caller but lets the next
          // request retry the exchange.
          const attemptExchange = async (isRetry: boolean): Promise<AccessToken | null> => {
            assertSessionIdentityUnchanged();
            const externalToken = await externalTokenStore.getToken();
            assertSessionIdentityUnchanged();
            if (externalToken == null) {
              if (externalTokenStore.getSessionId?.() != null) {
                // The provider reports an active session but handed out no token; this is usually a
                // transient state (eg. its SDK is still initializing), so don't treat it as signed out.
                throw new Error("The external token store returned no token even though it reports an active provider session. This is usually transient (eg. the provider SDK is still initializing) and the exchange will be retried on the next request.");
              }
              return null;
            }
            try {
              const accessToken = await this.exchangeToken(externalTokenStore.providerId, externalToken);
              const validatedAccessToken = AccessToken.createIfValid(accessToken)
                ?? throwErr("External authentication exchange returned an invalid Hexclave access token");
              // An explicit session key bypasses InternalSession's identity check. Refuse to install
              // a token if the provider switched accounts while the exchange was in flight instead
              // of returning null, which would permanently invalidate the reusable session.
              assertSessionIdentityUnchanged();
              return validatedAccessToken;
            } catch (error) {
              if (!KnownErrors.InvalidExternalAuthToken.isInstance(error)) {
                throw error;
              }
              // The server rejects provider tokens that expired in flight with the same error as
              // genuinely bad ones, so retry once with a freshly fetched provider token: the provider
              // SDK replaces an expired token. If the fresh token is rejected too, the cause is not
              // transient (eg. an issuer or client-ID misconfiguration), and it does not mean the
              // provider session ended either: the backend re-establishes a Hexclave session for any
              // valid provider token, so a rejection never signals revocation. Propagate the error
              // instead of returning null, which would permanently invalidate this session and make
              // a misconfiguration look like a silent sign-out.
              if (isRetry) {
                throw error;
              }
              return await attemptExchange(true);
            }
          };
          return await attemptExchange(false);
        },
      });
    }
    if (externalTokenStore != null) {
      this.externalTokenStoresBySession.set(session, externalTokenStore);
    }
    return session;
  }

  getExternalTokenStoreForSession(session: InternalSession): ExternalTokenStore | undefined {
    return this.externalTokenStoresBySession.get(session);
  }
}
