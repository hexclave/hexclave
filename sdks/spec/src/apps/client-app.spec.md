# HexclaveClientApp

The main client-side SDK class.

Deprecated alias: StackClientApp.


## Constructor

HexclaveClientApp(options)

Required:
  projectId: string - from Hexclave dashboard

Optional:
  publishableClientKey: string
    From Hexclave dashboard. If omitted, the SDK uses
    publishableClientKeyNotNecessarySentinel for OAuth client_secret (which
    assumes that the project does not require a publishable client key), and
    no x-stack-publishable-client-key header is sent.
  baseUrl: string | { browser, server } 
    Default: "https://api.hexclave.com"
    Can specify different URLs for browser vs server environments.
    
  tokenStore: "cookie" | "memory" | { accessToken, refreshToken } | null
    Default: "cookie" (JS) or "memory" (other SDKs)
    Where to store authentication tokens.
    "cookie" is JS-only due to complexity. See _utilities.spec.md for details.
      
  oauthScopesOnSignIn: object
    Additional OAuth scopes to request during sign-in for each provider.
    Example: { google: ["https://www.googleapis.com/auth/calendar"] }
    
  extraRequestHeaders: object
    Additional headers to include in every API request.
    
  redirectMethod: "nextjs" | "browser" | "none"
    How to perform redirects.
    "nextjs": Use Next.js redirect() function [JS-ONLY]
    "browser": Use window.location for client-side redirects
    "none": Don't redirect, return control to caller
    
  noAutomaticPrefetch: bool
    Default: false
    If true, skip prefetching project info on construction.

  automaticSideEffects: bool [JS-ONLY]
    Default: true
    If false, construction must not start any automatic side effects. This includes
    prefetching, processing authentication or redirect query parameters, reading
    or writing browser storage or cookies, consuming `hexclave_action_id` browser
    actions, recording analytics or session replays, installing browser listeners,
    starting timers, or mounting development UI.
    Explicit method calls retain their normal behavior and side effects. This
    option makes construction inert.

On construct: when automaticSideEffects=true, prefetch project info
(GET /projects/current) unless noAutomaticPrefetch=true. When
automaticSideEffects=false, perform no automatic side effects. Browser action
initialization removes `hexclave_action_id` from the address bar before consuming
it and retries that removal during the initial event-loop turns so framework
routers cannot restore the action URL after hydration. If consumption reports an
already-used or expired action, treat it as an expected no-op.


## Feature flags

Public JSON types:

```
FeatureFlagOptions {
  context?: map<string, Json>
  teamId?: string
  exposure?: "auto" | "manual" | "none"  // default "auto"
}

FeatureFlagRequest { key: string, fallback: Json, options?: FeatureFlagOptions }

FeatureFlagDetails<T> {
  flagKey: string
  value: T
  variantKey: string?
  reason: string
  ruleId: string?
  configVersion: string
  experimentId: string?
  experimentRunId: string?
  isStale: bool
  exposureToken: string?
}
```

Methods:

- `getFeatureFlag<T>(key, fallback, options?) -> T`
- `getFeatureFlagDetails<T>(key, fallback, options?) -> FeatureFlagDetails<T>`
- `getFeatureFlags(requests) -> Map<string, FeatureFlagDetails<Json>>`
- `trackFeatureFlagExposure(details) -> void`
- `useFeatureFlag<T>(key, fallback, options?) -> T` [REACT-LIKE]
- `useFeatureFlagDetails<T>(key, fallback, options?) -> FeatureFlagDetails<T>` [REACT-LIKE]

Before evaluation, call `getUser({ or: "anonymous" })`. This reuses the authenticated user when present and otherwise creates/reuses the SDK's persistent anonymous user. Build trusted evaluation attributes from that canonical user only: ID, verified primary email (or null), primary-email verification state, and sign-up timestamp. Never accept a user ID, verified-email state, or other trusted identity attribute from feature-flag options. `teamId` is only a selection hint and must be ignored unless the API can derive and authorize it from the current session.

Request:

```
POST /api/v1/feature-flags/evaluate [authenticated client]
{
  flag_keys: string[1..50],
  fallbacks: map<string, Json>,
  team_id?: string,
  context?: map<string, Json>
}
```

Context is limited to 32 keys, 64 characters per key, 8192 serialized bytes, five nested levels, finite numbers, and JSON-serializable values. All requests in one batch must use the same context and team ID. Duplicate flag keys are invalid.

The response has a `results` object keyed by public flag key. Fail loudly if any requested key is absent, metadata is malformed, or a result crosses the fallback's JSON kind. Normalize request order before caching, scope caches by the current user/session identity, and invalidate older entries when a response reveals a new config version. Bound evaluation, result, and identity-version caches with deterministic oldest-entry eviction (the JS implementation defaults to 1000 entries); bound exposure deduplication/retry state separately (the JS implementation uses 10000 entries). Hooks must suspend on the stable cached evaluation promise and surface evaluation errors to the nearest error boundary.

For `exposure: "auto"`, batch non-null signed exposure tokens to `POST /api/v1/feature-flags/exposures/batch`. Deduplicate by identity + config version + flag + experiment run, including concurrent calls. `manual` returns the token without sending it; `none` neither sends nor requires a token. `trackFeatureFlagExposure` applies the same deduplication and retries after failed sends.

