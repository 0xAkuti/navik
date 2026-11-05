# Navik

Vercel-style deployments for fully onchain websites, controlled by ENSv2.

```text
navik deploy portfolio ./index.html --promote

release      portfolio-v3.navik.eth
size         21,402 / 24,575 bytes
address      0x7469…c9Be (known before upload)
promoted     portfolio.navik.eth → portfolio-v3.navik.eth
```

- **Every release is an immutable ERC-8244 contract.** `html()` returns the site, stored in contract bytecode on Ethereum in chunks of up to 24,575 bytes. Sites can be up to about 1.5 MB; unchanged chunks are never uploaded twice.
- **Every release gets a permanent name:** `<project>-v<N>.navik.eth`. Nobody can change or remove it, including us.
- **Production is `<project>.navik.eth`.** It is one `contentcontract` text record on the project's own ENSv2 Permissioned Resolver, so promote, rollback and demote are each one ENS write.
- **Who may deploy is an ENSv2 permission.** The project owner grants a key "publish releases" and/or "change production", for that project only, and can revoke it at any time.

## How it works

```text
navik.eth                              resolver: NavikResolver (wildcard, immutable)
│                                      subregistry: Navik UserRegistry (no admin)
│                                      serves app.navik.eth's production (the dashboard)
├─ portfolio.navik.eth                 owner: alice · resolver: alice's PermissionedResolver
│     text contentcontract = 0x…v3     ← production, set by alice or a key she granted
├─ portfolio-v1.navik.eth   ┐
├─ portfolio-v2.navik.eth   ├─ not registered: ENSv2 falls back to navik.eth's resolver,
└─ portfolio-v3.navik.eth   ┘  which computes the answer from the factory (no writes, no admin)
```

| Contract | Role |
|---|---|
| `NavikRegistrar` | Creates the Navik UserRegistry and hands out `<project>.navik.eth`. Each project gets its own Permissioned Resolver with the creator as the only role holder. It claims the root project (`app`) at deploy, so nobody can front-run it |
| `NavikFactory` | `storeChunks(chunks)` stores content chunks. It is permissionless and addressed by content, so identical chunks are stored once across all projects. `publish(project, pointers)` deploys release `vN` at `CREATE3(keccak(project, N))`, computing the content hash onchain. `publishContent` does both in one transaction for small sites |
| `Deployment` | One release. ERC-8244 `html()` concatenates its chunks. `chunkCount()` and `chunk(i)` serve RPCs that limit `eth_call` size. `manifest()` returns project, version, content hash, size and chunk pointers. A clone with immutable args: no storage, no owner |
| `NavikResolver` | Resolver of navik.eth. Answers `contentcontract`, `addr`, `navik.version`, `navik.project` and `navik.contenthash` for `<project>-v<N>.navik.eth`. Unknown versions never resolve. Queries for `navik.eth` itself are forwarded to the root project's resolver, so navik.eth follows its promotions and rollbacks |

## Dashboard

`app/` is a dashboard for managing projects: connect a wallet, claim a project, drop in an HTML build, deploy, promote, roll back, take offline, and grant or revoke deploy keys. "View" fetches a release from Ethereum, checks its content hash, and opens it.

It is hosted on Navik itself:
- The build is one self-contained HTML file (~181 KB, 8 chunks), with no CDN, fonts or analytics. It talks only to the connected wallet's RPC, and transactions are signed by the wallet.
- It is published to the root project `app.navik.eth`, so `navik.eth` serves it.
- Every version of the dashboard keeps its own permanent name (`app-v1.navik.eth`, …).

```bash
PRIVATE_KEY=0x… ./scripts/deploy-app.sh   # build for the connected chain, deploy to app.navik.eth, promote
```

## ENSv2 features used

| ENSv2 feature | What it does in Navik | Change it → what users see |
|---|---|---|
| Hierarchical registries (navik.eth → Navik UserRegistry) | Our namespace of projects | Swappable by the navik.eth owner until frozen, then by nobody |
| Tokenized subnames (ERC-1155) owned by users | Who owns a project | Owner transfers → new wallet controls it |
| Registry walk with resolver fallback (ENSIP-10) | Permanent release names with zero writes | Cannot change; unknown versions do not resolve |
| One Permissioned Resolver per project, deployed via VerifiableFactory | What is live: `text("contentcontract")` | Set it → site changes; set an older release → rollback |
| Enhanced Access Control, setter-scoped grants (`grantSetterRoles`) | Least-privilege deploy keys: `navik.publish` vs `contentcontract` | Revoke → the key's next deploy reverts |
| Per-project EAC scope | Isolation: a key for one project is useless on another | — |
| Emancipation (no root admin on the Navik registry) | Nobody can unregister, repoint or upgrade project names | — |

## CROPS

