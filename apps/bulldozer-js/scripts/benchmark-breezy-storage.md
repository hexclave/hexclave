# SQLite / Breezylite proof of concept

Breezylite uses Node's built-in SQLite driver under Breezy's shared codec, heap planner/cache, publication and garbage collector. The service keeps its existing backend by default. No SQLite npm dependency is needed.

## Try the service

Use Node >=22.15 for the built-in SQLite and Zstd APIs (the repository requires Node >=24) and the normal Bulldozer environment/dependencies. From the repository root:

```sh
HEXCLAVE_BULLDOZER_JS_PILEDRIVER_IMPLEMENTATION=breezylite \
HEXCLAVE_BULLDOZER_JS_SQLITE_PATH=/absolute/path/to/separate-poc-directory \
pnpm -C apps/bulldozer-js start
```

The SQLite path is a required directory containing `breezy.sqlite` and its WAL files. Directories containing `data.mdb` or `lock.mdb` are rejected. This does not migrate LMDB data; use disposable development data. Removing the implementation override restores the default backend.

Existing heap-cache and buffered-Piledriver settings apply. Service buffering remains enabled by default; the benchmark disables it equally for both engines. LMDB compression and read-miss simulation settings do not apply to SQLite. The service loads SQLite only when selected.

## Tests and benchmarks

From `apps/bulldozer-js` after installing workspace dependencies:

```sh
node ../../node_modules/vitest/vitest.mjs run --config vitest.storage.config.ts \
  src/create-piledriver.test.ts src/databases/piledriver/implementations/breezy src/databases/piledriver/implementations/breezy-lmdb
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.storage.json
node scripts/benchmark-breezy-storage.mjs
```

The test config resolves shared source without SDK builds. The focused typecheck uses ES2022 plus ES2023 array APIs; the default ESNext library exposes an existing WeakKey/IterableWeakMap incompatibility in shared utilities.

The runner compares BreezyLMDB and Breezylite/SQLite using separate processes and fresh databases, rotating order across three repetitions. Results and logs go to `storage-benchmark.untracked`. Override `HEXCLAVE_BREEZY_BENCH_REPETITIONS` or `HEXCLAVE_BREEZY_BENCH_OUTPUT` as needed.

Repeated workloads: payments with 200 prefill users / 1,200 source facts and bursts of 10 concurrent requests; Bulldozer stored-table and group/map/group workloads with 20 warmup and 80 measured operations. Writes wait for durable completion. Heap caching is enabled, compression and the buffered wrapper are off.

Run both complete performance files, including listing/scaling assertions:

```sh
STACK_BULLDOZER_PILEDRIVER_IMPLEMENTATION=breezylite \
BULLDOZER_PERF_BACKEND=sqlite \
BULLDOZER_PAYMENTS_PERF_BACKEND=sqlite \
BULLDOZER_PERF_SNAPSHOT_MODE=consistent \
node ../../node_modules/vitest/vitest.mjs run --config vitest.storage.config.ts \
  src/databases/bulldozer/performance.test.ts src/payments/schema/performance.test.ts
```

For the LMDB comparison use `breezy-lmdb` / `lmdb`. Service and benchmark settings are separate.

## Measurements and limitations

October 8, 2026 sandbox measurements, three repetitions, Node 24.21.0 / Linux / 8 logical Xeon CPUs. Median operations/second:

| Workload | BreezyLMDB | Breezylite (SQLite) |
|---|---:|---:|
| Payments writes, combined six phases | 50.5 | 38.4 |
| Bulldozer stored table | 786.1 | 882.3 |
| Bulldozer group/map/group | 414.5 | 467.5 |

Payments aggregates 792 writes, excluding prefill and reads. SQLite was about 24% slower on payments; the smaller Bulldozer workloads are noisier. These compare Breezy implementations, not the service's default base-Piledriver backend.

SQLite uses WAL with `synchronous=FULL`; data and its monotonic sequence commit together, and rollback spans all logical stores. LMDB retains its async transaction/flush behavior. Both wait for durability, but fsync schedules differ: SQLite also synchronizes intermediate heap transactions. These are measurements of Node adapters, not isolated C engines.

The suite records an expected LMDB failure: throwing after issuing writes in its current async `transaction()` callback can leave them committed. SQLite passes that rollback test. The baseline behavior is unchanged.

This PoC includes no data migration, production rollout, power-loss certification, multi-process load test, or large-store/cold-cache qualification. Inherited Breezy integrity-audit limitations remain: the base-Piledriver serialization-audit hooks are not implemented here. SQLite calls are synchronous and can block the event loop; Node's SQLite API is experimental in the tested runtime.

## Database file size

Run `node scripts/benchmark-breezy-size.mjs` from `apps/bulldozer-js`. This repeats the comparable payments workload three times for BreezyLMDB and Breezylite with compression off/on, rotating execution order. Each run uses a fresh database, 1,200 prefill source facts and 792 measured writes, with buffering disabled. All variants run the same workload assertions.

