ALTER TABLE "GrowthActionItem"
  ADD COLUMN "documentDraftSourceJson" JSONB,
  ADD COLUMN "documentDraft" JSONB,
  ADD COLUMN "documentDraftUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "documentPublishedAt" TIMESTAMP(3),
  ADD COLUMN "documentPublishedByUserId" TEXT;

ALTER TABLE "GrowthActionItem"
  ADD CONSTRAINT "GrowthActionItem_document_draft_pair_check"
  CHECK (
    ("documentDraftSourceJson" IS NULL AND "documentDraft" IS NULL AND "documentDraftUpdatedAt" IS NULL)
    OR
    ("documentDraftSourceJson" IS NOT NULL AND "documentDraft" IS NOT NULL AND "documentDraftUpdatedAt" IS NOT NULL)
  ) NOT VALID;
