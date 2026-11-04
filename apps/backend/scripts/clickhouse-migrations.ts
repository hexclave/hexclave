import { getClickhouseAdminClient } from "@/lib/clickhouse";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";

export async function runClickhouseMigrations() {
  const start = performance.now();
  console.log("[Clickhouse] Running Clickhouse migrations...");
  const client = getClickhouseAdminClient();
  const clickhouseExternalPassword = getEnvVariable("STACK_CLICKHOUSE_EXTERNAL_PASSWORD");

  // Setup — database, user, sync metadata
  await client.command({ query: EXTERNAL_ANALYTICS_DB_SQL });
  await Promise.all([
    client.command({
      query: "CREATE USER IF NOT EXISTS limited_user IDENTIFIED WITH sha256_password BY {clickhouseExternalPassword:String}",
      query_params: { clickhouseExternalPassword },
    }),
    client.command({ query: SYNC_METADATA_TABLE_SQL }),
  ]);

  // Removing an app's schema definitions only keeps fresh installations clean. Drop the
  // retired Growth views first, then their backing tables, so existing installations converge
  // to the same schema without relying on dependencies or CASCADE behavior.
  await Promise.all([
    client.command({ query: "DROP VIEW IF EXISTS default.growth_daily_metrics" }),
    client.command({ query: "DROP VIEW IF EXISTS default.growth_daily_ad_metrics" }),
  ]);
  await Promise.all([
    client.command({ query: "DROP TABLE IF EXISTS analytics_internal.growth_daily_metrics" }),
    client.command({ query: "DROP TABLE IF EXISTS analytics_internal.growth_daily_ad_metrics" }),
  ]);

  // Create all tables in parallel
  await Promise.all([
    client.command({ query: EVENTS_TABLE_BASE_SQL }),
    client.command({ query: USERS_TABLE_BASE_SQL }),
    client.command({ query: CONTACT_CHANNELS_TABLE_BASE_SQL }),
    client.command({ query: TEAMS_TABLE_BASE_SQL }),
    client.command({ query: TEAM_MEMBER_PROFILES_TABLE_BASE_SQL }),
    client.command({ query: TEAM_PERMISSIONS_TABLE_BASE_SQL }),
    client.command({ query: TEAM_INVITATIONS_TABLE_BASE_SQL }),
    client.command({ query: EMAIL_OUTBOXES_TABLE_BASE_SQL }),

    client.command({ query: PROJECT_PERMISSIONS_TABLE_BASE_SQL }),
    client.command({ query: NOTIFICATION_PREFERENCES_TABLE_BASE_SQL }),
    client.command({ query: REFRESH_TOKENS_TABLE_BASE_SQL }),
    client.command({ query: CONNECTED_ACCOUNTS_TABLE_BASE_SQL }),
    client.command({ query: CLICKMAP_EVENTS_TABLE_SQL }),
  ]);

  await client.command({ query: CLICKMAP_EVENTS_ADD_DEAD_COLUMN_SQL });

  // Alter users table (must come before the view that references the new columns)
  await client.command({ query: USERS_ADD_SIGNUP_RISK_COLUMNS_SQL });

  // Alter events table (must come before views that reference new columns)
  await client.command({ query: EVENTS_ADD_REPLAY_COLUMNS_SQL });

  // Clickmap materialized view depends on the events table existing; create after the ALTER above
  // so the view sees the replay columns. IF NOT EXISTS makes this idempotent across reboots.
  await client.command({ query: CLICKMAP_EVENTS_MV_SQL });

  // Create all views in parallel
  await Promise.all([
    client.command({ query: EVENTS_VIEW_SQL }),
    client.command({ query: USERS_VIEW_SQL }),
    client.command({ query: CONTACT_CHANNELS_VIEW_SQL }),
    client.command({ query: TEAMS_VIEW_SQL }),
    client.command({ query: TEAM_MEMBER_PROFILES_VIEW_SQL }),
    client.command({ query: TEAM_PERMISSIONS_VIEW_SQL }),
    client.command({ query: TEAM_INVITATIONS_VIEW_SQL }),
    client.command({ query: EMAIL_OUTBOXES_VIEW_SQL }),

    client.command({ query: PROJECT_PERMISSIONS_VIEW_SQL }),
    client.command({ query: NOTIFICATION_PREFERENCES_VIEW_SQL }),
    client.command({ query: REFRESH_TOKENS_VIEW_SQL }),
    client.command({ query: CONNECTED_ACCOUNTS_VIEW_SQL }),
  ]);

  // Data migrations (mutations)
  await Promise.all([
    client.command({ query: TOKEN_REFRESH_EVENT_ROW_FORMAT_MUTATION_SQL }),
    client.command({ query: BACKFILL_REFRESH_TOKEN_ID_COLUMN_SQL }),
    client.command({ query: SIGN_UP_RULE_TRIGGER_EVENT_ROW_FORMAT_MUTATION_SQL }),
  ]);

  // Add column comments to all views so DESCRIBE TABLE returns useful descriptions.
  // Comments are lost on CREATE OR REPLACE VIEW, so we re-apply them every migration run.
  // The AI query builder treats these comments as authoritative schema metadata,
  // so a partial application is incompatible with the backend version being deployed.
  // One ALTER per view keeps each view's metadata update atomic and avoids
  // contending on the same metadata lock with one command per column.
  for (const sql of COLUMN_COMMENT_SQL) {
    await client.command({ query: sql });
  }

  // Row policies in parallel
  const tables = [
    "events", "users", "contact_channels", "teams", "team_member_profiles",
    "team_permissions", "team_invitations", "email_outboxes",
    "project_permissions", "notification_preferences", "refresh_tokens", "connected_accounts",
  ];
  await Promise.all(tables.map(table =>
    client.command({
      query: `CREATE ROW POLICY IF NOT EXISTS ${table}_project_isolation ON default.${table} FOR SELECT USING project_id = getSetting('SQL_project_id') AND branch_id = getSetting('SQL_branch_id') TO limited_user`,
    })
  ));

  // Grants
  await client.command({ query: "REVOKE ALL PRIVILEGES ON *.* FROM limited_user;" });
  await client.command({ query: "REVOKE ALL FROM limited_user;" });
  await Promise.all(tables.map(table =>
    client.command({ query: `GRANT SELECT ON default.${table} TO limited_user;` })
  ));

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`[Clickhouse] Clickhouse migrations complete (${elapsed}s)`);
  await client.close();
}