The benchmark records every database file's logical length and filesystem-allocated bytes immediately before and after close. Open SQLite totals include its WAL and shared-memory files; clean close checkpoints and removes those files. These are end-of-workload measurements, not peak usage or compacted live-data sizes: no VACUUM, compact-copy or additional GC pass is performed. LMDB's preallocated extents can make allocated disk space larger than file length while open.

Results and raw logs are written to `storage-size-benchmark.untracked`; use `HEXCLAVE_BREEZY_BENCH_REPETITIONS` and `HEXCLAVE_BREEZY_BENCH_OUTPUT` to override the repetition count and destination. The runner now includes compression on/off for both backends and captures payments timing metrics alongside file sizes. The table below records the earlier uncompressed-SQLite comparison.

October 9, 2026 sandbox results (Node 24.21.0), median of three runs; MiB = 1,048,576 bytes:

| Backend | Closed DB file | Open total file lengths | Open allocated disk space |
|---|---:|---:|---:|
| BreezyLMDB, no compression | 423.73 MiB | 423.74 MiB | 512.50 MiB |
| BreezyLMDB, compression | 180.32 MiB | 180.32 MiB | 256.50 MiB |
| Breezylite, no compression | 427.85 MiB | 433.79 MiB | 435.87 MiB |

Compression reduced BreezyLMDB’s database file by about 57%. Uncompressed Breezylite was about 1% larger than uncompressed BreezyLMDB. The closed LMDB lock file adds 8,272 logical bytes (4,096 allocated bytes); closed data-file allocation matched file length for both engines. All nine workload runs passed.

## Releasing free pages (shrinking the file)

Deleting data never shrinks a SQLite file: GC empties pages, and SQLite keeps them as *free pages* inside the file for reuse. Breezylite creates every new file with `auto_vacuum=INCREMENTAL`, so those pages can be given back to the operating system in small steps. A full `VACUUM` rewrites the whole file, needs up to twice its size in free disk and blocks writers for the whole run. SQLite only accepts `auto_vacuum` before the first table exists, so files created before this change report `canRelease: false` and must be recreated to use it.

Operator workflow, against the running service:

```sh
pnpm -C apps/bulldozer-js gc:piledriver <cutoff epoch ms>       # GC first, usually a few times, until no eligible work remains
pnpm -C apps/bulldozer-js release-free-pages:piledriver --dry-run
pnpm -C apps/bulldozer-js release-free-pages:piledriver --all   # or --max-mib N for one bounded step
```

The command calls `POST /internal/piledriver-release-free-pages` (`{ maxBytes?, dryRun? }`, default 1 GiB per request). The release runs inside the service as a series of short SQLite writes on its only connection. It yields to queued requests between them, so it never competes with Bulldozer for SQLite's write lock. Never run `VACUUM` or `incremental_vacuum` from a separate `sqlite3` process: with `busy_timeout=0`, every Bulldozer write fails while that process holds the lock. A second concurrent release, or a file without auto_vacuum, gets a 409. `GET /diagnostics` reports `freePages` (`pageSizeBytes`, `totalPages`, `freePages`, `canRelease`). These are read from SQLite's file header, so the cost doesn't grow with file size (about 3 µs).

Disk: releasing needs no space beyond the WAL, which `journal_size_limit` keeps at or below 64 MiB after checkpoints. The WAL size is in `/diagnostics` and in the 5-second activity log, and it keeps growing if checkpoints are starved. Both Breezy callers of `getRange` read their rows within a single synchronous loop, so no read stays open across an `await` to block checkpoints.

Chunk size: each chunk targets 5 ms of event-loop time. The first chunk releases 16 pages to measure the cost per page, and later chunks are sized from that, up to 4,096 pages. A fixed page count can't work, because the cost per page grows with the file. SQLite searches its free-page list for a slot for every live page it moves out of the file's tail. A native profile showed that search (`allocateBtreePage`) dominating, at about 7 µs per page on 50 MiB and about 55 µs on 5 GiB. Neither fsync nor `mmap` changed it. A 64 MiB `cache_size` halved it in a standalone test (134 → 63 ms per 1,000 pages at 5 GiB). It isn't enabled, because earlier tuning showed no win for normal traffic and about 63 MiB more memory. Release is rarely run and yields to requests, so a slower release is acceptable.

### Load test (October 28, 2026)

A local load test (not committed) filled a fresh database with incompressible 4 KB rows and deleted a random fraction of them, so free pages were scattered the way GC leaves them. It then released every free page while N writers and N readers ran through the buffered wrapper, and finally read back every written value. Medians of 3 runs on an Apple Silicon Mac (48 GB RAM, APFS), Node 24.11; "chunk time / 1k pages" counts only time inside release chunks:

