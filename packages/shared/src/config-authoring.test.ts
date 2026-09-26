import { expect, it } from "vitest";
import { defineStackConfig, type HexclaveEnvVarValue, type StackConfig } from "./config-authoring";
import { typeAssertExtends } from "./utils/types";

const validConfig = defineStackConfig({
  payments: {
    items: {
      todos: {
        displayName: "Todo Slots",
        customerType: "user",
      },
    },
  },
});
const showOnboardingConfig = defineStackConfig("show-onboarding");

typeAssertExtends<typeof validConfig, StackConfig>()();
typeAssertExtends<typeof showOnboardingConfig, StackConfig>()();

it("returns its input unchanged", () => {
  expect(defineStackConfig(validConfig)).toBe(validConfig);
  expect(defineStackConfig(showOnboardingConfig)).toBe(showOnboardingConfig);
});

defineStackConfig({
  // @ts-expect-error Top-level dot notation should not be accepted in typed config files.
  "payments.items": {
    todos: {
      displayName: "Todo Slots",
      customerType: "user",
    },
  },
});

defineStackConfig({
  payments: {
    // @ts-expect-error Unknown keys should not be accepted in typed config files.
    missingField: true,
  },
});

defineStackConfig({
  payments: {
    items: {
      todos: {
        displayName: "Todo Slots",
        // @ts-expect-error Invalid enum values should fail type-checking.
        customerType: "workspace",
      },
    },
  },
});

// Environment objects mirror the CLI: at least one environment, and
// `undefined` only on the others (conditional spreads).
const envVarValues: HexclaveEnvVarValue[] = [
  "literal",
  null,
  undefined,
  { all: "a" },
  { prod: null },
  { all: "a", dev: undefined },
  // @ts-expect-error The CLI rejects an empty environment object.
  {},
  // @ts-expect-error An object whose only environment is undefined is empty too.
  { dev: undefined },
  // @ts-expect-error Unknown environments fail type-checking, as they fail in the CLI.
  { all: "a", staging: "s" },
];
it("accepts the env var shapes the CLI accepts", () => {
  expect(envVarValues).toHaveLength(9);
});
