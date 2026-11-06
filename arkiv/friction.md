# Friction with Arkiv

What got in our way while integrating `@arkiv-network/sdk@1.0.1` against Rabdi, roughly in order of cost.

## 1. The SDK clients pull all of viem into a browser bundle

**What happened.** Our dashboard is a single HTML file published onchain, so every kilobyte is gas (and download time over a mixnet, ~15–20 KB/s). Adding two queries and two writes with `createPublicClient` / `createWalletClient` grew it from 94 KB to 166 KB gzipped: three more 24 KB chunks, ~16M gas per publish. Both clients call `.extend(publicActions).extend(walletActions)`, which brings in every viem action plus `ox` and `@noble/curves` (signature verification, ENS, …), none of which an Arkiv read or write uses.

**What we did.** Reads: `new SelectQueryBuilder(createClient({ chain, transport }))` on a plain viem client works and is tree-shakable (undocumented; we found it in the source). Writes: the operation encoders (`createOperation`, `encodeCreate`, `sendArkivTransaction`) are not exported, so we re-implemented the `execute` calldata for creates and extensions (~60 lines) and test it byte for byte against the SDK ([`sdk/test/arkiv-encoding.test.ts`](../sdk/test/arkiv-encoding.test.ts)). Result: 104.6 KB gzipped.

**Wish.** Tree-shakable actions (`createEntity(client, …)`, `query(client, …)`, like `viem/actions`), or an exported `encodeExecute(ops)` that returns calldata for any wallet to send.

## 2. Maximum lifetime of ~182.5 days

Our records describe releases that live forever on Ethereum. With a 182.5-day cap, provenance needs someone to keep extending it. `permissionlessExtension` makes this workable (anyone can do it, and we surface a "Keep alive" button and expiry dates), but a record still disappears if nobody acts. **Wish:** a way to pay once for a much longer lifetime, or a protocol-level "renew from a deposit" so a publisher can fund years of extensions up front.

## 3. The access key travels in the URL path

`rabdi({ accessKey })` puts the key in the RPC URL's path. For a dashboard whose build must be byte-reproducible from source, that means either committing the key or leaving it out of the build; we left it out (the public endpoint, rate limited) and let users paste a keyed URL in the privacy panel. Our anonymized reads all arrive from a handful of mixnet exits, so the shared public rate limit is the one most likely to bite. **Wish:** accept the key in a header too (e.g. `X-Api-Key`, which the CORS preflight already allows), and/or a documented rate limit per origin rather than per IP.

## 4. `Content-Type` is mandatory

Rabdi answers `415 Supplied content type is not allowed` to a JSON-RPC POST without `Content-Type: application/json`. Ethereum RPCs we use accept it. This matters for us because Nym's anon-rpc worker (`@nymproject/anon-rpc-worker@0.1.0`) drops request headers. **Steps to reproduce:** `curl -X POST https://rpc.rabdi.db-chain.testnet.arkiv.network -H 'Content-Type:' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'` (the empty `-H` removes the header) → 415. The same request to `https://ethereum-rpc.publicnode.com` → 200. **Expected:** the body parsed as JSON, as most Ethereum RPCs do. We route Arkiv reads over Nox instead; we will report the header bug to Nym as well.

## 5. Smaller papercuts

- **`str` is capped at 128 bytes, indexed or not.** Repo URLs and build commands can exceed it. The SDK rejects them at encode time; we added our own check with a clearer message naming the field. A larger limit for non-indexed strings (or a documented "use `bytes` for long text") would help.
- **`rabdi({ accessKey: '' })` warns on every process,** even when a transport with an explicit URL (e.g. a keyed one, or a local node) is passed, so CLI output always starts with the warning.
- **`$expiresAt` is a block number.** Showing users a date needs the current block and the block time; a `$expiresAtTime` selection or a documented helper would save every app the arithmetic.
- **Trust is entirely on the app.** Anyone can write entities under any schema tag (by design). It was not obvious from the docs that `$creator` (immutable) rather than `$owner` (transferable) is the field to base trust on; a short "who wrote this?" section in the docs would help.
