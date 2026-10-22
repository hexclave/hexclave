# Breezylite tuning experiments — October 10, 2026

Adopted: the inexpensive existence query, integer store IDs and Zstd level 1 in place of DEFLATE. Breezylite is undeployed, so no upgrade migration is needed; older PoC files are rejected with an instruction to use a fresh directory. Keep the default SQLite cache size for the measured workload. The measurements below predate the final codec replacement; they do not benchmark all three adopted changes together.

## End-to-end payments

Three fresh-process, fresh-database repetitions per variant, rotated order for the six individual variants. The combined variant was measured afterward. Same 1,200 prefill source facts and 792 measured writes; compression enabled, heap caching enabled, buffering disabled, WAL and synchronous=FULL throughout. Throughput aggregates the six write phases and excludes prefill and reads. Sizes refer to the comparable workload database after close, without compaction or extra GC.

| Variant | Median writes/s | Range | Median DB MiB |
|---|---:|---|---:|
| baseline | 30.03 | 29.81–31.45 | 145.72 |
| exists | 30.32 | 30.06–32.12 | 145.86 |
| zstd | 31.93 | 30.38–33.48 | 136.88 |
| cache32 | 29.88 | 29.46–32.04 | 146.09 |
| cache64 | 29.93 | 29.34–31.89 | 147.02 |
| storeids | 33.24 | 30.43–33.42 | 112.16 |
| combined | 34.62 | 33.03–35.61 | 112.66 |

Baseline is compressed Breezylite using DEFLATE level 1. `exists` uses SELECT 1; `zstd` uses native Node Zstd level 1 and codec 2 while retaining DEFLATE reads; `cache32`/`cache64` set PRAGMA cache_size to -32768/-65536; `storeids` uses a persistent name-to-integer dictionary and integer primary-key prefix. `combined` is integer IDs plus SELECT 1, retaining DEFLATE.

The combined result is about 15% faster and 23% smaller than baseline. Its later execution order can confound the timing comparison: three samples on a shared sandbox do not establish a production throughput guarantee. Integer IDs alone consistently reduced file size ~23%, with an observed ~11% median throughput improvement. Small changes in other variants have overlapping throughput ranges. A few MiB of size variation across identical storage formats is workload/allocation variation, not evidence that SELECT 1 or cache sizing compresses data.

## Targeted reads and memory

Separate fresh process per variant, 16,384 uncompressed 4 KiB values (64 MiB payload), adapter-direct reads bypassing the Breezy object cache. Three timed phases of 50,000 operations per kind; medians below. Pages were not evicted from the OS cache, so this is not a cold-disk test. Peak RSS includes Vitest/runtime and temporary buffers, not just SQLite. The Zstd variant is an effectively identical control here because compression is explicitly disabled; its variation illustrates measurement noise.

| Variant | Existence hits/s | Misses/s | Reads/s | Peak process MiB |
|---|---:|---:|---:|---:|
| baseline | 43,208 | 81,265 | 39,770 | 205.6 |
| exists | 56,489 | 81,259 | 39,157 | 209.2 |
| zstd | 46,415 | 82,793 | 44,029 | 206.5 |
| cache32 | 46,103 | 82,902 | 40,712 | 230.6 |
| cache64 | 45,417 | 83,784 | 40,770 | 269.0 |
| storeids | 49,139 | 84,802 | 44,106 | 205.3 |

## Complexity judgment

- **Existence query: yes.** One prepared statement and one call-site change (2 added lines, 1 removed). About 31% faster hit checks in the microbenchmark, ~1% payments median improvement, unchanged misses. No format or runtime change.
- **Integer store IDs: adopted.** Strongest repeatable file-size gain (~23%); a persistent dictionary replaces repeated store names in entry keys. The adapter reuses existing mappings without writing, handles conflicting name inserts, and rejects older TEXT-key files before changing them. Tests cover store isolation, ID stability across reopen and independent connections, and preservation of rejected old files. No upgrade migration is provided for this undeployed PoC.
- **Zstd: adopted as a replacement.** About 6% smaller and 6% higher median payments throughput, with overlapping timing ranges. The undeployed adapter now replaces DEFLATE rather than retaining a second compression/read path. Older PoC databases are rejected using a format version; no migration or DEFLATE reader is included. The repo already requires Node >=24, so the API minimum of Node 22.15 adds no practical runtime bump here. Older readers cannot decode new Zstd values.
- **32/64 MiB cache: no default change.** One line each, but no payments win and only ~2–3% microbenchmark read improvement, with ~25/~63 MiB more peak process memory. A different workload may justify tuning; these measurements do not.

## Validation and reproduction

All seven variants passed the selected full 32-test suite (21 Bulldozer, 2 payments/listing, 9 storage outcomes including the known expected LMDB failure). All 21 payments benchmark runs and all six read microbenchmark runs passed. Each variant was also checked with the focused TypeScript configuration. These are PoC experiments; no power-loss testing or integer-ID upgrade migration is included.

The archive contains raw logs, per-file logical/allocated sizes, timing JSON, exact adapter variants, patches for individual candidates and the scripts used. Its combined adapter uses integer IDs plus SELECT 1, retaining DEFLATE and default cache sizing; the current adapter additionally replaces DEFLATE with Zstd. Baseline commit: b567878f91c18d8b9da110159dc36d06817f949c. See environment.json for runtime/hardware.

Implementation context: https://github.com/hexclave/hexclave/pull/2098

💜🤖 Generated by [Reintersect Agent](https://app.reintersect.com/agents/ubq6ksakn0ed46oczohot95k) in [Benchmark Breezy, BreezyX and Breezylite storage alternatives](https://app.reintersect.com/agents/ubq6ksakn0ed46oczohot95k).
