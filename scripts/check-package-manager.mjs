import { readFileSync } from 'node:fs';

// Keep the installer check offline and available before node_modules exists.
const { packageManager } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const expected = packageManager.split('+')[0].replace('@', '/');
if (!(process.env.npm_config_user_agent ?? '').startsWith(`${expected} `)) {
  throw new Error(`Use the pinned package manager (${packageManager}) through Corepack.`);
}
