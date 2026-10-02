import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { backendUrlForPortPrefix, seedSourceMapRelease } from "./seed-source-map";

const MANIFEST_SHA256 = "a".repeat(64);

describe("source-map release seed", () => {
  it("uses the custom backend port prefix", () => {
    expect(backendUrlForPortPrefix("92").toString()).toBe("http://localhost:9202/");
    expect(() => backendUrlForPortPrefix("invalid")).toThrow("must contain one to three digits");
  });

  it("copies the fixture and invokes the CLI repeatably for release 1.4.2", async () => {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const fixtureDirectory = path.join(repositoryRoot, "packages/cli/src/lib/__fixtures__");
    const trackedBundle = path.join(fixtureDirectory, "minified-chunk.js");
    const trackedBytes = fs.readFileSync(trackedBundle);
    const invocations: Array<{ args: readonly string[], env: NodeJS.ProcessEnv }> = [];
    const runCli = vi.fn(async (input: { executable: string, args: readonly string[], env: NodeJS.ProcessEnv }) => {
      invocations.push({ args: input.args, env: input.env });
      const copiedDirectory = input.args.at(3);
      if (copiedDirectory === undefined) throw new Error("CLI invocation did not include a copied directory");
      expect(copiedDirectory.endsWith(".untracked")).toBe(true);
      expect(fs.readFileSync(path.join(copiedDirectory, "minified-chunk.js"))).toEqual(trackedBytes);
      fs.appendFileSync(path.join(copiedDirectory, "minified-chunk.js"), "\n// injected");
      return JSON.stringify({
        release: "1.4.2",
        manifestSha256: MANIFEST_SHA256,
        catalogStatus: invocations.length === 1 ? "published" : "already_published",
      });
    });
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith("/recent")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response(JSON.stringify({ artifacts: { items: [{ manifest_sha256: MANIFEST_SHA256 }] } }), { status: 200 });
    };
    const options = {
      apiUrl: backendUrlForPortPrefix("92"),
      cliEntryPath: path.join(repositoryRoot, "packages/cli/dist/index.js"),
      fixtureDirectory,
      secretServerKey: "local-test-key",
      runCli,
      fetchImpl,
      wait: async () => undefined,
    };

    await seedSourceMapRelease(options);
    await seedSourceMapRelease(options);

    expect(runCli).toHaveBeenCalledTimes(2);
    for (const invocation of invocations) {
      expect(invocation.args.slice(4)).toEqual([
        "--release", "1.4.2",
        "--environment", "development",
        "--cloud-project-id", "internal",
      ]);
      expect(invocation.env).toMatchObject({
        HEXCLAVE_API_URL: "http://localhost:9202/",
        HEXCLAVE_PROJECT_ID: "internal",
        HEXCLAVE_SECRET_SERVER_KEY: "local-test-key",
      });
    }
    expect(fs.readFileSync(trackedBundle)).toEqual(trackedBytes);
  });
});
