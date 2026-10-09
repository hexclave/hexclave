# SQLite / Breezylite proof of concept

Breezylite uses Node's built-in SQLite driver under Breezy's shared codec, heap planner/cache, publication and garbage collector. The service keeps its existing backend by default. No SQLite npm dependency is needed.

## Try the service

Use Node >=22.13 (tested on 24.21.0) and the normal Bulldozer environment/dependencies. From the repository root:

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
