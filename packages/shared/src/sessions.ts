import * as jose from 'jose';
import { InferType } from 'yup';
import { accessTokenPayloadSchema } from './schema-fields';
import { HexclaveAssertionError, throwErr } from "./utils/errors";
import { runAsynchronously, wait } from './utils/promises';
import { Store } from "./utils/stores";


export type AccessTokenPayload = InferType<typeof accessTokenPayloadSchema>;

function decodeAccessTokenIfValid(token: string): AccessTokenPayload | null {
  try {
    const payload = jose.decodeJwt(token);
    return accessTokenPayloadSchema.validateSync(payload);
  } catch (e) {
    return null;
  }
}

export class AccessToken {
  static createIfValid(token: string): AccessToken | null {
    const payload = decodeAccessTokenIfValid(token);
    if (!payload) return null;
    return new AccessToken(token);
  }

  private constructor(
    public readonly token: string,
  ) {
    if (token === "undefined") {
      throw new HexclaveAssertionError("Access token is the string 'undefined'; it's unlikely this is the correct value. They're supposed to be unguessable!");
    }
  }

  get payload() {
    return decodeAccessTokenIfValid(this.token) ?? throwErr("Invalid access token in payload (should've been validated in createIfValid)", { token: this.token });
  }

  get expiresAt(): Date {
    const { exp } = this.payload;
    if (exp === undefined) return new Date(8640000000000000);  // max date value
    return new Date(exp * 1000);
  }

  get issuedAt(): Date {
    const { iat } = this.payload;
    return new Date(iat * 1000);
  }

  /**
   * @returns The number of milliseconds until the access token expires, or 0 if it has already expired.
   */
  get expiresInMillis(): number {
    return Math.max(0, this.expiresAt.getTime() - Date.now());
  }

  get issuedMillisAgo(): number {
    return Math.max(0, Date.now() - this.issuedAt.getTime());
  }

  isExpired(): boolean {
    return this.expiresInMillis <= 0;
  }
}

export class RefreshToken {
  constructor(
    public readonly token: string,
  ) {
    if (token === "undefined") {
      throw new HexclaveAssertionError("Refresh token is the string 'undefined'; it's unlikely this is the correct value. They're supposed to be unguessable!");
    }
  }
}

/**
 * An InternalSession represents a user's session, which may or may not be valid. It may contain an access token, a refresh token, or both.
 *
 * A session never changes which user or session it belongs to, but the tokens in it may change over time.
 */
export class InternalSession {
  /**
  * Each session has a session key that depends on the tokens inside. If the session has a refresh token, the session key depends only on the refresh token. If the session does not have a refresh token, the session key depends only on the access token.
  *
  * Multiple Session objects may have the same session key, which implies that they represent the same session by the same user. Furthermore, a session's key never changes over the lifetime of a session object.
  *
  * This is useful for caching and indexing sessions.
  */
  public readonly sessionKey: string;

  /**
   * An access token that is not known to be invalid (ie. may be valid, but may have expired).
   */
  private _accessToken: Store<AccessToken | null>;
  private readonly _refreshToken: RefreshToken | null;

  /**
   * Whether the session as a whole is known to be invalid (ie. both access and refresh tokens are invalid). Used as a cache to avoid making multiple requests to the server (sessions never go back to being valid after being invalidated).
   *
   * It is possible for the access token to be invalid but the refresh token to be valid, in which case the session is
   * still valid (just needs a refresh). It is also possible for the access token to be valid but the refresh token to
   * be invalid, in which case the session is also valid (eg. if the refresh token is null because the user only passed
   * in an access token, eg. in a server-side request handler).
   */
  private _knownToBeInvalid = new Store<boolean>(false);

  private _refreshPromise: Promise<AccessToken | null> | null = null;

  constructor(private readonly _options: {
    refreshAccessTokenCallback(refreshToken: RefreshToken): Promise<AccessToken | null>,
    refreshToken: string | null,
    accessToken?: string | null,
  }) {
    this._accessToken = new Store(_options.accessToken ? AccessToken.createIfValid(_options.accessToken) : null);
    this._refreshToken = _options.refreshToken ? new RefreshToken(_options.refreshToken) : null;
    if (_options.accessToken === null && _options.refreshToken === null) {
      // this session is already invalid
      this._knownToBeInvalid.set(true);
    }
    this.sessionKey = InternalSession.calculateSessionKey({ accessToken: _options.accessToken ?? null, refreshToken: _options.refreshToken });
  }

  static calculateSessionKey(ofTokens: { refreshToken: string | null, accessToken?: string | null }): string {
    if (ofTokens.refreshToken) {
      return `refresh-${ofTokens.refreshToken}`;
    } else if (ofTokens.accessToken) {
      // Access-only sessions (no refresh token) are keyed by the underlying session's `refresh_token_id`, not the
      // access token string: access tokens get re-minted frequently, and keying by the raw token would spawn a new
      // session (and cold-invalidate every session-scoped cache) on each refresh. Falls back to the raw token if
      // the JWT can't be decoded.
      const refreshTokenId = decodeAccessTokenIfValid(ofTokens.accessToken)?.refresh_token_id;
      if (refreshTokenId) {
        return `access-session-${refreshTokenId}`;
      }
      return `access-${ofTokens.accessToken}`;
    } else {
      return "not-logged-in";
    }
  }

