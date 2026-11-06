// The dashboard writes to Arkiv with calldata built by `provenanceCall`, `attestationCall` and
// `keepAliveCall` instead of Arkiv's wallet client (see arkiv.ts). This checks that calldata is
// byte-identical to what the Arkiv SDK itself sends, by running the SDK against a fake node.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWalletClient, ExpirationTime } from '@arkiv-network/sdk'
import { custom, type Hex } from 'viem'

import * as arkiv from '../src/arkiv.ts'
import {
  ARKIV_LIFETIME_DAYS,
  type ArkivCall,
  AttestationSchema,
  arkivChain,
  attestationCall,
  keepAliveCall,
  ProvenanceSchema,
  provenanceCall,
} from '../src/arkiv.ts'

const FROM = '0x09D1F0ebF181503417b74203A1a924A8145830F5'
const SALT = 0x1234567890abcdef1234567890abcdefn
const HASH = `0x${'ab'.repeat(32)}` as Hex

/** Runs `fn` against Arkiv's wallet client and returns the transaction it tried to send. */
async function sdkSends(fn: (client: ReturnType<typeof client>) => Promise<unknown>): Promise<ArkivCall> {
  let sent: ArkivCall | undefined
  const c = client((method, params) => {
    if (method === 'eth_sendTransaction') {
      const tx = (params as { to: `0x${string}`; data: Hex }[])[0]
      sent = { to: tx.to, data: tx.data }
      throw new Error('captured')
    }
  })
  await fn(c).catch(() => undefined)
  assert.ok(sent, 'the SDK sent no transaction')
  return sent
}

function client(onRequest: (method: string, params: unknown) => void) {
  const chain = arkivChain()
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      onRequest(method, params)
      if (method === 'eth_chainId') return `0x${chain.id.toString(16)}`
      if (method === 'eth_blockNumber') return '0x1000'
      if (method === 'eth_estimateGas') return '0x100000'
      throw new Error(`fake node: unexpected ${method}`)
    },
  })
  return createWalletClient({ chain, transport, account: FROM })
}

const lifetime = () => ExpirationTime.fromDays(ARKIV_LIFETIME_DAYS)
const flags = { readonly: true, permissionlessExtension: true }

test('provenance create matches the Arkiv SDK', async () => {
  const input = {
    chainId: 1,
    site: '0x10e8315d939f1128616C1a9EB864A3768b1cA2E9' as const,
    contentHash: HASH,
    name: '3.app.navik.eth',
    project: 'app.navik.eth',
    version: 3n,
    repo: 'https://github.com/0xAkuti/navik',
    commit: 'f86a646cbdc0b1dd4a8ac0b1c1f0e6e5d5c4b3a2',
    build: 'pnpm install --frozen-lockfile && NAVIK_CHAINS=1 pnpm -C app build',
    output: 'app/dist/index.html',
    sourceSwarm: 'cd'.repeat(32),
    sourceHash: HASH,
    notes: 'first release with provenance ✓',
  }
  // the SDK's own path, with the same values and salt
  const expected = await sdkSends((c) =>
    c.createEntity(ProvenanceSchema, provenanceValuesOf(input), { expiration: lifetime(), flags, salt: SALT }),
  )
  assert.deepEqual(provenanceCall(input, SALT), expected)
})

test('attestation create (optional columns left out) matches the Arkiv SDK', async () => {
  const input = {
    chainId: 31337,
    site: '0x10e8315d939f1128616C1a9EB864A3768b1cA2E9' as const,
    contentHash: HASH,
    name: 'navik.eth',
    result: 'match' as const,
    builtHash: HASH,
    tool: 'navik-dashboard',
  }
  const expected = await sdkSends((c) =>
    c.createEntity(AttestationSchema, attestationValuesOf(input), { expiration: lifetime(), flags, salt: SALT }),
  )
  assert.deepEqual(attestationCall(input, SALT), expected)
})

test('keep-alive extension matches the Arkiv SDK', async () => {
  const keys = [HASH, `0x${'cd'.repeat(32)}` as Hex]
  const expected = await sdkSends((c) =>
    c.executeBatch({ extensions: keys.map((entityKey) => ({ entityKey, expiration: lifetime() })) }),
  )
  assert.deepEqual(keepAliveCall(keys), expected)
})

// the values recordProvenance/attest hand the SDK, captured with a stub client
const provenanceValuesOf = (p: Parameters<typeof arkiv.provenanceCall>[0]) => valuesOf(arkiv.recordProvenance, p)
const attestationValuesOf = (a: Parameters<typeof arkiv.attestationCall>[0]) => valuesOf(arkiv.attest, a)

function valuesOf(fn: (c: never, input: never) => Promise<unknown>, input: unknown): never {
  let values: unknown
  void fn({ createEntity: (_schema: unknown, v: unknown) => ((values = v), Promise.resolve()) } as never, input as never)
  return values as never
}
