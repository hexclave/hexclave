# HexclaveServerApp

Extends HexclaveClientApp with server-side capabilities. Requires secretServerKey.

Deprecated alias: StackServerApp.


## Constructor

HexclaveServerApp(options)

Extends HexclaveClientApp constructor options with:

Required:
  secretServerKey: string - from Hexclave dashboard

The secretServerKey enables server-only operations like listing all users,
creating users, and accessing server metadata.


## Local feature flag evaluation

The server app exposes the client feature-flag methods, but evaluates locally from protected definitions instead of calling the client evaluate endpoint.

Fetch `GET /api/v1/feature-flags/bootstrap` with the secret server key. The response contains `{ config, flag_ids_by_key, config_version }`; definitions must never be fetched with client authentication. Before caching, run whole-config reference validation, recompute the canonical SHA-256 config version, and require the public-key lookup to exactly match the definitions. Cache a validated response for 30 seconds, then revalidate with `If-None-Match`. A 304 refreshes its validation time. Coalesce concurrent refreshes.

On a transient network, 408, 429, or 5xx failure, a previously validated snapshot may be used for at most five minutes and returned details set `isStale=true`. Never serve stale definitions for authorization/4xx failures. If no eligible snapshot exists during a transient failure, report the error through the SDK error reporter and return every caller-provided fallback with reason `error`. Other bootstrap or schema failures fail loudly.

Use the shared deterministic evaluator from the feature-flags core package. Derive `distinctId`, `userId`, and trusted user attributes from `getUser({ or: "anonymous" })`. The trusted attributes are the canonical ID, verified primary email (or null), primary-email verification state, and sign-up timestamp; callers cannot override them through feature-flag context. Pass bounded non-security context and the selected team ID separately. When a team is selected, also pass `team: { id }` so `team.id` targeting matches the client evaluate endpoint. Attach the bootstrap config version to every result. Ordinary flags are fully local. When bootstrap is stale, ignore live experiment overlay rules and serve ordinary targeting or the published fallback so unauditable experiment traffic is not assigned. When bootstrap is fresh, an active experiment assignment may use the authenticated evaluation endpoint only to mint a signed exposure credential; the assignment returned to application code must remain the locally evaluated assignment. A token-mint failure must not change that assignment.

Feature flags are not authorization controls even when evaluated by the server SDK.


## getUser(id)

Arguments:
  id: string - user ID to look up

Returns: ServerUser | null

Request:
  GET /api/v1/users/{id} [server-only]

Response:
  ServerUserCrud object or 404 if not found

Construct ServerUser object (types/users/server-user.spec.md).

Does not error.


## getUser(options: { apiKey })

Arguments:
  options.apiKey: string - API key to authenticate with
  options.or: "return-null" | "anonymous"?

Returns: ServerUser | null

Request:
  POST /api/v1/api-keys/check [server-only]
  Body: { api_key: string }

Response:
  { user_id?: string, team_id?: string, ... }

Returns user associated with the API key.

Does not error.


## getUser(options: { from: "convex", ctx })  [JS-ONLY]

Arguments:
  options.from: "convex"
  options.ctx: ConvexQueryContext - Convex query context
  options.or: "return-null" | "anonymous"?

Returns: ServerUser | null

Extract token from Convex context, validate, and return user.
For Convex integration (JS SDK only).

Does not error.


## getPartialUser(options)

Get minimal user info without a full API call.
Same as HexclaveClientApp.getPartialUser but returns server user info.

Arguments:
  options.from: "token" | "convex"
    - "token": Extract user info from the stored access token
    - "convex": Extract user info from Convex auth context [JS-ONLY]
  
  For "convex" [JS-ONLY]:
    options.ctx: ConvexQueryContext - the Convex query context

Returns: TokenPartialUser | null

See HexclaveClientApp.getPartialUser for implementation details.

Does not error.


## listUsers(options?)

Arguments:
  options.cursor: string? - pagination cursor
  options.limit: number? - max results (default 100)
  options.orderBy: "signedUpAt"? - sort field
  options.desc: bool? - descending order
  options.query: string? - search query (searches email, display name)
  options.includeRestricted: bool? - include users who haven't completed onboarding
  options.includeAnonymous: bool? - include anonymous users

