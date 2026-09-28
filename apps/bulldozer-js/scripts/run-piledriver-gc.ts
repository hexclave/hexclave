import "../src/load-env.js";
import { parsePiledriverGcMaxObjects, parsePiledriverGcTimestamp } from "./piledriver-gc-cli-utils.js";

if (process.argv.length < 3) {
  throw new Error("Usage: pnpm gc:piledriver <epoch milliseconds> [max objects]");
}
const cutoffArgument = process.argv[2];

const secret = process.env.HEXCLAVE_BULLDOZER_SERVER_SECRET;
if (secret === undefined || secret.length === 0) throw new Error("HEXCLAVE_BULLDOZER_SERVER_SECRET must be set");
const configuredBaseUrl = process.env.HEXCLAVE_BULLDOZER_SERVER_URL;
const baseUrl = configuredBaseUrl === undefined || configuredBaseUrl.length === 0
  ? `http://localhost:${process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX ?? "81"}46`
  : configuredBaseUrl;
const cutoffTimestampMillis = parsePiledriverGcTimestamp(cutoffArgument);
const maxObjects = parsePiledriverGcMaxObjects(process.argv[3]);
const endpointUrl = new URL("/internal/piledriver-gc", baseUrl);
const requestStartedAtMillis = Date.now();
const requestStartedAt = performance.now();

const response = await fetch(endpointUrl, {
  method: "POST",
  headers: {
    "authorization": `Bearer ${secret}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    cutoffTimestampMillis,
    ...(maxObjects === undefined ? {} : { maxObjects }),
  }),
});
if (!response.ok) {
  throw new Error(
    `Piledriver GC request to ${endpointUrl.toString()} failed with HTTP ${response.status}`
    + ` (cutoff=${new Date(cutoffTimestampMillis).toISOString()}, requestedMaxObjects=${maxObjects ?? "server-default"}): ${await response.text()}`,
  );
}
const result: unknown = await response.json();
const requestCompletedAtMillis = Date.now();
console.log(JSON.stringify({
  command: "piledriver-gc",
  request: {
    endpoint: endpointUrl.toString(),
    cutoffTimestampMillis,
    cutoffTimestampIso: new Date(cutoffTimestampMillis).toISOString(),
    requestedMaxObjects: maxObjects ?? null,
    startedAtMillis: requestStartedAtMillis,
    completedAtMillis: requestCompletedAtMillis,
    httpRoundTripMillis: performance.now() - requestStartedAt,
    clientProcessId: process.pid,
    nodeVersion: process.version,
  },
  result,
}, null, 2));
