# ServerUser

Server-side user with full access to sensitive fields and management methods.

Extends: User (base-user.spec.md)
Includes: UserExtra methods, Customer methods


## Additional Properties

lastActiveAt: Date
  When the user was last active.

serverMetadata: json
  Server-only metadata, not visible to client.

restrictedByAdminPrivateDetails: string | null
  Private details about the restriction (e.g. which sign-up rule triggered it), never visible to the client.


## Server-specific Update Methods


### update(options)

options: {
  displayName?: string | null,
  clientMetadata?: json,
  clientReadOnlyMetadata?: json,
  serverMetadata?: json,
  selectedTeamId?: string | null,
  profileImageUrl?: string | null,
  primaryEmail?: string | null,
  primaryEmailVerified?: bool,
  primaryEmailAuthEnabled?: bool,
  password?: string,
  otpAuthEnabled?: bool,
  passkeyAuthEnabled?: bool,
  totpMultiFactorSecret?: bytes | null,
}

PATCH /api/v1/users/{userId} [server-only]
Body: only include provided fields, convert to snake_case
Route: apps/backend/src/app/api/latest/users/[userId]/route.ts

Does not error.


### setPrimaryEmail(email, options?)

email: string | null
options.verified: bool? - set verification status

Shorthand for update({ primaryEmail: email, primaryEmailVerified: options?.verified }).

Does not error.


### setServerMetadata(metadata)

metadata: json

Shorthand for update({ serverMetadata: metadata }).

Does not error.


### setClientReadOnlyMetadata(metadata)

metadata: json

Shorthand for update({ clientReadOnlyMetadata: metadata }).

Does not error.


### setPassword(password)

password: string

Server-side password setting. Shorthand for update({ password: password }).

Note: Unlike client-side setPassword (which uses POST /auth/password/set),
server-side password setting is done via the user update endpoint.

Does not error.


## Team Methods


### createTeam(options)

options.displayName: string
options.profileImageUrl: string?

Returns: ServerTeam

POST /api/v1/teams { display_name, profile_image_url, creator_user_id: thisUser.id } [server-only]

Does not error.


### listTeams()

Returns: ServerTeam[]

GET /api/v1/teams?user_id={userId} [server-only]

Does not error.


### getTeam(teamId)

teamId: string

Returns: ServerTeam | null

Find in listTeams() by id. This is deliberately scoped to the user's own team memberships (unlike the app-level getTeam), so it returns null for teams the user is not a member of.

Does not error.


## Contact Channel Methods


### listContactChannels()

Returns: ServerContactChannel[]

GET /api/v1/contact-channels?user_id={userId} [server-only]

ServerContactChannel extends ContactChannel with:
  update(data: ServerContactChannelUpdateOptions): Promise<void>

ServerContactChannelUpdateOptions adds:
  isVerified: bool?

Does not error.


### createContactChannel(options)

options.type: "email"
options.value: string
options.usedForAuth: bool
options.isPrimary: bool?
options.isVerified: bool?

Returns: ServerContactChannel

POST /api/v1/contact-channels { type, value, used_for_auth, is_primary, is_verified, user_id } [server-only]

Does not error.


## Permission Methods (with grant/revoke)


### grantPermission(scope?, permissionId)

scope: Team? - if omitted, grants project-level permission
permissionId: string

POST /api/v1/users/{userId}/permissions { team_id, permission_id } [server-only]

Does not error.


### revokePermission(scope?, permissionId)

scope: Team?
permissionId: string

DELETE /api/v1/users/{userId}/permissions/{permissionId}?team_id={teamId} [server-only]

Does not error.


### hasPermission(scope?, permissionId)

scope: Team?
permissionId: string

Returns: bool

GET /api/v1/users/{userId}/permissions?team_id={teamId}&permission_id={permissionId} [server-only]

Does not error.


### getPermission(scope?, permissionId)

scope: Team?
permissionId: string

Returns: TeamPermission | null

Does not error.


### listPermissions(scope?, options?)

scope: Team?
options.direct: bool? - only directly assigned, not inherited

Returns: TeamPermission[]

GET /api/v1/users/{userId}/permissions?team_id={teamId}&direct={direct} [server-only]

Does not error.


## OAuth Provider Methods


### listOAuthProviders()

Returns: ServerOAuthProvider[]

GET /api/v1/users/{userId}/oauth-providers [server-only]

ServerOAuthProvider extends OAuthProvider with:
  accountId: string (always present, not optional)
  update(data): can also update accountId and email

Does not error.


### getOAuthProvider(id)

id: string

Returns: ServerOAuthProvider | null

Does not error.


## Session Methods


### createSession(options?)

options.expiresInMillis: number? - session expiration
options.isImpersonation: bool? - mark as impersonation session
options.reason: string? - optional support-session note; stored on Audit Log events when that app is enabled

Returns: { getTokens(): Promise<{ accessToken, refreshToken }> }

POST /api/v1/auth/sessions { user_id, expires_in_millis, is_impersonation, reason? } [server-only]

Creates a new session for this user. Can be used to impersonate them.

Does not error.


## All methods from UserExtra

Also includes all methods from CurrentUser that are applicable:
- delete()
- setDisplayName(displayName)
- setClientMetadata(metadata)
- updatePassword(options)
- setPassword(options)
- listTeams()
- getTeam(teamId)
- createTeam(options)
- setSelectedTeam(teamOrId)
- leaveTeam(team)
- getTeamProfile(team)
- listContactChannels()
- createContactChannel(options)
- listOAuthProviders()
- getOAuthProvider(id)
- getConnectedAccount(providerId, options?)
- hasPermission(scope?, permissionId)
- getPermission(scope?, permissionId)
- listPermissions(scope?, options?)
- getActiveSessions()
- revokeSession(sessionId)
- registerPasskey(options?) [BROWSER-LIKE]
- listApiKeys()
- createApiKey(options)
- listNotificationCategories()
