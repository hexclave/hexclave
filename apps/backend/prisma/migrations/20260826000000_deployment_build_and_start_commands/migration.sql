-- Build and start commands on a deployment service. Both columns are additive
-- and nullable, and NULL means exactly what every existing row already does:
-- the base decides the build (Railpack auto-detection, the author's Dockerfile,
-- or a prebuilt image), and the image decides what starts. So there is nothing
-- to backfill and no row changes meaning.

-- A single command line, run through `sh -c` while the image is BUILT.
--
-- What it builds on is the rest of the row: `image` if one is named, else
-- `dockerfilePath`'s Dockerfile (where the command becomes a final appended
-- RUN), else the Hexclave base image — which is what makes a build command with
-- neither of those REPLACE Railpack auto-detection.
--
-- Setting it alongside `image` is also what turns that image from the thing to
-- run into the thing to build on, which is why `image` no longer implies "this
-- service is not built from the upload".
ALTER TABLE "DeploymentService" ADD COLUMN "buildCommand" TEXT;

-- A single command line, run through `sh -c` as the container's process instead
-- of whatever the image would have started.
--
-- Applied by the runtime when the machine starts, never baked into an image, so
-- it never causes a build: a service that only runs an already-built image can
-- carry one and still deploy in seconds.
--
-- Left unconstrained here, like `image` above: the rules (a single non-empty
-- line with no control characters, and required when a build command has no base
-- to inherit a command from) are enforced in code so that one place phrases them
-- and one error text reaches the author.
ALTER TABLE "DeploymentService" ADD COLUMN "startCommand" TEXT;
