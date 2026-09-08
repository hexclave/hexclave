import fs from 'node:fs'
import path from 'node:path'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { nitro } from 'nitro/vite'
import tsConfigPaths from 'vite-tsconfig-paths'

/**
 * Makes Vite watch specific packages inside node_modules for changes.
 * By default Vite/chokidar ignores all of node_modules. This plugin uses
 * the `config()` hook to inject negation patterns before chokidar is
 * initialized, which is the only reliable way to un-ignore specific packages.
 * See: https://github.com/vitejs/vite/issues/8619
 */
function watchNodeModules(modules: string[]): Plugin {
  return {
    name: 'watch-node-modules',
    config() {
      return {
        server: {
          watch: {
            ignored: modules.map((m) => `!**/node_modules/${m}/**`),
          },
        },
      }
    },
  }
}

/**
 * Waits for workspace package dist directories to exist before letting
 * Vite resolve them. Fixes the race condition where `pnpm dev` starts
 * hosted-components before dependency packages have finished their
 * initial build (eg. after `rimraf dist` in their dev script).
 */
function waitForWorkspacePackages(packages: string[]): Plugin {
  const packageDistEntries = packages.map((pkg) => ({
    name: pkg,
    entry: path.resolve(__dirname, 'node_modules', pkg, 'dist', 'esm', 'index.js'),
  }))

  async function waitForFile(filePath: string, timeoutMs = 60_000): Promise<void> {
    if (fs.existsSync(filePath)) return
    const start = Date.now()
    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (fs.existsSync(filePath)) {
          clearInterval(interval)
          resolve()
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval)
          reject(new Error(`Timed out waiting for ${filePath} to exist`))
        }
      }, 500)
    })
  }

  return {
    name: 'wait-for-workspace-packages',
    enforce: 'pre',
    async buildStart() {
      const missing = packageDistEntries.filter((p) => !fs.existsSync(p.entry))
      if (missing.length > 0) {
        console.log(`Waiting for workspace packages to build: ${missing.map((p) => p.name).join(', ')}`)
        await Promise.all(missing.map((p) => waitForFile(p.entry)))
        console.log('All workspace packages are ready.')
      }
    },
  }
}

export default defineConfig({
  server: {
    port: Number((process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX || "81") + "09"),
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    exclude: ['@hexclave/react', '@hexclave/shared'],
  },
  plugins: [
    waitForWorkspacePackages(['@hexclave/react', '@hexclave/shared']),
    watchNodeModules(['@hexclave/react', '@hexclave/shared']),
    tsConfigPaths(),
    tanstackStart(),
    nitro({
      config: {
        scanDirs: [
          'src/server',
        ],
      },
    }),
    // react's vite plugin must come after start's vite plugin
    viteReact(),
  ],
})
