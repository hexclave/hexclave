-- Author-configurable compute.
--
-- Both columns are nullable with no default and no backfill, deliberately: null
-- means "the size this thing already ran at", so every existing service keeps
-- its machine and every existing source keeps its builder. A default here would
-- write a value that then hashes into service revisions and re-rolls the fleet
-- on the next deploy for no change the author asked for.
--
-- Megabytes rather than the "4GB" token the deploy file writes. The token is an
-- authoring spelling; the number is what the runtime picks a machine shape with,
-- and a value that matches no shape reads back as unset rather than as a size we
-- claim to be running.
--
-- No CHECK constraint on the allowed sizes: the ladder is an entitlement that
-- moves with pricing (and differs per service type), which makes it application
-- policy rather than a fact about what this column may hold. Same reasoning as
-- the public/all-HTTP rule on DeploymentService.
ALTER TABLE "DeploymentService" ADD COLUMN "memoryMb" INTEGER;
ALTER TABLE "DeploymentSource" ADD COLUMN "builderMemoryMb" INTEGER;
