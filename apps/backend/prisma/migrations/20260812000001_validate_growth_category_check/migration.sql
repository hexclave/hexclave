-- Validates the widened category constraints added NOT VALID by 20260812000000. Split into its own
-- file so the full-table scan runs in its own short transaction instead of extending the one that
-- swapped the constraints; see that migration's header for why the swap could not validate inline.
ALTER TABLE "GrowthFinding" VALIDATE CONSTRAINT "GrowthFinding_category_check";
ALTER TABLE "GrowthActionItem" VALIDATE CONSTRAINT "GrowthActionItem_category_check";
ALTER TABLE "GrowthCategoryScore" VALIDATE CONSTRAINT "GrowthCategoryScore_category_check";
