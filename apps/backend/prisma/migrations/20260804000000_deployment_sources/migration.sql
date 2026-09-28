/*
  Deployments become project → DEPLOYMENT SOURCES → deployments → services.

  A deployment source is one deploy file (hexclave.deploy.ts, named by its own
  `id` export), and what one `hexclave deploy` ships: one upload, one build. It
  is what lets a project be deployed from several repositories, each owning the
  services it declares. Service ids stay unique per PROJECT, so a reference
  never has to name a source.

  Three things follow from that and are all in here:

    1. DeploymentSource, and DeploymentService owned by one.
    2. Volumes and domains move OFF the service row, because the resources they
       describe outlive it. A disk belongs to the deployment source and is merely
       mounted by a service; a hostname belongs to the project and is merely
       pointed at one. Dropping a service from a deploy file tears the service
       down and leaves both behind, unattached.
    3. DeploymentRun is gone. The build is per DEPLOYMENT now (one builder
       machine builds every service of the source), so the deployment owns the
       build, its log, and the per-service outcomes.

  Data: the pre-existing rows are Vercel-era services for an alpha-gated app
  whose definitions were already invalidated by
  20260803000000_marshal_container_deployments (they carry `ports = '[]'`, which
  no deploy accepts). They are moved into a source named after the config file
  rather than deleted — the rows are what the dashboard lists, and a re-sync
  makes them deployable again. Their DOMAIN rows are dropped: a domain now names
  the port it fronts, and those services have no ports to name.
*/

-- ============================ 1. deployment sources ============================
CREATE TABLE "DeploymentSource" (
    "tenancyId" UUID NOT NULL,
    -- No database default: ids are generated client-side by Prisma
    -- (`@default(uuid())`), like the rest of the schema. A database default here
    -- is drift that `prisma migrate diff` fails on.
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    -- The deploy file's own `id` export.
    "sourceId" TEXT NOT NULL,

    CONSTRAINT "DeploymentSource_pkey" PRIMARY KEY ("tenancyId","id")
);

CREATE UNIQUE INDEX "DeploymentSource_tenancyId_sourceId_key" ON "DeploymentSource"("tenancyId", "sourceId");

ALTER TABLE "DeploymentSource" ADD CONSTRAINT "DeploymentSource_tenancyId_fkey"
FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Mirrors DEPLOYMENT_SOURCE_ID_REGEX / MAX_DEPLOYMENT_SOURCE_ID_LENGTH in
-- @hexclave/shared/dist/deployments. Dots are allowed because deployments
-- declared in hexclave.config.ts belong to a source named after that file.
ALTER TABLE "DeploymentSource"
ADD CONSTRAINT "DeploymentSource_sourceId_format_check"
CHECK ("sourceId" ~ '^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,62}$');

-- ============================ 2. services ============================
-- Every existing service joins a source named after the config file, one per
-- tenancy that has any: those definitions predate deploy files, so the config
-- file is where they came from. gen_random_uuid() is fine for a backfill —
-- nothing reads these ids back through Prisma's client-side generator.
-- The DISTINCT is in a subquery, and gen_random_uuid() is applied to its OUTPUT. Selecting
-- them together would not deduplicate anything: the uuid is volatile and evaluated per input
-- row, so every row would be distinct from every other and a tenancy with two services would
-- insert two sources — violating the unique index above.
INSERT INTO "DeploymentSource" ("tenancyId", "id", "createdAt", "updatedAt", "sourceId")
SELECT tenancies."tenancyId", gen_random_uuid(), NOW(), NOW(), 'hexclave.config.ts'
FROM (SELECT DISTINCT "tenancyId" FROM "DeploymentService") AS tenancies;

ALTER TABLE "DeploymentService" ADD COLUMN "sourceRowId" UUID;

UPDATE "DeploymentService" AS s
SET "sourceRowId" = c."id"
FROM "DeploymentSource" AS c
WHERE c."tenancyId" = s."tenancyId" AND c."sourceId" = 'hexclave.config.ts';

ALTER TABLE "DeploymentService" ALTER COLUMN "sourceRowId" SET NOT NULL;

