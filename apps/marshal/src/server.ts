// Standalone Node entrypoint: owns the listener. Everything hosted (Vercel) goes through
// src/vercel.ts instead, which exports the same app without binding a port. This file is
// what `pnpm start` / `pnpm dev` / the e2e workflows run.
import "./load-env.js";
import { createMarshalApp } from "./marshal-app.js";
import { getConfig } from "./config.js";

const config = getConfig();
const { app } = createMarshalApp();
app.listen(config.port);
// The tenant project pool is NOT topped up from here. It is advanced by the maintenance crons
// (apps/marshal/vercel.json in production, apps/backend/scripts/run-cron-jobs.ts locally), so
// that provisioning survives a hosting platform that freezes the process at response time.

console.log(`Marshal listening on http://localhost:${config.port} (env=${config.envId}, builder=${config.builderKind}, runtimes=${[config.fly === null ? null : "fly", config.gcp === null ? null : `gcp:${config.gcp.region}`].filter((runtime) => runtime !== null).join(",")})`);
