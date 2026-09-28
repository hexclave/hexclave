-- Widens the growth category CHECK constraints to the five-stage growth journey.

ALTER TABLE "GrowthFinding" DROP CONSTRAINT "GrowthFinding_category_check";
ALTER TABLE "GrowthFinding"
  ADD CONSTRAINT "GrowthFinding_category_check"
  CHECK ("category" IS NULL OR "category" IN (
    'product', 'reach', 'conversion', 'retention', 'revenue',
    'acquisition', 'activation', 'engagement', 'content', 'ads'
  )) NOT VALID;

ALTER TABLE "GrowthActionItem" DROP CONSTRAINT "GrowthActionItem_category_check";
ALTER TABLE "GrowthActionItem"
  ADD CONSTRAINT "GrowthActionItem_category_check"
  CHECK ("category" IS NULL OR "category" IN (
    'product', 'reach', 'conversion', 'retention', 'revenue',
    'acquisition', 'activation', 'engagement', 'content', 'ads'
  )) NOT VALID;

-- Unlike the two above, this column is NOT NULL (a score row without a stage is meaningless), so
-- the predicate has no IS NULL branch.
ALTER TABLE "GrowthCategoryScore" DROP CONSTRAINT "GrowthCategoryScore_category_check";
ALTER TABLE "GrowthCategoryScore"
  ADD CONSTRAINT "GrowthCategoryScore_category_check"
  CHECK ("category" IN (
    'product', 'reach', 'conversion', 'retention', 'revenue',
    'acquisition', 'activation', 'engagement', 'content', 'ads'
  )) NOT VALID;
