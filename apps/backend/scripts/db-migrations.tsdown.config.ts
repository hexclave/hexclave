import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Rolldown, type UserConfig } from 'tsdown';
// @ts-expect-error - this is a workaround to allow the import of the plugins.ts file
import { createBasePlugin } from '../../../configs/tsdown/plugins.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const backendDir = resolve(__dirname, '..');

const packageJson = JSON.parse(readFileSync(resolve(backendDir, 'package.json'), 'utf-8'));

// Packages that must remain as runtime imports (can't be statically bundled).
// @aws-sdk and @smithy use complex class hierarchies that rolldown mis-scopes,
// causing "StructureSchema$2 is not defined" at runtime. They're unused by the
// migration script anyway (pulled in transitively), and node_modules is present
// in the Docker image, so keeping them external is safe.
const externalPackages = [
  '@prisma/client',
  '@aws-sdk',
  '@smithy',
];

const customNoExternal = new Set([
  ...Object.keys(packageJson.dependencies).filter(
    (dep) => !externalPackages.some((ext) => dep === ext || dep.startsWith(ext + '/'))
  ),
]);

// Node.js built-in modules that should not be bundled
const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

const basePlugin: Rolldown.Plugin = createBasePlugin({});

// Node.js ESM is stricter about subpath imports than Next, so we need to rewrite some packages to use the correct file extensions.
const rewriteNextSubpathImportsPlugin: Rolldown.Plugin = {
  name: "rewrite-next-subpath-imports",
  renderChunk(code) {
    return code.replace(
      /(["'])next\/(navigation|headers)\1/g,
      (_match, quote: string, subpath: string) => `${quote}next/${subpath}.js${quote}`,
    );
  },
};

export default defineConfig({
  entry: [resolve(backendDir, 'scripts/db-migrations.ts')],
  format: ['esm'],
  outDir: resolve(backendDir, 'dist'),
  target: 'node24',
  platform: 'node',
  noExternal: [...customNoExternal],
  inlineOnly: false,
  // Externalize Node.js builtins so they're imported rather than shimmed
  external: [...nodeBuiltins, ...externalPackages],
  // Docker builds the backend server into the same dist directory before this
  // script. Cleaning here deletes dist/server.mjs from the final image.
  clean: false,
  // Use banner to add createRequire for CommonJS modules that use require() for builtins
  // The imported require is used by the shimmed __require2 function
  banner: {
    js: `import { createRequire as __createRequire } from 'module';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __dirname_fn } from 'path';
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_fn(__filename);
const require = __createRequire(import.meta.url);`,
  },
  plugins: [basePlugin, rewriteNextSubpathImportsPlugin],
} satisfies UserConfig);
