// Bundles tests/e2e.ts with esbuild (so `?raw` imports work like in Vite) and runs it with Node.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

const raw = {
  name: 'raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: resolve(dirname(a.importer), a.path.replace(/\?raw$/, '')), namespace: 'raw' }))
    b.onLoad({ filter: /.*/, namespace: 'raw' }, (a) => ({ contents: readFileSync(a.path, 'utf8'), loader: 'text' }))
  },
}
await build({ entryPoints: ['tests/e2e.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.e2e/e2e.mjs', plugins: [raw], external: ['postgres'], logLevel: 'warning' })
const r = spawnSync(process.execPath, ['.e2e/e2e.mjs'], { stdio: 'inherit', env: process.env })
process.exit(r.status ?? 1)
