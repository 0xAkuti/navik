import type { Ctx } from './types.ts'

/**
 * eth.limo serves a name by calling the ERC-8121 hook in its `contenthash`. Every Navik name has
 * one: projects from their claim (NavikPages), releases and preview from the release itself.
 */

/** eth.limo refuses larger data URLs (it answers 501). */
export const LIMO_MAX_DATA_URL = 1_000_000
/** Above this, the hook's `eth_call` may pass the RPC's gas cap (50M by default in geth); see test_page_gas. */
export const LIMO_SAFE_SIZE = 450_000

/** `data:text/html;base64,…` of a document of `size` bytes. */
export const dataUrlSize = (size: number) => 'data:text/html;base64,'.length + 4 * Math.ceil(size / 3)

/** A public link to `name`. eth.limo only reads mainnet, so forks have none. */
export const limoUrl = (ctx: Ctx, name: string) => (ctx.deployment.chainId === 1 ? `https://${name}.limo` : undefined)

/** Why eth.limo may not serve a release of `size` stored bytes, if so. */
export function limoWarning(size: number): string | undefined {
  if (dataUrlSize(size) > LIMO_MAX_DATA_URL) {
    return `too large for eth.limo: ${dataUrlSize(size)} byte data URL, the limit is ${LIMO_MAX_DATA_URL}`
  }
  if (size > LIMO_SAFE_SIZE) return `eth.limo may fail above ${LIMO_SAFE_SIZE} bytes: the page can pass an RPC's eth_call gas cap`
  return undefined
}
