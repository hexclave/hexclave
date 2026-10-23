# CurrentUser

The authenticated user with methods to modify their own data.

Extends: User (base-user.spec.md)

Also includes:
- Auth methods (signOut, getAccessToken, etc.)
- Customer methods (payments/customer.spec.md)


## Additional Properties

selectedTeam: Team | null
  User's currently selected team.
  Constructed from selected_team in API response.


## Session Properties

currentSession.getTokens()
  Returns: { accessToken: string | null, refreshToken: string | null }
  Get current session tokens.


## update(options)

options: {
  displayName?: string | null,
  clientMetadata?: json,
  selectedTeamId?: string | null,
  profileImageUrl?: string | null,
  otpAuthEnabled?: bool,
  passkeyAuthEnabled?: bool,
  primaryEmail?: string | null,
  totpMultiFactorSecret?: bytes | null,
}

PATCH /api/v1/users/me [authenticated]
Body: only include provided fields, convert to snake_case
Route: apps/backend/src/app/api/latest/users/me/route.ts

Update local properties on success.

Does not error.


## delete()

DELETE /api/v1/users/me [authenticated]
Route: apps/backend/src/app/api/latest/users/me/route.ts

Clear stored tokens after success.

Does not error.


## setDisplayName(displayName)

displayName: string | null

Shorthand for update({ displayName }).

Does not error.


## setClientMetadata(metadata)

metadata: json

Shorthand for update({ clientMetadata: metadata }).

Does not error.


## updatePassword(options)

options.oldPassword: string
options.newPassword: string

Returns: void

POST /api/v1/auth/password/update { old_password, new_password } [authenticated]

Errors:
  PasswordConfirmationMismatch
    code: "password_confirmation_mismatch"
    message: "The current password is incorrect."
    
  PasswordRequirementsNotMet
    code: "password_requirements_not_met"
    message: "The new password does not meet the project's requirements."


## setPassword(options)

options.password: string

Returns: void

POST /api/v1/auth/password/set { password } [authenticated]

For users without existing password (OAuth-only, anonymous).

Errors:
  PasswordRequirementsNotMet
    code: "password_requirements_not_met"
    message: "The password does not meet the project's requirements."


## Team Methods


### listTeams(options?)

options: same as StackServerApp.listTeams options, without userId (limit, cursor, query, orderBy, desc)

Returns: Team[] & { nextCursor: string | null }

GET /api/v1/teams?user_id=me [authenticated], plus the query params from options

Construct Team for each item. See StackServerApp.listTeams for pagination and the behavior without limit.

Errors: same as StackServerApp.listTeams (400 when limit is omitted and the user is in more than 500 teams).


### getTeam(teamId)

teamId: string

Returns: Team | null

Call listTeams({ query: teamId }) and return the item whose id equals teamId, or null. Filtering on the ID (rather
than searching the unfiltered list) is required because a page holds at most 200 teams, and an unfiltered request
without limit fails past 500 teams.

React hook variant (useTeam): look in the unfiltered first page, requested as useTeams({ limit: 200 }) (never
without limit, which would fail for users in more than 500 teams), and only fall back to useTeams({ query: teamId,
limit: 200 }) when the team isn't there and the first page has a nextCursor.

Does not error.


### createTeam(options)

options.displayName: string
options.profileImageUrl: string?

Returns: Team

POST /api/v1/teams { display_name, profile_image_url, creator_user_id: "me" } [authenticated]
Route: apps/backend/src/app/api/latest/teams/route.ts

Then select the new team via update({ selectedTeamId: newTeam.id }).

Does not error.


### setSelectedTeam(teamOrId)

teamOrId: Team | string | null

Shorthand for update({ selectedTeamId: extractId(teamOrId) }).

Does not error.


### leaveTeam(team)

team: Team

DELETE /api/v1/teams/{teamId}/users/me [authenticated]

Does not error.


### getTeamProfile(team)

team: Team

Returns: EditableTeamMemberProfile

GET /api/v1/teams/{teamId}/users/me/profile [authenticated]

See types/teams/team-member-profile.spec.md for EditableTeamMemberProfile.

Does not error.


## Contact Channel Methods


### listContactChannels()

Returns: ContactChannel[]

GET /api/v1/contact-channels?user_id=me [authenticated]

Does not error.


### createContactChannel(options)

options.type: "email"
options.value: string (the email address)
options.usedForAuth: bool
options.isPrimary: bool?

Returns: ContactChannel

POST /api/v1/contact-channels { type, value, used_for_auth, is_primary, user_id: "me" } [authenticated]

Does not error.


## OAuth Provider Methods


### listOAuthProviders()

Returns: OAuthProvider[]

GET /api/v1/users/me/oauth-providers [authenticated]
Route: apps/backend/src/app/api/latest/users/me/oauth-providers/route.ts

OAuthProvider has:
  id: string
  type: string
  userId: string
  accountId: string?
  email: string?
  allowSignIn: bool
  allowConnectedAccounts: bool
  update(data): Promise<void>
    Errors:
      OAuthProviderAccountIdAlreadyUsedForSignIn
        code: "oauth_provider_account_id_already_used_for_sign_in"
        message: "This OAuth account is already linked to another user."
  delete(): Promise<void>

Does not error.


### getOAuthProvider(id)

id: string

Returns: OAuthProvider | null

Find in listOAuthProviders() by id.

Does not error.


## Connected Account Methods


### getConnectedAccount(providerId, options?)

Get access to a connected OAuth account for API calls to third-party services.
For example, get a Google access token to call Google APIs on behalf of the user.

providerId: string (e.g., "google", "github")
options.scopes: string[]? - required OAuth scopes for the access token
options.or: "redirect" | "throw" | "return-null"
  Default: "return-null"

