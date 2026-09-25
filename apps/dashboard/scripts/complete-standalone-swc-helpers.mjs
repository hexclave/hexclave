import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const SWC_HELPERS_STORE_PREFIX = "@swc+helpers@";
const ESM_INTEROP_REQUIRE_DEFAULT = join("esm", "_interop_require_default.js");

/**
 * Next 16.3.1's standalone tracer follows CJS `exports.default` and copies only
 * `cjs/_interop_require_default.cjs`. Node >= 22.10 then resolves
 * `module-sync` to `esm/_interop_require_default.js`, and the RDE dashboard
 * exits before `hexclave dev` can spawn the demo. Replace each traced
 * `@swc/helpers` copy with the complete package from the repo store.
 */
export function completeStandaloneSwcHelpers(standaloneRoot, repoPnpmRoot) {
  const standalonePnpm = join(standaloneRoot, "node_modules", ".pnpm");
  if (!existsSync(standalonePnpm)) {
    throw new Error(`Standalone pnpm store not found at ${standalonePnpm}.`);
  }
  if (!existsSync(repoPnpmRoot)) {
    throw new Error(`Repo pnpm store not found at ${repoPnpmRoot}.`);
  }

  const helperEntries = readdirSync(standalonePnpm).filter((name) => name.startsWith(SWC_HELPERS_STORE_PREFIX));
  for (const entry of helperEntries) {
    const dest = join(standalonePnpm, entry, "node_modules", "@swc", "helpers");
    const src = join(repoPnpmRoot, entry, "node_modules", "@swc", "helpers");
    if (existsSync(join(dest, ESM_INTEROP_REQUIRE_DEFAULT))) {
      continue;
    }
    if (!existsSync(src)) {
      throw new Error(`Repo pnpm store is missing ${entry} at ${src}. Cannot complete the standalone dashboard runtime.`);
    }
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
  }
}
