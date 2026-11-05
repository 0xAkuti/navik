# Navik

Vercel-style deployments for fully onchain websites, controlled by ENSv2.

```text
navik deploy portfolio ./index.html --promote

release      3.portfolio.navik.eth
size         21,402 / 24,575 bytes
address      0x7469…c9Be (known before upload)
promoted     portfolio.navik.eth → 3.portfolio.navik.eth
```

- **Every release is an immutable ERC-8244 contract.** `html()` returns the site, stored in contract bytecode on Ethereum in chunks of up to 24,575 bytes. Sites can be up to about 1.5 MB; unchanged chunks are never uploaded twice.
- **Every release gets a permanent name:** `<N>.<project>.navik.eth`, a real ENSv2 subname in the project's own registry, with no expiry and no roles. Nobody can change, transfer or remove it, including us and the project owner. `preview.<project>.navik.eth` follows the newest release.
- **Production is `<project>.navik.eth`.** It is one `contentcontract` text record on the project's own ENSv2 Permissioned Resolver, so promote, rollback and demote are each one ENS write.
- **Who may deploy is an ENSv2 permission.** The project owner grants a key "publish releases" and/or "change production", for that project only, and can revoke it at any time.
- **Reading is private by default.** The dashboard and its built-in site viewer send every chain read through an [anon-rpc](https://ethereum.github.io/anon-rpc/) network (Nym by default). The RPC provider sees a mixnet exit, not who is looking at which project or site.
- **Anyone can check that a site matches its source.** `navik verify <name> --against <build>` and `scripts/reproduce.sh` rebuild a site from its repo and compare it byte for byte with what the name serves.

## How it works

```text
navik.eth                         resolver: NavikResolver (serves app.navik.eth's production: the dashboard)
│                                 subregistry: Navik registry (no admin, parent locked)
└─ portfolio.navik.eth            owner: alice · resolver: alice's Permissioned Resolver
   │                                text contentcontract = 0x…v3   ← production (alice, or a key she granted)
   │                              subregistry: portfolio's release registry (no admin, parent locked,
   │                                the factory is its only registrar; alice cannot swap it)
   ├─ 1.portfolio.navik.eth       ┐ registered by each publish: held by the factory, no roles,
   ├─ 2.portfolio.navik.eth       ├ never expires; resolver = the release contract itself
   ├─ 3.portfolio.navik.eth       ┘
   └─ preview.portfolio.navik.eth   resolver repointed by the factory to the newest release
```

A custom domain can share a project's namespace. If `alice.eth` sets its subregistry to the project's release registry and links its record to the project (`linkToNode`), then `alice.eth` serves production, and `3.alice.eth` and `preview.alice.eth` work with no extra records.

| Contract | Role |
|---|---|
| `NavikRegistrar` | Creates the Navik registry and the factory, and hands out `<project>.navik.eth`. Each project gets its own Permissioned Resolver (creator is the only role holder) and its own release registry (`preview` registered, the factory as sole registrar). The registrar keeps no role. It claims the root project (`app`) at deploy, so nobody can front-run it |
| `NavikFactory` | `storeChunks(chunks)` stores content chunks. It is permissionless and addressed by content, so identical chunks are stored once across all projects. `publish(project, pointers)` deploys release N at `CREATE3(keccak(project, N))`, computing the content hash onchain, registers `<N>.<project>.navik.eth` and repoints `preview`. `publishContent` stores and publishes in one transaction for small sites |
| `Deployment` | One release. ERC-8244 `html()` concatenates its chunks. `chunkCount()` and `chunk(i)` serve RPCs that limit `eth_call` size. `manifest()` returns project, version, content hash, size and chunk pointers. It is also the ENS resolver of its own name(s): `contentcontract` and `addr` return its address. A clone with immutable args: no storage, no owner |
| `NavikResolver` | Resolver of navik.eth. Forwards queries for `navik.eth` itself to the root project's resolver, so navik.eth follows its promotions and rollbacks. Unregistered names under navik.eth do not resolve |

## Dashboard

`app/` is a dashboard for managing projects: connect a wallet, claim a project, drop in an HTML build, deploy, promote, roll back, take offline, and grant or revoke deploy keys. It is also a viewer for onchain sites: "Open a site" takes any ENS name with an ERC-8244 `contentcontract` record and works without a wallet. It:
- resolves the name through ENSv2's UniversalResolver;
- reads the bytes from Ethereum in parallel chunks;
- checks they are a genuine Navik release with a matching content hash;
- renders the site in a sandboxed frame with an opaque origin, so it cannot reach the dashboard or the wallet.

You can drop a local build on the viewer to compare it with the release.

It is hosted on Navik itself:
- The build is one self-contained HTML file (~260 KB, published compressed as 5 chunks), with no CDN, fonts or analytics. Its only external fetch is the pinned anon-rpc worker code.
- It is published to the root project `app.navik.eth`, so `navik.eth` serves it.
- Every version of the dashboard keeps its own permanent name (`1.app.navik.eth`, …).
- The build is reproducible, so anyone can check that `navik.eth` serves the code in this repo (see [Verify a site against its source](#verify-a-site-against-its-source)).

```bash
PRIVATE_KEY=0x… ./scripts/deploy-app.sh   # build for the connected chain, deploy compressed to app.navik.eth, promote
```

## Private reads (anon-rpc)

A dapp's RPC provider normally sees your IP next to every address and name you look up. Here, it would see which projects you manage and which sites you open. The dashboard closes that leak with [anon-rpc](https://ethereum.github.io/anon-rpc/), via `@anon-rpc/browser-harness` (`app/src/reads.ts`):

- **Every read goes through an anon-rpc worker:** ENS resolution, project and release listings, permission checks, event logs, gas simulation, transaction receipts and site bytes. The worker runs in a null-origin sandboxed iframe, and viem's `http()` transport uses its `fetch`.
- **The wallet only signs.** The app sends the wallet just `eth_requestAccounts`, `eth_chainId`, `wallet_switchEthereumChain` and `eth_sendTransaction`. This exclusion is deliberate: a broadcast transaction is public anyway. The dashboard e2e asserts that the wallet receives no reads.
- **The worker code is pinned in the app.** The harness normally reads each network's code hash from its specifier contract over a plain RPC before anything is anonymized. Navik instead embeds the hash and resolver URLs at build time. The harness still checks `keccak256(bundle)` before running it. As a result, no un-anonymized bootstrap read is ever made, and a given dashboard release (itself immutable) always runs the anonymizer code it was published with.
- **It fails closed.** If the network is unreachable, reads stop with an error and a Reconnect button. Nothing silently falls back to a direct connection.
- **Unrelated reads are kept apart.** The dashboard (keyed by account) and each opened site use separate `isolationKey`s, asking the network not to link them. Support depends on the network.
- **You can see where everything went.** The header shows the active network and how many calls went through anon-rpc. Clicking it opens a panel with a percentage meter, every request (route, method, latency, size) and the worker's log. There you can switch the network or RPC endpoint.

| Network | Anonymizes | Connect | Per read (batch) | Worker size |
|---|---|---|---|---|
| **Nym** (default on mainnet) | yes: Sphinx mixnet, exits at a Nym IP Packet Router | ~6 s | ~0.6 s | 3.9 MB (brotli) |
| Nox | yes: Sphinx mixnet, TLS to the RPC end to end | ~1.5 s | ~1 s | 0.5 MB |
| Tor | yes: Tor in WebAssembly via a KPS gateway | slow first circuit | — | 2.2 MB |
| Passthrough (default on the local fork) | no: reference worker, same sandbox | <1 s | direct | tiny |
| Direct | no: plain `fetch`, labelled as exposed | — | direct | — |

All numbers were measured from headless Chromium. The Tor demo gateway could not be reached while this was written. No mixnet exit can reach `127.0.0.1`, so the local fork uses the passthrough worker. It exercises the same harness, sandbox and code path, but it does not anonymize. Throughput over Nym is about 15–20 KB/s. Because mixnet round trips are slow:
- reads are batched into JSON-RPC batches;
- release chunks and release listings are read in parallel;
- compression (below) matters: the dashboard is 5 chunks instead of 11.

The CLI is not covered: anon-rpc has no published Node harness yet. Point `--rpc` at your own node if you need private CLI reads.

## Verify a site against its source

Every release stores its content hash, and `navik verify` checks the bytes against it. To also prove those bytes were built from a given source tree, rebuild the site and compare:

```bash
# any name with a contentcontract record; matches the original document of gzip-wrapped releases
node cli/src/cli.ts verify portfolio.navik.eth --against ./dist/index.html

# clone, build and compare in one step, e.g. the dashboard navik.eth serves
scripts/reproduce.sh navik.eth https://github.com/<org>/navik <commit> \
  "pnpm install --frozen-lockfile && NAVIK_CHAINS=1 pnpm -C app build" app/dist/index.html
```

The viewer has the same check: drop the file on "Compare with a local build". The dashboard's own build is deterministic: the lockfile pins every dependency, and the deployment addresses are committed. `scripts/test-all.sh` rebuilds it after publishing and checks that the rebuild matches what `navik.eth` serves.

## ENSv2 features used

| ENSv2 feature | What it does in Navik | Change it → what users see |
|---|---|---|
| Hierarchical registries (navik.eth → Navik registry → one registry per project) | Namespace of projects, and of each project's releases | Swappable by the navik.eth owner until frozen, then by nobody |
| Own subname registry per project (UserRegistry via VerifiableFactory) | Tokenized release names `<N>.<project>`, managed by the factory's rules | Locked: the owner has no right to swap the subregistry |
| Forever, non-transferable names with no parent control | Release names: no expiry, no roles, emancipated registry | Cannot change, move or disappear |
| Tokenized subnames (ERC-1155) owned by users | Who owns a project | Owner transfers → new wallet controls it |
| A resolver per name | Each release resolves itself; `preview`'s resolver is repointed per publish | Publish → preview moves; releases never do |
| Namespace aliasing via a shared registry + record aliasing (`linkToNode`) | Custom domains: `alice.eth`, `3.alice.eth`, `preview.alice.eth` | Unlink → the domain stops following |
| One Permissioned Resolver per project, deployed via VerifiableFactory | What is live: `text("contentcontract")` | Set it → site changes; set an older release → rollback |
| Enhanced Access Control, setter-scoped grants (`grantSetterRoles`) | Least-privilege deploy keys: `navik.publish` vs `contentcontract` | Revoke → the key's next deploy reverts |
| Per-project EAC scope | Isolation: a key for one project is useless on another | — |
| Emancipation and locked parents (no root admin on the Navik or release registries) | Nobody can unregister, repoint or upgrade project or release names | — |

## CROPS

- **C:** We control the `navik.eth` name, and nothing else is ours: no server, gateway, indexer or relayer. Sites, names and the dashboard all live on Ethereum, and any RPC can serve them. If we disappear, renewing `navik.eth` is permissionless. Once it is frozen, we cannot repoint it either. If an anon-rpc network or RPC provider refuses you, pick another network or endpoint in the privacy panel.
- **O:** MIT. The repo alone builds and runs everything: contracts, CLI, dashboard and a local mainnet fork. The dashboard build is reproducible, and `scripts/reproduce.sh` proves that `navik.eth` serves this code.
- **P:** By default the RPC provider sees reads arriving from a Nym exit, not your IP. The wallet only sees signing requests. The CDN serving the pinned anon-rpc worker sees that you use it, but not what you read. Navik runs no backend and no analytics. Details are [below](#what-each-party-learns).
- **S:** Keys never leave your wallet. The anon-rpc worker is hash-pinned code in a null-origin sandbox, and opened sites run sandboxed with no access to the dashboard or wallet. Releases are checked against their onchain content hash. The trust assumptions are your RPC's answers and ENSv2's core contracts; see the security phases below.

### What each party learns

| Party | Learns | Does not learn |
|---|---|---|
| RPC provider (default `ethereum-rpc.publicnode.com`, reached through the mixnet) | The reads themselves: names, project accounts, release addresses. Reads under one `isolationKey` may be linkable to each other | Your IP. Which reads belong to the same person across isolation keys (if the network honours them) |
| anon-rpc network (Nym mix nodes and exit) | Mix nodes: nothing. Exit: that some client is talking to the RPC host | Who you are; with Nox, the request contents (TLS ends inside the worker) |
| Worker CDN (jsDelivr, unpkg or GitHub, one fetch per network, cached) | Your IP, and that you load an anon-rpc worker | Anything you read |
| Your wallet and its RPC | Your account, chain and the transactions you sign (public once sent) | What you browse or manage in the dashboard |
| Navik (the team) | Nothing: there is no server | — |
| Sites you open in the viewer | Nothing about the dashboard: opaque origin, no wallet | — |

The CLI talks only to the RPC you pass. It has no anon-rpc support yet (see [Private reads](#private-reads-anon-rpc)).

### Security

Navik has two phases:

1. **Testing.** The navik.eth owner keeps the ENSv2 roles to repoint navik.eth's registry and resolver, so a broken deployment can be replaced. That power covers the whole namespace: repointing navik.eth hides every project and release name served by the old contracts. The releases themselves, their bytes and their addresses are untouched.
2. **Frozen.** `Freeze.s.sol` revokes those roles, including the admin roles that could grant them back, from every holder. Then it checks onchain that nobody holds them. This is irreversible. `navik info` reports which phase a deployment is in, read from the chain.

What each party can and cannot do:

| Party | Can | Cannot |
|---|---|---|
| Navik team (navik.eth owner) | Renew navik.eth (anyone can) | Unregister, take or repoint a project; publish to it; change production; alter a release |
| | Before the freeze only: repoint navik.eth to other Navik contracts | After the freeze: repoint navik.eth at all |
| Navik contracts | — | Hold any role on project names or project resolvers |
| Project creator | Publish releases; promote, roll back, demote; grant and revoke keys; transfer the name | Change or delete a published release or its name; swap the project's release registry |
| Key granted `publish` | Publish releases of that project | Change production; touch other projects |
| Key granted `promote` | Change that project's production | Publish (unless also granted); touch other projects |
| Anyone | Read and verify everything | Register or change a release name (only a publish registers `<N>.<project>`) |

Remaining assumptions, stated plainly:
- **ENSv2 core contracts.** The ETHRegistry reports itself emancipated, meaning no root override.
- **navik.eth must stay renewed.** Renewal is permissionless, so anyone can pay to keep it alive.
- **Release addresses never depend on ENS.** Every release stays readable at its contract address even if ENS changes.

`navik verify <name>` checks a site without trusting Navik; it trusts only the RPC's answers. It resolves the name through ENSv2's UniversalResolver, then checks three things:
- the target is a genuine factory release (its CREATE3 address matches), not a look-alike;
- the release belongs to the named project;
- `keccak256(html())` equals the content hash in the release manifest.

## Usage

Requirements: Node ≥ 22.18, pnpm, Foundry.

```bash
# contracts + fork tests against real mainnet ENSv2
cd contracts && forge test

# local mainnet fork with navik.eth registered and Navik deployed (FREEZE=1 to also freeze it)
./scripts/dev-fork.sh

# CLI (pnpm workspace: sdk, cli, app)
pnpm install && cd cli
export RPC_URL=http://127.0.0.1:8545 PRIVATE_KEY=0x…
node src/cli.ts claim portfolio
node src/cli.ts deploy portfolio ./index.html --promote
node src/cli.ts grant portfolio 0xCI… --permission publish   # preview-only key
node src/cli.ts rollback portfolio v1
node src/cli.ts ls portfolio
node src/cli.ts verify portfolio
node src/cli.ts verify portfolio --against ./index.html      # is this build what's live?
node src/cli.ts open 2.portfolio.navik.eth

# full CLI flow (claim → deploy → grants → rollback → multi-chunk → revoke → isolation → demote)
pnpm run e2e

# dashboard: dev server, or the headless-browser e2e (wallet injected; reads go through the
# passthrough anon-rpc worker to the fork, and the test asserts the wallet only signs)
cd ../app && pnpm dev
pnpm run e2e
# the same test against the exact (compressed) bytes navik.eth serves, fetched from the chain
node ../cli/src/cli.ts verify navik.eth --raw --out /tmp/navik.html && APP_FILE=/tmp/navik.html node test/e2e.ts
```

### Mainnet

1. Buy `navik.eth` in the ENS app (ENSv2).
2. From the wallet that owns it:

   ```bash
   cd contracts
   forge script script/Deploy.s.sol --rpc-url $MAINNET_RPC_URL --private-key $OWNER_KEY --broadcast --verify
   ```

   This deploys the contracts and points navik.eth at them. It writes `contracts/deployments/1.json`, which the CLI reads, plus `1-<block>.json` as a record. Commit both: the dashboard build embeds `1.json`, so a reproducible build needs it.

3. Publish the dashboard so `navik.eth` serves it (~24M gas), then check it against the commit:

   ```bash
   RPC_URL=$MAINNET_RPC_URL PRIVATE_KEY=$OWNER_KEY ./scripts/deploy-app.sh
   RPC_URL=$MAINNET_RPC_URL scripts/reproduce.sh navik.eth <repo url> <commit> \
     "pnpm install --frozen-lockfile && NAVIK_CHAINS=1 pnpm -C app build" app/dist/index.html
   ```

4. During testing, fix mistakes by deploying again (steps 2–3), or switch back to an earlier deployment:

   ```bash
   DEPLOYMENT=1-<block> forge script script/Attach.s.sol --rpc-url $MAINNET_RPC_URL --private-key $OWNER_KEY --broadcast
   ```

5. When ready, freeze navik.eth. This is irreversible. If other wallets were granted roles on navik.eth, list them in `ALSO_REVOKE` (comma-separated); the script fails if anyone would keep the power.

   ```bash
   CONFIRM_FREEZE=navik.eth forge script script/Freeze.s.sol --rpc-url $MAINNET_RPC_URL --private-key $OWNER_KEY --broadcast
   ```

Measured on a mainnet fork:

| Operation | Gas |
|---|---|
| Store one full chunk (24,575 B) | ~5.4M |
| Store + publish a site of up to 2 full chunks (one tx, `publishContent`) | 11.8M for 49,150 B |
| Publish already-stored chunks (incl. naming the release) | ~370k |
| Claim a project (resolver + release registry) | ~720k |
| Read `html()` of a 491 KB site (`eth_call`) | 2.85M |

Mainnet caps a transaction at 2^24 gas (EIP-7825), so the CLI uploads at most 2 chunks per transaction. An upload interrupted halfway resumes: re-running `deploy` skips chunks that are already onchain.

### Compression (opt-in)

`navik deploy --compress`, or the "Compress" checkbox in the dashboard, stores the site gzip-wrapped. The stored document is a small loader page: the original HTML gzipped and base64-encoded, plus a script that decompresses it in the browser (`DecompressionStream`) and swaps it in. The loader keeps `window` intact, so wallet discovery (EIP-6963) and other listeners keep working; it re-runs the page's scripts in order and fires `DOMContentLoaded` and `load`.

| Site | Raw | Compressed |
|---|---|---|
| Navik dashboard (JS bundle, incl. the anon-rpc harness) | 260 KB, 11 chunks | 108 KB, 5 chunks (~24M gas) |
| Text-heavy page | 114 KB, 5 chunks, ~27M gas | 9 KB, 1 chunk, 2.2M gas |

Trade-offs:
- **It is off by default:** a compressed site needs JavaScript to render.
- **Standard formats on purpose:** anyone can audit a release with `base64 -d | gunzip`.
- **`navik verify` reports both hashes:** the stored loader's hash and the original document's hash. `--out`, `open` and the dashboard's "View" return the original; `--raw` returns the stored bytes.

## Limits (MVP)

- **Single-file sites:** one prebuilt HTML document of up to 64 chunks (1,572,800 bytes).
- **Viewer sandbox:** sites opened in the dashboard run without wallet access. Sites that need a wallet render in ERC-8244 browsers or through `navik open`.
- **Read integrity:** reads are anonymized but not proven. A lying RPC could serve a false release consistently with its manifest. A light client or `eth_getProof` checks would remove that trust.
- **CLI reads are not anonymized** (no Node anon-rpc harness yet).
- **Dashboard wallets:** browser-injected wallets only (EIP-6963), no WalletConnect, so there's no relay server.
