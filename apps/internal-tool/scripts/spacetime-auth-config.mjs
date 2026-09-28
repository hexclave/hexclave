#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const TARGET = resolve("spacetimedb/src/index.ts");
const BACKUP = TARGET + ".bak";
const ISSUERS_PLACEHOLDER = "'__SPACETIMEDB_ALLOWED_ISSUERS__'";
const AUDIENCE_PLACEHOLDER = "'__SPACETIMEDB_EXPECTED_AUDIENCE__'";

function defaultDevIssuer() {
  const prefix = process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX ?? "81";
  return `http://localhost:${prefix}41`;
}

function allowedIssuers() {
  const raw = process.env.HEXCLAVE_SPACETIMEDB_ALLOWED_ISSUERS || process.env.HEXCLAVE_INTERNAL_TOOL_BASE_URL;
  if (!raw) return [defaultDevIssuer()];
  const issuers = raw.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter((s) => s !== "");
  if (issuers.length === 0) {
    console.error(
      "HEXCLAVE_INTERNAL_TOOL_BASE_URL is set but contains no issuer URLs after parsing. Refusing to publish a module with an empty trusted-issuer list, as it would reject every token."
    );
    process.exit(1);
  }
  return issuers;
}

const EXPECTED_AUDIENCE = "spacetimedb";

const action = process.argv[2];

if (action === "inject") {
  if (existsSync(BACKUP)) {
    console.error("Refusing to inject: backup already exists. Run restore first.");
    process.exit(1);
  }
  const content = readFileSync(TARGET, "utf8");
  if (!content.includes(ISSUERS_PLACEHOLDER) || !content.includes(AUDIENCE_PLACEHOLDER)) {
    console.error("Auth-config placeholders not found in module source.");
    process.exit(1);
  }
  const issuersLiteral = allowedIssuers().map((issuer) => JSON.stringify(issuer)).join(", ");
  writeFileSync(BACKUP, content, "utf8");
  writeFileSync(
    TARGET,
    content
      .replaceAll(ISSUERS_PLACEHOLDER, issuersLiteral)
      .replaceAll(AUDIENCE_PLACEHOLDER, JSON.stringify(EXPECTED_AUDIENCE)),
    "utf8",
  );
} else if (action === "restore") {
  if (existsSync(BACKUP)) {
    if (existsSync(TARGET)) {
      unlinkSync(TARGET);
    }
    renameSync(BACKUP, TARGET);
  }
} else {
  console.error("Usage: node scripts/spacetime-auth-config.mjs <inject|restore>");
  process.exit(1);
}
