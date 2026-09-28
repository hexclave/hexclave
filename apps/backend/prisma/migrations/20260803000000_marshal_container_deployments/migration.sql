/*
  Deployments move from Vercel to Marshal (the Fly.io-backed container
  runtime). No data migration: there are no backwards-compatible deployments
  projects, and upload rows are ephemeral (cleared below so the new reference
  column can be NOT NULL).

  Warnings:

  - You are about to drop the column `buildCommand` on the `DeploymentService` table. All the data in the column will be lost.
  - You are about to drop the column `framework` on the `DeploymentService` table. All the data in the column will be lost.
  - You are about to drop the column `installCommand` on the `DeploymentService` table. All the data in the column will be lost.
  - You are about to drop the column `outputDirectory` on the `DeploymentService` table. All the data in the column will be lost.
  - You are about to drop the column `vercelProjectId` on the `DeploymentService` table. All the data in the column will be lost.
  - You are about to drop the column `vercelDeploymentId` on the `DeploymentRun` table. All the data in the column will be lost.
  - You are about to drop the column `vercelDeploymentUrl` on the `DeploymentRun` table. All the data in the column will be lost.
  - You are about to drop the column `objectKey` on the `DeploymentSourceUpload` table. All the data in the column will be lost.
*/

-- AlterTable
ALTER TABLE "DeploymentService" DROP COLUMN "buildCommand",
DROP COLUMN "framework",
DROP COLUMN "installCommand",
DROP COLUMN "outputDirectory",
DROP COLUMN "vercelProjectId",
ADD COLUMN "dockerfilePath" TEXT,
ADD COLUMN "maxInstances" INTEGER,
ADD COLUMN "minInstances" INTEGER,
-- The ports the container listens on, as a JSON OBJECT keyed by port number:
-- `{"3000": {"public": true, "protocol": "http"}}`. The same shape the deploy
-- file writes, kept all the way through the wire and this column so nothing has
-- to translate between two spellings of one thing — and duplicate ports become
-- impossible by construction rather than by a constraint.
--
-- There is deliberately no service-level visibility column: a service is public
-- exactly when one of its ports is, so the two can never drift apart. `protocol`
-- sits on the port for the same reason — a container speaking HTTP on one port
-- and raw TCP on another is a normal thing to want, and a service-level protocol
-- cannot express it.
--
-- `{}` on rows that predate a synced definition: displayable, not deployable.
ADD COLUMN "ports" JSONB NOT NULL DEFAULT '{}',
-- Whether the service takes public ingress. A property of the SERVICE rather
-- than of a port: Fly's proxy listener set is per-app, not per-address, so every
-- declared port answers on every address the app holds. "Public 3000, private
-- 5432" is not something the runtime can do, so the flag lives where the truth
-- does instead of on each port where it could only lie.
ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "provisionedAt" TIMESTAMP(3);