Returns: OAuthConnection | null

Implementation:
1. Check if user has the OAuth provider connected:
   Look for providerId in user.oauthProviders
   If not found and or="redirect": go to step 4
   If not found otherwise: handle as "not connected" (see below)

2. Request an access token with the required scopes:
   POST /api/v1/connected-accounts/{providerId}/access-token { scope: scopes.join(" ") } [authenticated]
   Route: apps/backend/src/app/api/latest/connected-accounts/[provider]/access-token/route.ts

3. On success: return OAuthConnection { id: providerId, getAccessToken() }
   The getAccessToken() method returns the token from step 2 (cached, refreshed as needed)

4. On error "oauth_scope_not_granted" or "oauth_connection_not_connected":
   - or="redirect" [BROWSER-LIKE]:
     Start OAuth flow to connect/add scopes:
     - Use same PKCE flow as signInWithOAuth
     - Set type="link" instead of "authenticate"
     - Include afterCallbackRedirectUrl = current page URL
     - Merge requested scopes with any scopes from oauthScopesOnSignIn config
     - Never returns (browser redirects)
   - or="throw": throw the error
   - or="return-null": return null

Errors (only when or="throw"):
  OAuthConnectionNotConnectedToUser
    code: "oauth_connection_not_connected"
    message: "You don't have this OAuth provider connected."
    
  OAuthConnectionDoesNotHaveRequiredScope
    code: "oauth_scope_not_granted"
    message: "The connected OAuth account doesn't have the required permissions."


## Permission Methods


### hasPermission(scope?, permissionId)

scope: Team? - if omitted, checks project-level permission
permissionId: string

Returns: bool

GET /api/v1/users/me/permissions?team_id={teamId}&permission_id={permissionId} [authenticated]

Does not error.


### getPermission(scope?, permissionId)

scope: Team?
permissionId: string

Returns: TeamPermission | null

Find permission by id in listPermissions().

Does not error.


### listPermissions(scope?, options?)

scope: Team?
options.recursive: bool? - include inherited permissions

Returns: TeamPermission[]

GET /api/v1/users/me/permissions?team_id={teamId}&recursive={recursive} [authenticated]

Does not error.


## Session Methods


### getActiveSessions()

Returns: ActiveSession[]

GET /api/v1/users/me/sessions [authenticated]

See types/common/sessions.spec.md for ActiveSession and GeoInfo.

Does not error.


### revokeSession(sessionId)

sessionId: string

DELETE /api/v1/users/me/sessions/{sessionId} [authenticated]

Does not error.


## Passkey Methods


### registerPasskey(options?)  [BROWSER-LIKE]

options.hostname: string?

Returns: void

Implementation:
1. POST /api/v1/auth/passkey/initiate-passkey-registration {} [authenticated]
   Response: { options_json, code }
2. Replace options_json.rp.id with actual hostname
3. Call WebAuthn startRegistration(options_json)
4. POST /api/v1/auth/passkey/register { credential, code } [authenticated]

Errors:
  PasskeyRegistrationFailed
    code: "passkey_registration_failed"
    message: "Failed to register passkey. Please try again."
    
  PasskeyWebAuthnError
    code: "passkey_webauthn_error"
    message: "WebAuthn error: {errorName}."


## API Key Methods


### listApiKeys()

Returns: UserApiKey[]

GET /api/v1/users/me/api-keys [authenticated]

See types/common/api-keys.spec.md for UserApiKey.

Does not error.


### createApiKey(options)

options.description: string
options.expiresAt: Date?
options.scope: string? - the scope/permissions
options.teamId: string? - for team-scoped keys

Returns: UserApiKeyFirstView

POST /api/v1/users/me/api-keys { description, expires_at_millis, scope, team_id } [authenticated]

See types/common/api-keys.spec.md for UserApiKeyFirstView.
The apiKey property is only returned once at creation time.

Does not error.


## Notification Methods


### listNotificationCategories()

Returns: NotificationCategory[]

GET /api/v1/notification-categories [authenticated]

See types/notifications/notification-category.spec.md for NotificationCategory.

Does not error.


## Auth Methods

These methods are available on the CurrentUser object for convenience.
They operate on the user's current session.


### signOut(options?)

options.redirectUrl: string? - where to redirect after sign out

Signs out the current user by invalidating their session.

Implementation:
1. DELETE /api/v1/auth/sessions/current [authenticated]
   (Ignore errors - session may already be invalid)
2. Clear stored tokens
3. Redirect to redirectUrl or afterSignOut URL

Does not error.


### getAccessToken()

Returns: string | null

Returns the current access token, refreshing if needed.
Returns null if not authenticated.

Does not error.


### getRefreshToken()

Returns: string | null

Returns the current refresh token.
Returns null if not authenticated.

Does not error.


### getAuthorizationHeader()

Returns: string | null

Returns the HTTP Authorization header value in this format:
  Bearer stackauth_<base64({ "accessToken": "...", "refreshToken": "..." })>

Returns null if not authenticated.

Does not error.


### getAuthHeaders()

@deprecated Use getAuthorizationHeader().

Returns: { "x-stack-auth": string }

Returns headers for cross-origin authenticated requests.
The value is JSON: { "accessToken": "<token>", "refreshToken": "<token>" }

Does not error.


### getAuthJson()

Returns: { accessToken: string | null, refreshToken: string | null }

Returns the current tokens as an object.

Does not error.


## Deprecated Methods

sendVerificationEmail()
  @deprecated - Use contact channel's sendVerificationEmail instead.
  
  Errors:
    EmailAlreadyVerified
      code: "email_already_verified"
      message: "This email is already verified."
