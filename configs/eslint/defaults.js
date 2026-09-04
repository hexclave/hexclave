module.exports = {
  extends: [],
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint", "anti-slop"],
  ignorePatterns: [
    "**/.agent/**",
    "**/.agents/**",
    "**/.claude/**",
    "**/.codex/**",
    "**/.continue/**",
    "**/.cursor/**",
    "**/.gemini/**",
    "**/.opencode/**",
    "**/.pi/**",
    "**/.roo/**",
    "**/.windsurf/**",
    "../../tools/eslint/anti-slop/**",
    // The template is the source of truth for these generated SDK mirrors.
    // Linting every copy multiplies the same diagnostic and invites edits to
    // files that the generator will overwrite.
    "../../packages/js/src/**",
    "../../packages/next/src/**",
    "../../packages/react/src/**",
    "../../packages/tanstack-start/src/**",
    "../js/src/**",
    "../next/src/**",
    "../react/src/**",
    "../tanstack-start/src/**",
    "../packages/js/src/**",
    "../packages/next/src/**",
    "../packages/react/src/**",
    "../packages/tanstack-start/src/**",
  ],
  parserOptions: {
    // use the package folder as the root for the TS ESLint plugin
    project: "./tsconfig.json",
    tsconfigRootDir: process.cwd(),
  },
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true, allowInValidationFunctions: true }],
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "no-unused-expressions": ["error", { enforceForJSX: true }],
    "no-trailing-spaces": "warn",
    "eol-last": "error",
    "key-spacing": "error",
    "object-curly-spacing": ["error", "always"],
    indent: [
      "error",
      2,
      {
        SwitchCase: 1,
        ignoredNodes: [
          "TSIntersectionType",
          "TSTypeParameter",
          "TSTypeParameterDeclaration",
          "TSTypeParameterInstantiation",
          "TSUnionType",
          "ConditionalType",
          "TSConditionalType",
          "FunctionDeclaration",
          "CallExpression",
          "TemplateLiteral *",
        ],
      },
    ],
    "keyword-spacing": "warn",
    "block-spacing": "warn",
    "max-statements-per-line": "warn",
    semi: ["error", "always"],
    "no-fallthrough": "error",
    "@typescript-eslint/switch-exhaustiveness-check": ["error", {
      "considerDefaultExhaustiveForUnions": true,
    }],
    "@typescript-eslint/no-floating-promises": [
      "error",
      {
        ignoreVoid: false,
      },
    ],
    "no-return-await": "off",
    "@typescript-eslint/return-await": ["error", "always"],
    "no-multiple-empty-lines": "warn",
    "@typescript-eslint/await-thenable": "error",
    // TODO: Re-introduce this rule when we migrate to the Stylistic plugin/ESLint 9+
    /*"@typescript-eslint/member-delimiter-style": [
      "error",
      {
        multiline: {
          delimiter: "comma",
        },
        singleline: {
          delimiter: "comma",
          requireLast: false,
        },
        multilineDetection: "brackets",
      },
    ],*/
    "@typescript-eslint/no-unnecessary-condition": [
      "error",
      { allowConstantLoopConditions: true },
    ],
    "no-restricted-syntax": [
      "error",
      {
        selector: 'SwitchCase > *.consequent[type!="BlockStatement"]',
        message: "Switch cases without blocks are disallowed.",
      },
      {
        selector: "CallExpression[callee.property.name='catch']:has(MemberExpression[object.name='console'])",
        message: "Don't do .catch(console.error). Please handle errors explicitly, eg. with runAsynchronously or runAsynchronouslyWithAlert.",
      },
      {
        selector:
          "MemberExpression:has(Identifier[name='yupString']) > Identifier[name='url']",
        message:
          "Use urlSchema from schema-fields.tsx instead of yupString().url().",
      },
      {
        selector:
          "CallExpression > MemberExpression > Identifier[name='required']",
        message:
          `Use .defined(), .nonNullable(), or .nonEmpty() instead of .required(), as the latter has inconsistent/unexpected behavior on strings.`,
      },
      {
        selector:
          "CallExpression > MemberExpression:has(Identifier[name='yupString']) > Identifier[name='email']",
        message:
          `Use emailSchema instead of yupString().email().`,
      },
      {
        selector:
          "MemberExpression:has(Identifier[name='yup']):has(Identifier[name='string'], Identifier[name='number'], Identifier[name='boolean'], Identifier[name='array'], Identifier[name='object'], Identifier[name='tuple'], Identifier[name='date'], Identifier[name='mixed'])",
        message: "Use yupXyz() from schema-fields.tsx instead of yup.xyz().",
      },
      {
        selector:
          "Identifier[name='localeCompare']",
        message: "Use stringCompare() from utils/strings.tsx instead of String.prototype.localeCompare.",
      },
      {
        selector: "CallExpression > MemberExpression[property.name='$transaction']",
        message: "Calling .$transaction is disallowed. Use retryTransaction() instead.",
      },
      {
        selector: "ImportDeclaration[source.value='react'] ImportSpecifier[imported.name='use']",
        message: "Use `use` from @stack-shared/dist/utils/react instead (as it also supports React 18).",
      },
    ],
    "@typescript-eslint/no-misused-promises": [
      "error",
      {
        checksConditionals: true,
      },
    ],
    "@typescript-eslint/require-array-sort-compare": "error",
    "@typescript-eslint/consistent-type-definitions": ["error", "type"],
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["@vercel/functions"],
            importNames: ["waitUntil"],
            message:
              'Use runAsynchronouslyAndWaitUntil instead.',
          },
        ],
      },
    ],
  },
};