Feature flags are delivery controls, not authorization checks. Security decisions must remain on a trusted server.


## trackEvent(name, options?)

Records a customer-defined analytics conversion event. Names are 1-128 characters, use letters/numbers plus `. _ : -`, and cannot begin with `$` because those names are reserved. `options.properties` contains at most 50 JSON-serializable entries and 16384 serialized bytes; `options.value` must be finite. `options.teamId` selects the team assignment context and is accepted only after the backend verifies that the current user belongs to that team.

Browser implementations append custom events to the same `/api/v1/analytics/events/batch` buffer used for page views and clicks. Every resolved feature-flag call, including a cache hit, sets the active team context for subsequently captured page views and clicks; a user-scoped call clears it. Perform this update after the asynchronous evaluation resolves, never during React render. An explicit `trackEvent` team ID applies only to that event. Preserve event order and put a failed non-blocked batch back at the front of the buffer for retry. Clear buffered events and team context on sign-out to prevent cross-user leakage. Server-like implementations send a bounded one-event batch immediately. Fail explicitly when analytics is disabled.


## signInWithOAuth(provider, options?)  [BROWSER-LIKE]

Starts an OAuth authentication flow with the specified provider.
Use an OAuth library (e.g., oauth4webapi) to handle PKCE and state management.

Arguments:
  provider: string - OAuth provider ID (e.g., "google", "github", "microsoft")
  options.returnTo: string [BROWSER-ONLY, optional] - URL to redirect to after the OAuth callback completes
  
  options.presentationContextProvider: platform-specific [NATIVE-ONLY]
    - iOS/macOS: ASWebAuthenticationPresentationContextProviding
    - Android: Activity context for Custom Tabs

Returns: 
  - Browser: never (opens browser and redirects)
  - Native apps: void (async, completes when user finishes OAuth flow)

Note: Additional provider scopes are configured via oauthScopesOnSignIn constructor option.

Implementation:
1. Construct full redirect URLs using a fixed callback scheme:
   - Native apps: "hexclave-mobile-oauth-url://success" and "hexclave-mobile-oauth-url://error"
   - Browser: Use the configured OAuth callback handler URL as redirect_uri and window.location to construct absolute URLs
   - Browser: If options.returnTo is provided, pass it as afterCallbackRedirectUrl, not as redirect_uri

2. Call getOAuthUrl() with the constructed URLs to get:
   - Authorization URL
   - State parameter
   - PKCE code verifier
   - Redirect URL

3. Store code verifier for later retrieval, keyed by state
   - Browser: cookie "stack-oauth-outer-{state}" (maxAge: 1 hour)
   - Mobile/other: in-memory (passed directly to callback handler)

4. Open the authorization URL:
   - Browser: perform redirect according to redirectMethod
   - iOS/macOS: ASWebAuthenticationSession with callbackURLScheme: "hexclave-mobile-oauth-url"
   - Android: Custom Tabs with callback URL registered as deep link
   - Desktop: Open system browser with registered URL scheme for callback

   [APPLE-ONLY] Special case for Apple provider:
   When provider is "apple" on Apple platforms, use native Sign In with Apple
   (ASAuthorizationController) instead of ASWebAuthenticationSession. See
   "Native Apple Sign In" section below.

5. Handle callback:
   - Browser: Never returns; user lands on callback page which calls callOAuthCallback()
   - Native apps: ASWebAuthenticationSession/Custom Tabs returns callback URL directly;
     call callOAuthCallback(url, codeVerifier, redirectUrl) to exchange code for tokens

The flow continues when the user is redirected back to the callback URL.
Call callOAuthCallback() on the callback page/handler to complete the flow.

Error handling:
  - User cancellation: StackAuthError(code: "oauth_cancelled", message: "User cancelled OAuth")
  - Other errors: OAuthError(code: "oauth_error", message: <platform error description>)


### Native Apple Sign In [APPLE-ONLY]

When the provider is "apple" on Apple platforms (iOS, macOS, tvOS, watchOS, visionOS),
implementations SHOULD use the native Sign In with Apple flow instead of the web-based
OAuth flow. This provides a better user experience with Face ID/Touch ID integration
and follows Apple's guidelines.

Native Apple Sign In flow:
1. Create an ASAuthorizationAppleIDRequest via ASAuthorizationAppleIDProvider
2. Request scopes: [.fullName, .email]
3. Present via ASAuthorizationController
4. On success, receive:
   - identityToken: JWT signed by Apple containing user info
   - authorizationCode: Can be used for token refresh  
   - user: Contains name/email (only on first authorization)
5. Send identityToken to backend endpoint:
   POST /api/v1/auth/oauth/callback/apple/native
   Headers: x-stack-project-id, x-stack-publishable-client-key, x-stack-access-type: client
   Body: { id_token: string }
6. Backend verifies JWT against Apple's public keys (audience = Bundle ID), extracts user info
7. Backend returns: { access_token, refresh_token, user_id, is_new_user }
8. Store tokens and complete sign-in

