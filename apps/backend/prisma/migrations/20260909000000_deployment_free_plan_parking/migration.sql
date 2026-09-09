-- The Free plan's 24-hour deployment limit.
--
-- Three columns on DeploymentService and two switches on the platform config.
-- Nothing is backfilled, but the limit IS enforced from the moment this ships:
-- `freePlanParkingEnabled` defaults to TRUE, so an instance that has never been
-- configured enforces the Free plan's window. Every Free-plan project whose
-- services last deployed more than 24 hours ago is parked by the first sweep
-- after deployment. An operator can pause it from the Deploy Admin page.
--
-- `runningSince` is null on every existing row. The sweeper falls back to
-- `provisionedAt` when it is (see parkExpiredFreePlanServices), so services
-- deployed before this migration are measured from when they were first
-- provisioned rather than being either exempt forever or parked on the next tick.
--
-- No index is added. The candidate query filters on `provisionedAt IS NOT NULL
-- AND "parkedAt" IS NULL` across every tenancy, but the whole table is bounded by
-- HEXCLAVE_MAX_DEPLOYED_SERVICES (1000 by default) and the sweeper runs every ten
-- minutes, so a sequential scan over it costs less than maintaining an index for
-- it would.
ALTER TABLE "DeploymentService"
    ADD COLUMN "runningSince" TIMESTAMP(3),
    ADD COLUMN "parkedAt" TIMESTAMP(3),
    ADD COLUMN "parkedReason" TEXT;

ALTER TABLE "DeploymentsPlatformConfig"
    ADD COLUMN "freePlanParkingEnabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "freePlanParkAfterHours" INTEGER NOT NULL DEFAULT 24;
