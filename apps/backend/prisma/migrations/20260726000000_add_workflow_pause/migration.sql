-- Pause state for workflow definitions. Nullable with no default, so every
-- existing workflow starts unpaused.
-- AlterTable
ALTER TABLE "WorkflowDefinition" ADD COLUMN     "pausedAt" TIMESTAMP(3);
