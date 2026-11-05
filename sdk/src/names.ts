import { type Hex, keccak256, toBytes, toHex } from 'viem'

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

/** EAC resource for a text key on a Permissioned Resolver. */
export function textResource(key: string): bigint {
  return BigInt(keccak256(toBytes(key)))
}

/** Mirrors NavikNames.isValidProjectLabel. */
export function isValidProjectLabel(label: string): boolean {
  if (!/^[a-z0-9-]{3,63}$/.test(label)) return false
  if (label.startsWith('-') || label.endsWith('-') || label.includes('--')) return false
  return parseReleaseLabel(label) === undefined
}

/** `<project>-v<N>` → { project, version }, mirrors NavikNames.parseVersionLabel. */
export function parseReleaseLabel(label: string): { project: string; version: bigint } | undefined {
  const m = /^(.+)-v([1-9][0-9]{0,18})$/.exec(label)
  if (!m) return undefined
  return { project: m[1], version: BigInt(m[2]) }
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
