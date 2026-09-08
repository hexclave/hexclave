import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { format } from "node:util";
import { flyConfig, getConfig } from "./config.js";
import { FlyClient } from "./fly/client.js";
import { cleanupLiveRun, configureLiveRun, exerciseLiveRun, liveCredentialSettings, liveRunIdentity, loadLiveCredentials, newLiveRun, parseLiveRun, saveRecoveryFile } from "./live-platform-domain-test.js";
import { readSpec } from "./store.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: test:platform-domains:live [--cleanup recovery-file]\nUses Fly/S3 credentials from apps/marshal/.env.local. No Vercel token required.\nRequires the hosted-components proxy to be deployed first. Creates a disposable Fly app, verifies HTTPS and redeploy, then deletes it.\nExit codes: 0 = passed, 1 = failed.");
    return;
  }
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--cleanup")) throw new Error("Use --help for usage");
  const values = await loadLiveCredentials();
  const settings = liveCredentialSettings(values);
  const cleanupPath = args.at(1);
  const run = cleanupPath === undefined ? newLiveRun(settings) : parseLiveRun(JSON.parse(await readFile(cleanupPath, "utf8")), settings);
  configureLiveRun(settings, run);
  // Provider clients can log diagnostic errors. Redact credentials at the console
  // boundary as well as avoiding them in this runner's own messages.
  const secrets = [run.encryptionKey, ...Object.entries(process.env).filter(([key]) => /TOKEN|KEY|SECRET/.test(key)).map(([, value]) => value)]
    .filter((value): value is string => value !== undefined && value.length > 3);
  for (const method of ["log", "info", "warn", "error"] satisfies (keyof Console)[]) {
    const original = console[method].bind(console);
    console[method] = (...messages: unknown[]) => {
      let message = format(...messages);
      for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
      original(message);
    };
  }
  getConfig();
  if (cleanupPath !== undefined) {
    await cleanupLiveRun(run, cleanupPath);
    return;
  }
  const { app, ns } = liveRunIdentity(run);
  assert.equal(await new FlyClient(flyConfig().token, flyConfig().orgSlug).getApp(app), null, "Test identity already exists; refusing to reuse it");
  assert.equal(await readSpec(ns, "web"), null, "Test state already exists; refusing to reuse it");
  const recoveryPath = await saveRecoveryFile(run);
  console.log(`Recovery file: ${recoveryPath}\nIf cleanup fails, rerun with --cleanup ${recoveryPath}`);
  const controller = new AbortController();
  const interrupt = () => {
    console.log("Interrupted. Waiting for the current operation before cleaning up...");
    controller.abort(new Error("Live test interrupted"));
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const [exercise] = await Promise.allSettled([exerciseLiveRun(run, controller.signal, 3 * 60_000)]);
  const [cleanup] = await Promise.allSettled([cleanupLiveRun(run, recoveryPath)]);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  if (exercise.status === "rejected" || cleanup.status === "rejected") {
    if (cleanup.status === "rejected") console.error(`Cleanup incomplete. Keep ${recoveryPath} and rerun with --cleanup.`);
    throw new AggregateError([exercise, cleanup].flatMap((result) => result.status === "rejected" ? [result.reason] : []), "Live test failed");
  }
  if (controller.signal.aborted) throw new Error("Live test interrupted; cleanup completed");
  console.log("PASS: real Fly deployment, branded HTTPS proxy, stable redeploy, and cleanup verified.");
}

const [result] = await Promise.allSettled([main()]);
if (result.status === "rejected") {
  console.error(result.reason);
  process.exitCode = 1;
}
