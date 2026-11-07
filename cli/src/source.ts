import { execFileSync, spawnSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, relative } from 'node:path'
import * as navik from '@navik/sdk'

/**
 * The committed source a release was built from: repo URL, commit, and the built file's path in it
 * (a build directory, packed into one document, ends in `/`).
 */
export type GitSource = { root: string; repo: string; commit: string; output: string }

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function attempt<T>(failure: string, fn: () => T): T {
  try {
    return fn()
  } catch {
    throw new Error(failure)
  }
}

/**
 * Finds the git checkout `file` (or build directory) was built in. The tree must be clean: provenance names a commit,
 * so uncommitted changes would make it a lie.
 */
export function gitSource(file: string, repoOverride?: string): GitSource {
  const path = realpathSync(file)
  const root = attempt(`${dirname(path)} is not in a git checkout`, () => git(dirname(path), 'rev-parse', '--show-toplevel'))
  const dirty = git(root, 'status', '--porcelain', '--untracked-files=no')
  if (dirty) throw new Error(`${root} has uncommitted changes; commit them so the provenance names the source you built:\n${dirty}`)
  const url = repoOverride ?? attempt(`${root} has no usable origin remote; pass --repo`, () => publicUrl(git(root, 'remote', 'get-url', 'origin')))
  const rid = navik.radicleId(url)
  const repo = rid ? `rad://${rid}` : url
  const output = relative(root, path) + (statSync(path).isDirectory() ? '/' : '')
  return { root, repo, commit: git(root, 'rev-parse', 'HEAD'), output }
}

/** git@github.com:org/repo.git → https://github.com/org/repo; credentials are dropped. */
export function publicUrl(remote: string): string {
  const ssh = /^[\w.-]+@([\w.-]+):(.+?)(\.git)?$/.exec(remote)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`
  const url = new URL(remote)
  url.username = ''
  url.password = ''
  return url.href.replace(/\.git$/, '')
}

/**
 * Whether anyone can clone `repo`. Provenance is public, so a private repo's URL must not end up
 * there by default. A `rad://` repo is public when a public seed serves it. Runs outside the
 * checkout and without git config: CI keeps its token there.
 */
export function isPublicRepo(repo: string): boolean {
  const rid = navik.radicleId(repo)
  return rid ? radicleSeed(rid) !== undefined : repo.startsWith('https://') && answers(repo)
}

function answers(url: string): boolean {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  return spawnSync('git', ['ls-remote', url, 'HEAD'], { cwd: tmpdir(), env, stdio: 'ignore', timeout: 15_000 }).status === 0
}

/** Public seeds with an https git endpoint, so a `rad://` repo can be cloned without Radicle installed. */
const RADICLE_SEEDS = ['seed.radicle.at', 'seed.radicle.garden', 'iris.radicle.xyz', 'rosa.radicle.xyz']

const radicleSeed = (rid: string) => RADICLE_SEEDS.map((seed) => `https://${seed}/${rid}.git`).find(answers)

/** `git archive` of a commit: deterministic for a given commit, and it carries the commit id. */
export function gitArchive(root: string, commit: string): Uint8Array {
  return new Uint8Array(execFileSync('git', ['-C', root, 'archive', '--format=tar', commit], { maxBuffer: 1 << 30 }))
}

/** The commit a `git archive` tar was made from (from its pax header), if any. */
export function tarCommit(tar: Uint8Array): string | undefined {
  const r = spawnSync('git', ['get-tar-commit-id'], { input: tar, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() || undefined : undefined
}

export function extractTar(tar: Uint8Array, dir: string) {
  const r = spawnSync('tar', ['-x', '-C', dir], { input: tar })
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`)
}

export function gitCheckout(repo: string, commit: string, dir: string) {
  const rid = navik.radicleId(repo)
  const url = rid ? radicleSeed(rid) : repo
  if (!url) throw new Error(`no public seed serves ${repo}`)
  execFileSync('git', ['clone', '--quiet', url, dir], { stdio: 'inherit' })
  execFileSync('git', ['-C', dir, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', commit], { stdio: 'inherit' })
}

/** Runs a build command; its output is log, so it goes to stderr and stdout stays machine-readable. */
export function runBuild(dir: string, command: string) {
  const r = spawnSync('bash', ['-c', command], { cwd: dir, stdio: ['inherit', 2, 'inherit'] })
  if (r.status !== 0) throw new Error(`build failed (exit ${r.status}): ${command}`)
}