  isKnownToBeInvalid() {
    return this._knownToBeInvalid.get();
  }

  /**
   * Marks the session object as invalid, meaning that the refresh and access tokens can no longer be used. There is no
   * way out of this state, and the session object will never return valid tokens again.
   */
  markInvalid() {
    this._accessToken.set(null);
    this._knownToBeInvalid.set(true);
  }

  onInvalidate(callback: () => void): { unsubscribe: () => void } {
    return this._knownToBeInvalid.onChange(() => callback());
  }

  getRefreshToken(): RefreshToken | null {
    if (this.isKnownToBeInvalid()) return null;
    return this._refreshToken;
  }

  /**
   * Returns the access token if it is found in the cache and not expired yet, or null otherwise. Never fetches new tokens.
   */
  getAccessTokenIfNotExpiredYet(minMillisUntilExpiration: number, maxMillisSinceIssued: number | null): AccessToken | null {
    if (minMillisUntilExpiration > 45_000) {
      throw new Error(`Required access token expiry ${minMillisUntilExpiration}ms is too long; access tokens are too short to be used for more than 45s`);
    }
    if (maxMillisSinceIssued !== null && maxMillisSinceIssued < 15_000) {
      throw new Error(`Required access token issuance ${maxMillisSinceIssued}ms is too short; assume that access token generation can take at least 15s`);
    }

    const accessToken = this._getPotentiallyInvalidAccessTokenIfAvailable();
    if (!accessToken || accessToken.expiresInMillis < minMillisUntilExpiration) return null;
    if (maxMillisSinceIssued !== null && accessToken.issuedMillisAgo > maxMillisSinceIssued) return null;
    return accessToken;
  }

  /**
   * Returns the access token if it is found in the cache, fetching it otherwise.
   *
   * This is usually the function you want to call to get an access token. Either set `minMillisUntilExpiration` to a reasonable value, or catch errors that occur if it expires, and call `markAccessTokenExpired` to mark the token as expired if so (after which a call to this function will always refetch the token).
   *
   * @returns null if the session is known to be invalid, cached tokens if they exist in the cache and the access token hasn't expired yet (the refresh token might still be invalid), or new tokens otherwise.
   */
  async getOrFetchLikelyValidTokens(minMillisUntilExpiration: number, maxMillisSinceIssued: number | null): Promise<{ accessToken: AccessToken, refreshToken: RefreshToken | null } | null> {
    // fast path to save a roundtrip to the server if the session is known to be invalid
    if (this.isKnownToBeInvalid()) return null;

    const accessToken = this.getAccessTokenIfNotExpiredYet(minMillisUntilExpiration, maxMillisSinceIssued);
    if (!accessToken) {
      let newTokens = await this.fetchNewTokens();
      let issuedMillisAgo = newTokens?.accessToken.issuedMillisAgo;
      if (maxMillisSinceIssued !== null && issuedMillisAgo !== undefined && issuedMillisAgo > maxMillisSinceIssued) {
        // The process may have been suspended after the server issued the token but before this code resumed.
        // Retry once so an otherwise healthy session does not fail because of that scheduling delay.
        newTokens = await this.fetchNewTokens();
        issuedMillisAgo = newTokens?.accessToken.issuedMillisAgo;
      }
      const expiresInMillis = newTokens?.accessToken.expiresInMillis;
      if (expiresInMillis !== undefined && expiresInMillis < minMillisUntilExpiration) {
        throw new HexclaveAssertionError(`Required access token expiry ${minMillisUntilExpiration}ms is too long; access tokens are too short when they're generated (${expiresInMillis}ms)`);
      }
      if (maxMillisSinceIssued !== null && issuedMillisAgo !== undefined && issuedMillisAgo > maxMillisSinceIssued) {
        throw new HexclaveAssertionError(`Required access token issuance ${maxMillisSinceIssued}ms is too short; access token issuance is too slow (${issuedMillisAgo}ms)`);
      }
      return newTokens;
    }
    return { accessToken, refreshToken: this.getRefreshToken() };
  }

  /**
   * Fetches new tokens that are, at the time of fetching, guaranteed to be valid.
   *
   * The newly generated tokens are short-lived, so it's good practice not to rely on their validity (if possible). However, this function is useful in some cases where you only want to pass access tokens to a service, and you want to make sure said access token has the longest possible lifetime.
   *
   * In most cases, you should prefer `getOrFetchLikelyValidTokens`.
   *
   * @returns null if the session is known to be invalid, or new tokens otherwise (which, at the time of fetching, are guaranteed to be valid).
   */
  async fetchNewTokens(): Promise<{ accessToken: AccessToken, refreshToken: RefreshToken | null } | null> {
    const accessToken = await this._getNewlyFetchedAccessToken();
    return accessToken ? { accessToken, refreshToken: this._refreshToken } : null;
  }

