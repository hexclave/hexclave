import type { TSESLint } from "@typescript-eslint/utils";

export type { TSESTree as ESTree } from "@typescript-eslint/utils";
export type Scope = TSESLint.Scope.Scope;
export type SourceCode = TSESLint.SourceCode;
export type Variable = TSESLint.Scope.Variable;

type Rule = TSESLint.RuleModule<string, readonly unknown[]>;
type RuleDefinition = {
  readonly meta: Omit<Rule["meta"], "schema"> & { readonly schema?: Rule["meta"]["schema"] };
  readonly createOnce: Rule["create"];
};

/** ESLint creates a fresh listener per file, including each rule's closure state. */
export function defineRule(definition: RuleDefinition): Rule {
  return {
    meta: { schema: [], ...definition.meta },
    create: definition.createOnce,
  };
}

export function definePlugin<const Plugin>(plugin: Plugin): Plugin {
  return plugin;
}