Returns: ServerUser[] & { nextCursor: string | null }

Request:
  GET /api/v1/users [server-only]
  Query params: cursor, limit, order_by, desc, query, include_restricted, include_anonymous

Response:
  {
    items: [ServerUserCrud, ...],
    pagination: { next_cursor?: string }
  }

Construct ServerUser for each item.

Does not error.


## createUser(options)

Arguments:
  options.primaryEmail: string?
  options.primaryEmailAuthEnabled: bool?
  options.password: string?
  options.otpAuthEnabled: bool?
  options.displayName: string?
  options.primaryEmailVerified: bool?
  options.clientMetadata: json?
  options.clientReadOnlyMetadata: json?
  options.serverMetadata: json?

Returns: ServerUser

Request:
  POST /api/v1/users [server-only]
  Body: {
    primary_email?: string,
    primary_email_auth_enabled?: bool,
    password?: string,
    otp_auth_enabled?: bool,
    display_name?: string,
    primary_email_verified?: bool,
    client_metadata?: json,
    client_read_only_metadata?: json,
    server_metadata?: json
  }

Response:
  ServerUserCrud object

Does not error.


## getTeam(id)

Arguments:
  id: string - team ID

Returns: ServerTeam | null

Request:
  GET /api/v1/teams/{id} [server-only]

Response:
  ServerTeamCrud object or 404 if not found

Construct ServerTeam object (types/teams/server-team.spec.md).

Does not error.


## getTeam(options: { apiKey })

Arguments:
  options.apiKey: string - team API key

Returns: ServerTeam | null

Request:
  POST /api/v1/api-keys/check [server-only]
  Body: { api_key: string }

Response:
  { team_id?: string, ... }

Returns team associated with the API key.

Does not error.


## listTeams(options?)

Arguments:
  options.userId: string? - filter by user membership

Returns: ServerTeam[]

Request:
  GET /api/v1/teams [server-only]
  Query params: user_id?

Note: This endpoint does NOT support pagination parameters like limit/cursor.
Use optional user_id filter to get teams a specific user belongs to.

Response:
  { items: [ServerTeamCrud, ...] }

Does not error.


## createTeam(options)

Arguments:
  options.displayName: string
  options.profileImageUrl: string?
  options.creatorUserId: string? - user to add as creator/member

Returns: ServerTeam

Request:
  POST /api/v1/teams [server-only]
  Body: { 
    display_name: string, 
    profile_image_url?: string, 
    creator_user_id?: string 
  }

Response:
  ServerTeamCrud object

Does not error.


## grantProduct(options)

Arguments:
  Customer identification (one of):
    options.userId: string
    options.teamId: string
    options.customCustomerId: string
  
  Product identification (one of):
    options.productId: string - existing product ID
    options.product: InlineProduct - inline product definition
  
  options.quantity: number? - default 1

Returns: void

Request:
  POST /api/v1/customers/{customer_type}/{customer_id}/products [server-only]
  Body: { 
    product_id?: string,
    product?: { name, description, ... },
    quantity?: number 
  }

Does not error.


## queryAnalytics(options)

Arguments:
  options.query: string - ClickHouse SQL query to run
  options.params: Record<string, unknown>? - ClickHouse query parameters
  options.timeout_ms: number? - max execution time in milliseconds
  options.include_all_branches: bool? - unsupported; must be false or omitted

Returns:
  {
    result: Record<string, unknown>[],
    query_id: string
  }

Request:
  POST /api/v1/analytics/query [server-only]
  Body: {
    query: string,
    params?: Record<string, unknown>,
    timeout_ms?: number,
    include_all_branches?: false
  }

Runs a read-only analytics query for the current project and branch. The API applies project and branch filtering through ClickHouse settings.

Errors:
  AnalyticsQueryError
    code: "ANALYTICS_QUERY_ERROR"
    message: sanitized ClickHouse query error


## listSessionReplays(options?)

