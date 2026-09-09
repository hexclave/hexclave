-- The Free plan's 24-hour deployment limit.
--
-- Three columns on DeploymentService and two switches on the platform config.
-- `freePlanParkingEnabled` defaults to TRUE, so the limit is enforced from the
-- moment this ships without anyone configuring it. An operator can pause it from
-- the Deploy Admin page.
--
-- NOTHING IS BACKFILLED, and that is what grandfathers every existing deployment.
-- `runningSince` is null on every existing row, and the sweeper reads a null
-- there as "no window" rather than "unknown" (see windowStartedAt), so services
-- deployed before this migration keep running untouched. The first redeploy of
-- one writes `runningSince` and opts it into the limit — by which point its
-- author has seen the deploy-time notice explaining it.
--
-- So this migration stops nothing on the deploy that carries it. The limit
-- reaches a project the first time it deploys after it.
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
