# Piledriver GC and releasing free pages

Bulldozer never deletes data on its own. Old versions stay in the database until an operator runs GC. Getting disk space back takes two separate commands:

| Step | Command | What it does | Backends |
|---|---|---|---|
| 1. GC | `pnpm gc:piledriver` | Deletes objects nothing points at any more. Their space becomes free *inside* the database file. | all |
| 2. Release free pages | `pnpm release-free-pages:piledriver` | Gives those free pages back to the operating system, so the file gets smaller. | Breezylite (SQLite) only |

GC alone does not shrink the file. LMDB and SQLite both keep freed pages inside the file and reuse them for new writes, so after GC the file stops growing until that space is used up. Only step 2 makes the file smaller, and only on Breezylite. LMDB has no equivalent: the release command returns a 400 on any other backend.

Both commands call the running Bulldozer service over HTTP. Each runs inside the service, in small steps with a pause after each, so normal requests keep being served while they run. Both read `HEXCLAVE_BULLDOZER_SERVER_SECRET` and `HEXCLAVE_BULLDOZER_SERVER_URL` (default `http://localhost:<port prefix>46`) from the shell or from `apps/bulldozer-js/.env*.local`. Putting the secret in `.env.local` instead of on the command line keeps it out of shell history.

## How GC works

Piledriver stores data as a tree of *heap objects*: immutable, content-addressed blobs, where a parent refers to its children by key. A write never edits an object. It writes new objects for the parts that changed and points a *root* at the new tree. Unchanged subtrees are shared between the old and new trees. So after a write, the objects that only the old tree used are garbage: nothing reaches them any more.

GC finds them with reference counts:

- Every heap object has a metadata record with a `referenceCount` (how many parents point at it), `createdAtMillis`, and `lastDereferencedAtMillis` (when the count last went down).
- A write that makes an object visible increments its children's counts *before* the parent becomes visible. A crash can then leave a count too high (a leak GC can't see), but never too low (a live object deleted).
- When a count reaches 0, the object is added to a *candidate index*, sorted by the time it became unreferenced.
- A GC run reads candidates older than the cutoff, oldest first. For each one it deletes the object and its metadata, then decrements every child it pointed at. A child that reaches 0 becomes a new candidate, and a later batch or a later run deletes it. That's why one run usually leaves more work behind: deleting a parent turns its children into candidates.
- Objects written before reference counting existed have no record and are never deleted.

**Why the cutoff must predate the running service.** A running process can hold an object in memory: in its heap cache, in a snapshot a request is reading, or as a subtree a new write is about to reuse. Its stored count can be 0 while that is happening. GC only deletes objects that became unreferenced *before* the cutoff. The service rejects any cutoff that is not older than its own start time, so every eligible object was already unreferenced before this process existed, and no handle in it can be holding one. That's why you record the cutoff first, restart, and only then run GC.

GC works in transactions of up to 64 objects. A transaction also stops early once it has made 4,096 child-count updates, so one object with thousands of children can't hold the write lock for long. After each transaction GC lets queued requests run. Only one GC runs at a time, and stopping the service waits for it to finish.

## Running GC

From the repository root, on the Bulldozer host:

```sh
CUTOFF=$(( $(date +%s) * 1000 - 10000 ))   # epoch milliseconds, 10 s ago
sudo systemctl restart bulldozer-js
until curl -s -o /dev/null http://127.0.0.1:8146/health; do sleep 1; done   # wait until the service accepts connections (any HTTP status, even 401, means it's up)
pnpm -C apps/bulldozer-js gc:piledriver "$CUTOFF" 1000
```

- The first argument is the cutoff in epoch **milliseconds**. Only garbage that became unreferenced before it is deleted. Anything newer waits for a later cutoff and another restart.
- The second argument is the maximum number of objects to delete in this run (default 1000). It counts objects, not bytes. Objects vary in size; the result's `reclaimed.heapPayloadMiB` says how much was freed.
- If the restart didn't happen after the cutoff was taken, GC refuses with a 400 ("GC cutoff must be older than this Bulldozer process").

Repeat the `gc:piledriver` command with the same cutoff until a run reports `limits.moreEligibleWorkMayRemain: false`. There's no need to restart between runs. `limits.limitReached: true` means the run stopped at the object limit, so there is more to do.

