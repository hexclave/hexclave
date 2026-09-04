import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { Linter, LegacyESLint } from "@typescript-eslint/utils/ts-eslint";
import * as parser from "@typescript-eslint/parser";
import plugin from "./source/index.ts";

type RuleName = keyof typeof plugin.rules;
type Fixture = { valid: string; invalid: string };

const fixtures = new Map<RuleName, Fixture>([
  ["no-chained-type-assertions", { valid: "const value = 1 as const;", invalid: "const value = (input as unknown) as string;" }],
  ["no-conditional-empty-object-spread", { valid: "const value = { ...input };", invalid: "const value = { ...(enabled ? input : {}) };" }],
  ["no-known-value-widening", { valid: "const value = { id: 1 };", invalid: "const value: unknown = { id: 1 };" }],
  ["no-module-mocking", { valid: "vi.fn(); vi.mock('dependency', () => ({}));", invalid: "import { vi as testing } from 'vitest'; testing.mock('dependency');" }],
  ["no-object-parameters", { valid: "function read(value: User) {}", invalid: "function read(value: object) { return value; }" }],
  ["no-reflect-apply", { valid: "fn(...args);", invalid: "Reflect.apply(fn, null, args);" }],
  ["no-reflect-get", { valid: "value.id;", invalid: "Reflect.get(value, 'id');" }],
  ["no-runtime-typeof", { valid: "type Value = typeof value;", invalid: "typeof value === 'string';" }],
  ["no-shape-in-symbol-names", { valid: "type UserShape = { id: string };", invalid: "const shape = { id: string };" }],
  ["no-unknown-parameters", { valid: "function fail(cause: unknown) {}", invalid: "type Reader = (value: unknown) => string;" }],
  ["no-unknown-returns", { valid: "function read(): User { return user; }", invalid: "function expose(): unknown { return user; }" }],
  ["no-unknown-type-aliases", { valid: "type User = { id: string };", invalid: "type User = unknown;" }],
  ["no-unsafe-dictionary-type", { valid: "export type Users = Record<string, User>;", invalid: "export type Users = Record<string, unknown>;" }],
  ["no-widen-then-assert", { valid: "const value = { id: 1 }; value.id;", invalid: "const value: unknown = { id: 1 }; const user = value as { id: number };" }],
  ["require-safety-comment-for-type-assertion", { valid: "// SAFETY: The boundary parser checked this value.\nconst user = input as User;", invalid: "const user = input as User;" }],
]);

function lint(ruleName: RuleName, code: string) {
  const linter = new Linter();
  linter.defineParser("typescript", parser);
  linter.defineRule(`anti-slop/${ruleName}`, plugin.rules[ruleName]);
  return linter.verify(code, {
    parser: "typescript",
    parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    rules: { [`anti-slop/${ruleName}`]: "error" },
  }, { filename: "fixture.ts" });
}

describe("every exported rule accepts its valid fixture and rejects its invalid fixture", () => {
  test("covers every exported rule", () => {
    assert.equal(fixtures.size, Object.keys(plugin.rules).length);
  });
  for (const [name, fixture] of fixtures) {
    test(name, () => {
      assert.deepEqual(lint(name, fixture.valid), []);
      const messages = lint(name, fixture.invalid);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.ruleId, `anti-slop/${name}`);
      assert.equal(messages[0]?.severity, 2);
    });
  }
});

test("global-only rules respect locally shadowed names", () => {
  assert.deepEqual(lint("no-module-mocking", "function run(vi: TestDouble) { vi.mock('dependency'); }"), []);
  assert.deepEqual(lint("no-reflect-get", "function run(Reflect: Reader) { Reflect.get(value, 'id'); }"), []);
  assert.deepEqual(lint("no-reflect-apply", "function run(Reflect: Caller) { Reflect.apply(fn, null, args); }"), []);
});

test("mapped and inferred type parameters shadow module aliases", () => {
  assert.deepEqual(lint("no-object-parameters", "type Value = object; type Readers<T> = { [Value in keyof T]: (value: Value) => void };"), []);
  assert.deepEqual(lint("no-object-parameters", "type Value = object; type Reader<T> = T extends infer Value ? (value: Value) => void : never;"), []);
});

test("widening follows the referenced variable and compares actual source ranges", () => {
  assert.deepEqual(lint("no-widen-then-assert", "const first: unknown = 1; const second: User = user; const result = second as User;"), []);
  assert.equal(lint("no-widen-then-assert", "const original: User = user; const widened: object = original; const result = widened as User;").length, 1);
});

test("ESLint loads the local package entry and enables every rule", async () => {
  const eslint = new LegacyESLint({
    useEslintrc: false,
    overrideConfig: {
      parser: "@typescript-eslint/parser",
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
      plugins: ["anti-slop"],
      rules: Object.fromEntries(Object.keys(plugin.rules).map(name => [`anti-slop/${name}`, "error"])),
    },
  });
  const [result] = await eslint.lintText("const user = input as User;", { filePath: "fixture.ts" });
  assert.ok(result);
  assert.deepEqual(result.messages.map(message => message.ruleId), ["anti-slop/require-safety-comment-for-type-assertion"]);
});

test("the shared repository config enables all rules and ignores installed agent assets", async () => {
  const cwd = fileURLToPath(new URL("../../../packages/template/", import.meta.url));
  const eslint = new LegacyESLint({ cwd });
  const config = await eslint.calculateConfigForFile("src/index.ts");
  for (const name of Object.keys(plugin.rules)) {
    const configuredRule = config.rules?.[`anti-slop/${name}`];
    if (name === "no-runtime-typeof") {
      assert.deepEqual(configuredRule, ["error", { allowInTypeGuards: true, allowInValidationFunctions: true }]);
    } else {
      assert.deepEqual(configuredRule, ["error"]);
    }
  }
  assert.equal(await eslint.isPathIgnored("src/.agents/installed.ts"), true);
  assert.equal(await eslint.isPathIgnored("src/.codex/installed.ts"), true);
});
