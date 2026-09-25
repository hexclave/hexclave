-- Per-environment secret values (all / prod / preview / dev) and the
-- per-environment env map on deployment services. Existing secret rows become
-- `all` so current stored keys still satisfy prod deploys.
--
-- Split across three migrations so none holds a long lock on a large table:
-- this one only changes catalog metadata (constant defaults and a NOT VALID
-- check), 20260925000001 builds the new unique index concurrently, and
-- 20260925000002 drops the old index and validates the check.

-- Constant default: a metadata-only change on Postgres 11+, no table rewrite.
ALTER TABLE "ProjectSecret" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'all';

-- NOT VALID still enforces the check on every new or updated row; existing
-- rows can only hold the default 'all', and are validated in 20260925000002.
ALTER TABLE "ProjectSecret" ADD CONSTRAINT "ProjectSecret_environment_check" CHECK ("environment" IN ('all', 'prod', 'preview', 'dev')) NOT VALID;

-- Empty object default: rows synced before this column exist have no
-- per-environment map, and the dashboard falls back to the prod-resolved `env`
-- column.
ALTER TABLE "DeploymentService" ADD COLUMN "envPerEnvironment" JSONB NOT NULL DEFAULT '{}';
