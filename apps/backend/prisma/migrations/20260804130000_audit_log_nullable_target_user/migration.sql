-- Project-scoped audit events (e.g. settings changes) have no target user.
ALTER TABLE "AuditLogEvent" ALTER COLUMN "targetUserId" DROP NOT NULL;
