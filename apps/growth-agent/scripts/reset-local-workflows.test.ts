import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resetLocalWorkflows } from "./reset-local-workflows";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

async function createApp(packageName = "@hexclave/growth-agent") {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "growth-agent-reset-test-"));
  temporaryDirectories.push(appRoot);
  await writeFile(path.join(appRoot, "package.json"), JSON.stringify({ name: packageName }));
  await mkdir(path.join(appRoot, ".eve", ".workflow-data"), { recursive: true });
  await mkdir(path.join(appRoot, ".eve", "logs"), { recursive: true });
  await writeFile(path.join(appRoot, ".eve", ".workflow-data", "run.json"), "active workflow");
  await writeFile(path.join(appRoot, ".eve", "logs", "dev.log"), "diagnostics");
  return appRoot;
}

describe("resetLocalWorkflows", () => {
  test("removes previous workflow sessions while preserving other Eve diagnostics", async () => {
    const appRoot = await createApp();

    await resetLocalWorkflows(appRoot);

    await expect(readFile(path.join(appRoot, ".eve", ".workflow-data", "run.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(appRoot, ".eve", "logs", "dev.log"), "utf8")).resolves.toBe("diagnostics");
  });

  test("refuses to remove data outside the growth-agent package", async () => {
    const appRoot = await createApp("some-other-package");

    await expect(resetLocalWorkflows(appRoot)).rejects.toThrow(
      "Refusing to reset Eve workflows outside @hexclave/growth-agent",
    );
    await expect(readFile(path.join(appRoot, ".eve", ".workflow-data", "run.json"), "utf8")).resolves.toBe("active workflow");
  });
});
