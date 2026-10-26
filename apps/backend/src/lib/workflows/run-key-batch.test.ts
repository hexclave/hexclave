import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compileWorkflowBundle } from "./compile";
import { buildRunKeyBatchCode } from "./invoke";
import { WORKFLOWS_DEFAULT_LIMITS, WORKFLOWS_PROTOCOL_VERSION, type WorkflowSandboxInput } from "./protocol";

// Runs real compiled bundles in this process (with a stub Server SDK) to
// check that a batched run-key invocation yields exactly what one invocation
// per event would.

const WORKFLOW_SOURCE = `
import { workflow } from "@hexclave/workflows";
export default workflow("batch-test", {
  on: ["user.created"],
  runKey: (event) => {
    if (event.data.bad) throw new Error("bad key for " + event.id);
    console.log("deriving", event.id);
    return event.data.id + "@" + event.ts.toISOString();
  },
}, async () => {});
`;

function runKeyInput(id: string, data: unknown): WorkflowSandboxInput {
  return {
    protocolVersion: WORKFLOWS_PROTOCOL_VERSION,
    mode: "run-key",
    limits: WORKFLOWS_DEFAULT_LIMITS,
    event: { id, type: "user.created", tsMillis: Date.UTC(2026, 9, 1), data },
  };
}

let dir: string;
let compiledBundle: string;
let fileCounter = 0;

async function runModule(code: string): Promise<unknown> {
  const path = join(dir, `code-${fileCounter++}.mjs`);
  await writeFile(path, code);
  const mod = await import(/* @vite-ignore */ pathToFileURL(path).href);
  return await mod.default();
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "workflow-run-key-batch-"));
  const sdkDir = join(dir, "node_modules", "@hexclave", "js");
  await mkdir(sdkDir, { recursive: true });
  await writeFile(join(sdkDir, "package.json"), JSON.stringify({ name: "@hexclave/js", type: "module", main: "index.js" }));
  await writeFile(join(sdkDir, "index.js"), "export class HexclaveServerApp { constructor(options) { this.options = options; } }\n");
  const compiled = await compileWorkflowBundle(WORKFLOW_SOURCE);
  if (compiled.status === "error") throw new Error(compiled.error);
  compiledBundle = compiled.data.compiledBundle;
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("buildRunKeyBatchCode", () => {
  test("matches one invocation per event, including a runKey that throws", async () => {
    const inputs = [
      runKeyInput("11111111-1111-4111-8111-111111111111", { id: "user-1" }),
      runKeyInput("22222222-2222-4222-8222-222222222222", { id: "user-2", bad: true }),
      runKeyInput("33333333-3333-4333-8333-333333333333", { id: "user-3" }),
    ];
    const code = buildRunKeyBatchCode(compiledBundle, inputs);
    if (code == null) throw new Error("expected the compiled bundle to be batchable");
    const batched = await runModule(code) as { status: string, data: unknown[] };

    const single = [];
    for (const input of inputs) {
      single.push(await runModule("globalThis.__HEXCLAVE_WORKFLOWS_INPUT__ = " + JSON.stringify(input) + ";\n" + compiledBundle));
    }

    expect(batched.status).toBe("ok");
    // Error stacks name the file that ran, which differs per invocation.
    const withoutStacks = (value: unknown) => JSON.parse(JSON.stringify(value, (key, inner) => key === "stack" ? undefined : inner));
    expect(withoutStacks(batched.data)).toEqual(withoutStacks(single));
    expect(batched.data).toMatchObject([
      { status: "ok", data: { type: "run-key", runKey: "user-1@2026-10-01T00:00:00.000Z" } },
      { status: "ok", data: { type: "handler-failed", phase: "run-key", error: { message: "bad key for 22222222-2222-4222-8222-222222222222" } } },
      { status: "ok", data: { type: "run-key", runKey: "user-3@2026-10-01T00:00:00.000Z" } },
    ]);
  });

  test("does not expose the other events of the batch to a runKey", async () => {
    const compiled = await compileWorkflowBundle(`
import { workflow } from "@hexclave/workflows";
export default workflow("batch-isolation-test", {
  on: ["user.created"],
  runKey: (event) => event.data.id + ":" + typeof globalThis.__HEXCLAVE_WORKFLOWS_RUN_KEY_BATCH__,
}, async () => {});
`);
    if (compiled.status === "error") throw new Error(compiled.error);
    const code = buildRunKeyBatchCode(compiled.data.compiledBundle, [
      runKeyInput("11111111-1111-4111-8111-111111111111", { id: "user-1" }),
      runKeyInput("22222222-2222-4222-8222-222222222222", { id: "user-2" }),
    ]);
    if (code == null) throw new Error("expected the compiled bundle to be batchable");
    const batched = await runModule(code) as { status: string, data: unknown[] };
    expect(batched.data).toMatchObject([
      { status: "ok", data: { type: "run-key", runKey: "user-1:undefined" } },
      { status: "ok", data: { type: "run-key", runKey: "user-2:undefined" } },
    ]);
  }, 60_000);

  test("declines bundles without the trailing default-export block", () => {
    const input = runKeyInput("11111111-1111-4111-8111-111111111111", { id: "user-1" });
    expect(buildRunKeyBatchCode("export default async () => ({ status: 'ok', data: null });", [input])).toBeNull();
    expect(buildRunKeyBatchCode(compiledBundle + "\nconsole.log('trailing');\n", [input])).toBeNull();
    expect(buildRunKeyBatchCode(compiledBundle, [])).toBeNull();
  });
});
