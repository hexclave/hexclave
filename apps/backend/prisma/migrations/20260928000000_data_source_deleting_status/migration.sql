-- A deleted source is marked first and removed once no sync holds its lease, so
-- replication-slot cleanup can never race a sync that is still using the slot.
ALTER TYPE "DataSourceStatus" ADD VALUE 'DELETING';
