-- Prebuilt images: a service may run an already-built image instead of building
-- one from the deployment source's upload. Both columns are additive and
-- nullable-or-defaulted, so every existing row keeps its current meaning.

-- A service either builds from the upload (rootDirectory / dockerfilePath) or
-- runs an already-built image named here. Nullable because every existing row is
-- a source build, which is also why there is no backfill: NULL is exactly "built
-- from source".
--
-- Left unconstrained on purpose. The exclusivity with rootDirectory /
-- dockerfilePath, and the requirement that the reference carry an explicit tag
-- or digest, are enforced in code with the rest of the definition rules (see
-- deploymentServiceDefinitionSchema) so that one place phrases them and one
-- error text reaches the author — the same choice made for isPublic's rules.
ALTER TABLE "DeploymentService" ADD COLUMN "image" TEXT;

-- Whether a deployment produced a build log. A deployment whose every service
-- runs an already-built image starts no builder machine, so it has none.
--
-- Defaults true: every existing row predates prebuilt images and is therefore a
-- source build, which is what true says. No backfill needed for the same reason.
ALTER TABLE "Deployment" ADD COLUMN "hasBuildLogs" BOOLEAN NOT NULL DEFAULT true;
