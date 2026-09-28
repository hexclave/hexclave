ALTER TABLE "GrowthFinding"
  ADD COLUMN "category" TEXT,
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "GrowthActionItem"
  ADD COLUMN "category" TEXT,
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "GrowthFinding"
  ADD CONSTRAINT "GrowthFinding_category_check"
  CHECK ("category" IS NULL OR "category" IN ('acquisition', 'activation', 'engagement', 'retention', 'revenue', 'content', 'ads')) NOT VALID;

ALTER TABLE "GrowthActionItem"
  ADD CONSTRAINT "GrowthActionItem_category_check"
  CHECK ("category" IS NULL OR "category" IN ('acquisition', 'activation', 'engagement', 'retention', 'revenue', 'content', 'ads')) NOT VALID;

CREATE TABLE "GrowthCategoryScore" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "score" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GrowthCategoryScore_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GrowthCategoryScore_category_check"
    CHECK ("category" IN ('acquisition', 'activation', 'engagement', 'retention', 'revenue', 'content', 'ads')),
  CONSTRAINT "GrowthCategoryScore_score_check" CHECK ("score" BETWEEN 0 AND 100)
);

CREATE UNIQUE INDEX "GrowthCategoryScore_projectId_branchId_category_key"
  ON "GrowthCategoryScore"("projectId", "branchId", "category");

CREATE INDEX "GrowthCategoryScore_projectId_branchId_updatedAt_idx"
  ON "GrowthCategoryScore"("projectId", "branchId", "updatedAt" DESC);

CREATE INDEX "GrowthActionItem_projectId_branchId_category_status_created_idx"
  ON "GrowthActionItem"("projectId", "branchId", "category", "status", "createdAt" DESC);

ALTER TABLE "GrowthCategoryScore"
  ADD CONSTRAINT "GrowthCategoryScore_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
