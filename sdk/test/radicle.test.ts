import assert from 'node:assert/strict'
import { test } from 'node:test'

import { radicleId } from '../src/arkiv.ts'

const rid = 'z2v1RB3h2i7GWNbGQvqNaXsrPrHx1'

test('radicleId reads the repo id from every Radicle URL form', () => {
  assert.equal(radicleId(`rad://${rid}`), rid)
  assert.equal(radicleId(`rad:${rid}`), rid)
  assert.equal(radicleId(`rad://${rid}/z6MknMmVRgJS1QifUopYkB658YPam1ywxs4XZZwLbjjAD2dZ`), rid)
})

test('radicleId ignores everything else', () => {
  for (const repo of ['https://github.com/org/repo', `https://seed.radicle.at/${rid}.git`, 'rad://', 'rad://not-base58!', `xrad://${rid}`])
    assert.equal(radicleId(repo), undefined, repo)
})
