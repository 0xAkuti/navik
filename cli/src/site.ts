import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { packSite, type PackResult, type SiteFiles, wrapCompressed } from '@navik/sdk'

import { runBuild } from './source.ts'

/**
 * `navik.json`, next to the site's package.json: what `navik deploy` (no arguments) builds and
 * ships, and what provenance records, so CI and anyone reproducing a release run the same command.
 */
export type SiteConfig = {
  /** the project under navik.eth, e.g. "portfolio" */
  project: string
  /** shell command run in this directory that produces `output` */
  build?: string
  /** the built site: a directory (packed into one document, e.g. "dist") or one HTML file */
  output: string
  /** store gzip-wrapped (default: for a directory, when that is smaller; never for a file) */
  compress?: boolean
}

export type LoadedConfig = SiteConfig & { dir: string; file: string }

export const CONFIG_FILE = 'navik.json'

/** Finds navik.json in `from` or its parents. */
export function findConfig(from = process.cwd()): LoadedConfig | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const file = join(dir, CONFIG_FILE)
    if (existsSync(file)) return loadConfig(file)
    if (dirname(dir) === dir) return undefined
  }
}

function loadConfig(file: string): LoadedConfig {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SiteConfig>
  const bad = (msg: string) => new Error(`${file}: ${msg}`)
  if (typeof raw.project !== 'string' || !raw.project) throw bad('"project" is required')
  if (typeof raw.output !== 'string' || !raw.output) throw bad('"output" is required (e.g. "dist")')
  if (raw.build !== undefined && typeof raw.build !== 'string') throw bad('"build" must be a shell command')
  if (raw.compress !== undefined && typeof raw.compress !== 'boolean') throw bad('"compress" must be true or false')
  return { ...(raw as SiteConfig), dir: dirname(file), file }
}

/** Runs the configured build in the config's directory. */
export function buildSite(config: LoadedConfig) {
  if (!config.build) throw new Error(`${config.file} has no "build" command; build yourself and pass --skip-build`)
  console.log(`build        ${config.build}`)
  runBuild(config.dir, config.build)
}

/**
 * The command to record as provenance: it is re-run at the repo root, so a site in a
 * subdirectory (a monorepo package) gets a `cd` in front.
 */
export function recordedBuild(config: LoadedConfig, gitRoot: string): string {
  const sub = relative(gitRoot, config.dir)
  return sub ? `cd ${sub} && ${config.build}` : config.build!
}

export type Site = { bytes: Uint8Array; pack?: PackResult }

/** The document a path deploys: an HTML file as is, a build directory packed into one document. */
export function readSite(path: string): Site {
  if (!statSync(path).isDirectory()) return { bytes: new Uint8Array(readFileSync(path)) }
  const pack = packSite(readTree(path))
  return { bytes: pack.html, pack }
}

function readTree(root: string): SiteFiles {
  const files: SiteFiles = {}
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files[relative(root, path).split('\\').join('/')] = new Uint8Array(readFileSync(path))
    }
  }
  walk(root)
  return files
}

/** Whether to store gzip-wrapped: as asked, else for a packed directory when it saves bytes. */
export async function shouldCompress(site: Site, asked?: boolean): Promise<boolean> {
  if (asked !== undefined || !site.pack) return asked ?? false
  return (await wrapCompressed(site.bytes)).length < site.bytes.length
}

/** One line on what packing did, and what it left out (other pages, unreferenced files). */
export function describePack(pack: PackResult): string[] {
  const lines = [`packed       ${pack.inlined.length} file(s) inlined into one document`]
  const pages = pack.unused.filter((p) => p.endsWith('.html'))
  if (pages.length) lines.push(`  ⚠ only index.html is served; not included: ${pages.join(', ')}`)
  const other = pack.unused.filter((p) => !p.endsWith('.html'))
  if (other.length) lines.push(`  ⚠ not referenced, not included: ${other.join(', ')}`)
  return lines
}