  /**
   * Installs a freshly obtained token pair's access token into this session in place, keeping the session object
   * (and therefore every session-scoped cache) stable instead of constructing a new InternalSession. No-op if the
   * session is invalid, the access token can't be decoded, it's unchanged, or the pair doesn't map to this session
   * (so a foreign token can never be written into this object's cache); never clears an existing token.
   */
  updateAccessToken(tokens: { accessToken: string | null, refreshToken: string | null }) {
    if (this._knownToBeInvalid.get()) return;
    if (!tokens.accessToken) return;
    const newAccessToken = AccessToken.createIfValid(tokens.accessToken);
    if (!newAccessToken) return;
    // Self-enforce the "a session never changes which session it belongs to" invariant: only install a token pair
    // that maps to this same session key (validated against the incoming pair, not this session's existing tokens).
    if (InternalSession.calculateSessionKey(tokens) !== this.sessionKey) return;
    if (this._accessToken.get()?.token === newAccessToken.token) return;
    this._accessToken.set(newAccessToken);
  }

  /**
   * Manually mark the access token as expired, even if the date on its payload may still be valid.
   *
   * You don't usually have to call this function anymore, but you may want to call suggestAccessTokenExpired
   * to hint that the access token should be refreshed as its data may have changed, if possible.
   */
  markAccessTokenExpired(accessToken?: AccessToken) {
    if (!accessToken || this._accessToken.get()?.token === accessToken.token) {
      this._accessToken.set(null);
    }
  }

  /**
   * Strongly suggests that the access token should be refreshed as its data may have changed, although it's up to this
   * implementation to decide whether or when the access token will be refreshed.
   *
   * This is particularly useful when the data associated with the access token may have changed for example due to an
   * update to the user's profile.
   *
   * The current implementation marks the access token as expired if and only if a refresh token is available (regardless of
   * whether the refresh token is actually valid or not), although this is not a guarantee and subject to change.
   *
   * If you need a stronger guarantee of revoking an access token, use markAccessTokenExpired instead.
   */
  suggestAccessTokenExpired(): void {
    if (this._refreshToken) {
      this.markAccessTokenExpired();
    }
  }

  startRefreshingAccessToken(minMillisUntilExpiration: number, maxMillisSinceIssued: number | null): { unsubscribe: () => void } {
    let canceled = false;
    runAsynchronously(async () => {
      while (!canceled) {
        const tokens = await this.getOrFetchLikelyValidTokens(minMillisUntilExpiration, maxMillisSinceIssued);
        if (!tokens) return;  // session is invalid, stop refreshing
        const nextRefreshIn = Math.min(
          tokens.accessToken.expiresInMillis - minMillisUntilExpiration,
          (maxMillisSinceIssued ?? Infinity) - tokens.accessToken.issuedMillisAgo,
        );
        await wait(Math.max(1, nextRefreshIn));
      }
    });
    return {
      unsubscribe: () => {
        canceled = true;
      },
    };
  }

  /**
   * Note that a callback invocation with `null` does not mean the session has been invalidated; the access token may just have expired. Use `onInvalidate` to detect invalidation.
   */
  onAccessTokenChange(callback: (newAccessToken: AccessToken | null) => void): { unsubscribe: () => void } {
    return this._accessToken.onChange(callback);
  }

  /**
   * @returns An access token, which may be expired or expire soon, or null if it is known to be invalid.
   */
  private _getPotentiallyInvalidAccessTokenIfAvailable(): AccessToken | null {
    if (this.isKnownToBeInvalid()) return null;

    const accessToken = this._accessToken.get();
    if (accessToken && !accessToken.isExpired()) return accessToken;

    return null;
  }

  /**
   * You should prefer `_getOrFetchPotentiallyInvalidAccessToken` in almost all cases.
   *
   * @returns A newly fetched access token (never read from cache), or null if the session either does not represent a user or the session is invalid.
   */
  private async _getNewlyFetchedAccessToken(): Promise<AccessToken | null> {
    if (!this._refreshToken) return null;
    if (this._knownToBeInvalid.get()) return null;

    if (!this._refreshPromise) {
      this._refreshAndSetRefreshPromise(this._refreshToken);
    }
    return await this._refreshPromise;
  }

  private _refreshAndSetRefreshPromise(refreshToken: RefreshToken) {
    let refreshPromise: Promise<AccessToken | null> = this._options.refreshAccessTokenCallback(refreshToken)
      .then((accessToken) => {
        if (refreshPromise === this._refreshPromise) {
          this._refreshPromise = null;
          this._accessToken.set(accessToken);
          if (!accessToken) {
            this.markInvalid();
          }
        }
        return accessToken;
      })
      .finally(() => {
        // A failed refresh must not poison this session permanently. Fulfilled refreshes clear the promise above
        // before notifying listeners, while this also covers rejection without changing that listener ordering.
        if (refreshPromise === this._refreshPromise) {
          this._refreshPromise = null;
        }
      });
    this._refreshPromise = refreshPromise;
  }
}
