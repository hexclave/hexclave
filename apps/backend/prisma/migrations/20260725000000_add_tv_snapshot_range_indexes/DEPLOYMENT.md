# TV snapshot range-index deployment

This migration builds three potentially large PostgreSQL indexes concurrently.
The indexes improve TV snapshot query cost but are not required for schema or
application correctness.

This migration requires PostgreSQL 15 or newer. Deployment validation must
confirm `indpred IS NULL` (no predicate); an index with the right columns but
an added predicate is not an equivalent replacement.

## Deployment approach

Run this migration as a dedicated, single-runner deployment step before enabling
TV snapshot polling in production. Do not rely on application-startup migration
execution for production-sized tables.

The migration runner acquires a session-level advisory lock so only one runner
proceeds. `RUN_OUTSIDE_TRANSACTION_SENTINEL` statements execute on separate
connections, and each `CREATE INDEX CONCURRENTLY` uses its own per-statement
`statement_timeout`. The other migration path runs inside a `$transaction` with
an 80-second timeout. Index-build time depends on table size, active
transactions, I/O capacity, and replica load, so the default timeout cannot be
proven sufficient from the repository.

Use a deployment connection whose statement timeout accommodates the measured
build, and use a migration execution path whose outer timeout also accommodates
it. Do not globally disable timeouts for normal application-startup migrations.

## Preflight

1. Ensure exactly one migration runner will execute.
2. Confirm adequate primary and replica disk space for the three indexes, build
   workspace, and generated WAL.
3. Record table and existing-index sizes with `pg_total_relation_size` and
   `pg_relation_size`.
4. Check replica lag and current CPU and disk-I/O headroom.
5. Check for long-running transactions. They can delay concurrent-index
   validation even though ordinary reads and writes remain available.
6. Avoid overlapping schema changes, `VACUUM FULL`, `CLUSTER`, or other index
   builds on the target tables.
7. Query `pg_class`, `pg_index`, `pg_namespace`, `pg_attribute`, and `pg_am` for
   each target index name. If a name exists, confirm:
   - the expected table and schema;
   - B-tree access method;
   - key columns exactly `("tenancyId", "createdAt")` in that order;
   - no predicate and no uniqueness;
   - `indisvalid = true` and `indisready = true`.

The migration repeats these catalog checks and fails closed if a same-name
relation is invalid or has a different definition.

## Monitoring

Monitor `pg_stat_progress_create_index`, blocked sessions, CPU, disk I/O, WAL
generation, free storage, and replica lag throughout the build. PostgreSQL
permits normal reads and writes during `CREATE INDEX CONCURRENTLY`, but takes a
`ShareUpdateExclusiveLock` that conflicts with some DDL and maintenance work.

## Failed build and retry

The migration is not recorded as complete unless all three indexes are ready,
valid, and exact. If PostgreSQL leaves an invalid index:

1. Confirm the index is invalid in `pg_index`.
2. Drop only that index, outside a transaction:

   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS "<schema>"."<index_name>";
   ```

3. Re-run the migration with the dedicated single runner.
4. Do not rename or reuse an unexpected same-name relation.

Valid indexes completed before a later statement failed are retained and safely
skipped on retry after their definitions pass the preflight guard.

## Post-deployment verification

Do not consider the migration healthy, or enable TV polling, until the migration
record exists and all three catalog entries have:

- the expected schema and table;
- B-tree keys `("tenancyId", "createdAt")`;
- no predicate and no uniqueness;
- `indisvalid = true`;
- `indisready = true`.

Also confirm replica replay has caught up before relying on the indexes for
read-replica query performance.

## Rollback

Application rollback does not require dropping these additive indexes. If an
index rollback is operationally necessary, disable TV polling first and drop
each index separately with `DROP INDEX CONCURRENTLY` outside a transaction.
