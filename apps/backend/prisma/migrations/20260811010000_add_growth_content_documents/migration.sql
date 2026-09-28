-- Nullable JSON columns with no defaults are metadata-only additions in PostgreSQL. Existing rows
-- intentionally stay NULL and continue through the legacy Markdown/plain-text render path.
ALTER TABLE "GrowthFinding" ADD COLUMN "document" JSONB;
ALTER TABLE "GrowthReport" ADD COLUMN "document" JSONB;
ALTER TABLE "GrowthActionItem" ADD COLUMN "document" JSONB;
ALTER TABLE "GrowthBrief" ADD COLUMN "document" JSONB;
