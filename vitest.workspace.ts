import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'configs',
  'tools/eslint/anti-slop',
  'packages/*',
  'apps/*',
  'docs',
  'examples/*',
]);
