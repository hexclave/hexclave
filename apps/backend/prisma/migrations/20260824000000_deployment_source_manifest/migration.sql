-- What a deploy packaged: a listing of paths and sizes, never file contents.
-- The uploaded tarball is consumed by the build and deleted, so this is the only
-- record of what went into it.
--
-- Nullable with no backfill and no default: NULL means "not recorded" — an
-- all-prebuilt deploy that packaged nothing, or a row written before this
-- existed. An empty object would claim a deploy packaged zero files, which is a
-- different and false statement.
ALTER TABLE "Deployment" ADD COLUMN "sourceManifest" JSONB;
