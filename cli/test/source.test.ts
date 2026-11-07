import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { gitSource } from '../src/source.ts'

const rid = 'z2v1RB3h2i7GWNbGQvqNaXsrPrHx1'
const peer = 'z6MknMmVRgJS1QifUopYkB658YPam1ywxs4XZZwLbjjAD2dZ'

const dir = mkdtempSync(join(tmpdir(), 'navik-source-'))
const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
const site = join(dir, 'site.html')
git('init', '--quiet')
writeFileSync(site, '<p>hi</p>')
git('add', '.')
git('commit', '--quiet', '-m', 'site')
after(() => rmSync(dir, { recursive: true, force: true }))

test('a Radicle remote is recorded as the repo, without the peer', () => {
  git('remote', 'add', 'origin', `rad://${rid}/${peer}`)
  assert.equal(gitSource(site).repo, `rad://${rid}`)
})

test('--repo accepts the rad: form the rad CLI prints', () => {
  assert.equal(gitSource(site, `rad:${rid}`).repo, `rad://${rid}`)
})

test('https repos are recorded as given', () => {
  const repo = `https://seed.radicle.at/${rid}.git`
  assert.equal(gitSource(site, repo).repo, repo)
})
