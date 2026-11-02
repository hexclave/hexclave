import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestCli = createRequire(import.meta.url).resolve("vitest/vitest.mjs");
const repetitions = Number(process.env.HEXCLAVE_BREEZY_BENCH_REPETITIONS ?? 3);
if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("Invalid repetition count");
const output = resolve(root, process.env.HEXCLAVE_BREEZY_BENCH_OUTPUT ?? "storage-benchmark.untracked");
mkdirSync(output, { recursive: true });
const engines = [ ["breezy-lmdb", "lmdb"], ["breezylite", "sqlite"] ];
const runs = [];
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const metadata = { revision: revision.stdout.trim(), node: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), repetitions, startedAt: new Date().toISOString() };
for (let repetition = 0; repetition < repetitions; repetition++) {
  // Rotate order between repetitions; only one engine/process runs at a time.
  for (let offset = 0; offset < engines.length; offset++) {
    const [engine, backend] = engines[(repetition + offset) % engines.length];
    for (const suite of ["payments", "bulldozer"]) {
      const file = suite === "payments" ? "src/payments/schema/performance.test.ts" : "src/databases/bulldozer/performance.test.ts";
      const name = suite === "payments" ? "runs the comparable schema workload" : "reports ops/sec for baseline and composed example setup";
      console.log(`Run ${repetition + 1}/${repetitions}: ${engine} ${suite}`);
      const started = performance.now();
      const result = spawnSync(process.execPath, [vitestCli, "run", "--config", "vitest.storage.config.ts", file, "-t", name], {
        cwd: root,
        env: { ...process.env, STACK_BULLDOZER_PILEDRIVER_IMPLEMENTATION: engine, BULLDOZER_PAYMENTS_PERF_BACKEND: backend, BULLDOZER_PERF_BACKEND: backend, BULLDOZER_PERF_SNAPSHOT_MODE: "consistent", BULLDOZER_PAYMENTS_PERF_BUFFERED_PILEDRIVER: "0" },
        encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 900_000,
      });
      const log = result.stdout + result.stderr;
      writeFileSync(resolve(output, `${repetition + 1}-${engine}-${suite}.log`), log);
      if (result.error || result.status !== 0) throw new Error(`${engine} ${suite} failed: ${result.error ?? log.slice(-5000)}`);
      const metrics = suite === "payments"
        ? JSON.parse(readFileSync(resolve(root, "../../bulldozer-payments-schema-perf-js.untracked.json"), "utf8"))
        : [...log.matchAll(/\[bulldozer-perf-new\] (.+): ([\d.]+) ops\/s \((\d+) ops in ([\d.]+)ms\)/g)].map(match => ({ name: match[1], opsPerSecond: Number(match[2]), count: Number(match[3]), elapsedMs: Number(match[4]) }));
      runs.push({ repetition: repetition + 1, engine, backend, suite, wallMs: performance.now() - started, metrics });
      writeFileSync(resolve(output, "results.json"), JSON.stringify({ metadata, runs }, null, 2));
    }
  }
}
console.log(`Results: ${resolve(output, "results.json")}`);
