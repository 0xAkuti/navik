import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type Address, createPublicClient, createWalletClient, custom, type EIP1193Provider, http } from 'viem'
import { mainnet } from 'viem/chains'
import { normalize } from 'viem/ens'
import './style.css'

// viem's default public RPC for mainnet; any CORS-enabled endpoint works from an onchain site
const client = createPublicClient({ chain: mainnet, transport: http() })
const ethereum = (window as { ethereum?: EIP1193Provider }).ethereum

type Lookup = { name: string; address: Address | null; block: bigint } | { error: string }

function App() {
  const [name, setName] = useState('vitalik.eth')
  const [lookup, setLookup] = useState<Lookup>()
  const [busy, setBusy] = useState(false)
  const [account, setAccount] = useState<Address>()

  async function resolve(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const [address, block] = await Promise.all([client.getEnsAddress({ name: normalize(name) }), client.getBlockNumber()])
      setLookup({ name, address, block })
    } catch (err) {
      setLookup({ error: err instanceof Error ? err.message.split('\n')[0] : String(err) })
    } finally {
      setBusy(false)
    }
  }

  async function connect() {
    if (!ethereum) return
    const [address] = await createWalletClient({ chain: mainnet, transport: custom(ethereum) }).requestAddresses()
    setAccount(address)
  }

  return (
    <main>
      <h1>ENS lookup</h1>
      <p className="lead">A React + viem dapp, built with Vite and served from Ethereum by Navik.</p>
      <form onSubmit={resolve}>
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="ENS name" spellCheck={false} />
        <button disabled={busy}>{busy ? 'Resolving…' : 'Resolve'}</button>
      </form>
      {lookup && 'error' in lookup && <p className="error">{lookup.error}</p>}
      {lookup && 'name' in lookup && (
        <dl>
          <dt>{lookup.name}</dt>
          <dd>{lookup.address ?? 'no address set'}</dd>
          <dt>block</dt>
          <dd>{lookup.block.toString()}</dd>
        </dl>
      )}
      <footer>
        {account ? (
          <span>connected {account}</span>
        ) : (
          <button className="secondary" onClick={connect} disabled={!ethereum}>
            {ethereum ? 'Connect wallet' : 'No wallet found'}
          </button>
        )}
      </footer>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
