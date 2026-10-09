import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestCli = createRequire(import.meta.url).resolve("vitest/vitest.mjs");
const output = resolve(root, process.env.HEXCLAVE_BREEZY_BENCH_OUTPUT ?? "storage-size-benchmark.untracked");
const repetitions = Number(process.env.HEXCLAVE_BREEZY_BENCH_REPETITIONS ?? 3);
if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("Invalid repetition count");
mkdirSync(output, { recursive: true });
const variants = [["breezy-lmdb", "lmdb", "0"], ["breezy-lmdb", "lmdb", "1"], ["breezylite", "sqlite", "0"]];
const runs = [];
for (let repetition = 0; repetition < repetitions; repetition++) {
  for (let offset = 0; offset < variants.length; offset++) {
    const [engine, backend, compression] = variants[(repetition + offset) % variants.length];
    const name = `${repetition + 1}-${engine}-compression-${compression}`;
    const sizeFile = resolve(output, `${name}.json`);
    console.log(name);
    const result = spawnSync(process.execPath, [vitestCli, "run", "--config", "vitest.storage.config.ts", "src/payments/schema/performance.test.ts", "-t", "runs the comparable schema workload"], {
      cwd: root,
      env: { ...process.env, STACK_BULLDOZER_PILEDRIVER_IMPLEMENTATION: engine, BULLDOZER_PAYMENTS_PERF_BACKEND: backend, BULLDOZER_PAYMENTS_PERF_BUFFERED_PILEDRIVER: "0", HEXCLAVE_BREEZY_BENCH_COMPRESSION: compression, HEXCLAVE_BREEZY_BENCH_SIZE_OUTPUT: sizeFile },
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 900_000,
    });
    const log = result.stdout + result.stderr;
    writeFileSync(resolve(output, `${name}.log`), log);
    if (result.error || result.status !== 0) throw new Error(`${name} failed: ${result.error ?? log.slice(-5000)}`);
    runs.push({ repetition: repetition + 1, ...JSON.parse(readFileSync(sizeFile, "utf8")) });
    writeFileSync(resolve(output, "results.json"), JSON.stringify({ node: process.version, runs }, null, 2));
  }
}
