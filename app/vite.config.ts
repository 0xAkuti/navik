import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Navik deployments are embedded at build time; NAVIK_CHAINS=1 builds a mainnet-only app.
const dir = resolve(import.meta.dirname, '../contracts/deployments')
const chains = process.env.NAVIK_CHAINS?.split(',').map((c) => c.trim())
const deployments = Object.fromEntries(
  readdirSync(dir)
    .map((f) => /^(\d+)\.json$/.exec(f)?.[1])
    .filter((id): id is string => !!id && (!chains || chains.includes(id)))
    .map((id) => [id, JSON.parse(readFileSync(resolve(dir, `${id}.json`), 'utf8'))]),
)
if (Object.keys(deployments).length === 0) throw new Error(`no deployments found in ${dir} for ${chains ?? 'any chain'}`)

export default defineConfig({
  plugins: [preact(), viteSingleFile()],
  define: { __NAVIK_DEPLOYMENTS__: JSON.stringify(deployments) },
  build: { target: 'es2022', reportCompressedSize: false },
})
