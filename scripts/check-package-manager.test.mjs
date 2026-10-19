import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { packageManager } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const pinnedAgent = packageManager.split('+')[0].replace('@', '/');
function check(agent) {
  return spawnSync(process.execPath, [new URL('./check-package-manager.mjs', import.meta.url).pathname], {
    env: { ...process.env, npm_config_user_agent: agent }, encoding: 'utf8',
  });
}
test('the pinned installer works offline before dependencies exist', () => {
  assert.equal(check(`${pinnedAgent} npm/? node/v24.22.0 linux x64`).status, 0);
});
test('a different installer or pnpm version cannot run install hooks', () => {
  for (const agent of ['npm/11.0.0', 'bun/1.3.14', 'pnpm/11.5.0', `${pinnedAgent}-modified`, '']) {
    const result = check(agent);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Use the pinned package manager/);
  }
});
