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
- **Reading is private by default.** The dashboard and its built-in site viewer send every chain read through an [anon-rpc](https://ethereum.github.io/anon-rpc/) network (Nym by default). The RPC provider sees a mixnet exit, not who is looking at which project or site. `navik --anon` does the same for the CLI.
- **Every name has a public link.** `navik.eth.limo`, `portfolio.navik.eth.limo` and `3.portfolio.navik.eth.limo` open in any browser with no IPFS and no host of ours: eth.limo reads the site from Ethereum. See [eth.limo links](#ethlimo-links).
- **Anyone can check that a site matches its source.** `navik verify <name> --against <build>` and `scripts/reproduce.sh` rebuild a site from its repo and compare it byte for byte with what the name serves.
- **Real apps, one command, CI included.** With a `navik.json`, `navik deploy` builds a Vite app (React, viem, …), packs its `dist/` into one document and smoke-tests it in a sandboxed browser before spending gas. A GitHub Action previews every merge with a publish-only key and promotes after approval. See [Deploy a Vite app](#deploy-a-vite-app-and-from-ci).
- **Provenance on Arkiv, source on Swarm.** `navik deploy --build <cmd>` records on [Arkiv](https://arkiv.network) which commit and command built a release, and puts the source on Swarm. Anyone who rebuilds it can attest the result, and the viewer shows "reproduced ×N" for any ERC-8244 site. See [Provenance](#provenance-on-arkiv-source-on-swarm).

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

**Custom domains.** `navik link portfolio alice.eth`, or the project's Domains tab, makes a name you own serve the project: `alice.eth` serves production and follows every promotion, and `3.alice.eth` and `preview.alice.eth` serve releases. Nothing is copied. It uses ENSv2's two kinds of aliasing, which live in different contracts:

| Write | Contract | Signed by | Effect |
|---|---|---|---|
| `multicall(setText, linkToNode)` | project's Permissioned Resolver | project owner | `alice.eth` uses the project's production record. The name's previous resolver and subregistry are stored on the project's resolver, so they can be restored |
| `setResolver` | the name's registry (ETHRegistry for `alice.eth`) | domain owner | the name resolves through the project's resolver |
| `setSubregistry` | the same registry | domain owner | `<N>.alice.eth` and `preview.alice.eth` resolve through the project's release registry |

That makes three transactions (registries have no multicall), all from one wallet when you own both the domain and the project. If the domain and the project have different owners, each runs `link` or uses the Domains tab and only sends their own part. `navik domains portfolio` lists linked names, partly linked ones included. While a name is linked, its own records (address, avatar…) and its existing subnames are hidden. `navik unlink portfolio alice.eth` restores its previous resolver and subregistry.

| Contract | Role |
|---|---|
| `NavikRegistrar` | Creates the Navik registry and the factory, and hands out `<project>.navik.eth`. Each project gets its own Permissioned Resolver (creator is the only role holder, `contenthash` set to a NavikPages hook) and its own release registry (`preview` registered, the factory as sole registrar). The registrar keeps no role. It claims the root project (`app`) at deploy, so nobody can front-run it |
| `NavikFactory` | `storeChunks(chunks)` stores content chunks. It is permissionless and addressed by content, so identical chunks are stored once across all projects. `publish(project, pointers)` deploys release N at `CREATE3(keccak(project, N))`, computing the content hash onchain, registers `<N>.<project>.navik.eth` and repoints `preview`. `publishContent` stores and publishes in one transaction for small sites |
| `Deployment` | One release. ERC-8244 `html()` concatenates its chunks. `chunkCount()` and `chunk(i)` serve RPCs that limit `eth_call` size. `manifest()` returns project, version, content hash, size and chunk pointers. It is also the ENS resolver of its own name(s): `contentcontract` and `addr` return its address, and `contenthash` is a hook on its own `page()`, which returns the document as a data URL. A clone with immutable args: no storage, no owner |
| `NavikResolver` | Resolver of navik.eth. Forwards queries for `navik.eth` itself to the root project's resolver, so navik.eth follows its promotions and rollbacks. Unregistered names under navik.eth do not resolve |
| `NavikPages` | Stateless helper for gateways. `page(name)` resolves any ERC-8244 name onchain through ENS, reads `html()` and returns a data URL. No owner, no upgrades, nothing Navik-specific |

## Dashboard

`app/` is the dashboard. Opening a site needs no wallet; connect one to manage projects:
- **Projects:** each card shows what production serves and how many releases the project has.
- **New project:** type a name, see whether it's available live (as in the ENS app), and claim it.
- **Project page:** a live, hash-checked thumbnail of production, the release list (production and preview tagged; promote or roll back in one click), a Domains tab to link names you own ([custom domains](#how-it-works)), and an Access tab for deploy keys.
- **Deploy:** a dialog where you drop an HTML build, see the plan (release name, chunks already onchain, transactions, address known before upload), and follow each transaction.

The dashboard is also a viewer for onchain sites: "Open a site" takes any ENS name with an ERC-8244 `contentcontract` record and works without a wallet. It:
- resolves the name through ENSv2's UniversalResolver;
- reads the bytes from Ethereum in parallel chunks;
- checks they are a genuine Navik release with a matching content hash;
- renders the site in a sandboxed frame with an opaque origin, so it cannot reach the dashboard or the wallet;
- shows where its code came from and who rebuilt it, read from Arkiv: repo, commit, build command, the source on Swarm, and every reproduction ([details](#provenance-on-arkiv-source-on-swarm)).

You can drop a local build on the viewer to compare it with the release, then attest the result on Arkiv with your wallet.

It is hosted on Navik itself:
- The build is one self-contained HTML file (~350 KB, published compressed as 6 chunks, ~33M gas), with no CDN, web fonts or analytics: system fonts and inline SVG icons keep it small. Names and addresses get the ENS app's [etherloom](https://github.com/ensdomains/etherloom) identicons (generated locally, ~3.6 KB). Project owners, deploy keys, publishers and attesters show as their primary ENS name (e.g. "reproduced by vitalik.eth"), looked up through anon-rpc like every other read. Addresses link to Blockscout, and every address and hash has a copy button. Its only external fetch is the pinned anon-rpc worker code.
- It is published to the root project `app.navik.eth`, so `navik.eth` serves it.
- Every version of the dashboard keeps its own permanent name (`1.app.navik.eth`, …).
- The build is reproducible, so anyone can check that `navik.eth` serves the code in this repo (see [Verify a site against its source](#verify-a-site-against-its-source)).

```bash
PRIVATE_KEY=0x… ./scripts/deploy-app.sh   # build for the connected chain, deploy compressed to app.navik.eth, promote
```

## Deploy a Vite app (and from CI)

A release stores one HTML document, so a site with a build directory gets packed into one at deploy time. Add a `navik.json` next to its `package.json` ([example](examples/viem-vite), React + viem + self-hosted Inter):

```json
{ "project": "portfolio", "build": "pnpm install --frozen-lockfile && pnpm build", "output": "dist" }
```

```text
$ navik deploy --smoke --promote
build        pnpm install --frozen-lockfile && pnpm build
packed       8 file(s) inlined into one document
release      1.portfolio.navik.eth
compressed   736490 → 406562 bytes (30 → 21 chunks)
segments     5 asset(s) in chunks of their own, reused while unchanged
smoke        ✓ rendered in a sandboxed frame ("ENS lookup · a Navik example")
uploaded 2 chunk(s) …
promoted     portfolio.navik.eth → 1.portfolio.navik.eth
```

- **Packing** (`packSite` in the SDK) inlines scripts and stylesheets, and turns every other file the page references into a data URI: images, fonts, icons and JSON, whether referenced from HTML attributes, CSS `url()` or string literals in JS. It only rewrites paths that name a file in the build, and the same build always packs to the same bytes, so `navik verify --against dist/` and `navik reproduce` still compare byte for byte.
- **Code splitting has to be off:** chunks load each other by URL, and an onchain site has none. Packing refuses such a build, names the chunk and says how to fix it. With Vite 8, that's `build.rolldownOptions.output.codeSplitting = false` (viem's lazy CCIP-Read module is one such chunk). Only `index.html` is served; other pages and unreferenced files are listed as left out.
- **`--smoke`** loads the stored bytes (including the gzip loader) in headless Chromium, in a sandboxed frame with an opaque origin like the viewer's. It fails on uncaught errors, on requests for files that are not in the document, and on a blank page. It needs Playwright (`npx playwright install chromium`).
- **Compression** is on for packed builds when it makes them smaller.
- **Large assets get chunks of their own.** Fonts, images and other files of 4 KB or more are stored in segments that start a new chunk and depend only on the file's bytes. The document, gzipped, comes last, with placeholders where those files were. So an unchanged font is never uploaded again, whatever else changes, and the same file is shared by every Navik site that uses it (chunks are content-addressed). The loader and `navik verify` rebuild the packed document exactly, so verification and reproduction are unchanged. Measured with the example (React, viem, two Inter weights as woff2 + woff, ~740 KB packed) on a mainnet fork:

  | Release | Chunks reused | Gas |
  |---|---|---|
  | First deploy | 0 of 21 | 90.4M |
  | One word changed in the app | 20 of 21 | 3.5M |
  | New viem module imported + a CSS change | 10 of 21 (all fonts and images) | 57.8M |

  With plain gzip of the whole document, the last case reused nothing. Within the document, chunks before the first changed byte are reused; the bundler puts app code after library code, which is why a small app change is cheap. A change in library code still re-uploads the document's chunks; splitting the libraries into a segment of their own is future work.
- **CI-friendly:** `--json` prints the result on stdout, and in GitHub Actions the CLI writes step outputs and a job summary. If the bytes equal the latest release, nothing is published, so re-runs and commits that don't change the site cost nothing. `--max-gas-price <gwei>` stops before sending anything when gas is expensive.
- **`navik build`** does the same without a chain: build, pack, report the size, `--smoke`, `--out site.html` (e.g. to drop on the viewer's "Compare with a local build").

**GitHub Action.** [`action.yml`](action.yml) wraps this. [`examples/github-workflow.yml`](examples/github-workflow.yml) runs a dry run with smoke test on pull requests. On `main` it publishes a release with a key that may only publish, so `preview.<project>.navik.eth` follows it. After approval in a `production` environment, it promotes that exact release with a second key that may only promote. Both are [ENSv2 permissions](#ensv2-features-used) scoped to the project, so a leaked CI key cannot change what production serves. Between the two, a `reproduce` job rebuilds the release on a fresh runner from the commit recorded on Arkiv, compares it byte for byte and attests the result on Arkiv, linking the run's log. A mismatch fails the job, so production only gets releases that reproduced. Viewers show the attestation as "via navik-ci". The same `reproduce` input works on any site with provenance, including ones you don't own. Its outputs are `release`, `version`, `address`, `content-hash`, `published`, `unchanged`, `promoted`, `preview` and `provenance`, plus `reproduced` and `attestation` in `reproduce` mode.

**Outside this repo.** `pnpm -C cli bundle` builds `cli/dist/navik.js`, one file with the public Navik deployments embedded (`--deployment <file>` for others). `npm publish` ships it as `@navik/cli` (not on npm yet), for `npx @navik/cli deploy`. Until then, the Action builds the same file from its own checkout.

## Private reads (anon-rpc)

A dapp's RPC provider normally sees your IP next to every address and name you look up. Here, it would see which projects you manage and which sites you open. The dashboard closes that leak with [anon-rpc](https://ethereum.github.io/anon-rpc/), via `@anon-rpc/browser-harness` (`app/src/reads.ts`):

- **Every read goes through an anon-rpc worker:** ENS resolution, project and release listings, permission checks, event logs, gas simulation, transaction receipts and site bytes. The worker runs in a null-origin sandboxed iframe, and viem's `http()` transport uses its `fetch`.
- **The wallet only signs.** The app sends the wallet just `eth_requestAccounts`, `eth_chainId`, `wallet_switchEthereumChain` (plus `wallet_addEthereumChain` the first time you sign on Arkiv) and `eth_sendTransaction`. This exclusion is deliberate: a broadcast transaction is public anyway. The dashboard e2e asserts that the wallet receives no reads.
- **The worker code is pinned in the app.** The harness normally reads each network's code hash from its specifier contract over a plain RPC before anything is anonymized. Navik instead embeds the hash and resolver URLs at build time. The harness still checks `keccak256(bundle)` before running it. As a result, no un-anonymized bootstrap read is ever made, and a given dashboard release (itself immutable) always runs the anonymizer code it was published with.
- **It fails closed.** If the network is unreachable, reads stop with an error and a Reconnect button. Nothing silently falls back to a direct connection.
- **Unrelated reads are kept apart.** The dashboard (keyed by account) and each opened site use separate `isolationKey`s, asking the network not to link them. Support depends on the network.
- **Arkiv reads have a route of their own.** Release provenance and attestations come from Arkiv's RPC, also through anon-rpc: Nox by default, because Nym's worker (0.1.0) drops the `Content-Type` header, which Arkiv's node requires (it answers 415). Each network runs one worker, shared by every chain routed through it. The privacy panel configures both routes, and its counters include both.
- **You can see where everything went.** The header shows the active network. Clicking it opens a panel with call counts by route, every request (route, method, latency, size) and the worker's log. There you can switch the network or RPC endpoint.

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
- compression (below) matters: the dashboard is 6 chunks instead of 14.

### In the CLI

`navik --anon <command>` sends every RPC request through Nym, and `--anon-network nox` (or `NAVIK_ANON=nox`) picks another network. It needs Playwright, like `--smoke`.

```
$ navik --anon info
anon-rpc     Nym → ethereum-rpc.publicnode.com
anon-rpc     connected to Nym
root         navik.eth  owner 0xF606…64C2
…
anon-rpc     6 calls through Nym
```

Anon-rpc has no usable Node harness yet: its Node prototype runs workers without WebAssembly, WebSocket or Worker, which Nym and Nox need. So the CLI runs the official browser harness in headless Chromium (`cli/src/anon.ts`), and viem's `http()` transport forwards to it. The dashboard's guarantees carry over:

- **The same pinned workers.** `@navik/sdk` holds the hashes for both, and the harness checks `keccak256(bundle)` before running anything. No plain RPC call is made to bootstrap.
- **Keys stay in the CLI's process.** Transactions are signed in Node, and the browser only ever receives a URL and a body. The signed transaction goes out through the worker too, along with the gas, nonce and receipt reads around it.
- **It fails closed.** If the network does not connect within 90 s, the command fails. Nothing falls back to a direct connection, and `--anon` against a local RPC is refused, because no exit can reach it. `--anon-network passthrough` is the local test path, and it says it is not anonymous.
- **Arkiv goes through anon-rpc too**, over Nox, as in the dashboard.
- **Each run starts fresh:** a new browser, new worker state and a new `isolationKey`. Worker code is cached by hash in `~/.cache/navik/anon-rpc`, so the CDN only sees your first run.

Over the live networks, a run of 6 reads took about 20 s with Nym and 2 reads about 6 s with Nox, including the connection. Deploying works but is slow: every chunk crosses the mixnet at 15–20 KB/s. Swarm traffic (`--swarm`, `reproduce`) is not covered, and the CLI prints a warning when it happens.

## eth.limo links

Every Navik name works on [eth.limo](https://eth.limo), so a site can be opened in any browser, with no ERC-8244 support, IPFS or Navik server involved:

| Link | Serves |
|---|---|
| `navik.eth.limo` | The dashboard (the root project's production) |
| `portfolio.navik.eth.limo` | Production, following every promotion and rollback |
| `3.portfolio.navik.eth.limo` | That release, forever |
| `preview.portfolio.navik.eth.limo` | The newest release |
| `alice.eth.limo`, `3.alice.eth.limo` | The same, for a [linked domain](#how-it-works) |

There is nothing to set up. eth.limo follows [ERC-8121](https://eips.ethereum.org/EIPS/eip-8121) hooks: a `contenthash` record can name a function to call, which must return a `data:` URL. Each project gets a hook on `NavikPages.page("<project>.navik.eth")` when it is claimed, so the record never changes: every read follows `contentcontract`. Each release answers with a hook on its own `page()`. Owners can replace their project's `contenthash` like any other record. `navik deploy` prints the link on mainnet, and the dashboard shows it next to production and each release.

The trade-offs, stated plainly:

- **eth.limo is a trusted gateway.** It sees your IP and what you open, and its RPC's answers are not verified: nothing checks the content hash, unlike `navik verify`, the dashboard's viewer or an ERC-8244 browser. Links are for reach. Reading through Navik keeps the [private reads](#private-reads-anon-rpc).
- **The dashboard itself stays private.** Once loaded from eth.limo, it reads through anon-rpc and signs in your wallet as usual. eth.limo only learns that you opened it.
- **Size.** eth.limo refuses a data URL over 1,000,000 bytes (a 749,970-byte stored document), and the hook's `eth_call` costs 15M gas at 200 KB, 51M at 500 KB and 92M at the maximum. A default geth RPC caps calls at 50M, so `navik deploy` warns above 450 KB of stored bytes. eth.limo's own cap is not public. Compression counts: the dashboard is 145 KB.
- **The hook format is experimental.** eth.limo calls its protocodes placeholders until ERC-8121 and its ENSIP are accepted. If they change, `contenthash` records can change with them, but release contracts cannot: their hooks are fixed at deploy.
- **Headers.** The gateway sends `Content-Type: text/html` with no charset, so a document needs its own `<meta charset="utf-8">` (compressed releases always have one). Other paths are not expected to serve the document, so use hash routes.
- **Promotions may lag.** A production hook is constant, so a cache in front of the gateway could serve the previous release until it expires. Release links are immutable and `preview` changes its hook with every release, so neither has this problem.

`cli/test/gateway` replays what the gateway does, with the same libraries and versions as [dweb-proxy-api](https://github.com/ethlimo/dweb-proxy-api), and `scripts/test-all.sh` runs the whole dashboard e2e through it. eth.limo itself can only be tested once Navik is on mainnet.

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

## Provenance on Arkiv, source on Swarm

Ethereum proves which bytes a name serves, but not which code they came from. Storing a repo URL, commit and build command in bytecode for every release would cost gas, and could never be corrected. Navik keeps that layer on [Arkiv](https://arkiv.network) (testnet: Rabdi) and the source itself on [Swarm](https://www.ethswarm.org):

| What | Where | Written by |
|---|---|---|
| Site bytes, names, content hash, who may publish | Ethereum | the publisher (as before) |
| `navik.provenance`: repo, commit, build command, output path, notes, Swarm reference + keccak256 of the source | Arkiv | the publisher's deploy key |
| `git archive <commit>` (one tar) | Swarm | the publisher |
| `navik.attestation`: "I rebuilt these bytes: match / mismatch" | Arkiv | anyone |

- **Trust comes from Ethereum.** Anyone can write a provenance record for any release. A client trusts one only if its `$creator` (fixed at creation) is the `publisher` the Navik factory logged in `DeploymentPublished` for that release. Others are shown as ignored.
- **Attestations follow the content,** queried by `contentHash`, so they work for any ERC-8244 site and survive re-publishing the same bytes.
- **Records never change and anyone can keep them.** Both kinds are created `readonly`, with `permissionlessExtension`, for 180 days (Arkiv's cap is ~182.5). `navik keep-alive` or the viewer's "Keep alive" extends them, from any wallet.
- **The source is checked, not trusted.** `navik reproduce` downloads the tar from Swarm and checks three things before building: its keccak256 equals `sourceHash`, the commit embedded in the tar equals `commit`, and after the build, the file is byte-identical to what the name serves.
- **It is optional.** Nothing about serving or verifying a site needs Arkiv or Swarm. If Arkiv is unreachable, the viewer says so and still renders the site, verified from Ethereum.

```bash
export ARKIV_PRIVATE_KEY=0x…                 # tGLM from https://hub.arkiv.network/faucet; defaults to PRIVATE_KEY
export SWARM_API=http://127.0.0.1:1633 SWARM_BATCH=<postage batch>   # bee or Freedom's antd; only for --swarm

node cli/src/cli.ts deploy --provenance --swarm --notes "v3"   # build from navik.json; records its "build" and dist/
node cli/src/cli.ts deploy portfolio dist/index.html --build "npm ci && npm run build" --swarm   # a file built yourself
node cli/src/cli.ts record 2.portfolio dist/index.html --build "npm ci && npm run build"   # an existing release
node cli/src/cli.ts provenance portfolio      # source, publisher check, reproductions (no key needed)
node cli/src/cli.ts reproduce portfolio --yes --attest   # rebuild from Swarm (or --git), compare, attest
node cli/src/cli.ts verify portfolio --against ./index.html --attest
node cli/src/cli.ts keep-alive portfolio
NAVIK_PROVENANCE=1 ./scripts/deploy-app.sh    # the dashboard records its own provenance
```

`reproduce` runs the publisher's build command on your machine, so it shows the command and waits for `--yes`. Use a container if you don't trust the publisher.

Writing wallets on Rabdi:
- `0x09D1F0ebF181503417b74203A1a924A8145830F5`: test and demo records (chain id 31337, the local fork)
<!-- TODO(team): add the mainnet publisher once navik.eth's dashboard records its provenance -->

Query the records yourself (no key, no SDK):

```bash
curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network -H 'content-type: application/json' --data @- <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('navik.provenance')",
 {"select":{"key":true,"creator":true,"expiresAt":true,"attributes":true},"limit":"0x10"}]}
EOF
```

More detail in [`arkiv/`](arkiv/): [schema](arkiv/schema.md), [how we use Arkiv](arkiv/how-you-use-arkiv.md), [why Arkiv](arkiv/why-arkiv.md), [reach](arkiv/reach.md), [Swarm](arkiv/swarm.md) and [friction](arkiv/friction.md).

## ENSv2 features used

| ENSv2 feature | What it does in Navik | Change it → what users see |
|---|---|---|
| Hierarchical registries (navik.eth → Navik registry → one registry per project) | Namespace of projects, and of each project's releases | Swappable by the navik.eth owner until frozen, then by nobody |
| Own subname registry per project (UserRegistry via VerifiableFactory) | Tokenized release names `<N>.<project>`, managed by the factory's rules | Locked: the owner has no right to swap the subregistry |
| Forever, non-transferable names with no parent control | Release names: no expiry, no roles, emancipated registry | Cannot change, move or disappear |
| Tokenized subnames (ERC-1155) owned by users | Who owns a project | Owner transfers → new wallet controls it |
| A resolver per name | Each release resolves itself; `preview`'s resolver is repointed per publish | Publish → preview moves; releases never do |
| Namespace aliasing via a shared registry + record aliasing (`linkToNode`) | Custom domains: `alice.eth`, `3.alice.eth`, `preview.alice.eth` (`navik link`, Domains tab) | Unlink → the domain gets its previous resolver and subregistry back |
| One Permissioned Resolver per project, deployed via VerifiableFactory | What is live: `text("contentcontract")` | Set it → site changes; set an older release → rollback |
| Enhanced Access Control, setter-scoped grants (`grantSetterRoles`) | Least-privilege deploy keys: `navik.publish` vs `contentcontract` | Revoke → the key's next deploy reverts |
| Per-project EAC scope | Isolation: a key for one project is useless on another | — |
| Emancipation and locked parents (no root admin on the Navik or release registries) | Nobody can unregister, repoint or upgrade project or release names | — |

## CROPS

- **C:** We control the `navik.eth` name, and nothing else is ours: no server, indexer or relayer, and no gateway of our own (eth.limo links are a convenience on top; any ENS gateway or ERC-8244 browser works). Sites, names and the dashboard all live on Ethereum, and any RPC can serve them. If we disappear, renewing `navik.eth` is permissionless. Once it is frozen, we cannot repoint it either. If an anon-rpc network or RPC provider refuses you, pick another network or endpoint in the privacy panel. Provenance and attestations live on Arkiv, a public network where anyone can write, read and extend them; nothing about serving or verifying a site depends on them.
- **O:** MIT. The repo alone builds and runs everything: contracts, CLI, dashboard and a local mainnet fork. The dashboard build is reproducible, and `scripts/reproduce.sh` proves that `navik.eth` serves this code.
- **P:** By default the RPC provider sees reads arriving from a Nym exit, not your IP, and Arkiv's RPC sees provenance lookups arriving from Nox. The wallet only sees signing requests. The CDN serving the pinned anon-rpc worker sees that you use it, but not what you read. Navik runs no backend and no analytics. Details are [below](#what-each-party-learns).
- **S:** Keys never leave your wallet. The anon-rpc worker is hash-pinned code in a null-origin sandbox, and opened sites run sandboxed with no access to the dashboard or wallet. Releases are checked against their onchain content hash. The trust assumptions are your RPC's answers and ENSv2's core contracts; see the security phases below.

### What each party learns

| Party | Learns | Does not learn |
|---|---|---|
| RPC provider (default `ethereum-rpc.publicnode.com`, reached through the mixnet) | The reads themselves: names, project accounts, release addresses. Reads under one `isolationKey` may be linkable to each other | Your IP. Which reads belong to the same person across isolation keys (if the network honours them) |
| anon-rpc network (Nym mix nodes and exit) | Mix nodes: nothing. Exit: that some client is talking to the RPC host | Who you are; with Nox, the request contents (TLS ends inside the worker) |
| Worker CDN (jsDelivr, unpkg or GitHub, one fetch per network, cached) | Your IP, and that you load an anon-rpc worker | Anything you read |
| eth.limo, only if you open a `.limo` link | Your IP and the site you opened | What you do in the dashboard once it is loaded |
| Arkiv RPC (Rabdi, reached through Nox) | Which sites' provenance and attestations are looked up | Your IP |
| Your wallet and its RPC | Your account, chain and the transactions you sign (public once sent), including attestations you sign on Arkiv | What you browse or manage in the dashboard |
| Navik (the team) | Nothing: there is no server | — |
| Sites you open in the viewer | Nothing about the dashboard: opaque origin, no wallet | — |

The CLI talks only to the RPC you pass, Arkiv's RPC (`ARKIV_RPC`) and, for `--swarm` and `reproduce`, the Swarm node or gateway (`SWARM_API`). By default those connections are direct. With [`--anon`](#in-the-cli), the RPC and Arkiv traffic goes through anon-rpc, and Swarm stays direct.

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
node src/cli.ts link portfolio alice.eth                     # alice.eth serves production, 3.alice.eth release 3
node src/cli.ts rollback portfolio v1
node src/cli.ts ls portfolio
node src/cli.ts verify portfolio
node src/cli.ts verify portfolio --against ./index.html      # is this build what's live?
node src/cli.ts open 2.portfolio.navik.eth
node src/cli.ts provenance portfolio                         # source and reproductions, from Arkiv
(cd ../examples/viem-vite && node ../../cli/src/cli.ts deploy --smoke)   # build, pack and ship from navik.json

# full CLI flow (claim → deploy → grants → rollback → multi-chunk → revoke → isolation → private reads → eth.limo replica → custom domains → demote →
# the Vite example from navik.json, smoke-tested → unchanged re-deploy → code splitting rejected);
# with ARKIV_PRIVATE_KEY set (tGLM on Rabdi) also provenance → Swarm (local stand-in) → reproduce → attest
pnpm run e2e

# SDK: Arkiv calldata for browser wallets is byte-identical to the Arkiv SDK's; packing build directories
pnpm -C ../sdk test

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

3. Publish the dashboard so `navik.eth` serves it (~33M gas), then check it against the commit:

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
| Link a custom domain (3 transactions: 173k + 40k + 58k) / unlink it | ~271k / ~145k |
| Read `html()` of a 491 KB site (`eth_call`) | 2.85M |

Mainnet caps a transaction at 2^24 gas (EIP-7825), so the CLI uploads at most 2 chunks per transaction. An upload interrupted halfway resumes: re-running `deploy` skips chunks that are already onchain.

### Compression

`navik deploy --compress` (the default for packed build directories, when it saves bytes; they are stored [segmented](#deploy-a-vite-app-and-from-ci)), or the "Compress" checkbox in the dashboard, stores the site gzip-wrapped. The stored document is a small loader page: the original HTML gzipped and base64-encoded, plus a script that decompresses it in the browser (`DecompressionStream`) and swaps it in. The loader keeps `window` intact, so wallet discovery (EIP-6963) and other listeners keep working; it re-runs the page's scripts in order and fires `DOMContentLoaded` and `load`.

| Site | Raw | Compressed |
|---|---|---|
| Navik dashboard (JS bundle, incl. the anon-rpc harness and Arkiv) | 353 KB, 15 chunks | 145 KB, 6 chunks (~33M gas) |
| Text-heavy page | 114 KB, 5 chunks, ~27M gas | 9 KB, 1 chunk, 2.2M gas |

Trade-offs:
- **It is off by default for a single HTML file:** a compressed site needs JavaScript to render. `--no-compress` turns it off for a build directory.
- **Standard formats on purpose:** anyone can audit a release with `base64 -d | gunzip`.
- **`navik verify` reports both hashes:** the stored loader's hash and the original document's hash. `--out`, `open` and the dashboard's "View" return the original; `--raw` returns the stored bytes.

## Limits (MVP)

- **One document per site:** up to 64 chunks (1,572,800 bytes). Build directories are packed into it. Vite apps work with code splitting turned off; Next.js (its runtime loads chunks and RSC payloads by URL) and multi-page sites (only `index.html` is served) are not supported yet.
- **Viewer sandbox:** sites opened in the dashboard run without wallet access. Sites that need a wallet render in ERC-8244 browsers or through `navik open`.
- **Read integrity:** reads are anonymized but not proven. A lying RPC could serve a false release consistently with its manifest. A light client or `eth_getProof` checks would remove that trust.
- **CLI anonymity is opt-in** (`--anon`), because it needs a headless browser.
- **Provenance is on a testnet.** Arkiv's Rabdi is a testnet, and records expire 180 days after their last extension unless someone extends them.
- **Dashboard wallets:** browser-injected wallets only (EIP-6963), no WalletConnect, so there's no relay server.
