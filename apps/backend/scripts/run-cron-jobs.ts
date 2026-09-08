import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously, wait } from "@hexclave/shared/dist/utils/promises";
import { Result } from "@hexclave/shared/dist/utils/results";

type Target = "backend" | "marshal";

const endpoints: { path: string, intervalMs: number, target?: Target }[] = [
  { path: "/api/latest/internal/external-db-sync/sequencer", intervalMs: 1000 },
  { path: "/api/latest/internal/external-db-sync/poller", intervalMs: 1000 },
  { path: "/api/latest/internal/workflow-engine-step", intervalMs: 1000 },
  // Marshal's tenant GCP project pool. Its provisioning is a resumable state machine advanced
  // by a cron rather than background work, because the hosted deployment is frozen at response
  // time — see apps/marshal/src/project-pool.ts and apps/marshal/vercel.json, which schedule
  // exactly these two on the same cadence.
  { path: "/v1/maintenance/project-pool/step", intervalMs: 2 * 60_000, target: "marshal" },
  { path: "/v1/maintenance/project-pool/reap", intervalMs: 60 * 60_000, target: "marshal" },
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

  // Marshal is a separate service on its own port and with its own credential. In production
  // it has its own Vercel crons; locally this runner drives it too, so the pool behaves the
  // same way in dev as it does hosted. Its bearer is MARSHAL_API_KEY, not the backend's
  // CRON_SECRET. (Hosted, Marshal's maintenance routes also accept that project's own
  // CRON_SECRET, which is what Vercel's scheduler sends; this runner uses the API key.)
  const marshalApiKey = getEnvVariable("HEXCLAVE_MARSHAL_API_KEY", "");
  const marshalBaseUrl = getEnvVariable("HEXCLAVE_MARSHAL_URL", "") || `http://localhost:${portPrefix}47`;

  const run = async (endpoint: string, target: Target) => {
    console.log(`Running ${endpoint}...`);
    const res = await fetch(`${target === "marshal" ? marshalBaseUrl : baseUrl}${endpoint}`, {
      headers: { 'Authorization': `Bearer ${target === "marshal" ? marshalApiKey : cronSecret}` },
    });
    if (!res.ok) throw new HexclaveAssertionError(`Failed to call ${endpoint}: ${res.status} ${res.statusText}\n${await res.text()}`, { res });
    console.log(`${endpoint} completed.`);
  };

  for (const { path, intervalMs, target = "backend" } of endpoints) {
    // Deploy is optional: with no Marshal credential configured there is no Marshal to poll,
    // and every tick would otherwise be a captured error.
    if (target === "marshal" && !marshalApiKey) continue;
    runAsynchronously(async () => {
      await wait(30_000); // Wait 30 seconds to make sure the server is fully started
      while (true) {
        const runResult = await Result.fromPromise(run(path, target));
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