ALTER TABLE "DeploymentService" ADD CONSTRAINT "DeploymentService_tenancyId_sourceRowId_fkey"
FOREIGN KEY ("tenancyId", "sourceRowId") REFERENCES "DeploymentSource"("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Service ids stay unique per PROJECT (the existing index already says so), so
-- that a reference never has to name a deployment source. Two sources declaring
-- the same id is a conflict, refused at sync with a message naming the owner.
-- The source is an ownership column rather than part of the key.
CREATE INDEX "DeploymentService_tenancyId_sourceRowId_idx"
ON "DeploymentService"("tenancyId", "sourceRowId");

-- The type distinction ("server" suspends and may mount a disk; "serverless"
-- scales out and may not) that the config shape introduced. The DEFAULT exists
-- only so the NOT NULL column can be added to a table that already has rows;
-- every writer sets it explicitly.
ALTER TABLE "DeploymentService" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'serverless';

ALTER TABLE "DeploymentService"
ADD CONSTRAINT "DeploymentService_type_check"
CHECK ("type" IN ('server', 'serverless'));

-- ============================ 3. volumes ============================
-- Owned by the deployment source, mounted by a service. Keeping the disk on the service
-- row made "the service was removed from the deploy file" and "the disk is
-- gone" the same event; they are not, and the second one is not reversible.
CREATE TABLE "DeploymentVolume" (
    "tenancyId" UUID NOT NULL,
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sourceRowId" UUID NOT NULL,
    "volumeId" TEXT NOT NULL,
    "sizeGb" INTEGER NOT NULL,
    -- The service currently mounting it, and where. Both null = unattached.
    "serviceId" TEXT,
    "path" TEXT,

    CONSTRAINT "DeploymentVolume_pkey" PRIMARY KEY ("tenancyId","id")
);

ALTER TABLE "DeploymentVolume" ADD CONSTRAINT "DeploymentVolume_tenancyId_fkey"
FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DeploymentVolume" ADD CONSTRAINT "DeploymentVolume_tenancyId_sourceRowId_fkey"
FOREIGN KEY ("tenancyId", "sourceRowId") REFERENCES "DeploymentSource"("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The id names one disk within its deployment source.
CREATE UNIQUE INDEX "DeploymentVolume_tenancyId_sourceRowId_volumeId_key"
ON "DeploymentVolume"("tenancyId", "sourceRowId", "volumeId");

-- One disk per service: a Fly machine mounts at most one volume, and two rows
-- claiming one service would make which disk it gets a race. Project-wide
-- rather than per source, because service ids are.
CREATE UNIQUE INDEX "DeploymentVolume_tenancyId_serviceId_key"
ON "DeploymentVolume"("tenancyId", "serviceId");

-- Mirrors DEPLOYMENT_VOLUME_ID_REGEX / MAX_VOLUME_ID_LENGTH in
-- @hexclave/shared/dist/deployments. The id becomes a Fly volume name, so an id
-- Fly would reject must fail here rather than at apply time.
ALTER TABLE "DeploymentVolume"
ADD CONSTRAINT "DeploymentVolume_volumeId_format_check"
CHECK ("volumeId" ~ '^[a-z][a-z0-9_]{0,25}$');

-- Mirrors MIN/MAX_VOLUME_SIZE_GB. The API validates this too; the constraint is
-- the backstop against a hand-edited row reaching Marshal with a size Fly rejects.
ALTER TABLE "DeploymentVolume"
ADD CONSTRAINT "DeploymentVolume_sizeGb_range_check"
CHECK ("sizeGb" >= 1 AND "sizeGb" <= 500);

-- The attachment is a PAIR. A half-written row would be read as unattached
-- (which is a real state now), silently detaching a live disk instead of failing.
ALTER TABLE "DeploymentVolume"
ADD CONSTRAINT "DeploymentVolume_attachment_pair_check"
CHECK (("serviceId" IS NULL) = ("path" IS NULL));

-- ============================ 4. domains ============================
-- Project-scoped, pointing at (service, port). The old table's rows
-- cannot be carried over: a domain now names the port it fronts, and every
-- pre-existing service has an empty port list (see the header).
DROP TABLE "DeploymentServiceDomain";

CREATE TABLE "DeploymentDomain" (
    "tenancyId" UUID NOT NULL,
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hostname" TEXT NOT NULL,
    -- Both null = unattached, which is what a domain becomes when the service
    -- it pointed at stops being declared. The certificate is kept rather than
    -- silently released.
    --
    -- No foreign key to DeploymentService on purpose: a domain OUTLIVES the
    -- service it points at, which is the whole reason it is a table of its own.
    "serviceId" TEXT,
    "port" INTEGER,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DeploymentDomain_pkey" PRIMARY KEY ("tenancyId","id")
);

ALTER TABLE "DeploymentDomain" ADD CONSTRAINT "DeploymentDomain_tenancyId_fkey"
FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One hostname per tenancy: the runtime holds exactly one claim per hostname,
-- so two rows for one hostname would leave the loser advertising a verified URL
-- that routes to the winner.
CREATE UNIQUE INDEX "DeploymentDomain_tenancyId_hostname_key" ON "DeploymentDomain"("tenancyId", "hostname");

CREATE INDEX "DeploymentDomain_tenancyId_serviceId_idx" ON "DeploymentDomain"("tenancyId", "serviceId");

-- The target columns are a PAIR: attached names both, unattached names neither.
-- A half-written row would route a certificate at nothing.
ALTER TABLE "DeploymentDomain"
ADD CONSTRAINT "DeploymentDomain_target_tuple_check"
CHECK (("serviceId" IS NULL) = ("port" IS NULL));

ALTER TABLE "DeploymentDomain"
ADD CONSTRAINT "DeploymentDomain_port_range_check"
CHECK ("port" IS NULL OR ("port" >= 1 AND "port" <= 65535));

-- ============================ 5. deployments ============================
-- One row per `hexclave deploy`, owning the build and the per-service outcomes.
-- DeploymentRun is dropped rather than reshaped: with one build per deployment source it
-- would hold nothing a row of the outcome JSON does not.
DROP TABLE "DeploymentRun";
DROP TYPE "DeploymentRunStatus";

CREATE TYPE "DeploymentStatus" AS ENUM ('QUEUED', 'BUILDING', 'DEPLOYING', 'SUCCEEDED', 'FAILED', 'CANCELED');

CREATE TABLE "Deployment" (
    "tenancyId" UUID NOT NULL,
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sourceRowId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    -- ONE build per deployment: the deployment source's whole source is uploaded once and
    -- every service's image is built by one builder machine.
    "marshalBuildId" TEXT,
    "plannedServiceIds" JSONB NOT NULL DEFAULT '[]',
    -- What each service did in THIS deploy, keyed by service id.
    "services" JSONB NOT NULL DEFAULT '{}',
    -- KMS-encrypted snapshot of the values injected into this deploy, so build
    -- logs fetched later stay redacted after a secret is rotated or deleted.
    "redactionSecretsEncrypted" JSONB,
    "finishedAt" TIMESTAMP(3),
    -- Set when the client owning the deploy reports it has stopped. Without it,
    -- a client that dies before reporting anything leaves a deployment that
    -- reads as in-flight forever and a dashboard that polls it for eternity.
    "concludedAt" TIMESTAMP(3),

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("tenancyId","id")
);

ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_tenancyId_fkey"
FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_tenancyId_sourceRowId_fkey"
FOREIGN KEY ("tenancyId", "sourceRowId") REFERENCES "DeploymentSource"("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The user-facing "#47". Unique per tenancy so two concurrent deploys cannot
-- land on the same number — the loser's transaction fails and retries rather
-- than producing two deployments that print identically. Per TENANCY rather
-- than per source: the dashboard lists every deployment source's deploys together,
-- and a number that repeated across sources would be ambiguous there.
CREATE UNIQUE INDEX "Deployment_tenancyId_number_key" ON "Deployment"("tenancyId", "number");

CREATE INDEX "Deployment_tenancyId_createdAt_idx" ON "Deployment"("tenancyId", "createdAt" DESC);
CREATE INDEX "Deployment_tenancyId_sourceRowId_createdAt_idx" ON "Deployment"("tenancyId", "sourceRowId", "createdAt" DESC);