Arguments:
  options.limit: number? - max results
  options.cursor: string? - pagination cursor
  options.userIds: string[]? - only replays recorded by these users
  options.teamIds: string[]? - only replays recorded by members of these teams
  options.durationMsMin: number? - min replay duration in milliseconds
  options.durationMsMax: number? - max replay duration in milliseconds
  options.lastEventAtFromMillis: number? - only replays whose last event is at or after this Unix ms timestamp
  options.lastEventAtToMillis: number? - only replays whose last event is at or before this Unix ms timestamp
  options.clickCountMin: number? - only replays with at least this many click events

Returns:
  {
    items: AdminSessionReplay[],
    nextCursor: string | null
  }

Request:
  GET /api/v1/session-replays [server-only]
  Query params: cursor?, limit?, user_ids? (comma-separated), team_ids? (comma-separated),
                duration_ms_min?, duration_ms_max?, last_event_at_from_millis?,
                last_event_at_to_millis?, click_count_min?

Response:
  {
    items: [{
      id: string,
      refresh_token_id: string,
      project_user: { id: string, display_name: string | null, primary_email: string | null },
      started_at_millis: number,
      last_event_at_millis: number,
      chunk_count: number,
      event_count: number
    }],
    pagination: { next_cursor: string | null }
  }

Lists session replay recordings for the current project, most recently active first.

Errors:
  ItemNotFound
    code: "ITEM_NOT_FOUND"
    when: the cursor does not refer to a replay in this project


## getSessionReplay(sessionReplayId)

Arguments:
  sessionReplayId: string - the replay's id

Returns: AdminSessionReplay

Request:
  GET /api/v1/session-replays/{session_replay_id} [server-only]

Response:
  {
    id: string,
    refresh_token_id: string,
    project_user: { id: string, display_name: string | null, primary_email: string | null },
    started_at_millis: number,
    last_event_at_millis: number,
    chunk_count: number,
    event_count: number
  }

Errors:
  ItemNotFound
    code: "ITEM_NOT_FOUND"
    when: no replay with that id exists in this project


## listSessionReplayChunks(sessionReplayId, options?)

Arguments:
  sessionReplayId: string - the replay's id
  options.limit: number? - max results
  options.cursor: string? - pagination cursor

Returns:
  {
    items: AdminSessionReplayChunk[],
    nextCursor: string | null
  }

Request:
  GET /api/v1/session-replays/{session_replay_id}/chunks [server-only]
  Query params: cursor?, limit?

Response:
  {
    items: [{
      id: string,
      batch_id: string,
      session_replay_segment_id: string | null,
      browser_session_id: string | null,
      event_count: number,
      byte_length: number,
      first_event_at_millis: number,
      last_event_at_millis: number,
      created_at_millis: number
    }],
    pagination: { next_cursor: string | null }
  }

Lists the recorded chunks of a replay in chronological order, without their event payloads.

Errors:
  ItemNotFound
    code: "ITEM_NOT_FOUND"
    when: no replay with that id exists in this project, or the cursor does not refer to one of its chunks


## getSessionReplayChunkEvents(sessionReplayId, chunkId)

Arguments:
  sessionReplayId: string - the replay's id
  chunkId: string - the chunk's id, which must belong to that replay

Returns:
  {
    events: unknown[]
  }

Request:
  GET /api/v1/session-replays/{session_replay_id}/chunks/{chunk_id}/events [server-only]

Response:
  {
    events: unknown[]
  }

Returns the raw rrweb events of a single chunk. Unlike the other four methods, the response is
returned verbatim rather than mapped to a camelCase domain type; it carries no chunk id, so the
caller must track which chunk it asked for.

Errors:
  ItemNotFound
    code: "ITEM_NOT_FOUND"
    when: the chunk does not exist or does not belong to that replay in this project


## getSessionReplayEvents(sessionReplayId, options?)

Arguments:
  sessionReplayId: string - the replay's id
  options.offset: number? - index of the first chunk to fetch events for, default 0
  options.limit: number? - number of chunks to fetch events for, default all remaining chunks

Returns:
  {
    chunks: [{
      id, batchId, sessionReplaySegmentId, eventCount, byteLength,
      firstEventAt: Date, lastEventAt: Date, createdAt: Date
    }],
    chunkEvents: [{ chunkId: string, events: unknown[] }]
  }

