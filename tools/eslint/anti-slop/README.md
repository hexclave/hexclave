# Anti-slop ESLint rules

This local plugin ports the 15 rules bundled with the `install-anti-slop` skill to ESLint 8 and `@typescript-eslint/parser`. The shared configuration in `configs/eslint/defaults.js` enables every rule at error severity. Existing application findings are not suppressed or automatically fixed.

The root dependency links this directory as `eslint-plugin-anti-slop`. Node 24, already required by the repository, loads the TypeScript source through `index.cjs`. No Oxlint dependency or build step is needed. `@typescript-eslint/utils` supplies the parser and rule API types only.

The port uses ESLint source ranges, mapped-type parameters, and scope APIs. Parentheses are already unwrapped by the TypeScript ESLint parser. Each rule receives fresh per-file state.

Run `pnpm test:anti-slop` for rule and package-loading tests, and `pnpm typecheck:anti-slop` for the source and test typecheck. Both are included in the repository's corresponding test or typecheck setup.

For a package/rule breakdown of a captured repository lint run, use `node tools/eslint/anti-slop/summarize-lint.mjs <lint-log>`. Counts reflect emitted diagnostics, including generated SDK copies when those copies are present.
