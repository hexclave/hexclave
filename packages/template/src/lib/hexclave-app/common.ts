import { ProviderType } from "@hexclave/shared/dist/utils/oauth";
import type { ExternalAuthProviderId } from "@hexclave/shared/dist/interface/external-auth";
import type { GenericQueryCtx, UserIdentity } from "convex/server";
export type {
  DefaultHandlerUrlTarget,
  HandlerPageUrls,
  HandlerRedirectUrls,
  HandlerUrlOptions,
  HandlerUrlTarget,
  HandlerUrls,
  ResolvedHandlerUrls,
} from "@hexclave/shared/dist/interface/handler-urls";

export type RedirectToOptions = {
  replace?: boolean,
  noRedirectBack?: boolean,
};

export type AsyncStoreProperty<Name extends string, Args extends any[], Value, IsMultiple extends boolean> =
  & { [key in `${IsMultiple extends true ? "list" : "get"}${Capitalize<Name>}`]: (...args: Args) => Promise<Value> }
  & { [key in `use${Capitalize<Name>}`]: (...args: Args) => Value } // THIS_LINE_PLATFORM react-like

export type EmailConfig = {
  host: string,
  port: number,
  username: string,
  password: string,
  senderEmail: string,
  senderName: string,
}

export type RedirectMethod = "window"
  | "nextjs" // THIS_LINE_PLATFORM next
  | "tanstack-start" // THIS_LINE_PLATFORM tanstack-start
  | "none"
  | {
    useNavigate: () => (to: string) => void,
    navigate?: (to: string) => void,
  }


export type GetCurrentUserOptions<HasTokenStore> =
  & {
    or?: 'redirect' | 'throw' | 'return-null' | 'anonymous' | /** @deprecated */ 'anonymous-if-exists[deprecated]',
    /**
     * Whether to include restricted users (users who haven't completed onboarding requirements like email verification).
     * By default, restricted users are filtered out (treated similar to anonymous users).
     *
     * Note: This option cannot be set to false when `or: 'anonymous'` is used, as all anonymous users are also restricted.
     *
     * @default false
     */
    includeRestricted?: boolean,
    tokenStore?: TokenStoreInit,
  }
  & (HasTokenStore extends false ? {
    tokenStore: TokenStoreInit,
  } : {});

export type ConvexCtx =
| GenericQueryCtx<any>
| { auth: { getUserIdentity: () => Promise<UserIdentity | null> } };

export type GetCurrentPartialUserOptions<HasTokenStore> =
  & {
    or?: 'return-null' | 'anonymous-if-exists',  // note: unlike normal getUser, 'anonymous' still returns null sometimes (eg. if no token is present)
    tokenStore?: TokenStoreInit,
  }
  & (
    | {
      from: 'token',
    }
    | {
      from: 'convex',
      ctx: ConvexCtx,
    }
  )
  & (HasTokenStore extends false ? {
    tokenStore: TokenStoreInit,
  } : {});

export type RequestLike = {
  headers:
    | {
      get: (name: string) => string | null,
    }
    | Record<string, string | null>,
};

export type ExternalTokenStore = {
  readonly type: "external",
  readonly providerId: ExternalAuthProviderId,
  getSessionId?(): string | null,
  getToken(): Promise<string | null>,
  /** The adapter retains this subscription for its own lifetime and does not unsubscribe it. */
  subscribe?(callback: () => void): () => void,
};

type ExternalTokenStoreOptions = Omit<ExternalTokenStore, "type" | "providerId">;

function createExternalTokenStore(providerId: ExternalAuthProviderId, options: ExternalTokenStoreOptions): ExternalTokenStore {
  return {
    ...options,
    type: "external",
    providerId,
  };
}

export function clerkTokenStore(options: ExternalTokenStoreOptions): ExternalTokenStore {
  return createExternalTokenStore("clerk-integration", options);
}

export function betterAuthTokenStore(options: ExternalTokenStoreOptions): ExternalTokenStore {
  return createExternalTokenStore("better-auth-integration", options);
}

export function workosTokenStore(options: ExternalTokenStoreOptions): ExternalTokenStore {
  return createExternalTokenStore("workos-integration", options);
}

export type TokenStoreInit<HasTokenStore extends boolean = boolean> =
  HasTokenStore extends true ? (
    | "cookie"
    | "nextjs-cookie"
    | "memory"
    | RequestLike
    | { accessToken: string, refreshToken: string }
    | ExternalTokenStore
  )
  : HasTokenStore extends false ? null
  : TokenStoreInit<true> | TokenStoreInit<false>;

export type OAuthScopesOnSignIn = {
  [key in ProviderType]: string[];
};

/**
 * Contains the authentication methods without session-related fields.
 * Used for apps that have token storage capabilities.
 */
