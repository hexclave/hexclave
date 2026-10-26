import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { packageManager } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const pinnedAgent = packageManager.split('+')[0].replace('@', '/');
function check(agent) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('./check-package-manager.mjs', import.meta.url))], {
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

test('workspace Corepack pins agree when a command starts inside a package', () => {
  const root = new URL('../', import.meta.url);
  const manifests = ['docs-mintlify/package.json', 'docker/tools/package.json'];
  for (const group of ['apps', 'examples', 'packages']) {
    for (const entry of readdirSync(new URL(group, root), { withFileTypes: true })) {
      if (entry.isDirectory()) manifests.push(`${group}/${entry.name}/package.json`);
    }
  }
  for (const manifest of manifests) {
    let content;
    try {
      content = readFileSync(new URL(manifest, root), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const actual = JSON.parse(content).packageManager;
    if (actual !== undefined) assert.equal(actual, packageManager, manifest);
  }
});

test('preinstall generates a synthetic SDK fixture without node_modules or tsx', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'hexclave-bootstrap.untracked-'));
  try {
    mkdirSync(path.join(fixture, 'scripts'));
    mkdirSync(path.join(fixture, 'packages/template'), { recursive: true });
    const source = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ packageManager }));
    for (const file of ['check-package-manager.mjs', 'generate-sdks.ts', 'utils.ts']) {
      cpSync(new URL(file, import.meta.url), path.join(fixture, 'scripts', file));
    }
    writeFileSync(path.join(fixture, 'packages/template/package-template.json'), '{"name":"fixture"}');
    writeFileSync(path.join(fixture, 'packages/template/example.ts'), '// IF_PLATFORM js\nexport const platform = "js";\n// ELSE_PLATFORM\nexport const platform = "react-like";\n// END_PLATFORM\n');
    const result = spawnSync(source.scripts['pre-preinstall'], {
      cwd: fixture, shell: true, encoding: 'utf8',
      env: { ...process.env, npm_config_user_agent: `${pinnedAgent} npm/? node/v24`, HEXCLAVE_SKIP_TEMPLATE_GENERATION: 'false' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(path.join(fixture, 'packages/js/example.ts'), 'utf8'), /platform = "js"/);
    assert.match(readFileSync(path.join(fixture, 'packages/react/example.ts'), 'utf8'), /platform = "react-like"/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
