import { execFileSync, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, relative } from 'node:path'

/** The committed source a release was built from: repo URL, commit, and the built file's path in it. */
export type GitSource = { root: string; repo: string; commit: string; output: string }

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

/**
 * Finds the git checkout `file` was built in. The tree must be clean: provenance names a commit,
 * so uncommitted changes would make it a lie.
 */
export function gitSource(file: string, repoOverride?: string): GitSource {
  const path = realpathSync(file)
  const root = git(dirname(path), 'rev-parse', '--show-toplevel')
  const dirty = git(root, 'status', '--porcelain', '--untracked-files=no')
  if (dirty) throw new Error(`${root} has uncommitted changes; commit them so the provenance names the source you built:\n${dirty}`)
  const repo = repoOverride ?? publicUrl(git(root, 'remote', 'get-url', 'origin'))
  return { root, repo, commit: git(root, 'rev-parse', 'HEAD'), output: relative(root, path) }
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
  execFileSync('git', ['clone', '--quiet', repo, dir], { stdio: 'inherit' })
  execFileSync('git', ['-C', dir, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', commit], { stdio: 'inherit' })
}

export function runBuild(dir: string, command: string) {
  const r = spawnSync('bash', ['-c', command], { cwd: dir, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`build failed (exit ${r.status}): ${command}`)
}
