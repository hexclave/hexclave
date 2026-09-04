import { readFileSync } from "node:fs";

const logPath = process.argv[2];
if (logPath === undefined) throw new Error("Usage: node summarize-lint.mjs <lint-log>");

const byRule = new Map();
const byPackage = new Map();
for (const line of readFileSync(logPath, "utf8").split("\n")) {
  const diagnostic = line.match(/^([^\s]+):lint:.*(?:\berror\b|\bError:).*\b(anti-slop\/[a-z-]+)\s*$/);
  if (diagnostic === null) continue;
  const [, packageName, rule] = diagnostic;
  byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
  byPackage.set(packageName, (byPackage.get(packageName) ?? 0) + 1);
}

const descending = entries => [...entries].sort((left, right) => right[1] - left[1]);
console.log(JSON.stringify({
  total: [...byRule.values()].reduce((total, count) => total + count, 0),
  byRule: descending(byRule),
  byPackage: descending(byPackage),
}, null, 2));