**Censorship resistance.**
- Site bytes live in Ethereum bytecode, and names are ENS records on Ethereum.
- There is no server, gateway or indexer in the read path. Any ENS-aware client, or `navik open`, can load a site with only an RPC endpoint.

**Open source.**
- MIT licensed.
- None of the contracts has an owner, an admin function or an upgrade path.

**Privacy.**
- No backend, accounts or analytics.
- The CLI talks only to the RPC you choose.

**Security.** Navik has two phases:

1. **Testing.** The navik.eth owner keeps the ENSv2 roles to repoint navik.eth's registry and resolver, so a broken deployment can be replaced. That power covers the whole namespace: repointing navik.eth hides every project and release name served by the old contracts. The releases themselves, their bytes and their addresses are untouched.
2. **Frozen.** `Freeze.s.sol` revokes those roles, including the admin roles that could grant them back, from every holder. Then it checks onchain that nobody holds them. This is irreversible. `navik info` reports which phase a deployment is in, read from the chain.

What each party can and cannot do:

| Party | Can | Cannot |
|---|---|---|
| Navik team (navik.eth owner) | Renew navik.eth (anyone can) | Unregister, take or repoint a project; publish to it; change production; alter a release |
| | Before the freeze only: repoint navik.eth to other Navik contracts | After the freeze: repoint navik.eth at all |
| Navik contracts | — | Hold any role on project names or project resolvers |
| Project creator | Publish releases; promote, roll back, demote; grant and revoke keys; transfer the name | Change or delete a published release, or its name |
| Key granted `publish` | Publish releases of that project | Change production; touch other projects |
| Key granted `promote` | Change that project's production | Publish (unless also granted); touch other projects |
| Anyone | Read and verify everything | Claim a release-shaped label (`*-v<N>`) |

Remaining assumptions, stated plainly:
- **ENSv2 core contracts.** The ETHRegistry reports itself emancipated, meaning no root override.
- **navik.eth must stay renewed.** Renewal is permissionless, so anyone can pay to keep it alive.
- **Release addresses never depend on ENS.** Every release stays readable at its contract address even if ENS changes.

`navik verify <name>` checks a site without trusting anyone. It resolves the name through ENSv2's UniversalResolver, then checks three things:
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
node src/cli.ts open portfolio-v2.navik.eth

# full CLI flow (claim → deploy → grants → rollback → multi-chunk → revoke → isolation → demote)
pnpm run e2e

# dashboard: dev server, or the headless-browser e2e (wallet injected, talks to the fork)
cd ../app && pnpm dev
pnpm run e2e
# the same test against the copy served by navik.eth, fetched from the chain
APP_FILE=$(node ../cli/src/cli.ts open navik.eth | sed 's#file://##') node test/e2e.ts
```

### Mainnet

1. Buy `navik.eth` in the ENS app (ENSv2).
2. From the wallet that owns it:

   ```bash
   cd contracts
   forge script script/Deploy.s.sol --rpc-url $MAINNET_RPC_URL --private-key $OWNER_KEY --broadcast --verify
   ```

   This deploys the contracts and points navik.eth at them. It writes `contracts/deployments/1.json`, which the CLI reads, plus `1-<block>.json` as a record.

3. During testing, fix mistakes by deploying again (step 2), or switch back to an earlier deployment:

   ```bash
   DEPLOYMENT=1-<block> forge script script/Attach.s.sol --rpc-url $MAINNET_RPC_URL --private-key $OWNER_KEY --broadcast
   ```

4. When ready, freeze navik.eth. This is irreversible. If other wallets were granted roles on navik.eth, list them in `ALSO_REVOKE` (comma-separated); the script fails if anyone would keep the power.

   ```bash
   CONFIRM_FREEZE=navik.eth forge script script/Freeze.s.sol --rpc-url $MAINNET_RPC_URL --private-key $OWNER_KEY --broadcast
   ```

Measured on a mainnet fork:

| Operation | Gas |
|---|---|
| Store one full chunk (24,575 B) | ~5.4M |
| Store + publish a site of up to 2 full chunks (one tx, `publishContent`) | 11.8M for 49,150 B |
| Publish already-stored chunks | ~210–275k |
| Read `html()` of a 491 KB site (`eth_call`) | 2.85M |

Mainnet caps a transaction at 2^24 gas (EIP-7825), so the CLI uploads at most 2 chunks per transaction. An upload interrupted halfway resumes: re-running `deploy` skips chunks that are already onchain.

## Limits (MVP)

- **Single-file sites:** one prebuilt HTML document of up to 64 chunks (1,572,800 bytes).
- **No viewer:** browsers that support ERC-8244 `contentcontract`, `navik open`, or "View" in the dashboard render the sites.
- **Dashboard wallets:** browser-injected wallets only (EIP-6963), no WalletConnect, so there's no relay server.
