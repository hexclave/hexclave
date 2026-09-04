import { createRequire } from "node:module";
import { CONFIG_IMPORT_PACKAGES } from "@hexclave/shared/dist/config-rendering";
import { createJiti, type Jiti } from "jiti";

// Config files import `defineHexclaveConfig` and the config types from the SDK.
// New files import from the package root (e.g. `@hexclave/js`); older ones
// import from the deprecated `<pkg>/config` subpath. Both re-export the same
// side-effect-free helpers, so either can be aliased to the CLI's bundled copy.
const CONFIG_IMPORT_SPECIFIERS: readonly string[] = [
  ...CONFIG_IMPORT_PACKAGES,
  ...CONFIG_IMPORT_PACKAGES
    .filter((pkg) => pkg.startsWith("@hexclave/"))
    .map((pkg) => `${pkg}/config`),
];

/**
 * Builds a jiti loader for a `hexclave.config.ts` file whose SDK config imports
 * always resolve to the CLI's own bundled SDK copy. The only things a config
 * file imports from these packages are the config-authoring helpers
 * (`defineHexclaveConfig` / `defineStackConfig`), which are side-effect-free
 * pass-throughs, so the bundled copy is always correct — and using it
 * unconditionally means config loading works even in a bare checkout where the
 * project hasn't installed the SDK (e.g. `config push` in a fresh CI checkout),
 * with no dependence on the target project's `node_modules`.
 */
export function createConfigFileJiti(): Jiti {
  const cliRequire = createRequire(import.meta.url);

  const configAliases: Record<string, string> = {};
  for (const specifier of CONFIG_IMPORT_SPECIFIERS) {
    // `/config` subpaths map to the bundled `@hexclave/js/config` entrypoint;
    // everything else maps to the bundled `@hexclave/js` root.
    const bundled = specifier.endsWith("/config") ? "@hexclave/js/config" : "@hexclave/js";
    configAliases[specifier] = cliRequire.resolve(bundled);
  }

  return createJiti(import.meta.url, { alias: configAliases });
}
