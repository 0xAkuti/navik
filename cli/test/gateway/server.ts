/**
 * What eth.limo does for `<name>.limo`, on a local fork: the same libraries and the same steps as
 * ethlimo/dweb-proxy-api (EnsService.getEnsContentHash and resolveDataUrl, DataUrlProxy). Serves
 * `http://<name>.localhost:<port>/`, or a request with that Host header.
 *
 *   node server.ts <rpc> <port>
 */
import { createServer } from 'node:http'
import '@ensdomains/ethers-patch-v6'
import { detectAndDecodeHook, executeHook } from '@ethlimo/ens-hooks'
import { JsonRpcProvider } from 'ethers'

const [rpc = 'http://127.0.0.1:8545', port = '8588'] = process.argv.slice(2)
const MAX_DATA_URL = 1_000_000 // configuration.dataurl.maxLengthOfDataUrlInBytes

const probe = new JsonRpcProvider(rpc)
const chainId = Number((await probe.getNetwork()).chainId)
probe.destroy()
const provider = new JsonRpcProvider(rpc, chainId, { staticNetwork: true })

async function contenthash(name: string): Promise<string> {
  const resolver = await provider.getResolver(name)
  if (!resolver) throw new Error(`no resolver for ${name}`)
  try {
    return (await resolver.getContentHash()) ?? ''
  } catch (e) {
    const err = e as { code?: string; info?: { data?: string } }
    if (err.code === 'UNSUPPORTED_OPERATION' && err.info?.data) return err.info.data
    throw e
  }
}

async function dataUrl(name: string): Promise<string> {
  const hook = await detectAndDecodeHook(await contenthash(name))
  if (!hook) throw new Error(`${name} has no hook`)
  if (hook.target.chainId !== chainId) throw new Error('chainId mismatch')
  const ret = await executeHook(hook, { providerMap: new Map([[chainId, provider]]) })
  if (ret._tag === 'HookExecutionError') throw new Error(ret.message)
  return Buffer.from(ret.data.slice(2), 'hex').toString('utf8')
}

createServer(async (req, res) => {
  const name = (req.headers.host ?? '').split(':')[0].replace(/\.localhost$/, '')
  try {
    const data = await dataUrl(name)
    if (Buffer.byteLength(data) > MAX_DATA_URL) {
      res.writeHead(501).end('Data URL too large')
      return
    }
    const m = /^data:([^;]+)(;base64)?,(.*)$/.exec(data)
    if (!m) {
      res.writeHead(400).end('Invalid data URL')
      return
    }
    const body = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8')
    res.writeHead(200, { 'Content-Type': m[1], 'Content-Disposition': 'inline', 'Content-Length': body.length })
    res.end(body)
  } catch (e) {
    res.writeHead(502).end(e instanceof Error ? e.message : String(e))
  }
}).listen(Number(port), () => console.log(`limo gateway on ${port}, chain ${chainId}`))
