import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'configs',
  'packages/*',
  'apps/*',
  'docs',
  'examples/*',
]);
