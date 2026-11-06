// A stand-in for the two bee API calls Navik uses (POST /bzz, GET /bzz/<ref>/), for tests without
// a postage batch. References are sha256 digests, not Swarm addresses: it checks Navik's upload,
// download and hash pinning, not Swarm itself.
//
//   node cli/test/swarm-stub.ts <port>
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 1633)
const files = new Map<string, Buffer>()

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'POST' && url.pathname === '/bzz') {
    if (!req.headers['swarm-postage-batch-id']) return void res.writeHead(400).end('missing swarm-postage-batch-id')
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => {
      const body = Buffer.concat(parts)
      const reference = createHash('sha256').update(body).digest('hex')
      files.set(reference, body)
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ reference }))
    })
    return
  }
  const ref = /^\/bzz\/([0-9a-f]{64})\/?$/.exec(url.pathname)?.[1]
  const file = ref && files.get(ref)
  if (req.method === 'GET' && file) return void res.writeHead(200, { 'content-type': 'application/x-tar' }).end(file)
  res.writeHead(404).end('not found')
}).listen(port, '127.0.0.1', () => console.log(`swarm stub on http://127.0.0.1:${port}`))
