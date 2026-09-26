# Utilities

Common patterns referenced by bracketed notation in other spec files.


## Sending Requests

All API requests follow this pattern. This section describes the complete request lifecycle.

### Base URL

Construct API URL: `{baseUrl}/api/v1{path}`
  - baseUrl defaults to `https://api.hexclave.com`
  - Remove trailing slash from final URL
  - Example: `https://api.hexclave.com/api/v1/users/me`


### Required Headers (every request)

x-stack-project-id: <projectId>
x-stack-publishable-client-key: <publishableClientKey>
  - Note that this argument is optional, although if this is not given then the backend will return a PUBLISHABLE_CLIENT_KEY_REQUIRED_FOR_PROJECT error if requirePublishableClientKey is true on the project and you should panic.
x-stack-client-version: "<sdk-name>@<version>" (e.g., "python@1.0.0", "go@0.1.0")
x-stack-access-type: "client" | "server" | "admin"
  - "client" for HexclaveClientApp
  - "server" for HexclaveServerApp (also include server key header)
x-stack-override-error-status: "true"
  - Tells server to return 4xx errors as 200 with x-stack-actual-status header
  - This works around some platforms that intercept non-200 responses
x-stack-random-nonce: <random-string>
  - Cache buster to prevent framework caching (e.g., Next.js)
  - Generate a new random string for each request
content-type: application/json (for requests with body)

### OAuth client_secret sentinel

publishableClientKeyNotNecessarySentinel: "__stack_public_client__"
  - Use this as the OAuth client_secret when a project does not require a publishable client key.


### Authentication Headers [authenticated]

Include when session tokens are available:

x-stack-access-token: <access_token>
x-stack-refresh-token: <refresh_token> (if available)

On 401 response with code="invalid_access_token":
1. Mark access token as expired
2. Fetch new access token using refresh token (see Token Refresh below)
3. Retry the request with the new token
4. If still 401 after retry: treat as unauthenticated

### [server-only] - Server Key Required

Include header: x-stack-secret-server-key: <secretServerKey>
Only available in HexclaveServerApp.


### Retry Logic

For network errors (TypeError from fetch) on idempotent requests (GET, HEAD, OPTIONS, PUT, DELETE):
1. Retry up to 5 times
2. Use exponential backoff: delay = 1000ms * 2^attempt
3. If all retries fail: throw network error with diagnostics

For rate limiting (429 response):
1. Check Retry-After header for delay (in seconds)
2. Wait that duration, then retry
3. If no Retry-After header: retry immediately with backoff


### Request Body

POST, PATCH, and PUT requests MUST include a JSON body, even if empty.
If no body data is needed, send an empty object: {}

Set Content-Type: application/json for all requests with a body.


### Response Processing

1. Check x-stack-actual-status header for real status code
   (Server may return 200 with actual status in this header)

2. Check x-stack-known-error header for error code
   If present: body is { code, error, details? }
   Parse into appropriate error type

3. On success (2xx): parse JSON body and return


### Credentials

