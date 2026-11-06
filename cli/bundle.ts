// Bundles the CLI into one file (dist/navik.js) for npm and the GitHub Action: no workspace, no
// TypeScript at runtime. Public Navik deployments are embedded, so it works outside this repo;
// local forks (31337) are not. Playwright stays external: only --smoke and --anon need it.
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'rolldown'

import { buildAnonPage } from './src/anon-build.ts'

const dir = resolve(import.meta.dirname, '../contracts/deployments')
const deployments = Object.fromEntries(
  readdirSync(dir)
    .map((f) => /^(\d+)\.json$/.exec(f)?.[1])
    .filter((id): id is string => !!id && id !== '31337')
    .map((id) => [id, JSON.parse(readFileSync(resolve(dir, `${id}.json`), 'utf8'))]),
)
const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8'))

await build({
  input: resolve(import.meta.dirname, 'src/cli.ts'),
  platform: 'node',
  external: ['playwright'],
  transform: {
    define: {
      __NAVIK_DEPLOYMENTS__: JSON.stringify(deployments),
      __NAVIK_CLI_VERSION__: JSON.stringify(version),
      __NAVIK_ANON_PAGE__: JSON.stringify(await buildAnonPage()),
    },
  },
  output: { file: resolve(import.meta.dirname, 'dist/navik.js'), format: 'esm', codeSplitting: false },
})
console.log(`dist/navik.js (embedded deployments: ${Object.keys(deployments).join(', ') || 'none yet'})`)
