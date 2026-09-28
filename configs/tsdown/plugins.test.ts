import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBasePlugin } from './plugins.ts';

describe('tsdown base plugin', () => {
  it('uses the package owning the transformed module for the client version label', async () => {
    const plugin = createBasePlugin({});
    if (typeof plugin.transform !== 'function') {
      throw new Error('Expected the tsdown base plugin to define a transform hook.');
    }

    if (typeof plugin.buildStart !== 'function') {
      throw new Error('Expected the tsdown base plugin to define a buildStart hook.');
    }
    const packageRoot = fileURLToPath(new URL('../../packages/js', import.meta.url));
    Reflect.apply(plugin.buildStart, undefined, [{ cwd: packageRoot }]);
    const result = await Reflect.apply(plugin.transform, undefined, [
      'const clientVersion = "STACK_COMPILE_TIME_CLIENT_PACKAGE_VERSION_SENTINEL";',
      `${packageRoot}/src/lib/hexclave-app/apps/implementations/common.ts`,
      {},
    ]);

    expect(result).not.toBeNull();
    expect(typeof result === 'string' ? result : result?.code).toMatch(/js @hexclave\/js@\d+\.\d+\.\d+/);
    expect(typeof result === 'string' ? result : result?.code).not.toContain('@hexclave/monorepo@0.0.0');
  });

  it('resolves the package root when tsdown cwd is a nested config directory', async () => {
    const plugin = createBasePlugin({});
    if (typeof plugin.transform !== 'function') {
      throw new Error('Expected the tsdown base plugin to define a transform hook.');
    }

    if (typeof plugin.buildStart !== 'function') {
      throw new Error('Expected the tsdown base plugin to define a buildStart hook.');
    }
    const packageRoot = fileURLToPath(new URL('../../apps/backend', import.meta.url));
    const nestedConfigDirectory = join(packageRoot, 'scripts');
    Reflect.apply(plugin.buildStart, undefined, [{ cwd: nestedConfigDirectory }]);
    const result = await Reflect.apply(plugin.transform, undefined, [
      'const clientVersion = "STACK_COMPILE_TIME_CLIENT_PACKAGE_VERSION_SENTINEL";',
      join(packageRoot, 'src/index.ts'),
      {},
    ]);

    expect(result).not.toBeNull();
    expect(typeof result === 'string' ? result : result?.code).toMatch(/js @hexclave\/backend@\d+\.\d+\.\d+/);
    expect(typeof result === 'string' ? result : result?.code).not.toContain('@hexclave/monorepo@0.0.0');
  });
});