Set credentials: "omit" on fetch to avoid sending cookies cross-origin.
(Skip this on platforms that don't support it, e.g., Cloudflare Workers)


### Cache Control

Set cache: "no-store" to prevent caching.
(Skip this on platforms that don't support it)


## Error Response Format

If the response has x-hexclave-known-error / x-stack-known-error header, the body has shape:
  { code: string, error: string, details?: object }

The code matches the known error header value. "error" is the human-readable message
(there is no "message" field). Use the header value as the error code, "error" as the
message, and pass "details" through (e.g. details.attempt_code for
MULTI_FACTOR_AUTHENTICATION_REQUIRED).

OAuth endpoints (e.g. POST /api/v1/auth/oauth/token) may also return standard OAuth 2.0
error bodies without a known error header:
  { error: string, error_description?: string }
Here "error" is the error code. Surface these as OAuthError(error, error_description).
See packages/stack-shared/src/known-errors.ts for all error types.


## StackAuthApiError

The base error type for all Hexclave API errors.

Properties:
  code: string - error code from API, UPPERCASE_WITH_UNDERSCORES (e.g., "USER_NOT_FOUND")
  message: string - human-readable error message
  details: object? - optional additional details

Error codes are always UPPERCASE_WITH_UNDERSCORES format.
Examples: EMAIL_PASSWORD_MISMATCH, USER_NOT_FOUND, PASSWORD_REQUIREMENTS_NOT_MET, PASSWORD_TOO_SHORT

Note: PASSWORD_TOO_SHORT is returned when a password doesn't meet minimum length requirements.
PASSWORD_REQUIREMENTS_NOT_MET is a more general error for other password policy violations.

All function-specific errors (like PasswordResetCodeInvalid, EmailPasswordMismatch, etc.) 
should extend or be instances of StackAuthApiError.

For unrecognized error codes, create a StackAuthApiError with the code and message from the response.


## Token Store

Stores access_token and refresh_token. The tokenStore constructor option determines storage strategy.

Many functions also accept a tokenStore parameter to override storage for that call.
When the constructor's tokenStore is non-null, this parameter is optional (defaults to
the constructor's value). When the constructor's tokenStore is null, this parameter
becomes REQUIRED for all authenticated functions - see the "null" section below. (If possible in a language, this should be represented in its type system, but otherwise you can also panic.)

### TokenStoreInit Type

TokenStoreInit is a union type representing the different ways to provide token storage:

```ts
TokenStoreInit = 
  | "cookie"                              // [JS-ONLY] Browser cookies
  | "keychain"                            // [APPLE-ONLY] Secure Keychain storage
  | "memory"                              // In-memory storage
  | { accessToken: string, refreshToken: string }  // Explicit tokens
  | RequestLike                           // Extract from request headers
  | null                                  // No storage
```

This is the "token store" that developers interface with with the SDK, so this is the value that's passed to the constructor or any functions that require a token store. The SDK implementation then converts this to a concrete token store implementation as detailed below.

### Token Store Interface

Token stores have some properties and methods. Some are abstract and are implemented by the token store itself.


```
  abstract getStoredAccessToken(): string | null (getter)
    Currently stored access token, or null if not set. This is internal and shouldn't be used outside the token store; the getOrFetchLikelyValidAccessToken function as described below is preferred, as it automatically refreshes its tokens.
    
  abstract getStoredRefreshToken(): string | null (getter)
    Currently stored refresh token, or null if not set.

  abstract compareAndSet(compareRefreshToken, newRefreshToken, newAccessToken)
    Atomically compare-and-set the refresh and access token.
    Compares compareRefreshToken to current refreshToken.
    If they match: set the tokens accordingly. Otherwise, do nothing.
  
  getOrFetchLikelyValidTokens(): { refreshToken: string | null, accessToken: string | null }
    Gets the access token if it's likely to remain valid, and returns the associated refresh token with it. The function may refresh the tokens according to the algorithm below.

    This is the function that should usually be used to get an access token as it will automatically refresh tokens that are about to expire.

    Algorithm:
      Note: To avoid refreshing more than once at the same time, only one caller can hold the refresh lock for a given token store at once. Use a mutex, semaphore, or equivalent concurrency primitive appropriate for your language to ensure this.
      
      Let originalRefreshToken = TS.getStoredRefreshToken() (capture at start)
      Let originalAccessToken = TS.getStoredAccessToken() (capture at start)
      If originalRefreshToken does not exist:
        If originalAccessToken expires in >0 seconds:
          Return { refreshToken: null, accessToken: originalAccessToken }
          - NOTE: The returned token might be invalid by the time it's used due to timing delays. This is okay, the documentation should just explain that.
        Otherwise (originalAccessToken is expired or null):
          Return { refreshToken: null, accessToken: null }
      Otherwise (originalRefreshToken exists):
        if originalAccessToken expires in > 20 seconds and was issued < 75 seconds ago:
          Return { refreshToken: originalRefreshToken, accessToken: originalAccessToken }
        Otherwise:
          was_refresh_token_valid, newAccessToken = refresh(originalRefreshToken)
          If was_refresh_token_valid is TRUE:
            Call TS.compareAndSet(compare: originalRefreshToken, newRefreshToken: originalRefreshToken, newAccessToken: newAccessToken)
            return { refreshToken: originalRefreshToken, accessToken: newAccessToken }
          Otherwise (was_refresh_token_valid is FALSE):
            Call TS.compareAndSet(compare: originalRefreshToken, newRefreshToken: null, newAccessToken: null)
            return { refreshToken: null, accessToken: null }

  fetchNewAccessToken(): { refreshToken: string | null, accessToken: string | null }
    Forcefully fetches a new access token from the server if possible, returning a new access token or null if there was no refresh token, or the refresh token was invalid/expired. Returns the associated refresh token with the new access token.
```

To refresh an access token from a refresh token, use an OAuth2 token grant:
  POST /api/v1/auth/oauth/token
  Content-Type: application/x-www-form-urlencoded

  Body (form-encoded):
    grant_type: refresh_token
    refresh_token: <refresh_token>
    client_id: <projectId>
    client_secret: <publishableClientKey | publishableClientKeyNotNecessarySentinel>

  Response on success (200 OK):
    { access_token: string, refresh_token?: string, ... }


### Token Store Types

"cookie": [JS-ONLY]
  Store tokens in browser cookies. Requires browser environment.
  Due to cookie complexity (Secure flags, SameSite, Partitioned/CHIPS, HTTPS detection),
  this is only implemented in the JS SDK. Other SDKs should use "memory", "keychain",
  or explicit tokens.

"keychain": [APPLE-ONLY]
  Store tokens in the system Keychain (iOS, macOS, watchOS, tvOS, visionOS).
  Tokens persist securely across app launches and are protected by the OS.
  Only available on Apple platforms via the Security framework.
  This is the recommended default for iOS/macOS apps.
  
  Multiple uses of "keychain" with the same projectId must share the same
  underlying token store instance (and therefore the same refresh lock).
  See "Token Store Registry" below.
  
"memory":
  Store tokens in runtime memory. Lost on page refresh or process restart.
  Useful for short-lived sessions, CLI tools, or server-side scripts.
  
  Multiple uses of "memory" with the same projectId must share the same
  underlying token store instance (and therefore the same refresh lock).
  See "Token Store Registry" below.

{ accessToken, refreshToken } object:
  Initialize with explicit token values.
  For custom token management scenarios.

RequestLike object:
  An object that conforms to whatever the requests look like in common backend frameworks.
  In JavaScript, common shapes include:
  - `{ headers: { get(name: string): string | null } }`
  - `{ headers: Record<string, string | null> }`
  In other languages this may drastically differ (and may not even be an interface and instead rather just be an abstract class, or not exist at all).

  This exists as a simplified way to support common backend frameworks in a more accessible way than the `{ accessToken: string, refreshToken: string }` one.
  
  Extract tokens from request headers:
  1. Preferred: `Authorization` header in this format:
     `Bearer stackauth_<base64({ "accessToken": "...", "refreshToken": "..." })>`
  2. Legacy fallback: `x-stack-auth` JSON header
     (`{ "accessToken": string, "refreshToken": string }`)
  3. If neither auth header exists, read from cookies

null:
  No token storage. When the constructor's tokenStore is null, the tokenStore
  argument becomes REQUIRED (non-optional) for all authenticated function calls.
  
  Languages with expressive type systems (like TypeScript) can represent this
  at the type level - the tokenStore parameter is optional when the constructor
  has a token store, but required when it's null. For languages that cannot
  express this in the type system, panic at runtime if an
  authenticated function is called without a tokenStore argument when the
  constructor's tokenStore was null, with a descriptive error message that explains what to do.
  
  This is most useful for backends where you don't have a default token store
  but want to specify tokens per-request (e.g., from request headers).


### Token Store Registry

For "keychain" and "memory" token stores, SDKs must ensure that all uses with the
same projectId share the same underlying token store instance. This is important
because:

1. Multiple HexclaveClientApp instances for the same project should share tokens
2. Token store overrides (e.g., `getUser(tokenStore: .keychain)`) must use the
   same instance as the constructor's default store
3. The refresh lock must be shared to prevent concurrent refresh operations

To achieve this, maintain a registry that maps projectId to token store instances.
When a "keychain" or "memory" store is requested, return the existing instance
for that projectId if one exists, or create and store a new one if not.

This does NOT apply to explicit token stores (`{ accessToken, refreshToken }`),
custom stores, or null stores - those are always created fresh per use.


### Authorization Header Format

For cross-origin requests or server-side handling, use this header:
  Authorization: Bearer stackauth_<base64({ "accessToken": "<token>", "refreshToken": "<token>" })>

Use getAuthorizationHeader() to generate this header value.

### Legacy x-stack-auth Header Format

For backwards compatibility, request-like token stores also accept:
  x-stack-auth: { "accessToken": "<token>", "refreshToken": "<token>" }

Use getAuthHeaders() to generate this header value.

## MFA Handling Pattern

Several sign-in methods may return MultiFactorAuthenticationRequired error when MFA is enabled.

Error format:
  code: "MULTI_FACTOR_AUTHENTICATION_REQUIRED"
  message: "Multi-factor authentication is required."
  details: { attempt_code: string }

When this error is received:
1. Store the attempt_code (e.g., in sessionStorage)
2. Redirect user to the MFA page (urls.mfa)
3. User enters their 6-digit TOTP code
4. Call signInWithMfa(otp, attemptCode) to complete sign-in

Methods that can return this error:
- signInWithCredential
- signInWithMagicLink
- signInWithPasskey
- callOAuthCallback

The attempt_code is short-lived (a few minutes) and single-use.


## JWT Access Token Claims

The access token is a JWT with these claims:

| Claim | Maps to | Type |
|-------|---------|------|
| sub | id | string |
| name | displayName | string or null |
| email | primaryEmail | string or null |
| email_verified | primaryEmailVerified | boolean |
| is_anonymous | isAnonymous | boolean |
| is_restricted | isRestricted | boolean |
| restricted_reason | restrictedReason | object or null |
| exp | expiresAt | number (Unix timestamp) |
| iat | issuedAt | number (Unix timestamp) |

To decode: split by ".", base64url-decode the second segment, parse as JSON.


## Unknown Errors

If an API returns an error code not listed in the spec:
1. Create a generic StackAuthApiError with the code and message
2. Log the unknown error for debugging
3. Treat it as a general API error

This ensures forward compatibility when new error codes are added.