const EVENTS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.events (
    event_type       LowCardinality(String),
    event_at         DateTime64(3, 'UTC'),
    data             JSON,
    project_id       String,
    branch_id        String,
    user_id          Nullable(String),
    team_id          Nullable(String),
    created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE MergeTree
PARTITION BY toYYYYMM(event_at)
ORDER BY (project_id, branch_id, event_at);
`;

const EVENTS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.events 
SQL SECURITY DEFINER
AS
SELECT *
FROM analytics_internal.events;
`;

// Normalizes legacy $token-refresh rows (camelCase JSON) to the new format:
// - Row identity stays in columns (project_id/branch_id/user_id)
// - data JSON becomes { refresh_token_id, is_anonymous, ip_info } (snake_case)
// Assumption: all legacy rows have the camelCase format.
const TOKEN_REFRESH_EVENT_ROW_FORMAT_MUTATION_SQL = `
ALTER TABLE analytics_internal.events
UPDATE
  data = CAST(concat(
    '{',
      '"refresh_token_id":', toJSONString(data.refreshTokenId::String), ',',
      '"is_anonymous":', if(ifNull(data.isAnonymous::Nullable(Bool), false), 'true', 'false'), ',',
      '"ip_info":', if(
        isNull(data.ipInfo.ip::Nullable(String)),
        'null',
        concat(
          '{',
            '"ip":', toJSONString(data.ipInfo.ip::String), ',',
            '"is_trusted":', if(ifNull(data.ipInfo.isTrusted::Nullable(Bool), false), 'true', 'false'), ',',
            '"country_code":', if(isNull(data.ipInfo.countryCode::Nullable(String)), 'null', toJSONString(data.ipInfo.countryCode::String)), ',',
            '"region_code":', if(isNull(data.ipInfo.regionCode::Nullable(String)), 'null', toJSONString(data.ipInfo.regionCode::String)), ',',
            '"city_name":', if(isNull(data.ipInfo.cityName::Nullable(String)), 'null', toJSONString(data.ipInfo.cityName::String)), ',',
            '"latitude":', if(isNull(data.ipInfo.latitude::Nullable(Float64)), 'null', toString(data.ipInfo.latitude::Float64)), ',',
            '"longitude":', if(isNull(data.ipInfo.longitude::Nullable(Float64)), 'null', toString(data.ipInfo.longitude::Float64)), ',',
            '"tz_identifier":', if(isNull(data.ipInfo.tzIdentifier::Nullable(String)), 'null', toJSONString(data.ipInfo.tzIdentifier::String)),
          '}'
        )
      ),
    '}'
  ) AS JSON)
WHERE event_type = '$token-refresh'
  AND data.refreshTokenId::Nullable(String) IS NOT NULL;
`;

// Normalizes legacy $sign-up-rule-trigger rows (camelCase JSON) to the new format:
// - Row identity stays in columns (project_id/branch_id)
// - data JSON becomes { project_id, branch_id, rule_id, action, email, auth_method, oauth_provider } (snake_case)
const SIGN_UP_RULE_TRIGGER_EVENT_ROW_FORMAT_MUTATION_SQL = `
ALTER TABLE analytics_internal.events
UPDATE
  data = CAST(concat(
    '{',
      '"project_id":', toJSONString(JSONExtractString(toJSONString(data), 'projectId')), ',',
      '"branch_id":', toJSONString(JSONExtractString(toJSONString(data), 'branchId')), ',',
      '"rule_id":', toJSONString(JSONExtractString(toJSONString(data), 'ruleId')), ',',
      '"action":', toJSONString(JSONExtractString(toJSONString(data), 'action')), ',',
      '"email":', toJSONString(JSONExtract(toJSONString(data), 'email', 'Nullable(String)')), ',',
      '"auth_method":', toJSONString(JSONExtract(toJSONString(data), 'authMethod', 'Nullable(String)')), ',',
      '"oauth_provider":', toJSONString(JSONExtract(toJSONString(data), 'oauthProvider', 'Nullable(String)')),
    '}'
  ) AS JSON)
WHERE event_type = '$sign-up-rule-trigger'
  AND JSONHas(toJSONString(data), 'ruleId');
`;

const USERS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.users (
    project_id String,
    branch_id String,
    id UUID,
    display_name Nullable(String),
    profile_image_url Nullable(String),
    primary_email Nullable(String),
    primary_email_verified UInt8,
    signed_up_at DateTime64(3, 'UTC'),
    client_metadata String,
    client_read_only_metadata String,
    server_metadata String,
    is_anonymous UInt8,
    sign_up_risk_score_bot Int32,
    sign_up_risk_score_free_trial_abuse Int32,
    restricted_by_admin UInt8,
    restricted_by_admin_reason Nullable(String),
    restricted_by_admin_private_details Nullable(String),
    sync_sequence_id Int64,
    sync_is_deleted UInt8,
    sync_created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(signed_up_at)
ORDER BY (project_id, branch_id, id);
`;

const USERS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.users 
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  id,
  display_name,
  profile_image_url,
  primary_email,
  primary_email_verified,
  signed_up_at,
  client_metadata,
  client_read_only_metadata,
  server_metadata,
  is_anonymous,
  sign_up_risk_score_bot,
  sign_up_risk_score_free_trial_abuse,
  restricted_by_admin,
  restricted_by_admin_reason,
  restricted_by_admin_private_details
FROM analytics_internal.users
FINAL
WHERE sync_is_deleted = 0;
`;

const SYNC_METADATA_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal._stack_sync_metadata (
    tenancy_id UUID,
    mapping_name String,
    last_synced_sequence_id Int64,
    updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(updated_at)
ORDER BY (tenancy_id, mapping_name);
`;

const EVENTS_ADD_REPLAY_COLUMNS_SQL = `
ALTER TABLE analytics_internal.events
  ADD COLUMN IF NOT EXISTS refresh_token_id Nullable(String) AFTER team_id,
  ADD COLUMN IF NOT EXISTS session_replay_id Nullable(String) AFTER refresh_token_id,
  ADD COLUMN IF NOT EXISTS session_replay_segment_id Nullable(String) AFTER session_replay_id;
`;

const USERS_ADD_SIGNUP_RISK_COLUMNS_SQL = `
ALTER TABLE analytics_internal.users
  ADD COLUMN IF NOT EXISTS sign_up_risk_score_bot Int32 AFTER is_anonymous,
  ADD COLUMN IF NOT EXISTS sign_up_risk_score_free_trial_abuse Int32 AFTER sign_up_risk_score_bot;
`;

// Backfill refresh_token_id from data.refresh_token_id for existing $token-refresh rows
const BACKFILL_REFRESH_TOKEN_ID_COLUMN_SQL = `
ALTER TABLE analytics_internal.events
UPDATE refresh_token_id = data.refresh_token_id::Nullable(String)
WHERE event_type = '$token-refresh'
  AND refresh_token_id IS NULL
  AND data.refresh_token_id::Nullable(String) IS NOT NULL;
`;

const CONTACT_CHANNELS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.contact_channels (
    project_id String,
    branch_id String,
    id UUID,
    user_id UUID,
    type LowCardinality(String),
    value String,
    is_primary UInt8,
    is_verified UInt8,
    used_for_auth UInt8,
    created_at DateTime64(3, 'UTC'),
    sync_sequence_id Int64,
    sync_is_deleted UInt8,
    sync_created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, id);
`;

const CONTACT_CHANNELS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.contact_channels
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  id,
  user_id,
  type,
  value,
  is_primary,
  is_verified,
  used_for_auth,
  created_at
FROM analytics_internal.contact_channels
FINAL
WHERE sync_is_deleted = 0;
`;

const TEAMS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.teams (
    project_id String,
    branch_id String,
    id UUID,
    display_name String,
    profile_image_url Nullable(String),
    created_at DateTime64(3, 'UTC'),
    client_metadata String,
    client_read_only_metadata String,
    server_metadata String,
    sync_sequence_id Int64,
    sync_is_deleted UInt8,
    sync_created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, id);
`;

const TEAMS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.teams
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  id,
  display_name,
  profile_image_url,
  created_at,
  client_metadata,
  client_read_only_metadata,
  server_metadata
FROM analytics_internal.teams
FINAL
WHERE sync_is_deleted = 0;
`;

const TEAM_MEMBER_PROFILES_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.team_member_profiles (
    project_id String,
    branch_id String,
    team_id UUID,
    user_id UUID,
    display_name Nullable(String),
    profile_image_url Nullable(String),
    created_at DateTime64(3, 'UTC'),
    sync_sequence_id Int64,
    sync_is_deleted UInt8,
    sync_created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, team_id, user_id);
`;

const TEAM_MEMBER_PROFILES_VIEW_SQL = `
CREATE OR REPLACE VIEW default.team_member_profiles
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  team_id,
  user_id,
  display_name,
  profile_image_url,
  created_at
FROM analytics_internal.team_member_profiles
FINAL
WHERE sync_is_deleted = 0;
`;

const TEAM_PERMISSIONS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.team_permissions (
    project_id       String,
    branch_id        String,
    team_id          UUID,
    user_id          UUID,
    id               String,
    created_at       DateTime64(3, 'UTC'),
    sync_sequence_id Int64,
    sync_is_deleted  UInt8,
    sync_created_at  DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, team_id, user_id, id);
`;

const TEAM_PERMISSIONS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.team_permissions
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  team_id,
  user_id,
  id,
  created_at
FROM analytics_internal.team_permissions
FINAL
WHERE sync_is_deleted = 0;
`;

const TEAM_INVITATIONS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.team_invitations (
    project_id         String,
    branch_id          String,
    id                 UUID,
    team_id            UUID,
    team_display_name  String,
    recipient_email    String,
    expires_at_millis  Int64,
    created_at         DateTime64(3, 'UTC'),
    sync_sequence_id   Int64,
    sync_is_deleted    UInt8,
    sync_created_at    DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, id);
`;

const TEAM_INVITATIONS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.team_invitations
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  id,
  team_id,
  team_display_name,
  recipient_email,
  expires_at_millis,
  created_at
FROM analytics_internal.team_invitations
FINAL
WHERE sync_is_deleted = 0;
`;

const EMAIL_OUTBOXES_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.email_outboxes (
    project_id String,
    branch_id String,
    id UUID,
    status LowCardinality(String),
    simple_status LowCardinality(String),
    created_with LowCardinality(String),
    email_draft_id Nullable(String),
    email_programmatic_call_template_id Nullable(String),
    theme_id Nullable(String),
    is_high_priority UInt8,
    is_transactional Nullable(UInt8),
    subject Nullable(String),
    notification_category_id Nullable(String),
    started_rendering_at Nullable(DateTime64(3, 'UTC')),
    rendered_at Nullable(DateTime64(3, 'UTC')),
    render_error Nullable(String),
    scheduled_at DateTime64(3, 'UTC'),
    created_at DateTime64(3, 'UTC'),
    updated_at DateTime64(3, 'UTC'),
    started_sending_at Nullable(DateTime64(3, 'UTC')),
    server_error Nullable(String),
    delivered_at Nullable(DateTime64(3, 'UTC')),
    opened_at Nullable(DateTime64(3, 'UTC')),
    clicked_at Nullable(DateTime64(3, 'UTC')),
    unsubscribed_at Nullable(DateTime64(3, 'UTC')),
    marked_as_spam_at Nullable(DateTime64(3, 'UTC')),
    bounced_at Nullable(DateTime64(3, 'UTC')),
    delivery_delayed_at Nullable(DateTime64(3, 'UTC')),
    can_have_delivery_info Nullable(UInt8),
    skipped_reason LowCardinality(Nullable(String)),
    skipped_details Nullable(String),
    send_retries Int32,
    is_paused UInt8,
    sync_sequence_id Int64,
    sync_is_deleted UInt8,
    sync_created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, id);
`;

const EMAIL_OUTBOXES_VIEW_SQL = `
CREATE OR REPLACE VIEW default.email_outboxes
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  id,
  status,
  simple_status,
  created_with,
  email_draft_id,
  email_programmatic_call_template_id,
  theme_id,
  is_high_priority,
  is_transactional,
  subject,
  notification_category_id,
  started_rendering_at,
  rendered_at,
  render_error,
  scheduled_at,
  created_at,
  updated_at,
  started_sending_at,
  server_error,
  delivered_at,
  opened_at,
  clicked_at,
  unsubscribed_at,
  marked_as_spam_at,
  bounced_at,
  delivery_delayed_at,
  can_have_delivery_info,
  skipped_reason,
  skipped_details,
  send_retries,
  is_paused
FROM analytics_internal.email_outboxes
FINAL
WHERE sync_is_deleted = 0;
`;


const PROJECT_PERMISSIONS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.project_permissions (
    project_id       String,
    branch_id        String,
    user_id          UUID,
    id               String,
    created_at       DateTime64(3, 'UTC'),
    sync_sequence_id Int64,
    sync_is_deleted  UInt8,
    sync_created_at  DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, user_id, id);
`;

const PROJECT_PERMISSIONS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.project_permissions
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  user_id,
  id,
  created_at
FROM analytics_internal.project_permissions
FINAL
WHERE sync_is_deleted = 0;
`;

const NOTIFICATION_PREFERENCES_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.notification_preferences (
    project_id             String,
    branch_id              String,
    user_id                UUID,
    notification_category_id String,
    enabled                UInt8,
    sync_sequence_id       Int64,
    sync_is_deleted        UInt8,
    sync_created_at        DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
ORDER BY (project_id, branch_id, user_id, notification_category_id);
`;

const NOTIFICATION_PREFERENCES_VIEW_SQL = `
CREATE OR REPLACE VIEW default.notification_preferences
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  user_id,
  notification_category_id,
  enabled
FROM analytics_internal.notification_preferences
FINAL
WHERE sync_is_deleted = 0;
`;

const REFRESH_TOKENS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.refresh_tokens (
    project_id String,
    branch_id String,
    id UUID,
    user_id UUID,
    created_at DateTime64(3, 'UTC'),
    last_used_at DateTime64(3, 'UTC'),
    is_impersonation UInt8,
    expires_at Nullable(DateTime64(3, 'UTC')),
    sync_sequence_id Int64,
    sync_is_deleted UInt8,
    sync_created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, id);
`;

const REFRESH_TOKENS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.refresh_tokens
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  id,
  user_id,
  created_at,
  last_used_at,
  is_impersonation,
  expires_at
FROM analytics_internal.refresh_tokens
FINAL
WHERE sync_is_deleted = 0;
`;

const CONNECTED_ACCOUNTS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.connected_accounts (
    project_id String,
    branch_id String,
    user_id UUID,
    provider String,
    provider_account_id String,
    created_at DateTime64(3, 'UTC'),
    sync_sequence_id Int64,
    sync_is_deleted UInt8,
    sync_created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, user_id, provider, provider_account_id);
`;

const CONNECTED_ACCOUNTS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.connected_accounts
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  user_id,
  provider,
  provider_account_id,
  created_at
FROM analytics_internal.connected_accounts
FINAL
WHERE sync_is_deleted = 0;
`;

// ─── Column comments ────────────────────────────────────────────────
// Applied to the default.* views after creation so that DESCRIBE TABLE
// returns useful descriptions for each column. The AI assistant uses
// SHOW TABLES + DESCRIBE TABLE for schema discovery instead of
// hardcoded schema in the prompt.
const COLUMN_COMMENT_STATEMENTS: string[] = [
  // ── events ──
  `ALTER TABLE default.events COMMENT COLUMN event_type 'Event type identifier. Known types: \$page-view, \$click, \$token-refresh, \$sign-up-rule-trigger'`,
  `ALTER TABLE default.events COMMENT COLUMN event_at 'When the event occurred (UTC)'`,
  `ALTER TABLE default.events COMMENT COLUMN data 'Event payload as JSON. MUST use toString(data) before JSONExtract* functions. Payload varies by event_type: \$page-view → {is_anonymous, path, referrer}; \$click → {is_anonymous, selector, url, viewport_width, viewport_height, x, y, ...}; \$token-refresh → {is_anonymous, refresh_token_id, ip_info: {country_code, city_name, region_code, is_trusted, latitude, longitude, tz_identifier, ip}}'`,
  `ALTER TABLE default.events COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.events COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.events COMMENT COLUMN user_id 'User who triggered the event. Always populated despite Nullable type'`,
  `ALTER TABLE default.events COMMENT COLUMN team_id 'Reserved for future use. Currently always NULL — do not filter on this column'`,
  `ALTER TABLE default.events COMMENT COLUMN created_at 'When this record was inserted into the database (UTC)'`,
  `ALTER TABLE default.events COMMENT COLUMN refresh_token_id 'Denormalized from data.refresh_token_id for \$token-refresh events. NULL for other event types'`,
  `ALTER TABLE default.events COMMENT COLUMN session_replay_id 'Session replay identifier for linking to replay recordings'`,
  `ALTER TABLE default.events COMMENT COLUMN session_replay_segment_id 'Segment within a session replay recording'`,

  // ── users ──
  `ALTER TABLE default.users COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.users COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.users COMMENT COLUMN id 'Unique user identifier (UUID primary key)'`,
  `ALTER TABLE default.users COMMENT COLUMN display_name 'User-facing display name set by the user or application'`,
  `ALTER TABLE default.users COMMENT COLUMN profile_image_url 'URL to the user profile/avatar image'`,
  `ALTER TABLE default.users COMMENT COLUMN primary_email 'User primary email address'`,
  `ALTER TABLE default.users COMMENT COLUMN primary_email_verified '1 if the primary email has been verified, 0 otherwise'`,
  `ALTER TABLE default.users COMMENT COLUMN signed_up_at 'When the user first signed up (UTC)'`,
  `ALTER TABLE default.users COMMENT COLUMN client_metadata 'Application-defined JSON metadata readable and writable from client SDKs'`,
  `ALTER TABLE default.users COMMENT COLUMN client_read_only_metadata 'Application-defined JSON metadata readable from client SDKs but only writable from server'`,
  `ALTER TABLE default.users COMMENT COLUMN server_metadata 'Application-defined JSON metadata only accessible from server SDKs'`,
  `ALTER TABLE default.users COMMENT COLUMN is_anonymous '1 if this is an anonymous/guest user, 0 for authenticated users'`,
  `ALTER TABLE default.users COMMENT COLUMN sign_up_risk_score_bot 'Sign-up bot risk score from 0 to 100'`,
  `ALTER TABLE default.users COMMENT COLUMN sign_up_risk_score_free_trial_abuse 'Sign-up free-trial-abuse risk score from 0 to 100'`,
  `ALTER TABLE default.users COMMENT COLUMN restricted_by_admin '1 if an admin has restricted this user access'`,
  `ALTER TABLE default.users COMMENT COLUMN restricted_by_admin_reason 'Admin-provided reason for restricting the user, shown to the user'`,
  `ALTER TABLE default.users COMMENT COLUMN restricted_by_admin_private_details 'Private admin notes about the restriction, not shown to the user'`,

  // ── contact_channels ──
  `ALTER TABLE default.contact_channels COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN id 'Unique contact channel identifier'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN user_id 'Owner user ID (join to users.id)'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN type 'Channel type, e.g. email'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN value 'Channel value, e.g. the email address'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN is_primary '1 if this is the user primary contact channel'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN is_verified '1 if ownership of this channel has been verified'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN used_for_auth '1 if this channel can be used as an authentication identifier'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN created_at 'When this contact channel was created (UTC)'`,

  // ── teams ──
  `ALTER TABLE default.teams COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.teams COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.teams COMMENT COLUMN id 'Unique team identifier'`,
  `ALTER TABLE default.teams COMMENT COLUMN display_name 'Team name shown in the UI'`,
  `ALTER TABLE default.teams COMMENT COLUMN profile_image_url 'URL to the team logo/avatar image'`,
  `ALTER TABLE default.teams COMMENT COLUMN created_at 'When the team was created (UTC)'`,
  `ALTER TABLE default.teams COMMENT COLUMN client_metadata 'Application-defined JSON metadata readable and writable from client SDKs'`,
  `ALTER TABLE default.teams COMMENT COLUMN client_read_only_metadata 'Application-defined JSON metadata readable from client SDKs but only writable from server'`,
  `ALTER TABLE default.teams COMMENT COLUMN server_metadata 'Application-defined JSON metadata only accessible from server SDKs'`,

  // ── team_member_profiles ──
  `ALTER TABLE default.team_member_profiles COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.team_member_profiles COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.team_member_profiles COMMENT COLUMN team_id 'Team this membership belongs to (join to teams.id)'`,
  `ALTER TABLE default.team_member_profiles COMMENT COLUMN user_id 'User in this membership (join to users.id)'`,
  `ALTER TABLE default.team_member_profiles COMMENT COLUMN display_name 'Per-team display name override. NULL means use the user default display_name'`,
  `ALTER TABLE default.team_member_profiles COMMENT COLUMN profile_image_url 'Per-team profile image override. NULL means use the user default'`,
  `ALTER TABLE default.team_member_profiles COMMENT COLUMN created_at 'When this team membership was created (UTC)'`,

  // ── team_permissions ──
  `ALTER TABLE default.team_permissions COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.team_permissions COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.team_permissions COMMENT COLUMN team_id 'Team this permission is scoped to (join to teams.id)'`,
  `ALTER TABLE default.team_permissions COMMENT COLUMN user_id 'User granted this permission (join to users.id)'`,
  `ALTER TABLE default.team_permissions COMMENT COLUMN id 'Permission identifier string, e.g. admin, member'`,
  `ALTER TABLE default.team_permissions COMMENT COLUMN created_at 'When this permission was granted (UTC)'`,

  // ── team_invitations ──
  `ALTER TABLE default.team_invitations COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.team_invitations COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.team_invitations COMMENT COLUMN id 'Unique invitation identifier'`,
  `ALTER TABLE default.team_invitations COMMENT COLUMN team_id 'Team being invited to (join to teams.id)'`,
  `ALTER TABLE default.team_invitations COMMENT COLUMN team_display_name 'Snapshot of the team name at invitation time'`,
  `ALTER TABLE default.team_invitations COMMENT COLUMN recipient_email 'Email address the invitation was sent to'`,
  `ALTER TABLE default.team_invitations COMMENT COLUMN expires_at_millis 'Invitation expiry as Unix milliseconds. Compare with toUnixTimestamp64Milli(now())'`,
  `ALTER TABLE default.team_invitations COMMENT COLUMN created_at 'When the invitation was created (UTC)'`,

  // ── email_outboxes ──
  `ALTER TABLE default.email_outboxes COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN id 'Unique email record identifier'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN status 'Granular delivery status from the email provider'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN simple_status 'Simplified status for reporting, e.g. sent, delivered, failed'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN created_with 'How this email was created, e.g. programmatic API or draft editor'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN email_draft_id 'ID of the email draft template used, if created from a draft'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN email_programmatic_call_template_id 'ID of the programmatic template, if sent via API'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN theme_id 'Email theme/design ID applied to this email'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN is_high_priority '1 if marked as high priority for send ordering'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN is_transactional '1 for transactional emails (e.g. verification), NULL if unknown'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN subject 'Email subject line'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN notification_category_id 'Category for notification preferences/unsubscribe'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN started_rendering_at 'When email rendering began (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN rendered_at 'When email rendering completed (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN render_error 'Error message if rendering failed. Non-null implies render failure'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN scheduled_at 'When the email is/was scheduled to be sent (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN created_at 'When this email record was created (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN updated_at 'When this email record was last updated (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN started_sending_at 'When the send attempt began (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN server_error 'Error from the email provider. Non-null implies send failure'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN delivered_at 'When the email was confirmed delivered (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN opened_at 'When the recipient first opened the email (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN clicked_at 'When the recipient first clicked a link in the email (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN unsubscribed_at 'When the recipient unsubscribed via this email (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN marked_as_spam_at 'When the recipient marked this email as spam (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN bounced_at 'When the email bounced (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN delivery_delayed_at 'When a delivery delay was reported (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN can_have_delivery_info '1 if the email provider supports delivery tracking for this email'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN skipped_reason 'Why sending was skipped, if applicable. Non-null implies send was skipped'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN skipped_details 'Additional details about why sending was skipped'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN send_retries 'Number of send retry attempts made'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN is_paused '1 if email sending is currently paused'`,

  // ── project_permissions ──
  `ALTER TABLE default.project_permissions COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.project_permissions COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.project_permissions COMMENT COLUMN user_id 'User granted this permission (join to users.id)'`,
  `ALTER TABLE default.project_permissions COMMENT COLUMN id 'Permission identifier string'`,
  `ALTER TABLE default.project_permissions COMMENT COLUMN created_at 'When this permission was granted (UTC)'`,

  // ── notification_preferences ──
  `ALTER TABLE default.notification_preferences COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.notification_preferences COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.notification_preferences COMMENT COLUMN user_id 'User these preferences belong to (join to users.id)'`,
  `ALTER TABLE default.notification_preferences COMMENT COLUMN notification_category_id 'Notification category this preference applies to'`,
  `ALTER TABLE default.notification_preferences COMMENT COLUMN enabled '1 if the user has opted in to this notification category, 0 if opted out'`,

  // ── refresh_tokens ──
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN id 'Unique token identifier'`,
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN user_id 'User this token belongs to (join to users.id)'`,
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN created_at 'When the token was issued (UTC)'`,
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN last_used_at 'When the token was last exchanged for an access token (UTC). Proxy for session activity'`,
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN is_impersonation '1 if this is a dashboard/admin impersonation session'`,
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN expires_at 'When the token expires (UTC). NULL means non-expiring'`,

  // ── connected_accounts ──
  `ALTER TABLE default.connected_accounts COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.connected_accounts COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.connected_accounts COMMENT COLUMN user_id 'User this account is linked to (join to users.id)'`,
  `ALTER TABLE default.connected_accounts COMMENT COLUMN provider 'OAuth/SSO provider name, e.g. google, github'`,
  `ALTER TABLE default.connected_accounts COMMENT COLUMN provider_account_id 'User account ID at the external provider'`,
  `ALTER TABLE default.connected_accounts COMMENT COLUMN created_at 'When this account was linked (UTC)'`,
];

const COLUMN_COMMENT_TABLES = [
  "events",
  "users",
  "contact_channels",
  "teams",
  "team_member_profiles",
  "team_permissions",
  "team_invitations",
  "email_outboxes",
  "project_permissions",
  "notification_preferences",
  "refresh_tokens",
  "connected_accounts",
];

function buildColumnCommentSql(): string[] {
  const actionsByTable = new Map<string, string[]>();
  for (const table of COLUMN_COMMENT_TABLES) {
    actionsByTable.set(table, []);
  }

  for (const statement of COLUMN_COMMENT_STATEMENTS) {
    let matched = false;
    for (const table of COLUMN_COMMENT_TABLES) {
      const prefix = `ALTER TABLE default.${table} `;
      if (statement.startsWith(prefix)) {
        const actions = actionsByTable.get(table);
        if (actions == null) {
          throw new Error(`Missing column comment action group for analytics view: ${table}`);
        }
        actions.push(statement.slice(prefix.length));
        matched = true;
        break;
      }
    }
    if (!matched) {
      throw new Error(`Column comment statement does not target a known analytics view: ${statement}`);
    }
  }

  return COLUMN_COMMENT_TABLES.map((table) => {
    const actions = actionsByTable.get(table);
    if (actions == null || actions.length === 0) {
      throw new Error(`No column comments configured for analytics view: ${table}`);
    }
    return `ALTER TABLE default.${table}\n  ${actions.join(",\n  ")}`;
  });
}

const COLUMN_COMMENT_SQL = buildColumnCommentSql();

const EXTERNAL_ANALYTICS_DB_SQL = `
CREATE DATABASE IF NOT EXISTS analytics_internal;
`;

// Clickmap-only physical table (PostHog-style schema). Fed by clickmap_events_mv
// from analytics_internal.events WHERE event_type='$click'. Backwards compatible
// with click rows that pre-date elements_chain / scaled coords: the MV derives
// pointer_* from raw data.x / data.y / data.page_y, and elements_chain falls
// back to the empty string when the SDK didn't emit one.
//
// SCALE_FACTOR = 16 mirrors PostHog: pixel coords are divided at ingest so
// downstream queries operate on small integers and partitions stay compact.
//
// Order key (project_id, branch_id, date, path, viewport_width) matches the
// hot clickmap query: "all clicks on this path in this date range at these
// viewport widths".
//
// Dead-click classification lives on the click row itself: the SDK watches
// each click for up to ~3.75s for any observable effect and sets data.dead=1
// on the $click when there was none. One row per physical click, so count()
// stays the total and countIf(is_dead) is the dead subset; no second event
// type or table.
const CLICKMAP_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.clickmap_events (
    project_id           String,
    branch_id            String,
    event_at             DateTime64(3, 'UTC'),
    user_id              Nullable(String),
    session_replay_id    Nullable(String),
    url                  String,
    path                 String,
    viewport_width       UInt16,
    viewport_height      UInt16,
    pointer_x            UInt16,
    pointer_y            UInt16,
    client_y             UInt16,
    pointer_relative_x   Float32,
    pointer_target_fixed UInt8,
    elements_chain       String,
    selector             String,
    elements_text        String,
    tag_name             LowCardinality(String),
    href                 Nullable(String),
    is_dead              UInt8 DEFAULT 0
)
ENGINE MergeTree
PARTITION BY toYYYYMM(event_at)
ORDER BY (project_id, branch_id, toDate(event_at), path, viewport_width);
`;

const CLICKMAP_EVENTS_ADD_DEAD_COLUMN_SQL = `
ALTER TABLE analytics_internal.clickmap_events
ADD COLUMN IF NOT EXISTS is_dead UInt8 DEFAULT 0;
`;

// Materialized view that auto-populates clickmap_events on every $click insert.
// No POPULATE clause: existing rows stay in analytics_internal.events. New
// click rows flow into both tables.
//
// All field accesses use the toFloat64OrZero(toString(...)) pattern that the
// existing analytics queries use, so JSON-Variant nullability is handled the
// same way.
const CLICKMAP_EVENTS_MV_SQL = `
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics_internal.clickmap_events_mv
TO analytics_internal.clickmap_events
AS
SELECT
    project_id,
    branch_id,
    event_at,
    user_id,
    session_replay_id,
    toString(data.url) AS url,
    toString(data.path) AS path,
    toUInt16(least(65535, greatest(0, toUInt32(toFloat64OrZero(toString(data.viewport_width)))))) AS viewport_width,
    toUInt16(least(65535, greatest(0, toUInt32(toFloat64OrZero(toString(data.viewport_height)))))) AS viewport_height,
    toUInt16(least(65535, greatest(0, toUInt32(
        coalesce(toFloat64OrNull(toString(data.x_scaled)), toFloat64OrZero(toString(data.page_x)) / 16, toFloat64OrZero(toString(data.x)) / 16)
    )))) AS pointer_x,
    toUInt16(least(65535, greatest(0, toUInt32(
        coalesce(toFloat64OrNull(toString(data.y_scaled)), toFloat64OrZero(toString(data.page_y)) / 16, toFloat64OrZero(toString(data.y)) / 16)
    )))) AS pointer_y,
    toUInt16(least(65535, greatest(0, toUInt32(
        coalesce(toFloat64OrNull(toString(data.client_y_scaled)), toFloat64OrZero(toString(data.y)) / 16)
    )))) AS client_y,
    toFloat32(coalesce(
        toFloat64OrNull(toString(data.pointer_relative_x)),
        if(toFloat64OrZero(toString(data.viewport_width)) > 0,
           toFloat64OrZero(toString(data.x)) / toFloat64OrZero(toString(data.viewport_width)),
           0)
    )) AS pointer_relative_x,
    toUInt8(coalesce(toUInt8OrNull(toString(data.pointer_target_fixed)), 0)) AS pointer_target_fixed,
    toString(data.elements_chain) AS elements_chain,
    toString(data.selector) AS selector,
    toString(data.text) AS elements_text,
    toString(data.tag_name) AS tag_name,
    nullIf(toString(data.href), '') AS href,
    toUInt8(coalesce(toUInt8OrNull(toString(data.dead)), 0)) AS is_dead
FROM analytics_internal.events
WHERE event_type = '$click';
`;
