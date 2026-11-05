# Navik

Vercel-style deployments for fully onchain websites, controlled by ENSv2.

```text
navik deploy portfolio ./index.html --promote

release      portfolio-v3.navik.eth
size         21,402 / 24,575 bytes
address      0x7469…c9Be (known before upload)
promoted     portfolio.navik.eth → portfolio-v3.navik.eth
```

- **Every release is an immutable ERC-8244 contract.** `html()` returns the site, stored in contract bytecode on Ethereum.
- **Every release gets a permanent name:** `<project>-v<N>.navik.eth`. Nobody can change or remove it, including us.
- **Production is `<project>.navik.eth`.** It is one `contentcontract` text record on the project's own ENSv2 Permissioned Resolver, so promote, rollback and demote are each one ENS write.
- **Who may deploy is an ENSv2 permission.** The project owner grants a key "publish releases" and/or "change production", for that project only, and can revoke it at any time.

## How it works

```text
navik.eth                              resolver: NavikResolver (wildcard, immutable)
│                                      subregistry: Navik UserRegistry (no admin)
├─ portfolio.navik.eth                 owner: alice · resolver: alice's PermissionedResolver
│     text contentcontract = 0x…v3     ← production, set by alice or a key she granted
├─ portfolio-v1.navik.eth   ┐
├─ portfolio-v2.navik.eth   ├─ not registered: ENSv2 falls back to navik.eth's resolver,
└─ portfolio-v3.navik.eth   ┘  which computes the answer from the factory (no writes, no admin)
```

| Contract | Role |
|---|---|
| `NavikRegistrar` | Creates the Navik UserRegistry and hands out `<project>.navik.eth`. Each project gets its own Permissioned Resolver with the creator as the only role holder |
| `NavikFactory` | `publish(project, html)` in one transaction: stores the bytes (deduplicated) and deploys release `vN` at `CREATE3(keccak(project, N))` |
| `Deployment` | One release. ERC-8244 `html()`, plus `manifest()` (project, version, content hash). A clone with immutable args: no storage, no owner |
| `NavikResolver` | Resolver of navik.eth. Answers `contentcontract`, `addr`, `navik.version`, `navik.project` and `navik.contenthash` for `<project>-v<N>.navik.eth`. Unknown versions never resolve |

## ENSv2 features used

| ENSv2 feature | What it does in Navik | Change it → what users see |
|---|---|---|
| Hierarchical registries (navik.eth → Navik UserRegistry) | Our namespace of projects | Locked: nobody can swap it |
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

**Security.** What each party can and cannot do:

| Party | Can | Cannot |
|---|---|---|
| Navik team (navik.eth owner) | Renew navik.eth (anyone can) | Repoint navik.eth's registry or resolver: the roles are revoked at deploy (`attachAndLock`) |
| | | Unregister, take or repoint a project; publish to it; change production; alter a release |
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

# local mainnet fork with navik.eth registered, Navik deployed and the root locked
./scripts/dev-fork.sh

# CLI
cd cli && pnpm install
export RPC_URL=http://127.0.0.1:8545 PRIVATE_KEY=0x…
node src/cli.ts claim portfolio
node src/cli.ts deploy portfolio ./index.html --promote
node src/cli.ts grant portfolio 0xCI… --permission publish   # preview-only key
node src/cli.ts rollback portfolio v1
node src/cli.ts ls portfolio
node src/cli.ts verify portfolio
node src/cli.ts open portfolio-v2.navik.eth

# full CLI flow (claim → deploy → grants → rollback → revoke → isolation → demote)
pnpm run e2e
```

### Mainnet

1. Buy `navik.eth` in the ENS app (ENSv2).
2. From the wallet that owns it:

   ```bash
   cd contracts
   forge script script/Deploy.s.sol --rpc-url $MAINNET_RPC_URL --private-key $OWNER_KEY --broadcast --verify
   ```

   This deploys the contracts, points navik.eth at them, and permanently drops the owner's power to repoint it. It also writes `contracts/deployments/1.json`, which the CLI reads.

Measured on a mainnet fork: publishing a full 24,575-byte site costs about 5.57M gas. Republishing identical bytes costs about 155k gas, because the content is stored once.

## Limits (MVP)

- **One chunk per site:** at most 24,575 bytes of prebuilt HTML.
- **No viewer:** browsers that support ERC-8244 `contentcontract`, or `navik open`, render the sites.