Request:
  GET /api/v1/session-replays/{session_replay_id}/events [server-only]
  Query params: offset?, limit?

Response:
  {
    chunks: [{
      id: string,
      batch_id: string,
      session_replay_segment_id: string | null,
      event_count: number,
      byte_length: number,
      first_event_at_millis: number,
      last_event_at_millis: number,
      created_at_millis: number
    }],
    chunk_events: [{ chunk_id: string, events: unknown[] }]
  }

Returns the rrweb events of a whole replay. `chunks` always lists every chunk of the replay so the
caller can page through them; `chunk_events` only contains the events of the chunks selected by
`offset`/`limit`. Omitting `limit` downloads every chunk, which can be a large response for a long
recording.

Errors:
  ItemNotFound
    code: "ITEM_NOT_FOUND"
    when: no replay with that id exists in this project


## sendEmail(options)

Arguments:
  options.to: string | string[] - recipient email(s)
  options.subject: string
  options.html: string? - HTML body
  options.text: string? - plain text body

Returns: void

Request:
  POST /api/v1/emails [server-only]
  Body: { 
    to: string | string[], 
    subject: string, 
    html?: string, 
    text?: string 
  }

Does not error.


## getEmailDeliveryStats()

Returns: EmailDeliveryInfo

Request:
  GET /api/v1/emails/delivery-stats [server-only]

Response:
  {
    delivered: number,
    bounced: number,
    complained: number,
    total: number
  }

EmailDeliveryInfo:
  delivered: number - emails successfully delivered
  bounced: number - emails that bounced (hard or soft)
  complained: number - emails marked as spam by recipients
  total: number - total emails sent

Does not error.


## createOAuthProvider(options)

Arguments:
  options.userId: string
  options.accountId: string
  options.providerConfigId: string
  options.email: string
  options.allowSignIn: bool
  options.allowConnectedAccounts: bool

Returns: ServerOAuthProvider (on success)

Request:
  POST /api/v1/users/{userId}/oauth-providers [server-only]
  Body: {
    account_id: string,
    provider_config_id: string,
    email: string,
    allow_sign_in: bool,
    allow_connected_accounts: bool
  }

Errors:
  OAuthProviderAccountIdAlreadyUsedForSignIn
    code: "oauth_provider_account_id_already_used_for_sign_in"
    message: "This OAuth account is already linked to another user for sign-in."


## getDataVaultStore(id)

Arguments:
  id: string - data vault store ID

Returns: DataVaultStore

The Data Vault is a simple key-value store for storing sensitive data server-side.
Each store is isolated and identified by its ID.

DataVaultStore:
  id: string - the store ID

  get(key: string): Promise<string | null>
    GET /api/v1/data-vault/stores/{storeId}/items/{key} [server-only]
    Returns the value for the key, or null if not found.
    
  set(key: string, value: string): Promise<void>
    PUT /api/v1/data-vault/stores/{storeId}/items/{key} [server-only]
    Body: { value: string }
    Sets or updates the value for the key.
    
  delete(key: string): Promise<void>
    DELETE /api/v1/data-vault/stores/{storeId}/items/{key} [server-only]
    Deletes the key-value pair. No error if key doesn't exist.
    
  list(): Promise<string[]>
    GET /api/v1/data-vault/stores/{storeId}/items [server-only]
    Returns all keys in the store.

Does not error.


## getItem(options)

Arguments:
  Customer identification (one of):
    options.userId: string
    options.teamId: string
    options.customCustomerId: string
  options.itemId: string

Returns: ServerItem

Request:
  GET /api/v1/customers/{customer_type}/{customer_id}/items/{itemId} [server-only]

Response:
  { id: string, quantity: number }

Does not error.


## listProducts(options)

Arguments:
  Customer identification (one of):
    options.userId: string
    options.teamId: string
    options.customCustomerId: string
  options.cursor: string? - pagination cursor
  options.limit: number? - max results

Returns: CustomerProductsList

Request:
  GET /api/v1/customers/{customer_type}/{customer_id}/products [server-only]
  Query params: cursor?, limit?

Response:
  { 
    items: [{ id, name, quantity, ... }],
    pagination: { next_cursor?: string }
  }

Does not error.