-- The port rules, stated by the database because this column is the ONLY record
-- of whether a service is public.
--
-- Each rule goes through its own IMMUTABLE function: a CHECK constraint may not
-- contain a subquery, and walking a JSON object means one. Keeping them separate
-- (rather than one big validator) is what keeps the violated constraint's NAME a
-- useful diagnostic.
--
-- Every function returns the PASSING value for a non-object input, so that
-- "ports is not an object" is reported by the single constraint that says so.
-- Postgres evaluates a row's CHECK constraints in no particular order, and
-- jsonb_each on a scalar raises a hard error rather than returning false —
-- without the guard, a scalar would surface as "cannot deconstruct a scalar"
-- instead of a named violation.
CREATE OR REPLACE FUNCTION "hexclave_deployment_ports_entries_valid"(ports jsonb) RETURNS boolean AS $fn$
  SELECT CASE WHEN jsonb_typeof(ports) <> 'object' THEN true ELSE NOT EXISTS (
    SELECT 1
    FROM jsonb_each(ports) AS entry(port_key, definition)
    -- The KEY is the port number, in its ONE canonical spelling: decimal, no
    -- leading zero. The spelling rule is load-bearing rather than cosmetic —
    -- "80" and "080" are different keys of one JSON object but the same port,
    -- so both would be stored and the runtime would declare two identical
    -- external listeners for it. Refusing the non-canonical spelling makes a
    -- duplicate port impossible by construction, which is the same reason this
    -- column is an object keyed by port and not an array.
    --
    -- Unbounded digits are matched first and the range compared as numeric: the
    -- regex alone would let a 20-digit key through, and a cast to bigint would
    -- then raise a raw Postgres error instead of the named constraint violation
    -- this design exists to produce.
    WHERE entry.port_key !~ '^[1-9][0-9]*$'
      OR entry.port_key::numeric < 1
      OR entry.port_key::numeric > 65535
      -- IS DISTINCT FROM, not <>: jsonb_typeof of an ABSENT key is NULL, and
      -- `NULL <> 'object'` is NULL rather than true, which would let an entry
      -- missing the key through the filter entirely.
      OR jsonb_typeof(entry.definition) IS DISTINCT FROM 'object'
      -- Spelled out rather than NOT IN, which yields NULL (not true) for a
      -- missing protocol and would let the entry through.
      OR (entry.definition ->> 'protocol') IS NULL
      OR (entry.definition ->> 'protocol') NOT IN ('http', 'tcp')
  ) END;
$fn$ LANGUAGE sql IMMUTABLE;

ALTER TABLE "DeploymentService"
ADD CONSTRAINT "DeploymentService_ports_is_object_check"
CHECK (jsonb_typeof("ports") = 'object');

-- Each key is a port number in range, and each value is an object with a known
-- protocol. Holds vacuously for the empty object. Publicness is NOT here — it is
-- the service's, in isPublic.
ALTER TABLE "DeploymentService"
ADD CONSTRAINT "DeploymentService_ports_entries_check"
CHECK ("hexclave_deployment_ports_entries_valid"("ports"));

-- FLY.IO PLATFORM LIMITATIONS, deliberately NOT stated as CHECK constraints:
-- a public service must be all-HTTP (raw TCP carries no SNI or Host header, so a
-- shared public IPv4 cannot tell which app a connection is for — verified
-- against real Fly), and a public service must declare at least one port.
--
-- Unlike the port-SHAPE rules above, which say what these columns may contain
-- and stay true forever, these are facts about the RUNTIME we deploy onto and
-- are expected to move: public TCP is a dedicated IPv4 per service away, which
-- is a billing decision. Encoding a platform's current shape as a database
-- invariant buys an unmigratable copy of an opinion — this branch has already
-- rewritten this rule twice ("a public port may not have siblings", then "a
-- service may not mix public and private ports"), and a constraint would have
-- made each rewrite a migration.
--
-- Enforced instead in code, on every path that reaches these columns: the sync
-- route validates against `public-service-is-all-http` and
-- `public-service-serves-something` in @hexclave/shared's deployments.ts, and the
-- CLI evaluator and Marshal's validateServiceSpec each state the same two rules
-- again. Three copies rather than one shared check, because the CLI wants a
-- config-file diagnostic and Marshal deliberately takes no dependency on
-- @hexclave/shared — the rules are cross-referenced in all three places.

-- AlterTable
ALTER TABLE "DeploymentRun" DROP COLUMN "vercelDeploymentId",
DROP COLUMN "vercelDeploymentUrl",
ADD COLUMN "marshalBuildId" TEXT,
ADD COLUMN "revision" TEXT,
ADD COLUMN "serviceUrl" TEXT;

-- Upload slots are short-lived references; clearing them lets marshalUploadId
-- be NOT NULL without a default.
DELETE FROM "DeploymentSourceUpload";

-- AlterTable
ALTER TABLE "DeploymentSourceUpload" DROP COLUMN "objectKey",
ADD COLUMN "marshalUploadId" TEXT NOT NULL;
