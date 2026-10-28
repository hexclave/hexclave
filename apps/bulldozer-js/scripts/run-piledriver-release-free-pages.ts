import "../src/load-env.js";
import type { FreePageReleaseResult } from "../src/databases/piledriver/implementations/breezy/core.js";
import { formatReleaseFreePagesSummary, parseReleaseFreePagesArgs, releaseFreePagesHelp } from "./piledriver-release-free-pages-cli-utils.js";

const command = parseReleaseFreePagesArgs(process.argv.slice(2));
if (command.kind === "help") {
  console.log(releaseFreePagesHelp);
  process.exit(0);
}

const secret = process.env.HEXCLAVE_BULLDOZER_SERVER_SECRET;
if (secret === undefined || secret.length === 0) throw new Error("HEXCLAVE_BULLDOZER_SERVER_SECRET must be set");
const configuredBaseUrl = command.url ?? process.env.HEXCLAVE_BULLDOZER_SERVER_URL;
const baseUrl = configuredBaseUrl === undefined || configuredBaseUrl.length === 0
  ? `http://localhost:${process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX ?? "81"}46`
  : configuredBaseUrl;
const endpointUrl = new URL("/internal/piledriver-release-free-pages", baseUrl);

const requestRelease = async (): Promise<FreePageReleaseResult> => {
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ maxBytes: command.maxBytes, dryRun: command.dryRun }),
  });
  if (!response.ok) {
    throw new Error(`Releasing free pages via ${endpointUrl.toString()} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  // The service's own response type, sent as JSON by the endpoint this script was written against.
  return await response.json();
};

// Each request is bounded by --max-mib; --all repeats them, and stops early if a request released
// nothing (for example because writes kept reusing the free pages), so it can't loop forever.
for (;;) {
  const result = await requestRelease();
  console.log(JSON.stringify({ command: "piledriver-release-free-pages", endpoint: endpointUrl.toString(), result }, null, 2));
  console.log(formatReleaseFreePagesSummary(result));
  if (!command.all || result.stoppedBecause !== "limit" || result.released.pages === 0) break;
}
