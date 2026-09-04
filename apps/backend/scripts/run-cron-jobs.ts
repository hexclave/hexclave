import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously, wait } from "@hexclave/shared/dist/utils/promises";
import { Result } from "@hexclave/shared/dist/utils/results";

const endpoints: { path: string, intervalMs: number }[] = [
  { path: "/api/latest/internal/external-db-sync/sequencer", intervalMs: 1000 },
  { path: "/api/latest/internal/external-db-sync/poller", intervalMs: 1000 },
  { path: "/api/latest/internal/feature-flags/experiment-schedule-processor", intervalMs: 1000 },
  { path: "/api/latest/internal/workflow-engine-step", intervalMs: 1000 },
];

async function main() {
  if (getEnvVariable("NEXT_PUBLIC_STACK_IS_PREVIEW", "") === "true") {
    console.log("Preview mode is enabled, skipping cron jobs.");
    // Keep alive — concurrently uses -k and would kill all other processes if this exits
    setInterval(() => {}, 1 << 30);
    return;
  }
  console.log("Starting cron jobs...");
  const cronSecret = getEnvVariable('CRON_SECRET');

  // Cron jobs call the backend over HTTP, so they must follow the port the
  // backend listens on (including fallback setups where the primary port is down).
  const portPrefix = getEnvVariable("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX", "81");
  const backendPort = getEnvVariable("PORT", getEnvVariable("BACKEND_PORT", `${portPrefix}02`));
  const baseUrl = `http://localhost:${backendPort}`;

  const run = async (endpoint: string) => {
    console.log(`Running ${endpoint}...`);
    const res = await fetch(`${baseUrl}${endpoint}`, {
      headers: { 'Authorization': `Bearer ${cronSecret}` },
    });
    if (!res.ok) throw new HexclaveAssertionError(`Failed to call ${endpoint}: ${res.status} ${res.statusText}\n${await res.text()}`, { res });
    console.log(`${endpoint} completed.`);
  };

  for (const { path, intervalMs } of endpoints) {
    runAsynchronously(async () => {
      await wait(30_000); // Wait 30 seconds to make sure the server is fully started
      while (true) {
        const runResult = await Result.fromPromise(run(path));
        if (runResult.status === "error") {
          captureError("run-cron-jobs", runResult.error);
        }
        await wait(intervalMs);
      }
    });
  }
}

// eslint-disable-next-line no-restricted-syntax
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