export type AuthLike<ExtraOptions = {}> = {
  signOut(options?: { redirectUrl?: URL | string } & ExtraOptions): Promise<void>,
  signOut(options?: { redirectUrl?: URL | string }): Promise<void>,

  /**
   * Returns the current access token, or null if the user is not signed in.
   *
   * The access token is a short-lived JWT that can be used to authenticate requests to external servers.
   * It will be automatically refreshed when it expires.
   */
  getAccessToken(options?: {} & ExtraOptions): Promise<string | null>,
  useAccessToken(options?: {} & ExtraOptions): string | null, // THIS_LINE_PLATFORM react-like

  /**
   * Returns the current refresh token, or null if the user is not signed in.
   *
   * The refresh token is a long-lived token that can be used to obtain new access tokens.
   * It should be kept secret and never exposed to the client.
   */
  getRefreshToken(options?: {} & ExtraOptions): Promise<string | null>,
  useRefreshToken(options?: {} & ExtraOptions): string | null, // THIS_LINE_PLATFORM react-like

  /**
   * Returns the value for the HTTP `Authorization` header for authenticated requests to external servers.
   * Most commonly used in cross-origin requests. Similar to `getAuthJson`, but specifically for HTTP requests.
   *
   * If you are using `tokenStore: "cookie"`, you don't need this for same-origin requests. However, most
   * browsers now disable third-party cookies by default, so we must pass authentication tokens by header instead
   * if the client and server are on different origins.
   *
   * This function returns the header value in this format:
   * `Bearer stackauth_<base64(getAuthJson())>`, or `null` if the user is not signed in.
   * You can use this with `fetch` or other HTTP request libraries to send authenticated requests.
   *
   * On the server, you can then pass in the `Request` object to the `tokenStore` option
   * of your Stack app. Please note that CORS does not allow most headers by default, so you
   * must include `authorization` in the [`Access-Control-Allow-Headers` header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers)
   * of the CORS preflight response.
   *
   * If you are not using HTTP (and hence cannot set headers), use `getAuthJson()` instead.
   *
   * Example:
   *
   * ```ts
   * // client
   * const authorizationHeader = await hexclaveApp.getAuthorizationHeader();
   * const res = await fetch("https://api.example.com", {
   *   headers: {
   *     ...(authorizationHeader ? { Authorization: authorizationHeader } : {})
   *     // you can also add your own headers here
   *   },
   * });
   *
   * // server
   * function handleRequest(req: Request) {
   *   const user = await hexclaveServerApp.getUser({ tokenStore: req });
   *   return new Response("Welcome, " + user.displayName);
   * }
   * ```
   */
  getAuthorizationHeader(options?: {} & ExtraOptions): Promise<string | null>,
  useAuthorizationHeader(options?: {} & ExtraOptions): string | null, // THIS_LINE_PLATFORM react-like

  /**
   * @deprecated Use `getAuthorizationHeader()` instead.
   *
   * Returns the legacy `x-stack-auth` headers for authenticated HTTP requests. This remains for backwards
   * compatibility with existing integrations.
   */
  getAuthHeaders(options?: {} & ExtraOptions): Promise<{ "x-stack-auth": string }>,
  /** @deprecated Use `useAuthorizationHeader()` instead. */
  useAuthHeaders(options?: {} & ExtraOptions): { "x-stack-auth": string }, // THIS_LINE_PLATFORM react-like

  /**
   * Creates a JSON-serializable object containing the information to authenticate a user on an external server.
   * Similar to `getAuthorizationHeader`, but returns an object that can be sent over any protocol instead of just
   * HTTP headers.
   *
   * While `getAuthorizationHeader` is the recommended way to send authentication tokens over HTTP, your app may use
   * a different protocol, for example WebSockets or gRPC. This function returns a token object that can be JSON-serialized and sent to the server in any way you like.
   *
   * On the server, you can pass in this token object into the `tokenStore` option to fetch user details.
   *
   * Example:
   *
   * ```ts
   * // client
   * const res = await rpcCall(rpcEndpoint, {
   *   data: {
   *     auth: await hexclaveApp.getAuthJson(),
   *   },
   * });
   *
   * // server
   * function handleRequest(data) {
   *   const user = await hexclaveServerApp.getUser({ tokenStore: data.auth });
   *   return new Response("Welcome, " + user.displayName);
   * }
   * ```
   */
  getAuthJson(options?: {} & ExtraOptions): Promise<{ accessToken: string | null, refreshToken: string | null }>,
  useAuthJson(options?: {} & ExtraOptions): { accessToken: string | null, refreshToken: string | null }, // THIS_LINE_PLATFORM react-like
};

/** @internal */
export const hexclaveAppInternalsSymbol = Symbol.for("StackAuth--DO-NOT-USE-OR-YOU-WILL-BE-FIRED--StackAppInternals");
