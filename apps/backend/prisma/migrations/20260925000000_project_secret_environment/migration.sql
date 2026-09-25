-- Per-environment secret values (default / production / preview / development) and the
-- per-environment env map on deployment services. Existing secret rows become
-- `DEFAULT` so current stored keys still satisfy production deploys.
--
-- Split across three migrations so none holds a long lock on a large table:
-- this one only changes catalog metadata (a new enum type and constant
-- defaults), 20260925000001 builds the new unique index concurrently, and
-- 20260925000002 drops the old index.

CREATE TYPE "ProjectSecretEnvironment" AS ENUM ('DEFAULT', 'PRODUCTION', 'PREVIEW', 'DEVELOPMENT');

-- Constant default: a metadata-only change on Postgres 11+, no table rewrite.
-- The enum type itself restricts the values, so no CHECK constraint is needed.
ALTER TABLE "ProjectSecret" ADD COLUMN "environment" "ProjectSecretEnvironment" NOT NULL DEFAULT 'DEFAULT';

-- Empty object default: rows synced before this column exist have no
-- per-environment map, and the dashboard falls back to the production-resolved `env`
-- column.
ALTER TABLE "DeploymentService" ADD COLUMN "envPerEnvironment" JSONB NOT NULL DEFAULT '{}';
