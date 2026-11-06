import { type Hex, hexToBytes, keccak256, toBytes, toHex } from 'viem'

/** DNS wire-format encoding used by ENS (ENSIP-10). */
export function dnsEncode(name: string): Hex {
  const labels = name.split('.').filter((l) => l.length > 0)
  const parts: number[] = []
  for (const label of labels) {
    const bytes = toBytes(label)
    if (bytes.length > 255) throw new Error(`label too long: ${label}`)
    parts.push(bytes.length, ...bytes)
  }
  parts.push(0)
  return toHex(new Uint8Array(parts))
}

/** Inverse of dnsEncode: `0x05616c69636503657468 00` → `alice.eth`. */
export function dnsDecode(dns: Hex): string {
  const bytes = hexToBytes(dns)
  const labels: string[] = []
  for (let i = 0; i < bytes.length && bytes[i] !== 0; i += bytes[i] + 1) {
    labels.push(new TextDecoder().decode(bytes.subarray(i + 1, i + 1 + bytes[i])))
  }
  return labels.join('.')
}

/** EAC resource for a text key on a Permissioned Resolver. */
export function textResource(key: string): bigint {
  return BigInt(keccak256(toBytes(key)))
}

/** Mirrors NavikNames.isValidProjectLabel. */
export function isValidProjectLabel(label: string): boolean {
  if (!/^[a-z0-9-]{3,63}$/.test(label)) return false
  return !(label.startsWith('-') || label.endsWith('-') || label.includes('--'))
}

/** Accepts `v3`, `3` → 3n. */
export function parseVersion(v: string): bigint {
  const m = /^v?([1-9][0-9]*)$/.exec(v)
  if (!m) throw new Error(`invalid version "${v}" (expected v1, v2, …)`)
  return BigInt(m[1])
}

/** `contentcontract` values: plain hex or ERC-3770 (`eth:0x…`). */
export function parseContentContract(value: string): Hex | undefined {
  const m = /^(?:[a-z0-9-]+:)?(0x[0-9a-fA-F]{40})$/.exec(value.trim())
  return m ? (m[1] as Hex) : undefined
}
