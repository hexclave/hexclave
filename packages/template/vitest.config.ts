import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import sharedConfig from '../../vitest.shared'

const tanstackStartServerContextStub = fileURLToPath(new URL('./src/tanstack-start-server-context.default.ts', import.meta.url)) // THIS_LINE_PLATFORM template

const SOURCE_FILE_PATTERN = /\.(jsx?|tsx?)$/;
const CLIENT_VERSION_SENTINEL = "STACK_COMPILE_TIME_CLIENT_PACKAGE_VERSION_SENTINEL";
const ENFORCE_PRE: "pre" = "pre";

function getPackageVersionLabel() {
  const packageJson: unknown = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8"));
  if (
    typeof packageJson !== "object"
    || packageJson === null
    || !("name" in packageJson)
    || typeof packageJson.name !== "string"
    || !("version" in packageJson)
    || typeof packageJson.version !== "string"
  ) {
    throw new Error("Expected package.json to include string name and version fields.");
  }

  return `js ${packageJson.name}@${packageJson.version}`;
}

const replaceCompileTimeClientVersion = () => {
  const packageVersionLabel = getPackageVersionLabel();
  return {
    name: 'stackframe vitest client version replacement',
    enforce: ENFORCE_PRE,
    transform(code: string, id: string) {
      const filePath = id.split(/[?#]/, 1)[0];
      if (!SOURCE_FILE_PATTERN.test(filePath) || !code.includes(CLIENT_VERSION_SENTINEL)) {
        return null;
      }

      return {
        code: code.replaceAll(CLIENT_VERSION_SENTINEL, packageVersionLabel),
        map: null,
      };
    },
  };
};

export default mergeConfig(
  sharedConfig,
  defineConfig({
    resolve: {
      alias: {
        "@hexclave/tanstack-start/tanstack-start-server-context": tanstackStartServerContextStub, // THIS_LINE_PLATFORM template
      },
      // Component tests render with this package's react-dom, but hooks such as
      // `use` are imported from @hexclave/shared, whose devDependency can pin a
      // different React patch release in the pnpm store. Two React copies in one
      // render tree fail with "Invalid hook call"; in a real app peer deps
      // guarantee a single copy, so force the same here.
      dedupe: ["react", "react-dom"],
    },
    plugins: [replaceCompileTimeClientVersion()],
  }),
)