## Releasing free pages (Breezylite only)

SQLite keeps pages emptied by GC as *free pages* inside the file. Breezylite creates every new file with `auto_vacuum=INCREMENTAL`, so those pages can be released in small steps. The alternative, a full `VACUUM`, rewrites the whole file, needs up to twice its size in free disk, and blocks writers for the whole run. SQLite only accepts `auto_vacuum` before the first table exists, so files created before this setting was added report `canRelease: false` and must be recreated to use it.

```sh
pnpm -C apps/bulldozer-js release-free-pages:piledriver --dry-run              # how many free pages, and can this file release them
pnpm -C apps/bulldozer-js release-free-pages:piledriver --max-mib 1024         # one request: release up to 1 GiB, then stop
pnpm -C apps/bulldozer-js release-free-pages:piledriver --max-mib 1024 --all   # repeat 1 GiB requests until no free pages remain
```

`--max-mib` and `--all` work together:

- `--max-mib N` caps **each request** at N MiB (default 1024). Without `--all`, that's one request, so at most N MiB in total.
- `--all` keeps sending requests of up to N MiB. It sends the next one only after a request released its full N MiB, and stops after the first request that couldn't. So `--max-mib 1024 --all` releases everything, one bounded request at a time. Each request logs its own result, and you can stop between requests with Ctrl-C.
- `--dry-run` releases nothing, so it can't be combined with either.

Each result's `stoppedBecause` says why that request stopped:

| `stoppedBecause` | Meaning | Next step |
|---|---|---|
| `limit` | Released the full `--max-mib`; free pages may remain. | Run again (`--all` does this for you). |
| `no-free-pages` | Every free page is released. | Done. Run GC again later to free more. |
| `no-progress` | A step released nothing although free pages remained. | Unexpected; check `/diagnostics` and the service logs. |

The command calls `POST /internal/piledriver-release-free-pages` (`{ maxBytes?, dryRun? }`, default 1 GiB). A second release while one is running, or a file without auto_vacuum, gets a 409. `GET /diagnostics` reports `freePages` (`pageSizeBytes`, `totalPages`, `freePages`, `canRelease`). These are read from SQLite's file header, so reading them costs about 3 µs whatever the file size.

**Never run `VACUUM` or `incremental_vacuum` from a separate `sqlite3` process.** Bulldozer opens SQLite with `busy_timeout=0`, so every Bulldozer write fails while another process holds the write lock. The release command avoids that by running inside the service, on its only connection.

### Disk and WAL

A release adds at most one chunk (16 MiB at the 4,096-page cap) to the WAL between automatic checkpoints. `journal_size_limit` trims a WAL that grew past 64 MiB. SQLite only trims it when the next write starts after a checkpoint, not at the checkpoint itself, so a WAL that was already oversized stays that size until the next write. Keep at least 64 MiB of disk free; a release never needs the 2× that `VACUUM` does.

The WAL size is always in `/diagnostics` and in the release's own result and log line. The 5-second activity log only appears while ordinary writes happen, so it shows nothing during a release on an otherwise idle service. A WAL that keeps growing means checkpoints are starved. Both Breezy callers of `getRange` read their rows within a single synchronous loop, so no read stays open across an `await` to block checkpoints.

### Chunk size and speed

Each chunk targets 5 ms of event-loop time. The first chunk releases 16 pages to measure the cost per page, and later chunks are sized from that, up to 4,096 pages. A fixed page count can't work, because the cost per page grows with the file: SQLite searches its free-page list for a slot for every live page it moves out of the file's tail. A native profile showed that search (`allocateBtreePage`) dominating.

Measured cost per page: about 7 µs on 50 MiB. On 5 GiB, about 55 µs with the small time-budgeted chunks the release uses (the "chunk time / 1k pages" column below), and about 80–135 µs in fixed chunks of 250–8,000 pages, since the cost per page grows with chunk size. Plan release time with the 55 µs figure. Neither fsync nor `mmap` changed it. A 64 MiB `cache_size` halved it in a standalone test (134 → 63 ms per 1,000 pages at 5 GiB). It isn't enabled, because earlier tuning showed no win for normal traffic and it costs about 63 MiB more memory. Releases are rare and yield to requests, so a slower release is acceptable.

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