Configuration requirements:
- The project must have the Apple OAuth provider enabled in the Hexclave dashboard
- For native apps, the "Bundle ID" field must be configured (this is your app's Bundle Identifier)
- Note: The "Client ID" field in the dashboard is for web OAuth (Services ID), not native apps

Implementation notes:
- The identityToken is a JWT that can be verified using Apple's JWKS (`https://appleid.apple.com/auth/keys`)
- The JWT's audience claim must match the configured Bundle ID
- User's name and email are only provided on the FIRST authorization; cache if needed
- The native flow does NOT use redirect URLs - tokens are returned directly
- Face ID/Touch ID authentication is handled automatically by the system dialog

Error handling:
  - User cancellation: ASAuthorizationError.canceled → StackAuthError(code: "oauth_cancelled")
  - Other ASAuthorizationError: Map to appropriate StackAuthError

IMPORTANT: If the backend returns INVALID_APPLE_CREDENTIALS, implementations MUST panic/fatal error.
This indicates misconfigured Bundle ID in the dashboard or token tampering - not recoverable by retry.


## getOAuthUrl(provider, redirectUrl, errorRedirectUrl, options?)

Returns the OAuth authorization URL without performing the redirect.
Useful for non-browser environments or custom OAuth handling.

Arguments:
  provider: string - OAuth provider ID (e.g., "google", "github", "microsoft")
  redirectUrl: string - Full URL where the user will be redirected after OAuth (when not in a browser, must be an absolute URL)
  errorRedirectUrl: string - Full URL where the user will be redirected on error (when not in a browser, must be an absolute URL)
  options.state: string? - custom state parameter (default: auto-generated)
  options.codeVerifier: string? - custom PKCE verifier (default: auto-generated)

Returns: { url: string, state: string, codeVerifier: string, redirectUrl: string }
  url: The full authorization URL to open in a browser
  state: The state parameter (for CSRF verification)
  codeVerifier: The PKCE code verifier (store for token exchange)
  redirectUrl: The redirect URL (same as input, needed for token exchange - must match exactly)

Note on URL schemes:
- The "hexclave-mobile-oauth-url://" scheme is automatically accepted by the backend without any configuration.

Implementation:
1. Generate or use provided state and codeVerifier
2. Compute code challenge: base64url(sha256(codeVerifier))
3. Build authorization URL (same as signInWithOAuth step 5), using
   client_secret=<publishableClientKey | publishableClientKeyNotNecessarySentinel>
4. Return { url, state, codeVerifier, redirectUrl } without redirecting

The caller is responsible for:
- Opening the URL in a browser/webview
- Storing the state, codeVerifier, and redirectUrl
- Calling callOAuthCallback() with the callback URL and these values


## signInWithCredential(options)

Arguments:
  options.email: string
  options.password: string
  options.noRedirect: bool? - if true, don't redirect after success

Returns: void

Request:
  POST /api/v1/auth/password/sign-in
  Body: { email: string, password: string }

Response on success:
  { access_token: string, refresh_token: string }

Implementation:
1. Send request
2. On MFA required: redirect to MFA page (stores attempt_code in sessionStorage)
3. Store tokens { access_token, refresh_token }
4. Redirect to afterSignIn URL (unless noRedirect=true)

Errors:
  EmailPasswordMismatch
    code: "email_password_mismatch"
    message: "The email and password combination is incorrect."
    
  InvalidTotpCode
    code: "invalid_totp_code"
    message: "The MFA code is incorrect."


## signUpWithCredential(options)

Arguments:
  options.email: string
  options.password: string
  options.verificationCallbackUrl: string? - URL for email verification link
  options.noVerificationCallback: bool? - if true, skip email verification
  options.noRedirect: bool?

Returns: void

Request:
  POST /api/v1/auth/password/sign-up
  Body: { 
    email: string, 
    password: string, 
    verification_callback_url: string? 
  }

Response on success:
  { access_token: string, refresh_token: string }

Implementation:
1. If noVerificationCallback and verificationCallbackUrl both set: throw error
2. Build verification URL (unless noVerificationCallback=true)
3. Send request
4. If redirect URL not whitelisted error AND we didn't opt out of verification:
   - Log warning, retry without verification URL
5. Store tokens { access_token, refresh_token }
6. Redirect to afterSignUp URL (unless noRedirect=true)

Errors:
  UserWithEmailAlreadyExists
    code: "user_email_already_exists"
    message: "A user with this email address already exists."

  ContactChannelAlreadyUsedForAuthBySomeoneElse
    code: "contact_channel_already_used_for_auth_by_someone_else"
    message: "This email is already used for authentication by another account."
    
  PasswordRequirementsNotMet
    code: "password_requirements_not_met"
    message: "The password does not meet the project's requirements."


## signOut(options?)

Arguments:
  options.redirectUrl: string? - where to redirect after sign out
  options.tokenStore: TokenStoreInit? - override token storage for this call

Returns: void

Request:
  DELETE /api/v1/auth/sessions/current [authenticated]
  Body: {}

Implementation:
1. Send request (ignore errors - session may already be invalid)
2. Clear stored tokens (mark session invalid)
3. Redirect to redirectUrl or afterSignOut URL

Does not error (errors are ignored).


## getUser(options?)

Arguments:
  options.or: "redirect" | "throw" | "return-null" | "anonymous"
    Default: "return-null"
  options.includeRestricted: bool?
    Default: false
    Whether to return users who haven't completed onboarding
  options.tokenStore: TokenStoreInit? - override token storage for this call

Returns: CurrentUser | null

IMPORTANT: { or: 'anonymous' } and { includeRestricted: false } are mutually exclusive.
Anonymous users are always restricted, so this combination doesn't make sense.
Throw an error if both are specified.

Request (to fetch user):
  GET /api/v1/users/me [authenticated]

Response on success:
  CurrentUserCrud object (see types/users/current-user.spec.md for full schema)

Request (to create anonymous user):
  POST /api/v1/auth/anonymous/sign-up
  Body: {}

Response:
  { access_token: string, refresh_token: string }

Implementation:
1. Get tokens from storage
2. Determine flags:
   - includeAnonymous = (or == "anonymous")
   - includeRestricted = (includeRestricted == true) OR includeAnonymous
3. If no tokens:
   - "redirect": redirect to signIn URL, never returns
   - "throw": throw UserNotSignedIn error
   - "anonymous": create anonymous user (POST above), store tokens, continue
   - "return-null": return null
4. GET /api/v1/users/me [authenticated]
5. On 401: token refresh & retry. If still 401: handle as step 3
6. On 200: construct CurrentUser object
7. Filter based on user state:
   - If user.isAnonymous and not includeAnonymous: handle as step 3
   - If user.isRestricted and not includeRestricted:
     - "redirect": redirect to onboarding URL (not sign-in!)
     - otherwise: handle as step 3
8. [JS SDK only] The `getUser({ or: "redirect" })` overload is deprecated on both client and
   server app objects. App type controls permissions, not whether the call runs in a browser, so an
   async read must not be the recommended place to choose a navigation strategy. React code should
   use `useUser({ or: "redirect" })`; other browser code should call `getUser()` and explicitly
   invoke `redirectToSignIn()` when it returns null.
9. If a deprecated redirect call runs during server rendering and its sign-in or onboarding target
   is hosted or otherwise cross-origin, throw the server cross-origin redirect setup error instead
   of navigating. Server-rendered code cannot capture the browser URL or set the PKCE verifier
   cookie required for that handoff.

The React `useUser({ or: "redirect" })` API remains supported. When its target is hosted or
otherwise cross-origin, server rendering must bail the subtree out to its Suspense fallback without
starting navigation; hydration retries the subtree and starts the redirect in the browser.

Errors (only when or="throw"):
  UserNotSignedIn
    code: "user_not_signed_in"
    message: "User is not signed in but getUser was called with { or: 'throw' }."


## getProject()

Returns: Project

Request:
  GET /api/v1/projects/current

Response:
  {
    id: string,
    display_name: string,
    config: {
      sign_up_enabled: bool,
      credential_enabled: bool,
      magic_link_enabled: bool,
      passkey_enabled: bool,
      oauth_providers: [{ id: string }],
      client_team_creation_enabled: bool,
      client_user_deletion_enabled: bool,
      allow_user_api_keys: bool,
      allow_team_api_keys: bool
    }
  }

Construct Project object (types/projects/project.spec.md).

Does not error.


## getPartialUser(options)

Get minimal user info without a full API call.
Useful for quickly checking auth state.

Arguments:
  options.from: "token" | "convex"
    - "token": Extract user info from the stored access token (JWT claims)
    - "convex": Extract user info from Convex auth context [JS-ONLY]
  
  For "convex" [JS-ONLY]:
    options.ctx: ConvexQueryContext - the Convex query context
  
  options.tokenStore: TokenStoreInit? - override token storage for this call

Returns: TokenPartialUser | null

TokenPartialUser:
  id: string
  displayName: string | null
  primaryEmail: string | null
  primaryEmailVerified: bool
  isAnonymous: bool
  isMultiFactorRequired: bool
  isRestricted: bool
  restrictedReason: { type: "anonymous" | "email_not_verified" | "restricted_by_administrator" } | null

Implementation for "token":
1. Get access token from storage
2. If no token: return null
3. Decode JWT payload (base64url decode middle segment)
4. Extract fields: sub (id), name, email, email_verified, is_anonymous, is_restricted, restricted_reason

Implementation for "convex" [JS-ONLY]:
1. Call ctx.auth.getUserIdentity()
2. If null: return null
3. Map: subject→id, name→displayName, email, email_verified, is_anonymous, is_restricted, restricted_reason

Panics:
  If constructor tokenStore was null and no tokenStore override is provided (for "token" mode).
  This is a programmer error - the code should be fixed to provide a tokenStore.


## cancelSubscription(options)

Cancel an active subscription.

Arguments:
  options.productId: string - the subscription product to cancel
  options.teamId: string? - if canceling a team subscription
  options.tokenStore: TokenStoreInit? - override token storage for this call

Returns: void

Request:
  POST /api/v1/subscriptions/cancel [authenticated]
  Body: { product_id: string, team_id?: string }

Does not error.


## getAccessToken(options?)

Arguments:
  options.tokenStore: TokenStoreInit? - override token storage for this call

Returns: string | null

Get access token, refreshing if needed. See _utilities.spec.md getOrFetchLikelyValidTokens().

NOTE: When no refresh token exists, the returned access token might be invalid
by the time it's used due to timing delays between retrieval and use.

Panics:
  If constructor tokenStore was null and no tokenStore override is provided.
  This is a programmer error - the code should be fixed to provide a tokenStore.


## getRefreshToken(options?)

Arguments:
  options.tokenStore: TokenStoreInit? - override token storage for this call

Returns: string | null

Get refresh token from storage.
Return token string, or null if not authenticated.

Panics:
  If constructor tokenStore was null and no tokenStore override is provided.
  This is a programmer error - the code should be fixed to provide a tokenStore.


## getAuthorizationHeader(options?)

Arguments:
  options.tokenStore: TokenStoreInit? - override token storage for this call

Returns: string | null

Get current tokens and return the Authorization header value:
  Bearer stackauth_<base64({ "accessToken": "...", "refreshToken": "..." })>

Returns null if not authenticated.

For cross-origin authenticated requests where cookies can't be sent.

Panics:
  If constructor tokenStore was null and no tokenStore override is provided.
  This is a programmer error - the code should be fixed to provide a tokenStore.


## getAuthHeaders(options?)

@deprecated Use getAuthorizationHeader(options?).

Arguments:
  options.tokenStore: TokenStoreInit? - override token storage for this call

Returns: { "x-stack-auth": string }

Get current tokens and JSON-encode as header value:
  { "accessToken": "<token>", "refreshToken": "<token>" }

For cross-origin authenticated requests where cookies can't be sent.

Panics:
  If constructor tokenStore was null and no tokenStore override is provided.
  This is a programmer error - the code should be fixed to provide a tokenStore.


## sendForgotPasswordEmail(email, callbackUrl)

Arguments:
  email: string - The user's email address
  callbackUrl: string - URL where the user will be redirected to reset their password

Returns: void

Request:
  POST /api/v1/auth/password/send-reset-code
  Body: { email: string, callback_url: string }

Errors:
  UserNotFound
    code: "user_not_found"
    message: "No user with this email address was found."


## verifyPasswordResetCode(code)

Verifies a password reset code is valid before showing the reset form.
Call this before showing the password input to avoid user frustration.

Arguments:
  code: string - from password reset email URL

Returns: void

Request:
  POST /api/v1/auth/password/reset/check-code
  Body: { code: string }

Errors:
  VerificationCodeError
    code: "verification_code_error"
    message: "The verification code is invalid or expired."


## resetPassword(options)

Arguments:
  options.code: string - from password reset email
  options.password: string - new password

Returns: void

Request:
  POST /api/v1/auth/password/reset
  Body: { code: string, password: string }

Errors:
  VerificationCodeError
    code: "verification_code_error"
    message: "The verification code is invalid or expired."
    
  PasswordRequirementsNotMet
    code: "password_requirements_not_met"
    message: "The password does not meet the project's requirements."


## sendMagicLinkEmail(email, callbackUrl)

Arguments:
  email: string - The user's email address
  callbackUrl: string - URL where the user will be redirected after clicking the magic link

Returns: { nonce: string }

Request:
  POST /api/v1/auth/otp/send-sign-in-code
  Body: { email: string, callback_url: string }

Response:
  { nonce: string }

Errors:
  RedirectUrlNotWhitelisted
    code: "redirect_url_not_whitelisted"
    message: "The callback URL is not in the project's trusted domains list."


## signInWithMagicLink(code, options?)

Arguments:
  code: string - from magic link URL
  options.noRedirect: bool?

Returns: void

Request:
  POST /api/v1/auth/otp/sign-in
  Body: { code: string }

Response on success:
  { access_token: string, refresh_token: string, is_new_user: bool }

Implementation:
1. Send request
2. On MFA required: redirect to MFA page (stores attempt_code in sessionStorage)
3. Store tokens { access_token, refresh_token }
4. Redirect to afterSignIn or afterSignUp based on is_new_user (unless noRedirect)

Errors:
  VerificationCodeError
    code: "verification_code_error"
    message: "The verification code is invalid or expired."
  
  InvalidTotpCode
    code: "invalid_totp_code"
    message: "The MFA code is incorrect."


## signInWithMfa(totp, code, options?)

Completes sign-in when MFA is required.
Called after receiving MultiFactorAuthenticationRequired error from another sign-in method.

Arguments:
  totp: string - 6-digit TOTP code from authenticator app
  code: string - the attempt code from MFA error or sessionStorage
  options.noRedirect: bool?

Returns: void

Request:
  POST /api/v1/auth/mfa/sign-in
  Body: { type: "totp", totp: string, code: string }

Response on success:
  { access_token: string, refresh_token: string, is_new_user: bool }

Implementation:
1. Send request
2. Store tokens { access_token, refresh_token }
3. Redirect to afterSignIn or afterSignUp based on is_new_user (unless noRedirect)

Errors:
  VerificationCodeError
    code: "verification_code_error"
    message: "The verification code is invalid or expired."
    
  InvalidTotpCode
    code: "invalid_totp_code"
    message: "The MFA code is incorrect."


## signInWithPasskey()  [BROWSER-LIKE]

Returns: void

Requires WebAuthn support:
- Browser: native WebAuthn API
- iOS: ASAuthorizationPlatformPublicKeyCredentialProvider
- Android: FIDO2 API via Google Play Services

Implementation:
1. Initiate authentication:
   POST /api/v1/auth/passkey/initiate-passkey-authentication
   Body: {}
   Response: { options_json: PublicKeyCredentialRequestOptions, code: string }

2. Replace options_json.rpId with actual hostname (window.location.hostname)
   The server returns a sentinel value that must be replaced.

3. Call platform WebAuthn/FIDO2 API:
   - Browser: use WebAuthn library (e.g., @simplewebauthn/browser)
   - iOS/Android: use platform passkey APIs
   authentication_response = startAuthentication(options_json)
   
4. Complete authentication:
   POST /api/v1/auth/passkey/sign-in
   Body: { authentication_response: <WebAuthn response>, code: string }
   Response: { access_token: string, refresh_token: string }

5. On MFA required: redirect to MFA page
6. Store tokens, redirect to afterSignIn

Errors:
  PasskeyAuthenticationFailed
    code: "passkey_authentication_failed"
    message: "Passkey authentication failed. Please try again."
    
  PasskeyWebAuthnError
    code: "passkey_webauthn_error"
    message: "WebAuthn error: {errorName}."
    (errorName from WebAuthn/FIDO2 API error)
    
  InvalidTotpCode
    code: "invalid_totp_code"
    message: "The MFA code is incorrect."


## verifyEmail(code)

Arguments:
  code: string - from email verification link

Returns: void

Request:
  POST /api/v1/contact-channels/verify
  Body: { code: string }

Implementation:
1. Send request
2. Refresh user cache and contact channels cache

Errors:
  VerificationCodeError
    code: "verification_code_error"
    message: "The verification code is invalid or expired."


## acceptTeamInvitation(code, options?)

Arguments:
  code: string - from team invitation email
  options.tokenStore: TokenStoreInit? - override token storage for this call

Returns: void

Request:
  POST /api/v1/team-invitations/accept [authenticated]
  Body: { code: string }

Errors:
  VerificationCodeError
    code: "verification_code_error"
    message: "The verification code is invalid or expired."


## verifyTeamInvitationCode(code, options?)

Verifies a team invitation code is valid before accepting.

Arguments:
  code: string - from team invitation email
  options.tokenStore: TokenStoreInit? - override token storage for this call

Returns: void

Request:
  POST /api/v1/team-invitations/accept/check-code [authenticated]
  Body: { code: string }

Errors:
  VerificationCodeError
    code: "verification_code_error"
    message: "The verification code is invalid or expired."


## getTeamInvitationDetails(code, options?)

Arguments:
  code: string
  options.tokenStore: TokenStoreInit? - override token storage for this call

Returns: { teamDisplayName: string }

Request:
  POST /api/v1/team-invitations/accept/details [authenticated]
  Body: { code: string }

Response:
  { team_display_name: string }

Errors:
  VerificationCodeError
    code: "verification_code_error"
    message: "The verification code is invalid or expired."


## callOAuthCallback(url?, codeVerifier?, redirectUrl?)

Completes the OAuth flow after redirect from OAuth provider.
Call this on the OAuth callback page (browser) or after receiving the callback URL (native apps).

Arguments (all optional in browser, required in non-browser):
  url: URL - the callback URL containing the authorization code
    - Browser: inferred from window.location.href
  codeVerifier: string - the PKCE code verifier from getOAuthUrl()
    - Browser: retrieved from cookie "stack-oauth-outer-{state}"
  redirectUrl: string - the redirect URL from getOAuthUrl() (must match exactly)
    - Browser: retrieved from cookie "stack-oauth-outer-{state}"

Returns:
  - Browser: bool (true if handled, false if not an OAuth callback)
  - Non-browser: void

Implementation:
1. Get callback URL, codeVerifier, and redirectUrl:
   - Browser: Extract from window.location.href and cookie using state parameter
     - If "code" or "state" missing from URL: return false (not an OAuth callback)
     - If cookie not found: return false (callback not for us, or already consumed)
     - Delete cookie after retrieving
   - Non-browser: Use provided arguments

2. Parse callback URL for "code" and "error" query parameters
   - If "error" present: throw OAuthError with error code and description from URL
   - If "code" missing: throw OAuthError("missing_code", "No authorization code in callback URL")

3. [BROWSER-ONLY] Remove OAuth params from URL (history.replaceState to hide code)

4. Exchange authorization code for tokens:
   POST /api/v1/auth/oauth/token
   Content-Type: application/x-www-form-urlencoded
   Headers:
     - x-stack-project-id: <projectId>
   Body:
     - grant_type=authorization_code
     - code=<authorization code from URL>
     - redirect_uri=<redirectUrl - must match getOAuthUrl exactly>
     - code_verifier=<codeVerifier>
     - client_id=<projectId>
     - client_secret=<publishableClientKey | publishableClientKeyNotNecessarySentinel>

   Response on success:
     { 
       access_token: string, 
       refresh_token: string,
       is_new_user: bool,
       after_callback_redirect_url?: string
     }

5. Store tokens { access_token, refresh_token }

6. [BROWSER-ONLY] Redirect to:
   - after_callback_redirect_url (if present in response), or
   - afterSignUp URL (if is_new_user), or
   - afterSignIn URL
   Then return true

IMPORTANT: The redirectUrl must exactly match the one used in getOAuthUrl().
This is why getOAuthUrl() returns redirectUrl - store it and pass it here.

Errors:
  OAuthError(<error from URL>)
    message: <error_description from URL> or "OAuth error"
    When: OAuth provider returned an error in the callback URL
    
  OAuthError(missing_code)
    message: "No authorization code in callback URL"
    When: No "code" query parameter in callback URL
    
  OAuthError(invalid_response)
    message: "Invalid HTTP response"
    When: Token exchange response is not a valid HTTP response
    
  OAuthError(<error from response>)
    message: <error_description from response> or "Token exchange failed"
    When: Token exchange endpoint returns an error
    
  OAuthError(token_exchange_failed)
    message: "HTTP <status_code>"
    When: Token exchange returns non-200 status without error details
    
  OAuthError(parse_error)
    message: "Failed to parse token response"
    When: Token exchange response is not valid JSON or missing access_token


## promptCliLogin(options)  [CLI-ONLY]

Initiates a CLI authentication flow. Used for authenticating CLI tools.
Opens a browser for the user to sign in, then polls for completion.

Only available in languages/platforms with an interactive terminal.

Arguments:
  options.appUrl: string - base URL of your app (for the login page)
  options.expiresInMillis: number? - how long the login attempt is valid
  options.maxAttempts: number? - max polling attempts (default: Infinity)
  options.waitTimeMillis: number? - time between poll attempts (default: 2000ms)
  options.promptLink: function(url: string, loginCode: string)? - callback to display login URL and verification code to user
  options.anonRefreshToken: string? - anonymous refresh token to associate with this login attempt

Returns: string - the refresh token for the authenticated session

Implementation:
1. Initiate CLI auth:
   POST /api/v1/auth/cli
   Body: { expires_in_millis?: number, anon_refresh_token?: string }
   Response: { polling_code: string, login_code: string }

2. Build login URL from the app's resolved `urls.cliAuthConfirm` target, using `appUrl` as the base URL when the target is relative, and append `login_code={login_code}`.
3. Call promptLink(url, loginCode) if provided, or print login code and URL

4. Poll for completion:
   POST /api/v1/auth/cli/poll
   Body: { polling_code: string }
   Response on pending: { status: "waiting" }
   Response on success: { status: "success", refresh_token: string }
   
   Poll every waitTimeMillis until success, error, or maxAttempts reached.

5. Return refresh_token

Errors:
  CliAuthError
    code: "cli_auth_error"
    message: "CLI authentication failed."
    
  CliAuthExpiredError
    code: "cli_auth_expired"
    message: "CLI authentication attempt expired. Please try again."
    
  CliAuthUsedError
    code: "cli_auth_used"
    message: "This CLI authentication code has already been used."


## getItem(options)

Get a purchased item for a customer.

Arguments:
  Customer identification (one of):
    options.userId: string
    options.teamId: string
    options.customCustomerId: string
  options.itemId: string
  options.tokenStore: TokenStoreInit? - override token storage for this call

Returns: Item

Request:
  GET /api/v1/customers/{customer_type}/{customer_id}/items/{itemId} [authenticated]
  
  customer_type is "user", "team", or "custom"
  customer_id is the corresponding ID

Response:
  { id: string, quantity: number }

Does not error.


## listProducts(options)

List products available to a customer.

Arguments:
  Customer identification (one of):
    options.userId: string
    options.teamId: string
    options.customCustomerId: string
  options.cursor: string? - pagination cursor
  options.limit: number? - max results
  options.tokenStore: TokenStoreInit? - override token storage for this call

Returns: CustomerProductsList

Request:
  GET /api/v1/customers/{customer_type}/{customer_id}/products [authenticated]
  Query params: cursor?, limit?

Response:
  { 
    items: [{ id, name, quantity, ... }],
    pagination: { next_cursor?: string }
  }

Does not error.


## getConvexClientAuth(options)  [JS-ONLY]

Get auth callback for Convex client integration.

options.tokenStore: TokenStoreInit? - override token storage

Returns: function({ forceRefreshToken: bool }) => Promise<string | null>

The returned function is passed to Convex's useConvexAuth() hook.
It returns the access token (refreshed if needed) or null if not authenticated.

Does not error.


## getConvexHttpClientAuth(options)  [JS-ONLY]

Get auth token for Convex HTTP client.

options.tokenStore: TokenStoreInit

Returns: string - the access token for Convex HTTP requests

Does not error.


## Redirect Methods  [BROWSER-ONLY]

These methods are only available in browser environments (JavaScript SDK).
Non-browser SDKs (Swift, Python, etc.) should NOT expose these methods.

All redirect methods take optional options:

Options:
  replace: bool? - if true, replace current history entry instead of pushing
  noRedirectBack: bool? - if true, don't return to the initiating page after auth. Same-domain
    flows use their configured default destination. Cross-domain flows must still complete the
    normal handoff back to the source app, with the source app's configured afterSignIn URL as the
    final after-callback destination.

Methods:
  redirectToSignIn()         - redirect to signIn URL
  redirectToSignUp()         - redirect to signUp URL
  redirectToSignOut()        - redirect to signOut URL
  redirectToAfterSignIn()    - redirect to afterSignIn URL
  redirectToAfterSignUp()    - redirect to afterSignUp URL
  redirectToAfterSignOut()   - redirect to afterSignOut URL
  redirectToHome()           - redirect to home URL
  redirectToAccountSettings() - redirect to accountSettings URL
  redirectToForgotPassword() - redirect to forgotPassword URL
  redirectToPasswordReset()  - redirect to passwordReset URL
  redirectToEmailVerification() - redirect to emailVerification URL
  redirectToOnboarding()     - redirect to onboarding URL
  redirectToError()          - redirect to error URL
  redirectToMfa()            - redirect to mfa URL
  redirectToTeamInvitation() - redirect to teamInvitation URL
  redirectToOAuthCallback()  - redirect to oauthCallback URL
  redirectToMagicLinkCallback() - redirect to magicLinkCallback URL

Implementation:

1. Get the target URL from the urls config
2. For signIn/signUp/onboarding:
   - If noRedirectBack=true and the target is cross-domain, perform the normal cross-domain
     callback/authorize handoff, but set its final after-callback destination to the source app's
     configured afterSignIn URL instead of the initiating page. The hosted URL may carry an internal
     after_auth_return_to callback URL as part of that handoff, but it must not return to the
     initiating deep link.
   - If noRedirectBack=true and the target is same-domain, don't add redirect-back state; let the
     auth flow use its configured default destination.
   - Otherwise:
     - Check if current URL has after_auth_return_to query param
     - If yes: preserve it in the target URL
     - If no: set after_auth_return_to to current page URL
3. For afterSignIn/afterSignUp:
   - Check current URL for after_auth_return_to query param
   - If present: redirect to that URL instead of the default
   - If absent (unless noRedirectBack=true): fall back to the sessionStorage mirror of the
     redirect-back state (see "Redirect-back state mirror" below) before using the default
4. Perform redirect based on redirectMethod config:
   - "browser": window.location.assign() or .replace()
   - "nextjs": Next.js redirect() function [JS-ONLY]
   - "tanstack-start": throw a TanStack Start redirect during server rendering for same-origin
     targets
   - "none": don't redirect (for headless/API use)
   - Custom navigate function: call it with the URL

When no browser is available, hosted targets and custom cross-origin targets must throw a setup
error before navigation. They require browser URL and cookie APIs for redirect-back and PKCE.
Otherwise, do not error except when the redirect loop breaker triggers (see below).

### Redirect-back state mirror  [BROWSER-ONLY]

The `after_auth_return_to` and cross-domain handoff query params must survive every hop of an
auth flow (OAuth provider round-trips, MFA, magic links, ...). As a resilience layer, the SDK
mirrors them into sessionStorage so a hop that drops them doesn't strand the user on the default
post-auth page:

1. On app construction (browser only) and on every SDK-driven redirect, if the (target) URL
   contains after_auth_return_to, store it together with the hexclave_cross_domain_state,
   hexclave_cross_domain_code_challenge, and hexclave_cross_domain_after_callback_redirect_url
   params (if present) in sessionStorage, keyed by project ID.
2. When redirectToAfterSignIn/redirectToAfterSignUp run without an after_auth_return_to query
   param, restore the mirrored params (query params always take precedence over the mirror).
3. The mirror expires after 30 minutes (must stay below the 1h lifetime of the outer PKCE
   verifier cookie) and is NOT consumed on read (post-auth redirects may legitimately run more
   than once, eg. React re-renders).
4. Restored URLs go through the exact same trust validation as URLs read from query params, so
   the mirror never widens the set of allowed destinations.
5. If sessionStorage is unavailable (private browsing, sandboxed iframes), degrade silently to
   the previous behavior (no mirror).

### Redirect loop breaker  [BROWSER-ONLY]

As a last line of defense against redirect loops (particularly in hosted components flows), every
SDK-driven redirect records a breadcrumb (origin + pathname of the current and target URL; query
params are ignored because loops usually rotate nonce-style params each cycle) in sessionStorage:

1. Before navigating, count how often the exact same (from, to) redirect occurred within the last
   30 seconds (wall clock; must survive full page loads).
2. If this is the 5th identical redirect in that window, do NOT navigate: drop the matching
   breadcrumbs (so a manual retry isn't instantly blocked), report the error, and throw. The page
   that initiated the redirect renders its error state, which stops the loop and surfaces the bug.
3. If sessionStorage is unavailable, degrade silently (no loop breaking).

### Sign-out redirect validation

The sign-out page follows the after_auth_return_to query param only if it passes the same trust
validation as every other redirect (relative URLs, same-origin URLs, the project's hosted
components origin, and the project's trusted domains). Untrusted values are ignored (the error is
reported, and sign-out proceeds with the default after-sign-out destination); they must never be
followed, since the query param is attacker-craftable (open redirect).