| DB | freed | writers | pages released | release time | chunk time / 1k pages | slowest chunk | event-loop max, before → during | failed writes + mismatches |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 GiB | 10% | 0 | 26,929 | 0.5 s | 18 ms | 33 ms (max 72) | 0 → 33 ms | 0 |
| 1 GiB | 10% | 16 | 26,909 | 0.6 s | 18 ms | 24 ms (max 28) | 75 → 31 ms | 0 |
| 1 GiB | 10% | 64 | 26,845 | 0.9 s | 18 ms | 27 ms (max 30) | 34 → 37 ms | 0 |
| 1 GiB | 50% | 0 | 144,926 | 1.7 s | 12 ms | 21 ms (max 21) | 0 → 14 ms | 0 |
| 1 GiB | 50% | 16 | 144,908 | 2.4 s | 12 ms | 12 ms (max 13) | 26 → 16 ms | 0 |
| 1 GiB | 50% | 64 | 144,845 | 4.6 s | 12 ms | 12 ms (max 13) | 30 → 28 ms | 0 |
| 5 GiB | 10% | 0 | 134,650 | 7.4 s | 54 ms | 28 ms (max 33) | 0 → 28 ms | 0 |
| 5 GiB | 10% | 16 | 134,630 | 10.3 s | 52 ms | 50 ms (max 75) | 20 → 52 ms | 0 |
| 5 GiB | 10% | 64 | 134,565 | 41.8 s | 125 ms | 132 ms (max 899) | 34 → 140 ms | 0 |
| 5 GiB | 50% | 0 | 726,447 | 40.3 s | 55 ms | 23 ms (max 31) | 0 → 23 ms | 0 |
| 5 GiB | 50% | 16 | 726,430 | 64.5 s | 56 ms | 39 ms (max 617) | 18 → 43 ms | 0 |
| 5 GiB | 50% | 64 | 726,367 | 346.1 s | 149 ms | 695 ms (max 3,429) | 33 → 1,302 ms | 0 |

Every run ended with 0 free pages, and the main file shrank by the freed bytes (ratio 1.001). No write failed and every value read back. Up to 16 writers, a release barely affects the event loop.

**Open issue:** at 5 GiB with 64 concurrent writers, about 1% of chunks block for 0.4–3.4 s even though they are small (26–186 pages, after normal ~5 ms chunks). Ruled out:
- chunk growth (no chunk exceeded 656 pages);
- V8 GC (no pause over 41 ms, and none overlapped the slowest chunks);
- SQLite's automatic checkpoint and plain interleaved writes (a standalone `node:sqlite` reproduction with 40-page chunks between 64 writes stayed at or below 11 ms).

The cause is inside SQLite, but only under this in-process write pattern. Until it's understood, run large releases during low write traffic. Not yet measured: files larger than 5 GiB, cold OS cache, and GCP persistent-disk fsync.

## Breezylite compression

Breezylite compresses new SQLite values by default; the service has no compression flag. The adapter accepts `compression: false` for controlled benchmarks. Compression uses Node Zstd at level 1, attempts values of at least 256 bytes and keeps the original bytes when compression is not smaller. Keys remain uncompressed and retain their ordering. Compression and decompression are synchronous.

Each row has a codec column (0 = raw, 2 = Zstd). The reader handles both codecs regardless of the write setting, so disabling compression remains safe. Unknown codecs and corrupt compressed payloads fail reads. Stores use persistent integer IDs from a separate name dictionary, and existence queries use SELECT 1 without fetching value bytes. SQLite `user_version=1` identifies the Zstd format. Breezylite is undeployed: older PoC files, including integer-ID DEFLATE databases, are rejected before changes and require a fresh directory instead of a migration. DEFLATE codec 1 is not supported. Older PoC binaries do not understand Zstd values; use the matching binary and database. No LMDB-to-SQLite migration is provided.

Run `node scripts/benchmark-breezy-size.mjs` for three repetitions of size and payments throughput for all four variants. For complete performance suites with compressed SQLite, add `HEXCLAVE_BREEZY_BENCH_COMPRESSION=1` to the performance command above.

### Compression measurements (October 9, 2026)

Historical DEFLATE comparison, before integer IDs and the switch to Zstd: fresh four-variant comparison, three repetitions each, Node 24.21.0; same 1,200 prefill facts and 792 measured payments writes, durable completion, buffering off. Medians:

| Backend | Compression | Closed DB | Open files including WAL | Payments writes |
|---|---|---:|---:|---:|
| breezy-lmdb | off | 423.73 MiB | 423.74 MiB | 51.87 ops/s |
| breezy-lmdb | on | 180.22 MiB | 180.23 MiB | 49.73 ops/s |
| breezylite | off | 429.29 MiB | 434.82 MiB | 40.88 ops/s |
| breezylite | on | 144.54 MiB | 150.23 MiB | 38.52 ops/s |

Breezylite compression reduced median database size by 66% and median payments throughput by about 6%. SQLite size varied from 144.21–147.64 MiB with compression; uncompressed was 429.29 MiB in all runs. Compressed throughput ranged 37.38–38.84 ops/s versus 38.81–41.32 uncompressed. These are small sandbox samples, not production tail-latency measurements. The new codec column slightly increases uncompressed SQLite size versus the earlier 427.85 MiB format.

LMDB uses lmdb-js native LZ4 (including its defaults); SQLite uses synchronous DEFLATE level 1. This compares adapter configurations, not equal compression algorithms. All twelve benchmark workloads passed. File sizes are after the workload without compaction or an additional garbage-collection pass.
